/**
 * The reconciled marker's rules: where a ticket's marker is, which comments
 * a move past them covers, and how each of those comments is accounted for.
 */
import { commentAuthorKind } from './facts.js';
import { MARKER_URL, type StoredMarker, markerFromAttachment } from './marker.js';
import { commentKind, readMarker } from './sections.js';
import { type IssueCore } from './issue-core.js';

/**
 * Typed comments whose effect on the description landed in the same call
 * that posted them, so they never need reconciling afterwards. evidence is
 * not here: its patch is optional.
 */
// descope is written by set_state itself, never through the comment tool.
const SELF_APPLIED: readonly string[] = ['correction', 'answer', 'closed_by', 'ask', 'descope'];

/** How set_state accounts for one comment the reconciled marker moves past. */
export interface Accounting {
  /** A comment id, or "*" for every comment in range not named otherwise. */
  comment: string;
  how: 'folded' | 'no_state_change';
  reason?: string | undefined;
}

/** Where a ticket's reconciled marker was found. */
export interface FoundMarker {
  marker: StoredMarker;
  in: 'attachment' | 'description';
}

export function findMarker(issue: IssueCore): FoundMarker | null {
  const nodes = issue.markerAttachment?.nodes ?? [];
  const attached = markerFromAttachment(nodes.find((node) => node.url === MARKER_URL) ?? nodes[0]);
  if (attached) return { marker: attached, in: 'attachment' };
  // Written before the marker moved to an attachment; the next description write moves it.
  const legacy = readMarker(issue.description ?? '');
  return legacy ? { marker: legacy, in: 'description' } : null;
}

/**
 * Index of the first comment the previous marker does not cover: the one after
 * its comment, or, when that comment is gone, the first one written after it.
 * -1 when every comment is older than the marker.
 */
export function firstUncovered(ordered: MarkerNode[], previous: StoredMarker) {
  const at = ordered.findIndex((comment) => comment.id === previous.through);
  if (at >= 0) return at + 1;
  return ordered.findIndex((comment) => comment.createdAt > previous.at);
}

export interface MarkerNode {
  id: string;
  createdAt: string;
  editedAt?: string | null;
  body: string;
  user: { name: string; displayName?: string; app?: boolean | null } | null;
  botActor: { name: string | null } | null;
  externalUser: { name: string } | null;
}

export function isSelfApplied(body: string): boolean {
  const kind = commentKind(body);
  return kind !== null && SELF_APPLIED.includes(kind);
}

/** Comments edited after a time. With no time on record, nothing can be dated, so none are returned. */
export function editedSince<C extends { editedAt?: string | null }>(
  comments: C[],
  since: string | null | undefined,
): C[] {
  if (!since) return [];
  return comments.filter(
    (comment) => typeof comment.editedAt === 'string' && comment.editedAt > since,
  );
}

/**
 * Every comment the reconciled marker moves past has to close one named way:
 * a typed comment that already changed the description, a comment folded
 * into a patch in this same call, or one the caller says changes nothing,
 * with a reason. Moving the marker is otherwise a way to skip a correction.
 */
export function checkAccounting(
  range: MarkerNode[],
  accountsFor: Accounting[],
  hasPatches: boolean,
) {
  const inRange = new Set(range.map((comment) => comment.id));
  const named = new Map<string, Accounting>();
  let wildcard: Accounting | null = null;
  const problems: string[] = [];

  for (const entry of accountsFor) {
    if (entry.how === 'no_state_change' && !entry.reason?.trim()) {
      problems.push(`${entry.comment}: no_state_change needs a reason`);
    }
    if (entry.comment === '*') wildcard = entry;
    else if (!inRange.has(entry.comment))
      problems.push(`${entry.comment} is not between the previous marker and reconciled_through`);
    else named.set(entry.comment, entry);
  }

  const selfApplied: string[] = [];
  const folded: string[] = [];
  const quiet: { comment: string; author: string | null; author_kind: string; reason: string }[] =
    [];
  const missing: string[] = [];
  for (const comment of range) {
    if (isSelfApplied(comment.body)) {
      selfApplied.push(comment.id);
      continue;
    }
    const entry = named.get(comment.id) ?? wildcard;
    if (!entry) {
      missing.push(comment.id);
      continue;
    }
    if (entry.how === 'folded') {
      folded.push(comment.id);
    } else {
      const author = commentAuthorKind(comment);
      quiet.push({
        comment: comment.id,
        author: comment.user
          ? comment.user.displayName || comment.user.name
          : (comment.botActor?.name ?? comment.externalUser?.name ?? null),
        author_kind: author.kind,
        reason: entry.reason ?? '',
      });
    }
  }

  if (folded.length > 0 && !hasPatches) {
    problems.push(
      `${String(folded.length)} comment(s) marked folded, but this call carries no patch to fold them into`,
    );
  }
  if (missing.length > 0) {
    problems.push(
      `not accounted for: ${missing.join(', ')}. Add each to accounts_for as {comment, how: "folded"} (with the patch in this call) or {comment, how: "no_state_change", reason}; {comment: "*", ...} covers the rest.`,
    );
  }
  if (problems.length > 0)
    throw new Error(`reconciled_through would skip comments:\n- ${problems.join('\n- ')}`);

  const people = quiet.filter((entry) => entry.author_kind === 'person');
  return {
    self_applied: selfApplied.length,
    folded: folded.length,
    no_state_change: quiet,
    ...(people.length > 0
      ? {
          review:
            "Comments by people were marked as changing nothing. A person's comment is often the only first-hand record on a ticket; check these were not decisions or corrections.",
        }
      : {}),
  };
}
