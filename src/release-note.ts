import type { Gql } from './graphql.js';
import type { Finding } from './sections.js';

/**
 * Whether a ticket belongs in the release notes, decided once by whoever writes the ticket, as a
 * pair of labels: one says a visitor to production will notice the change, the other says nothing
 * they see changes. A release note is then assembled from tickets already sorted, instead of a model
 * ranking every shipped ticket at release time, which weighs a minor fix and a launch the same
 * (Kubernetes' release-note / release-note-none gate is the model). It switches on by itself in a
 * workspace that has both labels.
 */
export type ReleaseNote = 'yes' | 'none';

export interface ReleaseNoteLabels {
  yes: string;
  none: string;
}

export interface ResolvedReleaseNoteLabels extends ReleaseNoteLabels {
  ids: Record<ReleaseNote, string>;
}

export const RELEASE_NOTE_RUBRIC =
  'yes: once this ships, and any flag gating it is on, a visitor to production can do something new, sees changed behaviour or copy they would notice, or stops hitting a bug they could have hit, or something they used is gone. none: nothing a visitor sees changes: CI, tests, specs, gates, hooks, agent tooling, ticket bookkeeping, refactors, monitoring, docs for the team, staff-only tools, or a fix for something that never reached production.';

/** The label names, from `LINEAR_STRICT_RELEASE_NOTE_LABELS` ("yes-label,none-label", or "off"). */
export function releaseNoteLabelsFromEnv(
  env: Record<string, string | undefined>,
): ReleaseNoteLabels | null {
  const raw = env['LINEAR_STRICT_RELEASE_NOTE_LABELS']?.trim();
  if (raw === 'off') return null;
  const [yes, none, ...rest] = (raw || 'release-note,release-note-none')
    .split(',')
    .map((name) => name.trim());
  if (!yes || !none || rest.length > 0 || yes.toLowerCase() === none.toLowerCase()) {
    throw new Error(
      'LINEAR_STRICT_RELEASE_NOTE_LABELS must name two different labels, "yes-label,none-label", or be "off"',
    );
  }
  return { yes, none };
}

export function releaseNoteArg(value: unknown): ReleaseNote | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'yes' || value === 'none') return value;
  throw new Error(`release_note must be "yes" or "none". ${RELEASE_NOTE_RUBRIC}`);
}

/** What a ticket's labels say, or null when they say nothing (or both, which is also nothing). */
export function releaseNoteOf(labels: string[], pair: ReleaseNoteLabels): ReleaseNote | null {
  const has = (name: string) => labels.some((label) => label.toLowerCase() === name.toLowerCase());
  const yes = has(pair.yes);
  const none = has(pair.none);
  return yes === none ? null : yes ? 'yes' : 'none';
}

/** The label names set_fields adds and removes for a release_note value. */
export function releaseNoteLabelChanges(
  value: ReleaseNote,
  pair: ReleaseNoteLabels,
): { add: string; remove: string } {
  return value === 'yes'
    ? { add: pair.yes, remove: pair.none }
    : { add: pair.none, remove: pair.yes };
}

/**
 * A ticket that will ship, or has, and carries neither label (or both). A canceled ticket ships
 * nothing, so it is never asked.
 */
export function releaseNoteFindings(
  state: { type: string } | null,
  labels: string[],
  pair: ReleaseNoteLabels | null,
): Finding[] {
  if (!pair || state?.type === 'canceled') return [];
  if (releaseNoteOf(labels, pair) !== null) return [];
  const both = labels.some((l) => l.toLowerCase() === pair.yes.toLowerCase());
  return [
    {
      code: 'release_note_unset',
      detail: `${both ? `Both "${pair.yes}" and "${pair.none}" are set` : `Neither "${pair.yes}" nor "${pair.none}" is set`}, so the release note cannot tell whether this ticket belongs in it. Set release_note with set_fields. ${RELEASE_NOTE_RUBRIC}`,
    },
  ];
}

const RELEASE_NOTE_LABELS_QUERY = `query StrictReleaseNoteLabels($teamId: ID!, $names: [String!]!) {
  issueLabels(first: 20, filter: { name: { in: $names }, or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }) {
    nodes { id name isGroup }
  }
}`;

/** Both labels' ids as the team sees them, or null when either is missing (the feature is off). */
export async function resolveReleaseNoteLabels(
  gql: Gql,
  teamId: string,
  pair: ReleaseNoteLabels,
): Promise<ResolvedReleaseNoteLabels | null> {
  const { issueLabels } = await gql<{
    issueLabels: { nodes: { id: string; name: string; isGroup: boolean }[] };
  }>(RELEASE_NOTE_LABELS_QUERY, { teamId, names: [pair.yes, pair.none] });
  const find = (name: string) =>
    issueLabels.nodes.find(
      (label) => !label.isGroup && label.name.toLowerCase() === name.toLowerCase(),
    );
  const yes = find(pair.yes);
  const none = find(pair.none);
  if (!yes || !none) return null;
  return { yes: yes.name, none: none.name, ids: { yes: yes.id, none: none.id } };
}
