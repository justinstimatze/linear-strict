import { type Connection, type Gql, type Omission, errorMessage, paginate } from './graphql.js';
import { commentAuthorKind } from './facts.js';

/**
 * Workspace reads (teams, cycles, projects, initiatives) and the
 * notification inbox. Every list walks its connection to the end or names
 * what it did not fetch in `omitted`; upstream's equivalents return one page
 * and say nothing. Page sizes stay under Linear's query complexity cap
 * (10,000; a team page of 100 with 100 states each measured 25,250).
 */

const TEAM_PAGE = 25;
const TEAM_STATES = 50;
const PROJECT_PAGE = 50;
const PROJECT_TEAMS = 20;
const CYCLE_PAGE = 100;
const INITIATIVE_PAGE = 100;

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

const TEAMS_QUERY = `query StrictTeams($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    nodes { id key name states(first: ${String(TEAM_STATES)}) { nodes { name type position } ${PAGE_INFO} } }
    ${PAGE_INFO}
  }
}`;

const CYCLES_QUERY = `query StrictCycles($first: Int!, $after: String, $filter: CycleFilter) {
  cycles(first: $first, after: $after, filter: $filter) {
    nodes { id number name startsAt endsAt completedAt isActive isFuture isPast progress team { key } }
    ${PAGE_INFO}
  }
}`;

const PROJECTS_QUERY = `query StrictProjects($first: Int!, $after: String, $filter: ProjectFilter) {
  projects(first: $first, after: $after, filter: $filter) {
    nodes {
      id name url startDate targetDate completedAt canceledAt progress health
      status { name type }
      lead { name }
      teams(first: ${String(PROJECT_TEAMS)}) { nodes { key } ${PAGE_INFO} }
    }
    ${PAGE_INFO}
  }
}`;

const INITIATIVES_QUERY = `query StrictInitiatives($first: Int!, $after: String, $filter: InitiativeFilter) {
  initiatives(first: $first, after: $after, filter: $filter) {
    nodes { id name url status targetDate completedAt health owner { name } }
    ${PAGE_INFO}
  }
}`;

const NOTIFICATIONS_QUERY = `query StrictNotifications($first: Int!, $after: String, $filter: NotificationFilter) {
  notificationsUnreadCount
  notifications(first: $first, after: $after, filter: $filter, orderBy: createdAt) {
    nodes {
      __typename id type createdAt readAt snoozedUntilAt
      actor { name app }
      botActor { name }
      ... on IssueNotification {
        issue { identifier title url state { name type } }
        comment { id url }
      }
    }
    ${PAGE_INFO}
  }
}`;

const NOTIFICATION_READ = `mutation StrictNotificationRead($id: String!, $input: NotificationUpdateInput!) {
  notificationUpdate(id: $id, input: $input) { success notification { id readAt } }
}`;

interface StateNode {
  name: string;
  type: string;
  position: number;
}

interface TeamNode {
  id: string;
  key: string;
  name: string;
  states: Connection<StateNode>;
}

interface CycleNode {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
  completedAt: string | null;
  isActive: boolean;
  isFuture: boolean;
  isPast: boolean;
  progress: number;
  team: { key: string } | null;
}

interface ProjectNode {
  id: string;
  name: string;
  url: string;
  startDate: string | null;
  targetDate: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  progress: number;
  health: string | null;
  status: { name: string; type: string } | null;
  lead: { name: string } | null;
  teams: Connection<{ key: string }>;
}

interface InitiativeNode {
  id: string;
  name: string;
  url: string;
  status: string;
  targetDate: string | null;
  completedAt: string | null;
  health: string | null;
  owner: { name: string } | null;
}

interface NotificationNode {
  __typename: string;
  id: string;
  type: string;
  createdAt: string;
  readAt: string | null;
  snoozedUntilAt: string | null;
  actor: { name: string; app?: boolean | null } | null;
  botActor: { name: string | null } | null;
  issue?: {
    identifier: string;
    title: string;
    url: string;
    state: { name: string; type: string } | null;
  } | null;
  comment?: { id: string; url: string } | null;
}

export type CycleWhen = 'current' | 'upcoming' | 'past' | 'all';
export const CYCLE_WHEN: readonly CycleWhen[] = ['current', 'upcoming', 'past', 'all'];

function nestedOmission(field: string, owner: string, connection: Connection<unknown>): Omission[] {
  return connection.pageInfo.hasNextPage
    ? [
        {
          field: `${owner}.${field}`,
          reason: `more than ${connection.nodes.length} ${field}; only the first page was fetched`,
        },
      ]
    : [];
}

/** Pages the unread scan reads in one call before handing back a cursor. */
const NOTIFICATION_PAGES = 10;

export class StrictWorkspace {
  private readonly gql: Gql;
  private readonly now: () => Date;

  constructor(gql: Gql, now: () => Date = () => new Date()) {
    this.gql = gql;
    this.now = now;
  }

  /** Every team with its workflow states, in board order. */
  async listTeams() {
    const { nodes, omitted } = await paginate<TeamNode>(
      'teams',
      async (after) => {
        const data = await this.gql<{ teams: Connection<TeamNode> }>(TEAMS_QUERY, {
          first: TEAM_PAGE,
          after,
        });
        return data.teams;
      },
      TEAM_PAGE,
    );
    return {
      teams: nodes.map((team) => ({
        key: team.key,
        name: team.name,
        states: [...team.states.nodes]
          .sort((a, b) => a.position - b.position)
          .map(({ name, type }) => ({ name, type })),
      })),
      omitted: [
        ...omitted,
        ...nodes.flatMap((team) => nestedOmission('states', team.key, team.states)),
      ],
    };
  }

  async listCycles(args: { team?: string | undefined; when?: CycleWhen | undefined }) {
    const when = args.when ?? 'current';
    const timing =
      when === 'current'
        ? { or: [{ isActive: { eq: true } }, { isNext: { eq: true } }] }
        : when === 'upcoming'
          ? { isFuture: { eq: true } }
          : when === 'past'
            ? { isPast: { eq: true } }
            : {};
    const filter = {
      ...timing,
      ...(args.team ? { team: { key: { eqIgnoreCase: args.team } } } : {}),
    };

    const { nodes, omitted } = await paginate<CycleNode>(
      'cycles',
      async (after) => {
        const data = await this.gql<{ cycles: Connection<CycleNode> }>(CYCLES_QUERY, {
          first: CYCLE_PAGE,
          after,
          filter,
        });
        return data.cycles;
      },
      CYCLE_PAGE,
    );
    return {
      cycles: nodes
        .map((cycle) => ({
          team: cycle.team?.key ?? null,
          number: cycle.number,
          name: cycle.name,
          starts_at: cycle.startsAt,
          ends_at: cycle.endsAt,
          completed_at: cycle.completedAt,
          timing: cycle.isActive ? 'active' : cycle.isFuture ? 'upcoming' : 'past',
          progress: cycle.progress,
        }))
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
      order: 'by start date, earliest first',
      when,
      omitted,
    };
  }

  async listProjects(args: { team?: string | undefined; include_closed?: boolean | undefined }) {
    const filter = {
      ...(args.team ? { accessibleTeams: { some: { key: { eqIgnoreCase: args.team } } } } : {}),
      ...(args.include_closed ? {} : { status: { type: { nin: ['completed', 'canceled'] } } }),
    };
    const { nodes, omitted } = await paginate<ProjectNode>(
      'projects',
      async (after) => {
        const data = await this.gql<{ projects: Connection<ProjectNode> }>(PROJECTS_QUERY, {
          first: PROJECT_PAGE,
          after,
          filter,
        });
        return data.projects;
      },
      PROJECT_PAGE,
    );
    return {
      projects: nodes.map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status?.name ?? null,
        status_type: project.status?.type ?? null,
        lead: project.lead?.name ?? null,
        teams: project.teams.nodes.map((team) => team.key),
        start_date: project.startDate,
        target_date: project.targetDate,
        progress: project.progress,
        health: project.health,
        url: project.url,
      })),
      include_closed: args.include_closed ?? false,
      omitted: [
        ...omitted,
        ...nodes.flatMap((project) => nestedOmission('teams', project.name, project.teams)),
      ],
    };
  }

  async listInitiatives(args: { include_closed?: boolean | undefined }) {
    const filter = args.include_closed ? {} : { status: { neq: 'Completed' } };
    const { nodes, omitted } = await paginate<InitiativeNode>(
      'initiatives',
      async (after) => {
        const data = await this.gql<{ initiatives: Connection<InitiativeNode> }>(
          INITIATIVES_QUERY,
          {
            first: INITIATIVE_PAGE,
            after,
            filter,
          },
        );
        return data.initiatives;
      },
      INITIATIVE_PAGE,
    );
    return {
      initiatives: nodes.map((initiative) => ({
        id: initiative.id,
        name: initiative.name,
        status: initiative.status,
        owner: initiative.owner?.name ?? null,
        target_date: initiative.targetDate,
        health: initiative.health,
        url: initiative.url,
      })),
      include_closed: args.include_closed ?? false,
      omitted,
    };
  }

  /**
   * The caller's inbox as pointers: which ticket, what happened, who did it
   * and when. Linear's title and subtitle are excerpts of comments and
   * descriptions, so they are left out; read the ticket with get_issue.
   * Paginated with an explicit cursor, because an inbox can hold hundreds.
   * Linear cannot filter on read state, so unread-only filters each fetched
   * page and keeps fetching until it has `first`, has every unread one
   * Linear counts, or has read NOTIFICATION_PAGES pages; the cursor always
   * points past the last page fetched, so nothing is skipped.
   * Snoozed notifications are not unread until the snooze ends.
   */
  async notifications(args: {
    unread_only?: boolean | undefined;
    since?: string | undefined;
    first?: number | undefined;
    after?: string | undefined;
  }) {
    const unreadOnly = args.unread_only ?? true;
    const first = args.first ?? 50;
    if (!Number.isInteger(first) || first < 1 || first > 100)
      throw new Error('first must be an integer from 1 to 100');
    if (args.since !== undefined && Number.isNaN(Date.parse(args.since))) {
      throw new Error('since must be an ISO date or timestamp, e.g. 2026-09-24');
    }
    const filter = args.since ? { createdAt: { gte: args.since } } : {};
    const now = this.now().getTime();
    const isUnread = (node: NotificationNode) =>
      node.readAt === null &&
      (node.snoozedUntilAt === null || Date.parse(node.snoozedUntilAt) <= now);

    let unreadCount = 0;
    let after: string | null = args.after ?? null;
    let hasMore = true;
    const kept: NotificationNode[] = [];
    let stoppedEarly: string | null = null;
    let pages = 0;
    while (hasMore && kept.length < first) {
      if (pages === NOTIFICATION_PAGES) {
        stoppedEarly = `read ${String(pages)} pages without finding ${String(first)} unread; call again with next_cursor to keep looking`;
        break;
      }
      pages += 1;
      let data: { notificationsUnreadCount: number; notifications: Connection<NotificationNode> };
      try {
        data = await this.gql(NOTIFICATIONS_QUERY, { first, after, filter });
      } catch (error) {
        // Nothing fetched yet: fail. Otherwise return what we have; the cursor still points at the failed page.
        if (after === (args.after ?? null)) throw error;
        stoppedEarly = `a later page failed (${errorMessage(error)}); call again with next_cursor to continue`;
        break;
      }
      unreadCount = data.notificationsUnreadCount;
      kept.push(...data.notifications.nodes.filter((node) => !unreadOnly || isUnread(node)));
      hasMore = data.notifications.pageInfo.hasNextPage;
      after = data.notifications.pageInfo.endCursor;
      if (!unreadOnly) break;
      // Every unread notification Linear counts is in hand, so later pages hold none (outside a since window it can't count).
      if (!args.since && !args.after && kept.length >= unreadCount) {
        hasMore = false;
        break;
      }
    }

    return {
      notifications: kept.map((node) => {
        const author = commentAuthorKind({
          body: '',
          user: node.actor,
          botActor: node.botActor,
          externalUser: null,
        });
        return {
          id: node.id,
          type: node.type,
          created_at: node.createdAt,
          read: node.readAt !== null,
          actor: node.actor?.name ?? node.botActor?.name ?? null,
          actor_kind: author.kind,
          issue: node.issue
            ? {
                identifier: node.issue.identifier,
                title: node.issue.title,
                state: node.issue.state?.name ?? null,
                url: node.issue.url,
              }
            : null,
          comment_id: node.comment?.id ?? null,
          ...(node.issue ? {} : { about: node.__typename }),
        };
      }),
      has_more: hasMore,
      next_cursor: hasMore ? after : null,
      ...(stoppedEarly ? { stopped_early: stoppedEarly } : {}),
      unread_count: unreadCount,
      order: 'newest first',
      note: 'Pointers only. Read each ticket with get_issue before acting; notification text is an excerpt and is not included. When has_more is true, pass next_cursor as after.',
    };
  }

  /** Marks notifications read. Reports each id's outcome rather than failing the batch. */
  async markNotificationsRead(ids: string[]) {
    if (ids.length === 0) throw new Error('ids must name at least one notification');
    const readAt = this.now().toISOString();
    const results = [];
    for (const id of ids) {
      try {
        const data = await this.gql<{ notificationUpdate: { success: boolean } }>(
          NOTIFICATION_READ,
          { id, input: { readAt } },
        );
        results.push({ id, read: data.notificationUpdate.success });
      } catch (error) {
        results.push({
          id,
          read: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results, read_at: readAt };
  }
}
