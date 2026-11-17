import type { Gql } from './graphql.js';
import type { Finding } from './sections.js';

/**
 * Whether a ticket belongs in the release notes, decided once by whoever writes the ticket, as a
 * group of labels: one says a visitor to production will notice the change, one says only people
 * running their own copy will (self-host), and one says nothing anyone sees changes. A release note is
 * then assembled from tickets already sorted, instead of a model ranking every shipped ticket at
 * release time, which weighs a minor fix and a launch the same (Kubernetes' release-note /
 * release-note-none gate is the model). It switches on by itself in a workspace that has the yes and
 * none labels; the self-host label is optional.
 *
 * What the note says about a ticket is the ticket's own `## Release note` line, written by whoever
 * ships it: `<Kind> · <Area> · <sentence> · flag: <key|none>`, or `NONE`.
 */
export type ReleaseNote = 'yes' | 'none' | 'selfhost';

export interface ReleaseNoteLabels {
  yes: string;
  none: string;
  /** Absent when the workspace configures only the pair. */
  selfhost?: string | undefined;
}

export interface ResolvedReleaseNoteLabels {
  yes: string;
  none: string;
  /** Null when the workspace has not created the self-host label. */
  selfhost: string | null;
  ids: { yes: string; none: string; selfhost: string | null };
}

export const RELEASE_NOTE_RUBRIC =
  'yes: once this ships, and any flag gating it is on, a visitor to production can do something new, sees changed behaviour or copy they would notice, or stops hitting a bug they could have hit, or something they used is gone. none: nothing a visitor sees changes: CI, tests, specs, gates, hooks, agent tooling, ticket bookkeeping, refactors, monitoring, docs for the team, staff-only tools, or a fix for something that never reached production. selfhost: only people running their own copy notice it (a deploy option, an install step, a self-host setting).';

/**
 * The label names, from `LINEAR_STRICT_RELEASE_NOTE_LABELS` ("yes-label,none-label[,selfhost-label]",
 * or "off").
 */
export function releaseNoteLabelsFromEnv(
  env: Record<string, string | undefined>,
): ReleaseNoteLabels | null {
  const raw = env['LINEAR_STRICT_RELEASE_NOTE_LABELS']?.trim();
  if (raw === 'off') return null;
  const names = (raw || 'release-note,release-note-none,release-note-selfhost')
    .split(',')
    .map((name) => name.trim());
  const [yes, none, selfhost, ...rest] = names;
  const distinct = new Set(names.map((name) => name.toLowerCase())).size === names.length;
  if (!yes || !none || selfhost === '' || rest.length > 0 || !distinct) {
    throw new Error(
      'LINEAR_STRICT_RELEASE_NOTE_LABELS must name two or three different labels, "yes-label,none-label[,selfhost-label]", or be "off"',
    );
  }
  return selfhost ? { yes, none, selfhost } : { yes, none };
}

export function releaseNoteArg(value: unknown): ReleaseNote | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'yes' || value === 'none' || value === 'selfhost') return value;
  throw new Error(`release_note must be "yes", "none" or "selfhost". ${RELEASE_NOTE_RUBRIC}`);
}

function labelNames(pair: ReleaseNoteLabels | ResolvedReleaseNoteLabels): [ReleaseNote, string][] {
  return [
    ['yes', pair.yes],
    ['none', pair.none],
    ...(pair.selfhost ? [['selfhost', pair.selfhost] as [ReleaseNote, string]] : []),
  ];
}

/** What a ticket's labels say, or null when they say nothing (or more than one, which is also nothing). */
export function releaseNoteOf(
  labels: string[],
  pair: ReleaseNoteLabels | ResolvedReleaseNoteLabels,
): ReleaseNote | null {
  const has = (name: string) => labels.some((label) => label.toLowerCase() === name.toLowerCase());
  const set = labelNames(pair).filter(([, name]) => has(name));
  return set.length === 1 ? (set[0]?.[0] ?? null) : null;
}

/** The label names set_fields adds and removes for a release_note value. */
export function releaseNoteLabelChanges(
  value: ReleaseNote,
  pair: ReleaseNoteLabels | ResolvedReleaseNoteLabels,
): { add: string; remove: string[] } {
  const names = labelNames(pair);
  const add = names.find(([kind]) => kind === value)?.[1];
  if (!add) throw new Error(`release_note "${value}" has no label in this workspace`);
  return { add, remove: names.filter(([kind]) => kind !== value).map(([, name]) => name) };
}

// ── the ## Release note line ─────────────────────────────────────────────────────────────────────

export const RELEASE_NOTE_SECTION = 'Release note';
export const RELEASE_NOTE_KINDS = ['Added', 'Changed', 'Fixed', 'Removed', 'Security'] as const;
export const RELEASE_NOTE_AREAS = ['Alpha', 'Gap Map', 'AI Potluck', 'Self-host'] as const;
export const RELEASE_NOTE_FORMAT = `"<${RELEASE_NOTE_KINDS.join('|')}> · <${RELEASE_NOTE_AREAS.join('|')}> · <one sentence a visitor reads> · flag: <key|none>", or "NONE"`;

export interface ReleaseNoteLine {
  kind: (typeof RELEASE_NOTE_KINDS)[number];
  area: (typeof RELEASE_NOTE_AREAS)[number];
  sentence: string;
  /** The PostHog flag gating it, or null for "flag: none". */
  flag: string | null;
}

const FLAG_PART = /^flag:\s*([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

/**
 * One release-note line read strictly: "NONE", a parsed line, or every reason it is not one. The
 * separator is " · " (a middle dot with a space each side), and the sentence may not hold one.
 */
export function parseReleaseNoteLine(
  text: string,
): { none: true } | { line: ReleaseNoteLine } | { errors: string[] } {
  const raw = text.trim().replace(/^[-*]\s+/, '');
  if (raw === 'NONE') return { none: true };
  const parts = raw.split(' · ').map((part) => part.trim());
  if (parts.length !== 4)
    return {
      errors: [
        `"${raw}" has ${String(parts.length)} part${parts.length === 1 ? '' : 's'} separated by " · "; a release-note line has four: ${RELEASE_NOTE_FORMAT}`,
      ],
    };
  const [kind = '', area = '', sentence = '', flagPart = ''] = parts;
  const errors: string[] = [];
  const kindOk = (RELEASE_NOTE_KINDS as readonly string[]).includes(kind);
  const areaOk = (RELEASE_NOTE_AREAS as readonly string[]).includes(area);
  if (!kindOk) errors.push(`kind "${kind}" is not one of ${RELEASE_NOTE_KINDS.join(', ')}`);
  if (!areaOk) errors.push(`area "${area}" is not one of ${RELEASE_NOTE_AREAS.join(', ')}`);
  if (sentence.length < 10)
    errors.push('the sentence is missing or too short to tell a visitor anything');
  if (/\b[A-Z][A-Z0-9]*-\d+\b/.test(sentence))
    errors.push('the sentence names a ticket id; the note is for visitors, who never see one');
  const flag = FLAG_PART.exec(flagPart)?.[1];
  if (!flag) errors.push(`the last part "${flagPart}" is not "flag: <key>" or "flag: none"`);
  if (errors.length > 0 || !kindOk || !areaOk || !flag) return { errors };
  return {
    line: {
      kind: kind as ReleaseNoteLine['kind'],
      area: area as ReleaseNoteLine['area'],
      sentence,
      flag: flag === 'none' ? null : flag,
    },
  };
}

/** Every error for a ## Release note body: exactly one line, NONE or well formed. Empty means valid. */
export function releaseNoteBodyErrors(body: string): string[] {
  const lines = body.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== 1)
    return [
      `${RELEASE_NOTE_SECTION}: exactly one line, ${RELEASE_NOTE_FORMAT} (it has ${String(lines.length)})`,
    ];
  const parsed = parseReleaseNoteLine(lines[0] ?? '');
  return 'errors' in parsed
    ? parsed.errors.map((error) => `${RELEASE_NOTE_SECTION}: ${error}`)
    : [];
}

/**
 * The state a ticket's labels and its ## Release note section are in, read together. `body` is the
 * section's text, or null when the description has none.
 */
export function releaseNoteSectionState(
  body: string | null,
): 'missing' | 'none' | 'line' | 'malformed' {
  if (body === null || body.trim() === '') return 'missing';
  if (releaseNoteBodyErrors(body).length > 0) return 'malformed';
  return body.trim().replace(/^[-*]\s+/, '') === 'NONE' ? 'none' : 'line';
}

export type ReleaseNoteGate = 'warn' | 'block';

/** `LINEAR_STRICT_RELEASE_NOTE_GATE`: "warn" (default) or "block". */
export function releaseNoteGateFromEnv(env: Record<string, string | undefined>): ReleaseNoteGate {
  const raw = env['LINEAR_STRICT_RELEASE_NOTE_GATE']?.trim().toLowerCase() || 'warn';
  if (raw === 'warn' || raw === 'block') return raw;
  throw new Error('LINEAR_STRICT_RELEASE_NOTE_GATE must be "warn" or "block"');
}

/** Workflow states that mean the work shipped, or is about to: a release-note ticket needs its line first. */
const SHIPPED_STATE_NAMES = ['merged', 'verify', 'done'];

export function releaseNoteGatesState(state: { name: string; type: string }): boolean {
  return state.type === 'completed' || SHIPPED_STATE_NAMES.includes(state.name.toLowerCase());
}

/**
 * Why a ticket may not move to `stateName`, or null when it may: a ticket labelled release-note or
 * release-note-selfhost reaches Merged, Verify or Done only with a well-formed line, since the note is
 * assembled from that line and nothing else.
 */
export function releaseNoteGateRefusal(
  identifier: string,
  stateName: string,
  labels: string[],
  pair: ResolvedReleaseNoteLabels | null,
  body: string | null,
): string | null {
  if (!pair) return null;
  const tag = releaseNoteOf(labels, pair);
  if (tag !== 'yes' && tag !== 'selfhost') return null;
  const state = releaseNoteSectionState(body);
  if (state === 'line') return null;
  const label = tag === 'yes' ? pair.yes : (pair.selfhost ?? 'release-note-selfhost');
  const what =
    state === 'missing'
      ? 'has no ## Release note section'
      : state === 'none'
        ? 'says NONE under ## Release note while it carries that label'
        : `has a ## Release note line that does not parse (${releaseNoteBodyErrors(body ?? '').join('; ')})`;
  return `Refusing to move ${identifier} to ${stateName}: it is labelled "${label}" and ${what}. The release note is assembled from that one line, so write it first with set_state (section "${RELEASE_NOTE_SECTION}", mode replace): ${RELEASE_NOTE_FORMAT}. Writing NONE moves the ticket to "${pair.none}" instead.`;
}

/**
 * A ticket that will ship, or has, and carries none of the labels (or more than one); and a ticket
 * whose ## Release note line does not parse. A canceled ticket ships nothing, so it is never asked.
 */
export function releaseNoteFindings(
  state: { type: string } | null,
  labels: string[],
  pair: ReleaseNoteLabels | ResolvedReleaseNoteLabels | null,
  sectionBody: string | null = null,
): Finding[] {
  if (!pair || state?.type === 'canceled') return [];
  const findings: Finding[] = [];
  if (releaseNoteSectionState(sectionBody) === 'malformed') {
    findings.push({
      code: 'release_note_line_invalid',
      detail: `${releaseNoteBodyErrors(sectionBody ?? '').join('; ')}. Rewrite it with set_state.`,
    });
  }
  if (releaseNoteOf(labels, pair) !== null) return findings;
  const names = labelNames(pair).map(([, name]) => name);
  const carried = names.filter((name) =>
    labels.some((l) => l.toLowerCase() === name.toLowerCase()),
  );
  return [
    ...findings,
    {
      code: 'release_note_unset',
      detail: `${carried.length === 2 ? `Both ${carried.map((n) => `"${n}"`).join(' and ')} are set` : carried.length > 2 ? `All of ${carried.map((n) => `"${n}"`).join(', ')} are set` : `None of ${names.map((n) => `"${n}"`).join(', ')} is set`}, so the release note cannot tell whether this ticket belongs in it. Set release_note with set_fields. ${RELEASE_NOTE_RUBRIC}`,
    },
  ];
}

const RELEASE_NOTE_LABELS_QUERY = `query StrictReleaseNoteLabels($teamId: ID!, $names: [String!]!) {
  issueLabels(first: 20, filter: { name: { in: $names }, or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }) {
    nodes { id name isGroup }
  }
}`;

/**
 * The labels' ids as the team sees them, or null when the yes or none label is missing (the feature is
 * off). The self-host label is optional: without it, release_note "selfhost" is refused.
 */
export async function resolveReleaseNoteLabels(
  gql: Gql,
  teamId: string,
  pair: ReleaseNoteLabels,
): Promise<ResolvedReleaseNoteLabels | null> {
  const { issueLabels } = await gql<{
    issueLabels: { nodes: { id: string; name: string; isGroup: boolean }[] };
  }>(RELEASE_NOTE_LABELS_QUERY, {
    teamId,
    names: [pair.yes, pair.none, ...(pair.selfhost ? [pair.selfhost] : [])],
  });
  const find = (name: string) =>
    issueLabels.nodes.find(
      (label) => !label.isGroup && label.name.toLowerCase() === name.toLowerCase(),
    );
  const yes = find(pair.yes);
  const none = find(pair.none);
  if (!yes || !none) return null;
  const selfhost = pair.selfhost ? find(pair.selfhost) : undefined;
  return {
    yes: yes.name,
    none: none.name,
    selfhost: selfhost?.name ?? null,
    ids: { yes: yes.id, none: none.id, selfhost: selfhost?.id ?? null },
  };
}
