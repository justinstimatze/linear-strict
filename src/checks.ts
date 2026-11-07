/**
 * A ticket's `## Checks` section, on the teams that use one. Each line is a check with a permanent id:
 *
 *   - [ ] C1 · walk alpha/visitor · the reply names the cap <!-- from impact "a visitor sees the cap" -->
 *
 * The grammar, the per-kind targets and the Impact coverage rule are not written here. The server
 * imports the project's own module (LINEAR_STRICT_CHECKS_MODULE, a path to a JavaScript
 * module in the project's checkout), which reads them from the project's rulebook, so a write is refused by
 * the same code that later grades the ticket and the two can't drift apart.
 *
 * What this file adds is what only a writer can know: which ids a write retires or rewords, which
 * need sign-off like a dropped Done when item, and whether a new id was ever used before.
 */
import { pathToFileURL } from 'node:url';
import { readSection } from './sections.js';

export interface Check {
  id: string;
  ticked: boolean;
  kind: string;
  target: string;
  claim: string;
  from: string | null;
  quotes: string[];
  line: string;
}

export interface ChecksModule {
  parseChecks(description: string): { checks: Check[]; problems: string[] } | null;
  impactCoverage(
    impact: string | null,
    checks: Check[],
  ): { misquoted: { id: string; quote: string }[]; uncovered: string[] };
  impactLine(description: string): string | null;
}

export interface ChecksRules {
  /** Team keys, upper case, whose tickets carry ## Checks. */
  teams: string[];
  module: ChecksModule;
}

/**
 * Reads LINEAR_STRICT_CHECKS_TEAMS (comma-separated keys) and LINEAR_STRICT_CHECKS_MODULE (a path).
 * Off when neither is set. Setting one without the other, or a module that does not load or lacks
 * the functions, stops the server at startup rather than letting it write ## Checks unchecked. The
 * module is loaded once, so a change to it or to the rulebook it reads takes effect on restart.
 */
export async function checksRulesFromEnv(
  env: Record<string, string | undefined>,
  load: (path: string) => Promise<unknown> = (path) => import(pathToFileURL(path).href),
): Promise<ChecksRules | undefined> {
  const teams = (env['LINEAR_STRICT_CHECKS_TEAMS'] ?? '')
    .split(',')
    .map((key) => key.trim().toUpperCase())
    .filter(Boolean);
  const path = env['LINEAR_STRICT_CHECKS_MODULE']?.trim();
  if (teams.length === 0 && !path) return undefined;
  if (teams.length === 0 || !path)
    throw new Error(
      'Set LINEAR_STRICT_CHECKS_TEAMS and LINEAR_STRICT_CHECKS_MODULE together, or neither.',
    );
  const bad = teams.filter((key) => !/^[A-Z][A-Z0-9]*$/.test(key));
  if (bad.length > 0)
    throw new Error(
      `LINEAR_STRICT_CHECKS_TEAMS has a key that is not a team key: ${bad.join(', ')}`,
    );
  // Both variables are set, so this is a configuration error, not a missing feature: the server
  // will not start and write those teams' ## Checks with nothing to check them.
  const refusal =
    'linear-strict will not start with LINEAR_STRICT_CHECKS_TEAMS and LINEAR_STRICT_CHECKS_MODULE both set and no checks module to read ## Checks with. Fix the path (an absolute one does not depend on where the server was launched) or unset both variables.';
  let module: Partial<ChecksModule>;
  try {
    module = (await load(path)) as Partial<ChecksModule>;
  } catch (error) {
    throw new Error(
      `LINEAR_STRICT_CHECKS_MODULE ${path} did not load: ${error instanceof Error ? error.message : String(error)}. ${refusal}`,
      { cause: error },
    );
  }
  const missing = (['parseChecks', 'impactCoverage', 'impactLine'] as const).filter(
    (name) => typeof module[name] !== 'function',
  );
  if (missing.length > 0)
    throw new Error(
      `LINEAR_STRICT_CHECKS_MODULE ${path} does not export ${missing.join(', ')}. ${refusal}`,
    );
  return { teams, module: module as ChecksModule };
}

/**
 * The module to read a team's ## Checks with, or undefined on a team that does not use one. It reads
 * descriptions as Linear stores them (see linearChecks).
 */
export function checksApply(
  rules: ChecksRules | undefined,
  teamKey: string | undefined,
): ChecksModule | undefined {
  return rules && teamKey && rules.teams.includes(teamKey.toUpperCase())
    ? linearChecks(rules.module)
    : undefined;
}

// A check line as Linear hands it back: a `*` or `-` bullet, a box Linear may escape, and a tick it
// writes as a capital X.
const STORED_CHECK = /^(\s*)[-*]\s+\\?\[([ xX])\\?\]\s+(?=C[1-9])/;

/**
 * A description with its check lines in the form a check is written in. Linear stores a ticked item
 * as `- [X]`, a bullet as `*`, and escapes `[`, `]`, `~` and `*` in plain text, so a check written as
 * `- [x] C1 · …` comes back from the next read in a form the module may not read. Only lines that
 * are checklist items naming a C<n> id are touched.
 */
export function asWritten(description: string): string {
  return description
    .split('\n')
    .map((line) => {
      const m = STORED_CHECK.exec(line);
      if (!m) return line;
      const box = m[2] === ' ' ? ' ' : 'x';
      const rest = line.slice(m[0].length).replace(/\\([[\]~*_])/g, '$1');
      return `${m[1] ?? ''}- [${box}] ${rest}`;
    })
    .join('\n');
}

/** The module, reading every description through asWritten. */
export function linearChecks(m: ChecksModule): ChecksModule {
  return {
    parseChecks: (description) => m.parseChecks(asWritten(description)),
    impactCoverage: (impact, checks) => m.impactCoverage(impact, checks),
    impactLine: (description) => m.impactLine(asWritten(description)),
  };
}

const idNumber = (id: string) => Number(id.slice(1));

/** The ## Checks section's lines, under the exact heading the module reads, up to the next heading. */
function checksLines(description: string): string[] | null {
  const lines = asWritten(description).split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Checks');
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

const ID_LINE = /^- \[[ x]\] (C[1-9][0-9]*)\b\s*(?:·\s*)?(.*)$/;

/**
 * Every check a description holds, by id: the ones the module reads, and the lines it can't read
 * that still name an id. A line that does not parse is still a check someone wrote, so retiring or
 * rewording it needs sign-off and its id is never issued again. `text` is what a grade is made
 * against: kind, target and claim for a parsed check, the line after its id for one that isn't.
 */
function checksById(m: ChecksModule, description: string): Map<string, { text: string }> {
  const byId = new Map<string, { text: string }>();
  for (const c of m.parseChecks(description)?.checks ?? []) byId.set(c.id, { text: graded(c) });
  for (const raw of checksLines(description) ?? []) {
    const [, id, rest = ''] = ID_LINE.exec(raw.trim()) ?? [];
    if (id && !byId.has(id)) byId.set(id, { text: rest.replace(/\s*<!--.*-->\s*$/, '') });
  }
  return byId;
}

/** The ids a write adds that the description before it did not have. */
export function newIds(m: ChecksModule, before: string, after: string): string[] {
  const had = checksById(m, before);
  return [...checksById(m, after).keys()].filter((id) => !had.has(id));
}

/** Whether the description has the section under any heading level or case; two of them count. */
const hasSection = (description: string, name: 'Checks' | 'Done when') => {
  try {
    return readSection(description, name) !== null;
  } catch {
    return true;
  }
};

/** What the module and the Impact coverage rule say is wrong with a description's checks. */
function contentProblems(m: ChecksModule, description: string): string[] {
  const parsed = m.parseChecks(description);
  if (!parsed) {
    // The section is there under a heading the module does not read: never treat that as no checks.
    return hasSection(description, 'Checks')
      ? ['Checks: the section heading must be exactly "## Checks" for the checks to be read']
      : [];
  }
  const problems = parsed.problems.map((p) => `Checks: ${p}`);
  const { misquoted, uncovered } = m.impactCoverage(m.impactLine(description), parsed.checks);
  for (const { id, quote } of misquoted)
    problems.push(
      `Checks: ${id} quotes "${quote}", which the Impact line does not say word for word`,
    );
  if (uncovered.length > 0)
    problems.push(
      `Impact claim has no check: no check quotes ${uncovered.map((w) => `"${w}"`).join(', ')}. Cite the clause with <!-- from impact "…" --> on the check that proves it, add a check, or narrow the Impact.`,
    );
  return problems;
}

const sectionText = (description: string) => {
  try {
    return readSection(description, 'Checks');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * Why a write's ## Checks section can't land, or [] when it can or there is none. A problem the
 * description already had is not this write's to fix when the write touches neither Checks nor the
 * Impact line (an Observed append, say), so it does not refuse that write.
 * `earlier` is the full text of every earlier version of the description, read only when the write
 * adds an id, so a retired id is never issued again.
 */
export function checksWriteProblems(
  m: ChecksModule,
  before: string,
  after: string,
  earlier: string[] = [],
): string[] {
  // Excused only when this write leaves Checks and the Impact line alone: a write into the section
  // must leave it readable, or nothing it adds is checked.
  const untouched =
    sectionText(before) === sectionText(after) && m.impactLine(before) === m.impactLine(after);
  const known = new Set(untouched ? contentProblems(m, before) : []);
  const problems = contentProblems(m, after).filter((p) => !known.has(p));
  const used = new Set([before, ...earlier].flatMap((text) => [...checksById(m, text).keys()]));
  const highest = Math.max(0, ...[...used].map(idNumber));
  for (const id of newIds(m, before, after)) {
    if (used.has(id))
      problems.push(
        `Checks: ${id} was used before and retired; ids are never reused, so give this check C${highest + 1}`,
      );
    else if (idNumber(id) <= highest)
      problems.push(
        `Checks: ${id} is not above C${highest}, the highest id this ticket has had; ids are assigned in increasing order`,
      );
  }
  return problems;
}

/** A check's graded text: its kind, target and claim. The box and the provenance comment are not. */
const graded = (c: Check) => `${c.kind} ${c.target} · ${c.claim}`;

/**
 * Checks a write retires or rewords, for the same sign-off a dropped Done when item gets. A reword
 * keeps the id and voids every grade made before it, so it is a dropped check as much as a removal.
 */
export function droppedChecksById(m: ChecksModule, before: string, after: string): string[] {
  const now = checksById(m, after);
  return [...checksById(m, before)].flatMap(([id, { text }]) => {
    const next = now.get(id);
    if (!next) return [`${id} · ${text} (retired)`];
    if (next.text !== text) return [`${id} · ${text} (reworded)`];
    return [];
  });
}

/** Checks a write adds or rewords, shown beside the dropped ones in the sign-off. */
export function addedChecksById(m: ChecksModule, before: string, after: string): string[] {
  const had = checksById(m, before);
  return [...checksById(m, after)]
    .filter(([id, { text }]) => had.get(id)?.text !== text)
    .map(([id, { text }]) => `${id} · ${text}`);
}

const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Of the Done when items a write drops, the ones it did not carry into ## Checks. Only a migration
 * moves items: a write that removes Done when and adds ## Checks in the same step. An item moved when
 * its text, its citation aside, is the whole claim of exactly one check this write adds, and that
 * check is not ticked unless the item was. Every other dropped item, and every item in any other
 * write, still needs sign-off.
 */
export function notMigrated(
  m: ChecksModule,
  before: string,
  after: string,
  dropped: string[],
): string[] {
  const migration =
    hasSection(before, 'Done when') &&
    !hasSection(after, 'Done when') &&
    !hasSection(before, 'Checks') &&
    m.parseChecks(after) !== null;
  if (!migration) return dropped;
  // The ticket had no ## Checks before this write, so every check is one this write adds.
  const added = m.parseChecks(after)?.checks ?? [];
  return dropped.filter((item) => {
    const wasTicked = item.endsWith(' (already ticked)');
    const text = item.replace(/ \(already ticked\)$/, '');
    const matches = added.filter((c) => sameText(c.claim, text));
    return !(matches.length === 1 && (wasTicked || !matches[0]?.ticked));
  });
}
