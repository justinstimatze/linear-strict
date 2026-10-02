/**
 * The export half of the citation audit: what a team's tickets say, with
 * every saved version of each description, written once so the check can be
 * rerun offline as often as it changes.
 */
import { type Gql, type Omission, PAGE_SIZE, paginate } from './graphql.js';
import { type PmNode, renderMarkdown } from './prosemirror.js';
import { CONTENT_HISTORY_QUERY } from './queries.js';

export interface ExportedComment {
  id: string;
  createdAt: string;
  body: string;
}

/** One ticket as the check reads it. Versions are whole texts, oldest first. */
export interface ExportedIssue {
  identifier: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  description: string;
  versions: { at: string; text: string }[];
  comments: ExportedComment[];
  omitted: Omission[];
}

const TEAM_ISSUES_QUERY = `query StrictAuditTeamIssues($team: String!, $after: String) {
  issues(first: ${String(PAGE_SIZE)}, after: $after, filter: { team: { key: { eq: $team } } }) {
    nodes { id identifier updatedAt state { type } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const AUDIT_ISSUE_QUERY = `query StrictAuditIssue($id: String!) {
  issue(id: $id) { id identifier url createdAt updatedAt description documentContent { id } }
}`;

const AUDIT_COMMENTS_QUERY = `query StrictAuditComments($id: String!, $after: String) {
  issue(id: $id) { comments(first: ${String(PAGE_SIZE)}, after: $after) { nodes { id createdAt body } pageInfo { hasNextPage endCursor } } }
}`;

interface IssueRef {
  id: string;
  identifier: string;
  updatedAt: string;
  state: { type: string } | null;
}

const CLOSED = ['completed', 'canceled', 'duplicate'];

/** Every ticket on the team, with when each last changed. */
async function listTeamIssues(gql: Gql, team: string) {
  return paginate<IssueRef>(
    'issues',
    async (after) =>
      (
        await gql<{
          issues: { nodes: IssueRef[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
        }>(TEAM_ISSUES_QUERY, { team, after })
      ).issues,
    PAGE_SIZE,
    1000,
  );
}

async function exportIssue(gql: Gql, id: string): Promise<ExportedIssue> {
  const { issue } = await gql<{
    issue: {
      identifier: string;
      url: string;
      createdAt: string;
      updatedAt: string;
      description: string | null;
      documentContent: { id: string } | null;
    } | null;
  }>(AUDIT_ISSUE_QUERY, { id });
  if (!issue) throw new Error(`Issue ${id} not found`);
  const omitted: Omission[] = [];

  const comments = await paginate<ExportedComment>('comments', async (after) => {
    const data = await gql<{
      issue: {
        comments: {
          nodes: ExportedComment[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      };
    }>(AUDIT_COMMENTS_QUERY, { id, after });
    return data.issue.comments;
  });
  omitted.push(...comments.omitted);

  const versions: { at: string; text: string }[] = [];
  if (issue.documentContent) {
    try {
      const history = await gql<{
        documentContentHistory: {
          history: { contentDataSnapshotAt: string; contentData: PmNode }[];
        };
      }>(CONTENT_HISTORY_QUERY, { id: issue.documentContent.id });
      const snapshots = [...history.documentContentHistory.history].sort((a, b) =>
        a.contentDataSnapshotAt.localeCompare(b.contentDataSnapshotAt),
      );
      for (const snapshot of snapshots) {
        const text = renderMarkdown(snapshot.contentData).markdown;
        if (text !== versions.at(-1)?.text)
          versions.push({ at: snapshot.contentDataSnapshotAt, text });
      }
    } catch (error) {
      omitted.push({
        field: 'versions',
        reason: `not fetched: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } else {
    omitted.push({ field: 'versions', reason: 'Linear keeps no document history for this ticket' });
  }

  return {
    identifier: issue.identifier,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    description: issue.description ?? '',
    versions,
    comments: [...comments.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    omitted,
  };
}

export interface ExportRun {
  /** Tickets to fetch at most in this run. */
  maxFetch: number;
  /** Waited before each fetch, so a long export leaves the key's hourly quota to its other users. */
  paceMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called with the export so far, every `checkpointEvery` fetched tickets. */
  checkpoint?: (issues: ExportedIssue[]) => void;
  checkpointEvery?: number;
  progress?: (done: number, total: number) => void;
}

/**
 * Exports a team's tickets, open ones first, reusing a previous export's
 * record for any ticket not updated since, so a rerun fetches only what
 * changed. It stops after `maxFetch` fetched tickets, or at the first
 * failure, and keeps the previous record (if any) for every ticket it
 * didn't reach, so a rerun carries on from there.
 */
export async function exportTeam(
  gql: Gql,
  team: string,
  previous: Map<string, ExportedIssue>,
  run: ExportRun,
): Promise<{
  issues: ExportedIssue[];
  fetched: number;
  pending: number;
  stopped: string | null;
  omitted: Omission[];
}> {
  const sleep =
    run.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const listed = await listTeamIssues(gql, team);
  const open = (ref: IssueRef) => !CLOSED.includes(ref.state?.type ?? '');
  const refs = [...listed.nodes].sort(
    (a, b) => Number(open(b)) - Number(open(a)) || b.updatedAt.localeCompare(a.updatedAt),
  );
  const issues: ExportedIssue[] = [];
  // The export so far plus the previous record of every ticket not reached yet.
  const sofar = (index: number) => [
    ...issues,
    ...refs.slice(index + 1).flatMap((ref) => previous.get(ref.identifier) ?? []),
  ];
  let fetched = 0;
  let pending = 0;
  let stopped: string | null = null;
  for (const [index, ref] of refs.entries()) {
    const kept = previous.get(ref.identifier);
    if (kept?.updatedAt === ref.updatedAt) {
      issues.push(kept);
    } else if (stopped === null && fetched < run.maxFetch) {
      try {
        if (run.paceMs > 0) await sleep(run.paceMs);
        issues.push(await exportIssue(gql, ref.id));
        fetched += 1;
        if (run.checkpoint && fetched % (run.checkpointEvery ?? 25) === 0)
          run.checkpoint(sofar(index));
      } catch (error) {
        stopped = `${ref.identifier}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (issues.at(-1)?.identifier !== ref.identifier) {
      pending += 1;
      if (kept) issues.push(kept);
    }
    run.progress?.(index + 1, refs.length);
  }
  return { issues, fetched, pending, stopped, omitted: listed.omitted };
}
