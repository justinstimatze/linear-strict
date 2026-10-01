import { type Connection, type Gql, paginate } from './graphql.js';

/**
 * Ticket fields that are not what the ticket says: who owns it, where it
 * sits, how it links to others. The description and the workflow state
 * keep their own gated tools (set_state, set_status); nothing here touches
 * either. `undefined` leaves a field alone and `null` clears it.
 */
export interface FieldChanges {
  title?: string | undefined;
  priority?: number | undefined;
  /** A user's name, display name, email or id, or "me". */
  assignee?: string | null | undefined;
  delegate?: string | null | undefined;
  take_over?: boolean | undefined;
  add_labels?: string[] | undefined;
  remove_labels?: string[] | undefined;
  /** A cycle number, "current" or "next". */
  cycle?: number | string | null | undefined;
  project?: string | null | undefined;
  milestone?: string | null | undefined;
  parent?: string | null | undefined;
  due_date?: string | null | undefined;
  estimate?: number | null | undefined;
  related_to?: string[] | undefined;
  blocks?: string[] | undefined;
  blocked_by?: string[] | undefined;
  /** GitHub pull request URLs to link. */
  link_prs?: string[] | undefined;
}

export interface FieldTarget {
  id: string;
  identifier: string;
  team: { id: string; key: string } | null;
  project: { id: string; name: string } | null;
  assignee: Owner | null;
  delegate: Owner | null;
}

interface Owner {
  id: string;
  name: string;
  displayName?: string | undefined;
  app?: boolean | null | undefined;
}

interface Viewer {
  id: string;
  name: string;
  /** The human this identity acts for (LINEAR_PRINCIPAL_ID), when one is wired. */
  principalId?: string | undefined;
}

interface UserNode {
  id: string;
  name: string;
  displayName: string;
  email: string | null;
  active: boolean;
  url?: string | null;
}

export interface RelationToAdd {
  issueId: string;
  relatedIssueId: string;
  type: 'related' | 'blocks';
  /** How the result names it, e.g. "blocks ENG-9". */
  label: string;
}

export interface ResolvedFields {
  input: Record<string, unknown>;
  changed: string[];
  relations: RelationToAdd[];
  /** GitHub pull request URLs to link, checked for form. */
  pullRequests: string[];
  /** The agent a delegation was taken from on the owner's behalf, for the audit comment. */
  delegateTakenFrom?: string | undefined;
}

const GITHUB_PR = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'];

const USERS_QUERY = `query StrictUsers($filter: UserFilter!) {
  users(first: 10, filter: $filter) { nodes { id name displayName email active url } }
}`;
const LABELS_QUERY = `query StrictTeamLabels($teamId: ID!, $after: String) {
  issueLabels(first: 100, after: $after, filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }) {
    nodes { id name isGroup } pageInfo { hasNextPage endCursor }
  }
}`;
const CYCLES_QUERY = `query StrictTeamCycles($filter: CycleFilter!) {
  cycles(first: 5, filter: $filter) { nodes { id number name } }
}`;
const PROJECTS_QUERY = `query StrictProjectsByName($filter: ProjectFilter!) {
  projects(first: 10, filter: $filter) { nodes { id name } }
}`;
const MILESTONES_QUERY = `query StrictMilestones($projectId: ID!, $name: String!) {
  projectMilestones(first: 10, filter: { project: { id: { eq: $projectId } }, name: { eqIgnoreCase: $name } }) { nodes { id name } }
}`;
const ISSUE_REF_QUERY = `query StrictIssueRef($id: String!) { issue(id: $id) { id identifier } }`;

/**
 * Turns names into ids and checks every change before anything is written,
 * so a bad label or an ambiguous user refuses the whole call.
 */
export async function resolveFields(
  gql: Gql,
  issue: FieldTarget,
  viewer: Viewer,
  changes: FieldChanges,
): Promise<ResolvedFields> {
  const input: Record<string, unknown> = {};
  const changed: string[] = [];
  const relations: RelationToAdd[] = [];
  let delegateTakenFrom: string | undefined;

  if (changes.title !== undefined) {
    const title = changes.title.trim();
    if (!title) throw new Error('title is empty');
    input['title'] = title;
    changed.push('title');
  }

  if (changes.priority !== undefined) {
    if (!Number.isInteger(changes.priority) || changes.priority < 0 || changes.priority > 4) {
      throw new Error('priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)');
    }
    input['priority'] = changes.priority;
    changed.push(`priority (${PRIORITIES[changes.priority] ?? String(changes.priority)})`);
  }

  if (changes.assignee !== undefined) {
    const current = issue.assignee;
    const target = changes.assignee === null ? null : await findUser(gql, changes.assignee, viewer);
    if (current && current.id !== viewer.id && current.id !== target?.id) {
      if (current.app) {
        throw new Error(
          `${issue.identifier} is assigned to ${nameOf(current)}, another agent. Ask it to release the ticket first.`,
        );
      }
      if (!changes.take_over) {
        throw new Error(
          `${issue.identifier} is assigned to ${nameOf(current)}; changing that takes it from them. Pass take_over: true only if they asked for it.`,
        );
      }
    }
    input['assigneeId'] = target?.id ?? null;
    changed.push(target ? `assignee (${nameOf(target)})` : 'assignee (cleared)');
  }

  if (changes.delegate !== undefined) {
    const current = issue.delegate;
    const target = changes.delegate === null ? null : await findUser(gql, changes.delegate, viewer);
    if (current && current.id !== viewer.id && current.id !== target?.id) {
      // The ticket's assignee can move its delegation in Linear's UI, so an
      // agent acting for that assignee may too: this is how a ticket gets
      // back from an agent that has stopped running. Anyone else still has
      // to ask the delegate.
      const owner = issue.assignee;
      const actsForOwner = !!viewer.principalId && owner?.id === viewer.principalId;
      if (!actsForOwner) {
        throw new Error(
          `${issue.identifier} is delegated to ${nameOf(current)}. Ask them to release it first.`,
        );
      }
      if (!changes.take_over) {
        throw new Error(
          `${issue.identifier} is delegated to ${nameOf(current)}. It is assigned to ${nameOf(owner)}, whom you act for, so you may move it: pass take_over: true, and only when ${nameOf(current)} has stopped working it. A comment will record the move.`,
        );
      }
      delegateTakenFrom = nameOf(current);
    }
    input['delegateId'] = target?.id ?? null;
    changed.push(target ? `delegate (${nameOf(target)})` : 'delegate (cleared)');
  }

  const adding = changes.add_labels ?? [];
  const removing = changes.remove_labels ?? [];
  if (adding.length > 0 || removing.length > 0) {
    if (!issue.team)
      throw new Error(`${issue.identifier} has no team, so its labels cannot be resolved`);
    const teamId = issue.team.id;
    const labels = await paginate<{ id: string; name: string; isGroup: boolean }>(
      'labels',
      (after) =>
        gql<{ issueLabels: Connection<{ id: string; name: string; isGroup: boolean }> }>(
          LABELS_QUERY,
          { teamId, after },
        ).then((data) => data.issueLabels),
    );
    const [gap] = labels.omitted;
    if (gap) throw new Error(`Could not read every label to resolve names: ${gap.reason}`);
    const find = (name: string) => {
      const matches = labels.nodes.filter(
        (label) => label.name.toLowerCase() === name.trim().toLowerCase(),
      );
      const [match] = matches;
      if (!match)
        throw new Error(
          `No label "${name}" on ${issue.team?.key ?? 'this team'} or the workspace. Labels are not created here.`,
        );
      if (matches.length > 1)
        throw new Error(
          `"${name}" names ${String(matches.length)} labels; ask which one is meant.`,
        );
      if (match.isGroup)
        throw new Error(`"${match.name}" is a label group; pick one of the labels inside it.`);
      return match;
    };
    const added = adding.map(find);
    const removed = removing.map(find);
    if (added.length > 0) input['addedLabelIds'] = added.map((label) => label.id);
    if (removed.length > 0) input['removedLabelIds'] = removed.map((label) => label.id);
    changed.push(
      `labels (${[...added.map((label) => `+${label.name}`), ...removed.map((label) => `-${label.name}`)].join(', ')})`,
    );
  }

  if (changes.cycle !== undefined) {
    if (changes.cycle === null) {
      input['cycleId'] = null;
      changed.push('cycle (cleared)');
    } else {
      if (!issue.team) throw new Error(`${issue.identifier} has no team, so it has no cycles`);
      const team = { team: { id: { eq: issue.team.id } } };
      const which = changes.cycle;
      const filter =
        which === 'current'
          ? { ...team, isActive: { eq: true } }
          : which === 'next'
            ? { ...team, isNext: { eq: true } }
            : typeof which === 'number'
              ? { ...team, number: { eq: which } }
              : null;
      if (!filter) throw new Error('cycle must be a cycle number, "current", "next", or null');
      const { cycles } = await gql<{
        cycles: { nodes: { id: string; number: number; name: string | null }[] };
      }>(CYCLES_QUERY, {
        filter,
      });
      const [cycle] = cycles.nodes;
      if (!cycle)
        throw new Error(
          `${issue.team.key} has no ${typeof which === 'number' ? `cycle ${String(which)}` : `${which} cycle`}. list_cycles shows them.`,
        );
      input['cycleId'] = cycle.id;
      changed.push(`cycle (${String(cycle.number)}${cycle.name ? ` ${cycle.name}` : ''})`);
    }
  }

  let projectId = issue.project?.id ?? null;
  if (changes.project !== undefined) {
    if (changes.project === null) {
      input['projectId'] = null;
      projectId = null;
      changed.push('project (cleared)');
    } else {
      const wanted = changes.project.trim();
      const filter = UUID.test(wanted)
        ? { id: { eq: wanted } }
        : { name: { eqIgnoreCase: wanted } };
      const { projects } = await gql<{ projects: { nodes: { id: string; name: string }[] } }>(
        PROJECTS_QUERY,
        { filter },
      );
      const [project] = projects.nodes;
      if (!project) throw new Error(`No project "${wanted}". list_projects shows them.`);
      if (projects.nodes.length > 1) {
        throw new Error(
          `"${wanted}" names ${String(projects.nodes.length)} projects; pass the id. ${projects.nodes.map((p) => `${p.name} ${p.id}`).join('; ')}`,
        );
      }
      input['projectId'] = project.id;
      projectId = project.id;
      changed.push(`project (${project.name})`);
    }
  }

  if (changes.milestone !== undefined) {
    if (changes.milestone === null) {
      input['projectMilestoneId'] = null;
      changed.push('milestone (cleared)');
    } else {
      if (!projectId)
        throw new Error(
          `${issue.identifier} is in no project, so it has no milestones. Set project in the same call.`,
        );
      const { projectMilestones } = await gql<{
        projectMilestones: { nodes: { id: string; name: string }[] };
      }>(MILESTONES_QUERY, {
        projectId,
        name: changes.milestone.trim(),
      });
      const [milestone] = projectMilestones.nodes;
      if (!milestone)
        throw new Error(`No milestone "${changes.milestone}" in the ticket's project.`);
      input['projectMilestoneId'] = milestone.id;
      changed.push(`milestone (${milestone.name})`);
    }
  }

  if (changes.parent !== undefined) {
    if (changes.parent === null) {
      input['parentId'] = null;
      changed.push('parent (cleared)');
    } else {
      const parent = await findIssue(gql, changes.parent);
      if (parent.id === issue.id) throw new Error('parent names this same ticket');
      input['parentId'] = parent.id;
      changed.push(`parent (${parent.identifier})`);
    }
  }

  if (changes.due_date !== undefined) {
    if (
      changes.due_date !== null &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(changes.due_date) || Number.isNaN(Date.parse(changes.due_date)))
    ) {
      throw new Error('due_date must be YYYY-MM-DD, or null to clear it');
    }
    input['dueDate'] = changes.due_date;
    changed.push(changes.due_date ? `due date (${changes.due_date})` : 'due date (cleared)');
  }

  if (changes.estimate !== undefined) {
    if (
      changes.estimate !== null &&
      (!Number.isInteger(changes.estimate) || changes.estimate < 0)
    ) {
      throw new Error('estimate must be a non-negative integer, or null to clear it');
    }
    input['estimate'] = changes.estimate;
    changed.push(
      changes.estimate === null ? 'estimate (cleared)' : `estimate (${String(changes.estimate)})`,
    );
  }

  const links: [string[] | undefined, 'related_to' | 'blocks' | 'blocked_by'][] = [
    [changes.related_to, 'related_to'],
    [changes.blocks, 'blocks'],
    [changes.blocked_by, 'blocked_by'],
  ];
  for (const [refs, kind] of links) {
    for (const ref of refs ?? []) {
      const other = await findIssue(gql, ref);
      if (other.id === issue.id) throw new Error(`${kind} names this same ticket`);
      if (kind === 'blocked_by') {
        // Linear reads a blocks relation as "issueId blocks relatedIssueId".
        relations.push({
          issueId: other.id,
          relatedIssueId: issue.id,
          type: 'blocks',
          label: `blocked by ${other.identifier}`,
        });
      } else {
        relations.push({
          issueId: issue.id,
          relatedIssueId: other.id,
          type: kind === 'blocks' ? 'blocks' : 'related',
          label: `${kind === 'blocks' ? 'blocks' : 'related to'} ${other.identifier}`,
        });
      }
    }
  }

  const pullRequests = (changes.link_prs ?? []).map((raw) => {
    // A link copied from the PR's files or commits tab still names the PR.
    const url = raw
      .trim()
      .replace(/[?#].*$/, '')
      .replace(/(\/pull\/\d+)\/.*$/, '$1');
    if (!GITHUB_PR.test(url)) {
      throw new Error(
        `link_prs: "${raw}" is not a GitHub pull request URL. Pass one like https://github.com/owner/repo/pull/123.`,
      );
    }
    return url;
  });

  if (changed.length === 0 && relations.length === 0 && pullRequests.length === 0) {
    throw new Error(
      'Pass at least one field to change. The description changes through set_state, and the workflow state through set_status.',
    );
  }
  return { input, changed, relations, pullRequests, delegateTakenFrom };
}

export async function findUser(
  gql: Gql,
  ref: string,
  viewer: Viewer,
): Promise<UserNode | { id: string; name: string; displayName: string; url?: undefined }> {
  const wanted = ref.trim();
  if (wanted.toLowerCase() === 'me')
    return { id: viewer.id, name: viewer.name, displayName: viewer.name };
  const filter = UUID.test(wanted)
    ? { id: { eq: wanted } }
    : {
        or: [
          { name: { eqIgnoreCase: wanted } },
          { displayName: { eqIgnoreCase: wanted } },
          { email: { eqIgnoreCase: wanted } },
        ],
      };
  const { users } = await gql<{ users: { nodes: UserNode[] } }>(USERS_QUERY, { filter });
  const active = users.nodes.filter((user) => user.active);
  const [user] = active;
  if (!user)
    throw new Error(
      `No active user "${wanted}". Use a name, display name or email as Linear shows it.`,
    );
  if (active.length > 1) {
    throw new Error(
      `"${wanted}" matches ${String(active.length)} users: ${active.map((u) => `${nameOf(u)} <${u.email ?? u.id}>`).join(', ')}. Pass the email.`,
    );
  }
  return user;
}

async function findIssue(gql: Gql, ref: string) {
  const { issue } = await gql<{ issue: { id: string; identifier: string } | null }>(
    ISSUE_REF_QUERY,
    { id: ref.trim() },
  );
  if (!issue) throw new Error(`Issue ${ref} not found`);
  return issue;
}

function nameOf(person: { name: string; displayName?: string | undefined }) {
  return person.displayName || person.name;
}
