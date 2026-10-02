/**
 * The searches create_issue falls back on when no model reads the open
 * titles (overlap-model.ts): which open tickets on the team already cover
 * the same ground. Two of Linear's searches find them, filtered to the
 * team's open tickets: semanticSearch (vector search with reranking) on the
 * title and description, and searchIssues on the title, which catches the
 * shared nouns (a vendor, a file) vector search ranks low. On 88 pairs of
 * tickets agents had linked as related, each found the earlier ticket about
 * a third of the time, and the two together 40%. Neither returns a score, so
 * there is no threshold to tune here: the filer is shown the closest few and
 * has to decide, per ticket, whether the new work belongs under it, widens
 * it, or is separate.
 */
import type { Gql } from './graphql.js';

/** How many of the closest open tickets by meaning a filer has to account for. */
export const OVERLAP_SHOWN = 5;
/** And how many more by keyword, past those. */
export const KEYWORD_EXTRA = 3;
/** Longest new_because, so the reason reads as one plain sentence. */
export const NEW_BECAUSE_MAX = 300;
/** The query is the title plus the start of the description: Linear refuses a semanticSearch query over 1,024 characters. */
const QUERY_CHARS = 1000;

const CLOSED = ['completed', 'canceled', 'duplicate'];

export const OVERLAP_QUERY = `query StrictOverlap($query: String!, $team: String!, $max: Int!) {
  semanticSearch(query: $query, types: [issue], maxResults: $max, filters: {
    issues: { team: { key: { eqIgnoreCase: $team } }, state: { type: { nin: ${JSON.stringify(CLOSED)} } } }
  }) { results { issue { identifier title url state { name } } } }
}`;

export const OVERLAP_KEYWORD_QUERY = `query StrictOverlapKeyword($term: String!, $team: String!, $first: Int!) {
  searchIssues(term: $term, first: $first, filter: {
    team: { key: { eqIgnoreCase: $team } }, state: { type: { nin: ${JSON.stringify(CLOSED)} } }
  }) { nodes { identifier title url state { name } } }
}`;

export interface Candidate {
  identifier: string;
  title: string;
  state: string | null;
  url: string;
}

interface FoundIssue {
  identifier: string;
  title: string;
  url: string;
  state: { name: string } | null;
}

const candidate = (issue: FoundIssue): Candidate => ({
  identifier: issue.identifier,
  title: issue.title,
  state: issue.state?.name ?? null,
  url: issue.url,
});

/**
 * The open tickets on the team closest to the new one: the closest by
 * meaning, most relevant first, then any more by keyword. One search
 * failing leaves the other's; both failing throws.
 */
export async function overlapCandidates(
  gql: Gql,
  team: string,
  title: string,
  description: string | undefined,
): Promise<Candidate[]> {
  const query = `${title}\n\n${description ?? ''}`.slice(0, QUERY_CHARS);
  const [semantic, keyword] = await Promise.allSettled([
    gql<{ semanticSearch: { results: { issue: FoundIssue | null }[] } }>(OVERLAP_QUERY, {
      query,
      team,
      max: OVERLAP_SHOWN,
    }),
    gql<{ searchIssues: { nodes: FoundIssue[] } }>(OVERLAP_KEYWORD_QUERY, {
      term: title,
      team,
      first: OVERLAP_SHOWN + KEYWORD_EXTRA,
    }),
  ]);
  if (semantic.status === 'rejected' && keyword.status === 'rejected') throw semantic.reason;
  const found: Candidate[] =
    semantic.status === 'fulfilled'
      ? semantic.value.semanticSearch.results.flatMap(({ issue }) =>
          issue ? [candidate(issue)] : [],
        )
      : [];
  if (keyword.status === 'fulfilled') {
    const extra = keyword.value.searchIssues.nodes
      .filter((issue) => !found.some((c) => c.identifier === issue.identifier))
      .slice(0, KEYWORD_EXTRA);
    found.push(...extra.map(candidate));
  }
  return found;
}

function listed(candidates: Candidate[]) {
  return candidates
    .map((c) => `- ${c.identifier} [${c.state ?? 'no state'}] ${c.title}`)
    .join('\n');
}

/**
 * The refusal create_issue throws, carrying the close tickets as data so a
 * program filing tickets (with its own judge) can decide without parsing
 * the message. `missing` is what distinct_from left out.
 */
export class OverlapRefusal extends Error {
  readonly candidates: Candidate[];
  readonly missing: Candidate[];
  constructor(message: string, candidates: Candidate[], missing: Candidate[]) {
    super(message);
    this.name = 'OverlapRefusal';
    this.candidates = candidates;
    this.missing = missing;
  }
}

/**
 * Refuses a new ticket that hasn't accounted for every close open ticket:
 * each has to be named in distinct_from, with one new_because covering why
 * the work is none of theirs. Returns nothing when the filing may go ahead.
 */
export function overlapRefusal(
  candidates: Candidate[],
  newBecause: string | undefined,
  distinctFrom: string[],
): OverlapRefusal | null {
  if (candidates.length === 0) return null;
  const named = new Set(distinctFrom.map((id) => id.trim().toUpperCase()));
  const missing = candidates.filter((c) => !named.has(c.identifier.toUpperCase()));
  const options = `For each, decide which it is:
- The new work is part of it: file under it, with parent set to it.
- The new work widens it: file nothing. Widen that ticket instead (set_state adding to its Done when, or a comment), so one ticket carries the whole change.
- It is separate from every one of them: retry with new_because (one sentence, at most ${String(NEW_BECAUSE_MAX)} characters, on why this can't be part of any of them) and distinct_from listing each identifier above. The reason is posted on the new ticket.`;
  if (newBecause === undefined) {
    return new OverlapRefusal(
      `Nothing was filed: these open tickets on the team are the closest to this one, and a new ticket has to show it isn't one of them.\n${listed(candidates)}\n\n${options}`,
      candidates,
      missing,
    );
  }
  if (missing.length > 0) {
    return new OverlapRefusal(
      `Nothing was filed: new_because has to account for every close open ticket, and distinct_from leaves out:\n${listed(missing)}\n\nThe closest tickets can change between calls. ${options}`,
      candidates,
      missing,
    );
  }
  return null;
}

export function newBecauseArg(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const reason = value.trim().replace(/\s+/g, ' ');
  if (reason.length > NEW_BECAUSE_MAX)
    throw new Error(
      `Nothing was filed: new_because is ${String(reason.length)} characters; keep it to one sentence of at most ${String(NEW_BECAUSE_MAX)}.`,
    );
  return reason;
}
