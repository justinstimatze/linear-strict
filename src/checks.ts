/**
 * A ticket's `## Checks` section, on the teams that use one. Each line is a check with a permanent id:
 *
 *   - [ ] C1 · walk alpha/visitor · the reply names the cap <!-- from impact "a visitor sees the cap" -->
 *
 * The grammar, the per-kind targets and the Impact coverage constants are data: the project's
 * rulebook, a JSON file named by LINEAR_STRICT_CHECKS_RULEBOOK and read once at startup. This file is
 * the one interpreter for it. It reads a description as Linear stores it as well as it was written
 * (see asWritten). The server never loads project code; a project that grades tickets with
 * its own implementation of the same rules keeps the two in step with the conformance fixtures
 * (src/__tests__/fixtures/checks-conformance.json).
 *
 * What this file adds beyond reading is what only a writer can know: which ids a write retires or
 * rewords, which need sign-off like a dropped Done when item, and whether a new id was ever used before.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { doneWhenDropped } from './done-when.js';
import { readSection, sectionsNamed } from './sections.js';

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

/** The three readings a write is checked with. checksInterpreter builds one from a rulebook. */
export interface ChecksModule {
  /** The exact heading line the checks sit under. */
  section: string;
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

/** A rulebook's `checks` block, validated and with its patterns compiled. */
export interface ChecksRulebook {
  /** The exact heading line, e.g. "## Checks". */
  section: string;
  /** Six groups: box, id, kind, target, claim, and the optional provenance comment's body. */
  line: RegExp;
  provenance: RegExp;
  /** One group, the quoted Impact text; matched globally against the provenance comment. */
  quote: RegExp;
  kinds: Map<string, { target: string; targetPattern: RegExp }>;
  stopwords: Set<string>;
  minWordLength: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** How many capture groups a pattern has. */
const groups = (re: RegExp) => (new RegExp(`${re.source}|`).exec('')?.length ?? 1) - 1;

/**
 * Reads a rulebook: either the `checks` block itself or a whole file with a `checks` key. Throws
 * naming every missing or malformed field, so a bad file is fixed in one round.
 */
export function parseChecksRulebook(text: string): ChecksRulebook {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`not JSON (${error instanceof Error ? error.message : String(error)})`, {
      cause: error,
    });
  }
  const block = isObject(json) && isObject(json['checks']) ? json['checks'] : json;
  if (!isObject(block)) throw new Error('not a JSON object');
  const missing: string[] = [];
  const str = (v: unknown, name: string) => {
    if (typeof v === 'string' && v !== '') return v;
    missing.push(`${name} (string)`);
    return '';
  };
  const pattern = (v: unknown, name: string, flags = '', min = 0) => {
    const source = str(v, name);
    if (!source) return /$^/;
    try {
      const re = new RegExp(source, flags);
      if (groups(re) < min) missing.push(`${name} (a pattern with ${String(min)} capture groups)`);
      return re;
    } catch {
      missing.push(`${name} (a valid regular expression)`);
      return /$^/;
    }
  };
  const provenance = isObject(block['provenance']) ? block['provenance'] : {};
  const coverage = isObject(block['coverage']) ? block['coverage'] : {};
  const section = str(block['section'], 'checks.section');
  const line = pattern(block['line'], 'checks.line', '', 6);
  const prov = pattern(provenance['pattern'], 'checks.provenance.pattern');
  const quote = pattern(provenance['quote_pattern'], 'checks.provenance.quote_pattern', 'g', 1);
  const kinds = new Map<string, { target: string; targetPattern: RegExp }>();
  if (!isObject(block['kinds']) || Object.keys(block['kinds']).length === 0)
    missing.push('checks.kinds (an object of kinds)');
  else
    for (const [kind, spec] of Object.entries(block['kinds'])) {
      const s = isObject(spec) ? spec : {};
      kinds.set(kind, {
        target: str(s['target'], `checks.kinds.${kind}.target`),
        targetPattern: pattern(s['target_pattern'], `checks.kinds.${kind}.target_pattern`),
      });
    }
  const words = coverage['stopwords'];
  if (!Array.isArray(words) || !words.every((w) => typeof w === 'string'))
    missing.push('checks.coverage.stopwords (an array of strings)');
  const min = coverage['min_word_length'];
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 1)
    missing.push('checks.coverage.min_word_length (a positive integer)');
  if (missing.length > 0) throw new Error(`missing or malformed: ${missing.join(', ')}`);
  return {
    section,
    line,
    provenance: prov,
    quote,
    kinds,
    stopwords: new Set(words as string[]),
    minWordLength: min as number,
  };
}

/**
 * The body lines under the rulebook's exact heading, read through the one section reader every other
 * section uses (sections.ts sectionsNamed): a heading at column 0 outside a code fence, a span that ends
 * at the next heading of the same or a higher level or at a generated block. A `###` line inside it is
 * part of the section, as it is inside Done when, and reads as a line that is not a check. Null when no
 * heading names the section, or the one that does is not the rulebook's exact line; a string when two
 * do, since reading either would hide the other.
 */
function sectionOf(description: string, heading: string): string[] | string | null {
  const name = heading.replace(/^#{1,6}\s+/, '').trim();
  const found = sectionsNamed(description, name);
  if (found.length > 1)
    return `the description has ${String(found.length)} "${name}" headings; merge them into one`;
  const [only] = found;
  return only?.heading.trimEnd() === heading ? only.body : null;
}

/** The text after `Impact:` on the first line that carries it, or null. An empty one is null. */
function readImpactLine(description: string): string | null {
  return /(?:^|\n)\W*Impact:[ \t]*(.*)/i.exec(description)?.[1]?.trim() || null;
}

/**
 * Only an Impact whose first word is "none" can say the work reached nobody, and "none of …" does not:
 * "none of the visitors can lose their history" is a claim like any other, as is "nonetheless …".
 */
const saysNone = (impact: string) => /^\W*none\b(?!\s+of\b)/i.test(impact);

/**
 * Text without default-ignorable code points (soft hyphen, zero-width space and joiners, word joiner,
 * BOM and the rest of Unicode's set). They do not show when the text is displayed, so a word broken by
 * one reads whole, and must be read whole: otherwise its fragments fall under min_word_length and no
 * quote has to cover them.
 */
const visible = (s: string) => s.replace(/\p{Default_Ignorable_Code_Point}/gu, '');

/** Case and punctuation dropped: every run of non-letters and non-digits becomes one space. */
const normalised = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// A line written twice over reads "🤖 Impact: …" after the first prefix.
const unprefixed = (s: string) => s.replace(/^(?:\p{Extended_Pictographic}\s*)*Impact:\s*/iu, '');

/** The interpreter: the readings a rulebook defines, in the form the write checks below use. */
export function checksInterpreter(rb: ChecksRulebook): ChecksModule {
  return {
    section: rb.section,
    impactLine: readImpactLine,

    parseChecks(description) {
      const lines = writtenSection(description, rb.section);
      if (lines === null) return null;
      if (typeof lines === 'string') return { checks: [], problems: [lines] };
      const checks: Check[] = [];
      const problems: string[] = [];
      for (const raw of lines) {
        const l = raw.trim();
        if (!l) continue;
        const m = rb.line.exec(l);
        if (!m) {
          problems.push(`not a check line: ${l}`);
          continue;
        }
        const [, box, id = '', kind = '', rawTarget = '', claim = '', from] = m;
        const target = rawTarget.trim();
        if (checks.some((c) => c.id === id)) problems.push(`${id} appears twice`);
        const spec = rb.kinds.get(kind);
        if (!spec) problems.push(`${id}: "${kind}" is not a kind the rulebook defines`);
        else if (!spec.targetPattern.test(target))
          problems.push(`${id}: "${target}" is not a ${kind} target (${spec.target})`);
        if (from === undefined)
          problems.push(`${id} names no source (<!-- from impact "…" --> or <!-- from D<n> -->)`);
        else if (!rb.provenance.test(from))
          problems.push(`${id}: "${from}" is not a source the rulebook reads`);
        const quotes = [...(from ?? '').matchAll(rb.quote)].map((q) => q[1] ?? '');
        checks.push({
          id,
          ticked: box !== ' ',
          kind,
          target,
          claim: claim.trim(),
          from: from ?? null,
          quotes,
          line: l,
        });
      }
      return { checks, problems };
    },

    // A quote must appear in the Impact once both are normalised, and every content word of the
    // Impact (min_word_length or more characters, not a stopword) must lie inside some quote. Both are
    // read without default-ignorable code points. An Impact that says none (saysNone) exempts only
    // that opening clause: everything after its first colon is still a claim, and with no colon it
    // claims nothing.
    impactCoverage(line, checks) {
      if (!line) return { misquoted: [], uncovered: [] };
      const impact = unprefixed(visible(line));
      const claimed = saysNone(impact)
        ? impact.includes(':')
          ? impact.slice(impact.indexOf(':') + 1)
          : ''
        : impact;
      const whole = normalised(impact);
      const text = normalised(claimed);
      const covered = new Array<boolean>(text.length).fill(false);
      const misquoted: { id: string; quote: string }[] = [];
      for (const c of checks)
        for (const quote of c.quotes) {
          const q = normalised(unprefixed(visible(quote)));
          // Whole words only: "cap" must not cover the start of "capacity".
          const re = q
            ? new RegExp(
                `(?<![\\p{L}\\p{N}])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
                'gu',
              )
            : null;
          const hits = re ? [...text.matchAll(re)] : [];
          if (!re?.test(whole)) misquoted.push({ id: c.id, quote });
          for (const h of hits) covered.fill(true, h.index, h.index + q.length);
        }
      const uncovered = new Set<string>();
      for (const w of text.matchAll(/\S+/g))
        if (w[0].length >= rb.minWordLength && !rb.stopwords.has(w[0]) && !covered[w.index])
          uncovered.add(w[0]);
      return { misquoted, uncovered: [...uncovered] };
    },
  };
}

/**
 * Reads LINEAR_STRICT_CHECKS_TEAMS (comma-separated keys) and LINEAR_STRICT_CHECKS_RULEBOOK (a path
 * to a JSON file). Off when neither is set. Anything short of both set and a rulebook that reads is
 * off too, for every team, with one line on stderr saying why: no code is loaded, so a bad file can
 * do nothing worse than leave Checks off. The file is read once, and its sha256 logged, so a change
 * to it takes effect on restart and the log says which version a server ran.
 */
export function checksRulesFromEnv(
  env: Record<string, string | undefined>,
  read: (path: string) => Buffer = (path) => readFileSync(path),
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): ChecksRules | undefined {
  const teams = (env['LINEAR_STRICT_CHECKS_TEAMS'] ?? '')
    .split(',')
    .map((key) => key.trim().toUpperCase())
    .filter(Boolean);
  const path = env['LINEAR_STRICT_CHECKS_RULEBOOK']?.trim();
  if (teams.length === 0 && !path) return undefined;
  const loaded = loadRules(teams, path, read);
  if (typeof loaded === 'string') {
    log(`linear-strict: ## CHECKS ARE OFF FOR EVERY TEAM: ${loaded}`);
    return undefined;
  }
  log(
    `linear-strict: ## Checks on for ${teams.join(', ')}, rulebook ${path ?? ''} sha256 ${loaded.sha}`,
  );
  return loaded.rules;
}

/** The rules, or why there are none. */
function loadRules(
  teams: string[],
  path: string | undefined,
  read: (path: string) => Buffer,
): { rules: ChecksRules; sha: string } | string {
  if (teams.length === 0 || !path)
    return 'set LINEAR_STRICT_CHECKS_TEAMS and LINEAR_STRICT_CHECKS_RULEBOOK together, or neither.';
  const bad = teams.filter((key) => !/^[A-Z][A-Z0-9]*$/.test(key));
  if (bad.length > 0)
    return `LINEAR_STRICT_CHECKS_TEAMS has a key that is not a team key: ${bad.join(', ')}.`;
  const why = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let bytes: Buffer;
  try {
    bytes = read(path);
  } catch (error) {
    return `LINEAR_STRICT_CHECKS_RULEBOOK ${path} could not be read: ${why(error)}.`;
  }
  try {
    const rulebook = parseChecksRulebook(bytes.toString('utf8'));
    const sha = createHash('sha256').update(bytes).digest('hex');
    return { rules: { teams, module: checksInterpreter(rulebook) }, sha };
  } catch (error) {
    return `LINEAR_STRICT_CHECKS_RULEBOOK ${path} is ${why(error)}.`;
  }
}

/** The interpreter to read a team's ## Checks with, or undefined on a team that does not use one. */
export function checksApply(
  rules: ChecksRules | undefined,
  teamKey: string | undefined,
): ChecksModule | undefined {
  return rules && teamKey && rules.teams.includes(teamKey.toUpperCase()) ? rules.module : undefined;
}

// A check line as Linear hands it back: a `*` or `-` bullet, a box Linear may escape, and a tick it
// writes as a capital X.
const STORED_CHECK = /^(\s*)[-*]\s+\\?\[([ xX])\\?\]\s+(?=C[1-9])/;

/**
 * A description with its check lines in the form a check is written in. Linear stores a ticked item
 * as `- [X]`, a bullet as `*`, and escapes `[`, `]`, `~` and `*` in plain text, so a check written as
 * `- [x] C1 · …` comes back from the next read in a form the line pattern may not read. Only lines that
 * are checklist items naming a C<n> id are touched. A project's own interpreter of the rulebook applies
 * the same function, so the conformance fixtures' stored forms read the same in both.
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

/**
 * The section's lines, its span found on the description as stored, so a line is a boundary or a
 * heading here exactly when it is one for readSection; asWritten then applies to the body alone. An
 * escaped marker (`<!-- a\_b:begin -->`) is no boundary for readSection, so it is none here either,
 * and the check line that carries it is read, and refused, like any other line.
 */
function writtenSection(description: string, heading: string): string[] | string | null {
  const lines = sectionOf(description, heading);
  return Array.isArray(lines) ? asWritten(lines.join('\n')).split('\n') : lines;
}

const idNumber = (id: string) => Number(id.slice(1));

/** The ## Checks section's lines in the form they were written in, over the span parseChecks reads. */
const checksLines = (m: ChecksModule, description: string) => {
  const lines = writtenSection(description, m.section);
  return typeof lines === 'string' ? null : lines;
};

const ID_LINE = /^- \[([ x])\] (C[1-9][0-9]*)\b(.*)$/;

/** The text after a check's id, without the separator or a trailing provenance comment. */
function afterId(rest: string): string {
  let text = rest.trimStart();
  if (text.startsWith('·')) text = text.slice(1).trimStart();
  text = text.trimEnd();
  const open = text.lastIndexOf('<!--');
  if (open !== -1 && text.endsWith('-->')) text = text.slice(0, open).trimEnd();
  return text;
}

/**
 * Every check a description holds, by id: the ones the line pattern reads, and the lines it can't read
 * that still name an id. A line that does not parse is still a check someone wrote, so retiring or
 * rewording it needs sign-off and its id is never issued again. `text` is what a grade is made
 * against: kind, target and claim for a parsed check, the line after its id for one that isn't.
 */
function checksById(
  m: ChecksModule,
  description: string,
): Map<string, { text: string; ticked: boolean }> {
  const byId = new Map<string, { text: string; ticked: boolean }>();
  for (const c of m.parseChecks(description)?.checks ?? [])
    byId.set(c.id, { text: graded(c), ticked: c.ticked });
  for (const raw of checksLines(m, description) ?? []) {
    const [, box, id, rest = ''] = ID_LINE.exec(raw.trim()) ?? [];
    if (id && !byId.has(id)) byId.set(id, { text: afterId(rest), ticked: box === 'x' });
  }
  return byId;
}

/** The ids a write adds that the description before it did not have. */
export function newIds(m: ChecksModule, before: string, after: string): string[] {
  const had = checksById(m, before);
  return [...checksById(m, after).keys()].filter((id) => !had.has(id));
}

/** Whether the description has the section under any heading level or case; two of them count. */
export const hasSection = (description: string, name: 'Checks' | 'Done when') => {
  try {
    return readSection(description, name) !== null;
  } catch {
    return true;
  }
};

/** What the rulebook's grammar and the Impact coverage rule say is wrong with a description's checks. */
function contentProblems(m: ChecksModule, description: string): string[] {
  const parsed = m.parseChecks(description);
  if (!parsed) {
    // The section is there under a heading the rulebook does not read: never treat that as no checks.
    return hasSection(description, 'Checks')
      ? [`Checks: the section heading must be exactly "${m.section}" for the checks to be read`]
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
  if (hasSection(after, 'Done when') && hasSection(after, 'Checks')) problems.push(BOTH_SECTIONS);
  problems.push(...tickProblems(m, before, after));
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

export const BOTH_SECTIONS =
  'Checks: a ticket holds ## Done when or ## Checks, never both, since only one of them is graded. Remove ## Done when (replace it with an empty body) in this same write, so every item it drops moves into a check or goes to sign-off.';

export const TICKED_BY_GRADER =
  'checks are ticked by the grader that reads their evidence, not by hand';

/**
 * Ticks this write puts on a check. Only the project's grader ticks a check, and it writes Linear
 * itself, never through this server: so a check this write ticks, a new check that arrives ticked and a
 * reworded check that stays ticked are all refused. Unticking, and keeping a tick on an unchanged
 * check, are not.
 */
function tickProblems(m: ChecksModule, before: string, after: string): string[] {
  const had = checksById(m, before);
  return [...checksById(m, after)].flatMap(([id, { text, ticked }]) => {
    if (!ticked) return [];
    const prev = had.get(id);
    if (!prev)
      return [
        `Checks: ${id} is new and arrives ticked; a new check arrives unticked, since ${TICKED_BY_GRADER}`,
      ];
    if (!prev.ticked) return [`Checks: this write ticks ${id}; ${TICKED_BY_GRADER}`];
    if (prev.text !== text)
      return [
        `Checks: ${id} is reworded and stays ticked; a reword voids its grade, so it arrives unticked, since ${TICKED_BY_GRADER}`,
      ];
    return [];
  });
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
 * Whether a Done when item may move into this check with no sign-off. The item's text says nothing
 * about how it is proved, so the kind and target are the migrating agent's choice, and the kind picks
 * the grader: a run, read, fault, telemetry or monitor check is closed by the grader's own proof. Only
 * the check an unmigrated item would have had passes through: a fresh walker on either host, as a
 * visitor, still to be graded. Any other kind or profile is a choice a person approves. The whole
 * exemption is this function; returning false sends every migrated item to sign-off.
 */
function migrationExempt(check: Check): boolean {
  return !check.ticked && check.kind === 'walk' && check.target.endsWith('/visitor');
}

/**
 * The Done when items a write drops (done-when.ts droppedChecks, in the same form) that it did not carry
 * into ## Checks. Only a migration moves items: a write that removes Done when and adds ## Checks in the
 * same step. An item moved when its text, its citation aside, is the whole claim of exactly one check
 * this write adds, and that check passes migrationExempt. A ticked item moves the same way and arrives
 * unticked: its tick was the old gate's, and a check is graded afresh. Every other dropped item, and
 * every item in any other write, still needs sign-off.
 */
export function notMigrated(m: ChecksModule, before: string, after: string): string[] {
  const dropped = doneWhenDropped(before, after);
  const shown = dropped.map((d) => d.shown);
  const migration =
    hasSection(before, 'Done when') &&
    !hasSection(after, 'Done when') &&
    !hasSection(before, 'Checks') &&
    m.parseChecks(after) !== null;
  if (!migration) return shown;
  // The ticket had no ## Checks before this write, so every check is one this write adds.
  const added = m.parseChecks(after)?.checks ?? [];
  return dropped
    .filter(({ item }) => {
      const matches = added.filter((c) => sameText(c.claim, item));
      const [only] = matches;
      return !(matches.length === 1 && only && migrationExempt(only));
    })
    .map((d) => d.shown);
}
