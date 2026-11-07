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
 * the functions, stops the server at startup rather than letting it write ## Checks unchecked.
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
  let module: Partial<ChecksModule>;
  try {
    module = (await load(path)) as Partial<ChecksModule>;
  } catch (error) {
    throw new Error(
      `LINEAR_STRICT_CHECKS_MODULE ${path} did not load: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const missing = (['parseChecks', 'impactCoverage', 'impactLine'] as const).filter(
    (name) => typeof module[name] !== 'function',
  );
  if (missing.length > 0)
    throw new Error(`LINEAR_STRICT_CHECKS_MODULE ${path} does not export ${missing.join(', ')}`);
  return { teams, module: module as ChecksModule };
}

export function checksApply(rules: ChecksRules | undefined, teamKey: string | undefined) {
  return rules && teamKey && rules.teams.includes(teamKey.toUpperCase()) ? rules.module : undefined;
}

const idNumber = (id: string) => Number(id.slice(1));

/** The ids a write adds that no earlier version had. */
export function newIds(m: ChecksModule, before: string, after: string): string[] {
  const had = new Set(m.parseChecks(before)?.checks.map((c) => c.id) ?? []);
  return (m.parseChecks(after)?.checks ?? []).map((c) => c.id).filter((id) => !had.has(id));
}

/**
 * Why a write's ## Checks section can't land, or [] when it can or there is none. `earlier` is every
 * earlier version of the description, read only when the write adds an id, so a retired id is never
 * issued again.
 */
export function checksWriteProblems(
  m: ChecksModule,
  before: string,
  after: string,
  earlier: string[] = [],
): string[] {
  const parsed = m.parseChecks(after);
  if (!parsed) return [];
  const problems = parsed.problems.map((p) => `Checks: ${p}`);
  const { misquoted, uncovered } = m.impactCoverage(m.impactLine(after), parsed.checks);
  for (const { id, quote } of misquoted)
    problems.push(
      `Checks: ${id} quotes "${quote}", which the Impact line does not say word for word`,
    );
  if (uncovered.length > 0)
    problems.push(
      `Impact claim has no check: no check quotes ${uncovered.map((w) => `"${w}"`).join(', ')}. Cite the clause with <!-- from impact "…" --> on the check that proves it, add a check, or narrow the Impact.`,
    );
  const used = [before, ...earlier].flatMap((text) => m.parseChecks(text)?.checks ?? []);
  const highest = Math.max(0, ...used.map((c) => idNumber(c.id)));
  const fresh = newIds(m, before, after);
  for (const id of fresh) {
    if (used.some((c) => c.id === id))
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
  const now = new Map((m.parseChecks(after)?.checks ?? []).map((c) => [c.id, c]));
  return (m.parseChecks(before)?.checks ?? []).flatMap((c) => {
    const next = now.get(c.id);
    if (!next) return [`${c.id} · ${graded(c)} (retired)`];
    if (graded(next) !== graded(c)) return [`${c.id} · ${graded(c)} (reworded)`];
    return [];
  });
}

/** Checks a write adds or rewords, shown beside the dropped ones in the sign-off. */
export function addedChecksById(m: ChecksModule, before: string, after: string): string[] {
  const had = new Map((m.parseChecks(before)?.checks ?? []).map((c) => [c.id, graded(c)]));
  return (m.parseChecks(after)?.checks ?? [])
    .filter((c) => had.get(c.id) !== graded(c))
    .map((c) => `${c.id} · ${graded(c)}`);
}

/**
 * Of the Done when items a write drops, the ones it did not carry into ## Checks. A migration moves
 * an item mechanically when the item's text, its citation aside, appears inside exactly one check's
 * claim; that item needs no sign-off. Anything changed on the way still does.
 */
export function notMigrated(m: ChecksModule, after: string, dropped: string[]): string[] {
  const claims = (m.parseChecks(after)?.checks ?? []).map((c) => c.claim);
  return dropped.filter((item) => {
    const text = item.replace(/ \(already ticked\)$/, '').trim();
    return claims.filter((claim) => claim.includes(text)).length !== 1;
  });
}
