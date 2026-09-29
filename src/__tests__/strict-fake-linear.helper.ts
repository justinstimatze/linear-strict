import type { Gql } from '../graphql.js';
import type { PmNode } from '../prosemirror.js';
import { MARKER_URLS } from '../marker.js';

/**
 * An in-memory stand-in for the slice of Linear's GraphQL API the strict
 * tools use. Requests are dispatched on the operation name in the query.
 * Connections page newest-first, like Linear's, so tests prove the strict
 * layer sorts rather than trusting the API's order.
 */
export interface FakeComment {
  id: string;
  body: string;
  createdAt: string;
  userName: string;
  editedAt?: string;
}

export interface FakeState {
  viewer: { id: string; name: string; displayName: string; app: boolean };
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string;
    updatedAt: string;
    assignee: { id: string; name: string; displayName: string; app?: boolean } | null;
    delegate: { id: string; name: string; displayName: string; app?: boolean } | null;
    stateId: string;
    project?: { id: string; name: string } | null;
    labels?: string[];
    archivedAt?: string | null;
    trashed?: boolean;
  };
  comments: FakeComment[];
  descriptionEdits: { createdAt: string; actorName: string }[];
  states: { id: string; name: string; type: string }[];
  attachments: {
    title: string;
    url: string;
    sourceType: string;
    metadata: Record<string, unknown>;
    subtitle?: string | null;
  }[];
  /** What Linear's GitHub integration knows about a PR, by URL; attachmentLinkGitHubPR copies it into the attachment. */
  github?: Record<string, Record<string, unknown>>;
  /** When set, attachmentCreate for the reconciled marker fails. */
  failMarkerUpsert?: boolean;
  relations: { issueId: string; relatedIssueId: string; type: string }[];
  /** Other issues addressable by identifier, e.g. a closed_by target. With a title, get_issue can read one. */
  others: { id: string; identifier: string; title?: string; description?: string }[];
  /** Page numbers (1-based) of the comments connection that should fail. */
  failCommentPages: Set<number>;
  calls: { operation: string; variables: Record<string, unknown> }[];
  /** Workspace people, labels, cycles, projects and milestones that set_fields resolves names against. */
  users: {
    id: string;
    name: string;
    displayName: string;
    email: string;
    app?: boolean;
    active: boolean;
  }[];
  labels: { id: string; name: string; isGroup: boolean }[];
  cycles: { id: string; number: number; name: string | null; isActive: boolean; isNext: boolean }[];
  projects: { id: string; name: string }[];
  milestones: { id: string; name: string; projectId: string }[];
  /** Every issueUpdate input, in order. */
  updates: Record<string, unknown>[];
  /** Comments posted to an issue other than the main one. */
  otherComments: { issueId: string; body: string }[];
  /** Description snapshots, oldest first; the fake serves them newest first. null: the ticket has no document. */
  snapshots: { at: string; actorIds: string[]; doc: PmNode }[] | null;
  /** Seconds past the fake epoch; each write advances it, per state so runs are repeatable. */
  clock: number;
}

export function fakeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    viewer: { id: 'u-agent', name: 'agent-a', displayName: 'agent-a', app: true },
    issue: {
      id: 'issue-1',
      identifier: 'ENG-1',
      title: 'A ticket',
      description:
        '## Observed\n\n- 2026-09-01 · `curl /health` · 200\n\n## Done when\n\n- [x] `npm test` passes · `npm test` → 142 passed',
      updatedAt: '2026-09-01T00:00:00.000Z',
      assignee: null,
      delegate: null,
      stateId: 's-todo',
    },
    comments: [],
    descriptionEdits: [],
    states: [
      { id: 's-todo', name: 'Todo', type: 'unstarted' },
      { id: 's-progress', name: 'In Progress', type: 'started' },
      { id: 's-done', name: 'Done', type: 'completed' },
      { id: 's-canceled', name: 'Canceled', type: 'canceled' },
    ],
    attachments: [],
    relations: [],
    others: [{ id: 'issue-2', identifier: 'ENG-2' }],
    failCommentPages: new Set(),
    calls: [],
    otherComments: [],
    users: [
      { id: 'u-ada', name: 'Ada', displayName: 'Ada', email: 'ada@example.com', active: true },
      {
        id: 'u-grace',
        name: 'Grace',
        displayName: 'Grace',
        email: 'grace@example.com',
        active: true,
      },
      {
        id: 'u-agent-b',
        name: 'agent-b',
        displayName: 'agent-b',
        email: 'agent-b@example.com',
        app: true,
        active: true,
      },
    ],
    labels: [
      { id: 'l-bug', name: 'Bug', isGroup: false },
      { id: 'l-triage', name: 'needs-triage', isGroup: false },
      { id: 'l-area', name: 'Area', isGroup: true },
    ],
    cycles: [
      { id: 'cy-7', number: 7, name: null, isActive: true, isNext: false },
      { id: 'cy-8', number: 8, name: null, isActive: false, isNext: true },
    ],
    projects: [{ id: 'p-alpha', name: 'Alpha launch' }],
    milestones: [{ id: 'm-beta', name: 'Beta', projectId: 'p-alpha' }],
    updates: [],
    snapshots: [],
    clock: 0,
    ...overrides,
  };
}

function tick(state: FakeState) {
  state.clock += 1;
  return new Date(Date.UTC(2026, 8, 24, 0, 0, state.clock)).toISOString();
}

function page<N>(all: N[], variables: Record<string, unknown>, size = 100) {
  const newestFirst = [...all].reverse();
  const after = typeof variables['after'] === 'string' ? Number(variables['after']) : 0;
  const nodes = newestFirst.slice(after, after + size);
  const end = after + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < newestFirst.length, endCursor: String(end) } };
}

function issueNode(state: FakeState) {
  const { issue } = state;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: `https://linear.app/x/issue/${issue.identifier}`,
    priority: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: issue.updatedAt,
    archivedAt: issue.archivedAt ?? null,
    trashed: issue.trashed ?? false,
    state: state.states.find((s) => s.id === issue.stateId) ?? null,
    team: { id: 't-1', key: 'ENG', name: 'Engineering' },
    assignee: issue.assignee,
    delegate: issue.delegate,
    creator: null,
    parent: null,
    project: issue.project ?? null,
    labels: {
      nodes: (issue.labels ?? []).map((name) => ({ id: `l-${name}`, name })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    markerAttachment: {
      nodes: state.attachments.flatMap((a, i) =>
        MARKER_URLS.includes(a.url)
          ? [{ id: `a-${String(i)}`, url: a.url, metadata: a.metadata }]
          : [],
      ),
    },
  };
}

function nameMatches(wanted: unknown, ...candidates: string[]) {
  return (
    typeof wanted === 'string' &&
    candidates.some((candidate) => candidate.toLowerCase() === wanted.toLowerCase())
  );
}

type Filter = Record<string, Record<string, unknown> | undefined>;

export function fakeGql(state: FakeState): Gql {
  const handler = (query: string, variables: Record<string, unknown> = {}): unknown => {
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'anonymous';
    state.calls.push({ operation, variables });
    const { issue } = state;

    if (operation.startsWith('StrictIssue_') && variables['id'] !== issue.id) {
      const field = operation.slice('StrictIssue_'.length);
      return {
        issue: { [field]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      };
    }

    switch (operation) {
      case 'StrictViewer':
        return { viewer: state.viewer };
      case 'StrictIssue': {
        const wanted = variables['id'];
        const other = state.others.find(
          (candidate) => candidate.id === wanted || candidate.identifier === wanted,
        );
        if (other?.title !== undefined) {
          return {
            issue: {
              ...issueNode(state),
              id: other.id,
              identifier: other.identifier,
              title: other.title,
              description: other.description ?? '',
              url: `https://linear.app/x/issue/${other.identifier}`,
              state: state.states[0] ?? null,
              assignee: null,
              delegate: null,
            },
          };
        }
        if (wanted !== issue.id && wanted !== issue.identifier) return { issue: null };
        return { issue: issueNode(state) };
      }
      case 'StrictIssue_comments': {
        const pageNumber =
          (typeof variables['after'] === 'string' ? Number(variables['after']) / 100 : 0) + 1;
        if (state.failCommentPages.has(pageNumber))
          throw new Error(`simulated failure on page ${pageNumber}`);
        const nodes = state.comments.map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: c.createdAt,
          updatedAt: c.createdAt,
          editedAt: c.editedAt ?? null,
          url: `https://linear.app/x/issue/${issue.identifier}#comment-${c.id}`,
          parent: null,
          user: {
            id: `u-${c.userName}`,
            name: c.userName,
            displayName: c.userName,
            app: c.userName === state.viewer.name && state.viewer.app,
          },
          botActor: null,
          externalUser: null,
        }));
        return { issue: { comments: page(nodes, variables) } };
      }
      case 'StrictIssue_history':
        return {
          issue: {
            history: page(
              state.descriptionEdits.map((e, i) => ({
                id: `h-${i}`,
                createdAt: e.createdAt,
                updatedDescription: true,
                actor: { id: 'x', name: e.actorName, displayName: e.actorName },
                botActor: null,
              })),
              variables,
            ),
          },
        };
      case 'StrictIssue_attachments':
        return {
          issue: {
            attachments: page(
              state.attachments.map((a, i) => ({
                id: `a-${i}`,
                subtitle: null,
                createdAt: '2026-09-01T00:00:00.000Z',
                ...a,
              })),
              variables,
            ),
          },
        };
      case 'StrictDescriptionDoc':
        if (variables['id'] !== issue.id && variables['id'] !== issue.identifier)
          return { issue: null };
        return {
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            description: issue.description,
            documentContent: state.snapshots ? { id: `doc-${issue.id}` } : null,
          },
        };
      case 'StrictContentHistory':
        return {
          documentContentHistory: {
            success: true,
            history: [...(state.snapshots ?? [])].reverse().map((snapshot) => ({
              contentDataSnapshotAt: snapshot.at,
              actorIds: snapshot.actorIds,
              contentData: snapshot.doc,
            })),
          },
        };
      case 'StrictUsersById': {
        const ids = variables['ids'] as string[];
        return {
          users: {
            nodes: state.users
              .filter((user) => ids.includes(user.id))
              .map(({ id, name, displayName }) => ({ id, name, displayName })),
          },
        };
      }
      case 'StrictIssueRef':
      case 'StrictIssueId': {
        const wanted = variables['id'];
        const found = [{ id: issue.id, identifier: issue.identifier }, ...state.others].find(
          (candidate) => candidate.id === wanted || candidate.identifier === wanted,
        );
        return { issue: found ?? null };
      }
      case 'StrictUsers': {
        const filter = variables['filter'] as { id?: { eq: string }; or?: Filter[] };
        const nodes = state.users.filter((user) =>
          filter.id
            ? user.id === filter.id.eq
            : (filter.or ?? []).some((clause) =>
                Object.entries(clause).some(([field, comparator]) =>
                  nameMatches(
                    comparator?.['eqIgnoreCase'],
                    user[field as 'name' | 'displayName' | 'email'],
                  ),
                ),
              ),
        );
        return {
          users: {
            nodes: nodes.map(({ id, name, displayName, email, active }) => ({
              id,
              name,
              displayName,
              email,
              active,
              url: `https://linear.app/x/profiles/${name.toLowerCase()}`,
            })),
          },
        };
      }
      case 'StrictTeamLabels':
        return { issueLabels: page(state.labels, variables) };
      case 'StrictTeamCycles': {
        const filter = variables['filter'] as Filter;
        const nodes = state.cycles.filter(
          (cycle) =>
            (filter['isActive'] === undefined || cycle.isActive) &&
            (filter['isNext'] === undefined || cycle.isNext) &&
            (filter['number'] === undefined || cycle.number === filter['number']['eq']),
        );
        return { cycles: { nodes: nodes.map(({ id, number, name }) => ({ id, number, name })) } };
      }
      case 'StrictProjectsByName': {
        const filter = variables['filter'] as Filter;
        const nodes = state.projects.filter((project) =>
          filter['id']
            ? project.id === filter['id']['eq']
            : nameMatches(filter['name']?.['eqIgnoreCase'], project.name),
        );
        return { projects: { nodes } };
      }
      case 'StrictMilestones':
        return {
          projectMilestones: {
            nodes: state.milestones
              .filter(
                (milestone) =>
                  milestone.projectId === variables['projectId'] &&
                  nameMatches(variables['name'], milestone.name),
              )
              .map(({ id, name }) => ({ id, name })),
          },
        };
      case 'StrictMarkerUpsert': {
        if (state.failMarkerUpsert) throw new Error('simulated attachmentCreate failure');
        const input = variables['input'] as {
          issueId: string;
          url: string;
          title: string;
          subtitle: string;
          metadata: Record<string, unknown>;
        };
        if (input.issueId !== issue.id)
          throw new Error(`fake Linear has no issue ${input.issueId}`);
        // Linear upserts on (url, issue) and replaces the metadata whole.
        const existing = state.attachments.find((a) => a.url === input.url);
        const next = {
          title: input.title,
          subtitle: input.subtitle,
          url: input.url,
          sourceType: 'api',
          metadata: input.metadata,
        };
        if (existing) Object.assign(existing, next);
        else state.attachments.push(next);
        return {
          attachmentCreate: {
            success: true,
            attachment: { id: `a-${state.attachments.indexOf(existing ?? next)}` },
          },
        };
      }
      case 'StrictMarkerDelete': {
        const index = Number(String(variables['id']).slice('a-'.length));
        state.attachments.splice(index, 1);
        return { attachmentDelete: { success: true } };
      }
      case 'StrictPrLink': {
        if (variables['issueId'] !== issue.id)
          throw new Error(`fake Linear has no issue ${String(variables['issueId'])}`);
        const url = String(variables['url']);
        const known = state.github?.[url];
        if (!known) throw new Error(`fake GitHub has no pull request ${url}`);
        const metadata = { ...known, linkKind: 'contributes' };
        state.attachments.push({
          title: `PR ${String(known['number'])}`,
          url,
          sourceType: 'github',
          metadata,
        });
        return { attachmentLinkGitHubPR: { success: true, attachment: { url, metadata } } };
      }
      case 'StrictRelationCreate':
        state.relations.push(variables['input'] as FakeState['relations'][number]);
        return { issueRelationCreate: { success: true } };
      case 'StrictIssue_relations':
      case 'StrictIssue_inverseRelations':
      case 'StrictIssue_children': {
        const field = operation.slice('StrictIssue_'.length);
        return {
          issue: { [field]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        };
      }
      case 'StrictIssueUpdate': {
        const input = variables['input'] as Record<string, unknown>;
        if (variables['id'] !== issue.id) {
          // A write to another issue lands on that issue, never on the main one.
          const other = state.others.find((candidate) => candidate.id === variables['id']);
          if (!other) throw new Error(`fake Linear has no issue ${String(variables['id'])}`);
          if (typeof input['description'] === 'string') other.description = input['description'];
          return {
            issueUpdate: {
              success: true,
              issue: {
                id: other.id,
                identifier: other.identifier,
                updatedAt: tick(state),
                description: other.description ?? '',
              },
            },
          };
        }
        if (typeof input['description'] === 'string') {
          issue.description = input['description'];
          state.descriptionEdits.push({ createdAt: tick(state), actorName: state.viewer.name });
        }
        state.updates.push(input);
        const person = (userId: unknown) => {
          if (userId === null) return null;
          if (userId === state.viewer.id) return { ...state.viewer };
          const user = state.users.find((candidate) => candidate.id === userId);
          if (!user) throw new Error(`fake Linear has no user ${JSON.stringify(userId)}`);
          return {
            id: user.id,
            name: user.name,
            displayName: user.displayName,
            ...(user.app ? { app: true } : {}),
          };
        };
        if ('assigneeId' in input) issue.assignee = person(input['assigneeId']);
        if ('delegateId' in input) issue.delegate = person(input['delegateId']);
        if ('projectId' in input)
          issue.project =
            state.projects.find((project) => project.id === input['projectId']) ?? null;
        if (typeof input['title'] === 'string') issue.title = input['title'];
        if (typeof input['stateId'] === 'string') issue.stateId = input['stateId'];
        issue.updatedAt = tick(state);
        return {
          issueUpdate: {
            success: true,
            issue: {
              id: issue.id,
              identifier: issue.identifier,
              updatedAt: issue.updatedAt,
              description: issue.description,
            },
          },
        };
      }
      case 'StrictCommentCreate': {
        const input = variables['input'] as { body: string; issueId: string };
        if (input.issueId !== issue.id) {
          state.otherComments.push({ issueId: input.issueId, body: input.body });
          const id = `o-${String(state.otherComments.length)}`;
          return {
            commentCreate: {
              success: true,
              comment: { id, url: `https://linear.app/x/comment/${id}`, createdAt: tick(state) },
            },
          };
        }
        const comment = {
          id: `c-${state.comments.length + 1}`,
          body: input.body,
          createdAt: tick(state),
          userName: state.viewer.name,
        };
        state.comments.push(comment);
        return {
          commentCreate: {
            success: true,
            comment: {
              id: comment.id,
              url: `https://linear.app/x/issue/${issue.identifier}#comment-${comment.id}`,
              createdAt: comment.createdAt,
            },
          },
        };
      }
      case 'StrictTeamStates':
        return { issue: { team: { states: { nodes: state.states } } } };
      default:
        throw new Error(`fake Linear has no handler for ${operation}`);
    }
  };

  return <T>(query: string, variables?: Record<string, unknown>) =>
    Promise.resolve().then(() => handler(query, variables) as T);
}

/** Simulates someone editing the description from another client. */
export function editOutOfBand(state: FakeState, description: string) {
  state.issue.description = description;
  state.issue.updatedAt = tick(state);
  state.descriptionEdits.push({ createdAt: state.issue.updatedAt, actorName: 'someone-else' });
}

/** Simulates a label change: updatedAt moves, the description does not. */
export function touchWithoutContentChange(state: FakeState) {
  state.issue.updatedAt = tick(state);
}

export function addComments(state: FakeState, count: number, from = 'human') {
  for (let i = 0; i < count; i++) {
    state.comments.push({
      id: `seed-${state.comments.length + 1}`,
      body: `comment ${i + 1}`,
      createdAt: tick(state),
      userName: from,
    });
  }
}
