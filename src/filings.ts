/**
 * What create_issue hands back about the filer's own pile: the tickets this
 * identity filed on the team that are still waiting (Triage, Todo or Backlog)
 * with no agent delegated to them. Filing a ticket doesn't get the work done,
 * so the filer sees what it filed and nobody took up each time it adds one.
 */
import { type Gql, type Omission, paginate } from './graphql.js';
import { PAGE_INFO } from './queries.js';

/** Waiting states: filed and not started. */
const WAITING = ['triage', 'unstarted', 'backlog'];

/** At most this many tickets are fetched, oldest first. */
const UNCLAIMED_CAP = 200;
/** At most this many are listed in the result, oldest first. */
const UNCLAIMED_SHOWN = 10;

export const UNCLAIMED_QUERY = `query StrictUnclaimedFilings($team: String!, $after: String) {
  issues(first: 100, after: $after, orderBy: createdAt, filter: {
    team: { key: { eqIgnoreCase: $team } }
    creator: { isMe: { eq: true } }
    delegate: { null: true }
    state: { type: { in: ${JSON.stringify(WAITING)} } }
  }) { nodes { identifier title createdAt updatedAt state { name } } ${PAGE_INFO} }
}`;

interface UnclaimedNode {
  identifier: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: { name: string } | null;
}

export interface UnclaimedFilings {
  /** How many of your filings are waiting with no agent delegated, counted to the cap. */
  total: number;
  older_than_7_days: number;
  columns: readonly string[];
  /** The oldest ones, oldest first. */
  oldest: [string, string, string | null, number][];
  note: string;
  omitted?: Omission[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function unclaimedFilings(
  gql: Gql,
  team: string,
  now: Date,
): Promise<UnclaimedFilings> {
  const { nodes, omitted } = await paginate<UnclaimedNode>(
    'issues',
    async (after) =>
      (
        await gql<{
          issues: {
            nodes: UnclaimedNode[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        }>(UNCLAIMED_QUERY, { team, after })
      ).issues,
    100,
    UNCLAIMED_CAP / 100,
    `stopped at ${String(UNCLAIMED_CAP)}; there are more`,
  );
  const age = (node: UnclaimedNode) =>
    Math.floor((now.getTime() - Date.parse(node.createdAt)) / DAY_MS);
  const oldest = [...nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const total = nodes.length;
  return {
    total,
    older_than_7_days: nodes.filter((node) => age(node) > 7).length,
    columns: ['identifier', 'title', 'state', 'age_days'],
    oldest: oldest
      .slice(0, UNCLAIMED_SHOWN)
      .map((node) => [node.identifier, node.title, node.state?.name ?? null, age(node)]),
    note:
      total === 0
        ? 'Nothing you filed on this team is waiting unclaimed.'
        : `You filed these and no agent has taken them up. A ticket is not the work: for each, get it into someone's queue (delegate it with set_fields, or ask your user who should take it), fold it into the ticket that covers it, or cancel it with a reason.`,
    ...(omitted.length > 0 ? { omitted } : {}),
  };
}
