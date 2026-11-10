/**
 * A ticket description is the current state of the ticket, split into named
 * sections under markdown headings. This module reads and patches those
 * sections and validates what may go into each one. It is pure: no I/O.
 *
 * Sections are ATX headings (`## Observed`) matched by name, case-insensitive,
 * at any level. A section runs until the next heading of the same or a higher
 * level, or until a generated block begins. Generated blocks are delimited by
 * `<!-- name:begin -->` / `<!-- name:end -->`, are written by tools, and are
 * never touched here.
 */

export const SECTION_ORDER = [
  'Observed',
  'Cause',
  'Fix',
  'Checks',
  'Done when',
  'Open questions',
] as const;
export type SectionName = (typeof SECTION_ORDER)[number];

/** The sections a ticket on a team that does not use ## Checks has: Checks is not one of them. */
const WITHOUT_CHECKS: readonly SectionName[] = SECTION_ORDER.filter((name) => name !== 'Checks');
const sectionOrder = (checks: boolean): readonly SectionName[] =>
  checks ? SECTION_ORDER : WITHOUT_CHECKS;

/** Sections set_state may write. Open questions changes only through ask/answer comments. */
export const PATCHABLE_SECTIONS: readonly SectionName[] = ['Observed', 'Cause', 'Fix', 'Done when'];

/** The same, on a team whose tickets carry ## Checks (checks.ts). */
export const CHECKS_PATCHABLE_SECTIONS: readonly SectionName[] = [
  'Observed',
  'Cause',
  'Fix',
  'Checks',
  'Done when',
];

/**
 * Not a section: the one "Impact: ..." line at the top of the description, saying in plain
 * language who notices this work. It is a field a patch can set, alongside the sections.
 */
export const IMPACT = 'Impact';
const IMPACT_LINE = /^[ \t]*(?:\u{1F916}[ \t]*)*impact[ \t]*:/iu;

/** Sets or replaces the description's Impact line, keeping it first. */
export function setImpactLine(description: string, body: string): string {
  const text = body.trim().replace(/^impact[ \t]*:[ \t]*/i, '');
  const kept = trimBlankEdges(splitLines(description).filter((line) => !IMPACT_LINE.test(line)));
  return [`Impact: ${text}`, ...(kept.length > 0 ? ['', ...kept] : [])].join('\n');
}

/**
 * The text of the description's Impact line, without its "Impact:" label or robot prefix, with each
 * run of whitespace read as one space; null when there is none or it is empty.
 */
export function impactText(description: string): string | null {
  const line = splitLines(description).find((l) => IMPACT_LINE.test(l));
  const text = line?.replace(IMPACT_LINE, '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function validateImpact(patch: SectionPatch): string[] {
  const errors: string[] = [];
  const lines = splitLines(patch.body).filter((line) => line.trim() !== '');
  if (patch.mode !== 'replace') errors.push('Impact: use mode "replace"; there is one Impact line');
  if (lines.length !== 1)
    errors.push('Impact: one line, in plain language a PM or exec would understand');
  if (lines.some((line) => HEADING.test(line) || line.includes('<!--')))
    errors.push('Impact: plain text only');
  return errors;
}

export type PatchMode = 'replace' | 'append';

export interface SectionPatch {
  section: string;
  mode: PatchMode;
  body: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const CHECKS_HEADING = /^#{1,6}\s+checks\s*#*\s*$/i;
/** Tool-written lines that end the section above them: a generated block, or the reconciled marker. */
export const BOUNDARY = /<!--\s*(?:[\w.-]+:begin\s*|strict:reconciled\b[^>]*)-->/;
const GENERATED_ANY = /<!--\s*[\w.-]+:(begin|end)\s*-->/;
/**
 * The description with every generated block removed, begin and end markers included. A tool
 * rewrites its own block on a schedule (ticket-facts' Live state), and that rewrite says nothing
 * about the text an agent read, patched or claimed, so the base check, the claim check and the
 * changed-elsewhere check compare descriptions through this.
 */
export function withoutGeneratedBlocks(text: string): string {
  return text.replace(/<!--\s*([\w.-]+):begin\s*-->[\s\S]*?<!--\s*\1:end\s*-->\n?/g, '');
}

// A time after the date is allowed (2026-09-25 04:40Z); only the date is checked.
const OBSERVED_LINE =
  /^(?:[-*]\s+)?(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2}| ?UTC)?)?\s+·\s+(\S.*?)\s+·\s+(\S.*)$/;
const CHECKLIST_LINE = /^[-*]\s+\[( |x|X)\]\s+\S/;
const QUESTION_ROW = /^[-*]\s+(Q\d+)\s+·\s+(OPEN|ANSWERED\b[^·]*?)\s*·/;

interface Heading {
  line: number;
  level: number;
  name: string;
}

interface SectionSpan {
  headingLine: number;
  level: number;
  /** First body line (the line after the heading). */
  start: number;
  /** One past the last body line. */
  end: number;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function scanHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = HEADING.exec(line);
    const [, hashes, name] = match ?? [];
    if (hashes && name) headings.push({ line: index, level: hashes.length, name: name.trim() });
  });
  return headings;
}

function canonicalName(name: string, checks: boolean): SectionName | null {
  const wanted = name.trim().toLowerCase();
  return sectionOrder(checks).find((section) => section.toLowerCase() === wanted) ?? null;
}

/**
 * Every span headed `name`, at any level and in any case. A heading is a line at column 0 that reads
 * `#{1,6} text`, outside a code fence; a span ends at the next heading of the same or a higher level,
 * or at a generated block. This is the one definition of a section: every reader, the ## Checks
 * interpreter included, takes its span from here, so a line is a heading for one if and only if it is
 * one for all.
 */
function sectionSpans(lines: string[], name: string): SectionSpan[] {
  const headings = scanHeadings(lines);
  return headings
    .filter((heading) => heading.name.toLowerCase() === name.toLowerCase())
    .map((heading) => {
      let end = lines.length;
      const next = headings.find((h) => h.line > heading.line && h.level <= heading.level);
      if (next) end = next.line;
      const generated = lines.findIndex(
        (line, i) => i > heading.line && i < end && BOUNDARY.test(line),
      );
      if (generated !== -1) end = generated;
      return { headingLine: heading.line, level: heading.level, start: heading.line + 1, end };
    });
}

function findSection(lines: string[], name: SectionName): SectionSpan | null {
  const matches = sectionSpans(lines, name);
  if (matches.length > 1) {
    throw new Error(
      `The description has ${matches.length} "${name}" headings (lines ${matches
        .map((m) => m.headingLine + 1)
        .join(', ')}). Merge them by hand before patching; picking one would hide the other.`,
    );
  }
  return matches[0] ?? null;
}

/**
 * Each section headed `name`, as its heading line and its body lines untrimmed, read by the same rules
 * as readSection. More than one means the description has two such headings, which no reader may
 * resolve by picking one.
 */
export function sectionsNamed(
  description: string,
  name: string,
): { heading: string; body: string[] }[] {
  const lines = splitLines(description);
  return sectionSpans(lines, name).map((span) => ({
    heading: lines[span.headingLine] ?? '',
    body: lines.slice(span.start, span.end),
  }));
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === '';
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start])) start++;
  while (end > start && isBlank(lines[end - 1])) end--;
  return lines.slice(start, end);
}

/** Returns the body of a section, or null when the description has no such heading. */
export function readSection(description: string, name: SectionName): string | null {
  const lines = splitLines(description);
  const span = findSection(lines, name);
  if (!span) return null;
  return trimBlankEdges(lines.slice(span.start, span.end)).join('\n');
}

/** Every validation error for putting `body` into `section`. Empty means valid. */
export function validateSectionBody(section: SectionName, body: string): string[] {
  const errors: string[] = [];
  const lines = splitLines(body).filter((line) => line.trim() !== '');

  if (lines.length === 0) errors.push(`${section}: body is empty`);
  if (GENERATED_ANY.test(body)) {
    errors.push(
      `${section}: body contains a generated-block marker; generated blocks are written by tools only`,
    );
  }
  if (body.includes('strict:reconciled')) {
    errors.push(
      `${section}: body contains the reconciled marker; set it with reconciled_through instead`,
    );
  }
  for (const line of lines) {
    if (HEADING.test(line)) {
      errors.push(
        `${section}: body contains a heading ("${line.trim()}"), which would split the section`,
      );
    } else if (CHECKS_HEADING.test(line.trimStart())) {
      // trimStart drops NBSP and BOM too. Linear may store an indented heading at column 0.
      errors.push(
        `${section}: body contains a "${line.trim()}" line behind leading whitespace, which Linear may store as a heading`,
      );
    }
  }

  if (section === 'Observed') {
    for (const line of lines) {
      const match = OBSERVED_LINE.exec(line.trim());
      if (!match) {
        const sourced = line.split(' · ').length >= 3;
        errors.push(
          `Observed: "${line.trim()}" is not "YYYY-MM-DD · <source> · <result>" (a time after the date is fine).` +
            (sourced
              ? ''
              : ' A line with no source is a hypothesis; put it under Cause as "not established" instead.'),
        );
      } else if (Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`))) {
        errors.push(`Observed: "${match[1]}" is not a real date`);
      }
    }
  }

  // Checks gets its full grammar from the project's rulebook (checks.ts); here only the shape.
  if (section === 'Done when' || section === 'Checks') {
    for (const line of lines) {
      if (!CHECKLIST_LINE.test(line.trim())) {
        errors.push(
          `${section}: "${line.trim()}" is not a checklist item ("- [ ] <check that proves it>")`,
        );
      }
    }
  }

  return errors;
}

/**
 * Validates every patch and applies them in order. Throws with all
 * validation errors at once, so a caller fixes everything in one round.
 * Checks is a section only when `allowed` names it, i.e. on a team that uses one.
 */
export function applySectionPatches(
  description: string,
  patches: SectionPatch[],
  allowed: readonly SectionName[] = PATCHABLE_SECTIONS,
): string {
  const checks = allowed.includes('Checks');
  const errors: string[] = [];
  const resolved: {
    name: SectionName | typeof IMPACT;
    mode: PatchMode | 'remove';
    body: string;
  }[] = [];

  for (const patch of patches) {
    if (patch.section.trim().toLowerCase() === 'impact') {
      errors.push(...validateImpact(patch));
      resolved.push({ name: IMPACT, mode: patch.mode, body: patch.body });
      continue;
    }
    const name = canonicalName(patch.section, checks);
    if (!name) {
      errors.push(
        `"${patch.section}" is not a known section (${[IMPACT, ...sectionOrder(checks)].join(', ')})`,
      );
      continue;
    }
    if (!allowed.includes(name)) {
      errors.push(
        name === 'Open questions'
          ? 'Open questions changes only through comment kind "ask" (adds a row) or "answer" (closes one)'
          : `"${name}" cannot be patched here`,
      );
      continue;
    }
    // Emptying Done when removes it, for a ticket whose checks moved to ## Checks (checked below).
    if (checks && name === 'Done when' && patch.mode === 'replace' && patch.body.trim() === '') {
      resolved.push({ name, mode: 'remove', body: '' });
      continue;
    }
    errors.push(...validateSectionBody(name, patch.body));
    resolved.push({ name, mode: patch.mode, body: patch.body });
  }

  if (errors.length > 0) throw new Error(`Description patch refused:\n- ${errors.join('\n- ')}`);

  let result = description;
  for (const patch of resolved) {
    result =
      patch.name === IMPACT
        ? setImpactLine(result, patch.body)
        : patch.mode === 'remove'
          ? removeSection(result, patch.name)
          : patchSection(result, patch.name, patch.mode, patch.body, checks);
  }
  if (resolved.some((p) => p.mode === 'remove') && !sectionExists(splitLines(result), 'Checks'))
    throw new Error(
      'Description patch refused:\n- Done when: body is empty. Only a ticket with a ## Checks section may drop Done when.',
    );
  return result;
}

/** The description without one section, heading and body. */
function removeSection(description: string, name: SectionName): string {
  const lines = splitLines(description);
  const span = findSection(lines, name);
  if (!span) return description;
  const kept = [...lines.slice(0, span.headingLine), ...lines.slice(span.end)];
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '');
}

/** Applies one patch without validation. Exported for the ask/answer row writers. */
export function patchSection(
  description: string,
  name: SectionName,
  mode: PatchMode,
  body: string,
  checks = false,
): string {
  const lines = splitLines(description);
  const span = findSection(lines, name);
  const existing = span ? trimBlankEdges(lines.slice(span.start, span.end)) : [];
  let bodyLines = trimBlankEdges(splitLines(body));
  if (name === 'Observed' || name === 'Done when' || name === 'Checks')
    bodyLines = bulleted(bodyLines, existing);

  if (span) {
    const newBody = mode === 'append' ? [...existing, ...bodyLines] : bodyLines;
    const after = lines.slice(span.end);
    const replacement = ['', ...newBody, ...(after.length > 0 ? [''] : [])];
    return [...lines.slice(0, span.start), ...replacement, ...after].join('\n');
  }

  return insertSection(lines, name, bodyLines, checks).join('\n');
}

// Observed and Done when are lists, and markdown splits a list two ways: a line without a bullet
// under a bulleted list is a continuation of the item above, and a change of bullet character
// starts a new list. Linear stores both, as a folded item or a list broken by blank lines. Each
// written line gets the bullet the section already uses, or "-".
function bulleted(bodyLines: string[], existing: string[]): string[] {
  const marker = /^([-*])\s/.exec(existing.find((line) => /^[-*]\s/.test(line)) ?? '')?.[1] ?? '-';
  return bodyLines.map((line) =>
    line.trim() === '' ? line : `${marker} ${line.trim().replace(/^[-*]\s+/, '')}`,
  );
}

function insertSection(
  lines: string[],
  name: SectionName,
  bodyLines: string[],
  checks: boolean,
): string[] {
  const sections = sectionOrder(checks);
  const order = sections.indexOf(name);
  const later = sections
    .slice(order + 1)
    .map((section) => findSection(lines, section))
    .filter((span): span is SectionSpan => span !== null)
    .sort((a, b) => a.headingLine - b.headingLine)[0];

  let at: number;
  let level = 2;
  if (later) {
    at = later.headingLine;
    level = later.level;
  } else {
    const generated = lines.findIndex((line) => BOUNDARY.test(line));
    at = generated === -1 ? lines.length : generated;
    const earlier = sections
      .slice(0, order)
      .map((section) => findSection(lines, section))
      .find((span): span is SectionSpan => span !== null);
    if (earlier) level = earlier.level;
  }

  const before = lines.slice(0, at);
  while (before.length > 0 && isBlank(before.at(-1))) before.pop();
  const after = lines.slice(at);
  const block = [`${'#'.repeat(level)} ${name}`, '', ...bodyLines];
  return [
    ...before,
    ...(before.length > 0 ? [''] : []),
    ...block,
    ...(after.length > 0 ? ['', ...after] : []),
  ];
}

/**
 * The reconciled marker is the description's HEAD: it names the last comment
 * whose content the description already reflects. Every comment after it,
 * from any client, is unreconciled until someone folds it in and moves the
 * marker. That is how tickets written through other servers get repaired by
 * whoever reads them next through this one.
 */
export interface ReconciledMarker {
  through: string;
  at: string;
  by: string;
  /** When the comments were last checked against the description. Markers written before it existed lack it. */
  checked?: string | undefined;
}

const MARKER =
  /^<!--\s*strict:reconciled\s+through=(\S+)\s+at=(\S+)\s+by="([^"]*)"(?:\s+checked=(\S+))?\s*-->\s*$/;

export function readMarker(description: string): ReconciledMarker | null {
  for (const line of splitLines(description)) {
    const match = MARKER.exec(line.trim());
    const [, through, at, by, checked] = match ?? [];
    if (through && at && by !== undefined)
      return checked ? { through, at, by, checked } : { through, at, by };
  }
  return null;
}

/**
 * The description without a marker line. Markers were once written into the
 * description; they now live in an attachment (marker.ts), and a write
 * through this server moves a line it finds there.
 */
export function stripMarker(description: string): string {
  if (!readMarker(description)) return description;
  const lines = splitLines(description).filter((candidate) => !MARKER.test(candidate.trim()));
  while (lines.length > 0 && isBlank(lines.at(-1))) lines.pop();
  return lines.join('\n');
}

export function writeMarker(description: string, marker: ReconciledMarker): string {
  const line = `<!-- strict:reconciled through=${marker.through} at=${marker.at} by="${marker.by.replace(/"/g, "'")}"${marker.checked ? ` checked=${marker.checked}` : ''} -->`;
  const lines = splitLines(description).filter((candidate) => !MARKER.test(candidate.trim()));
  while (lines.length > 0 && isBlank(lines.at(-1))) lines.pop();
  return [...lines, ...(lines.length > 0 ? [''] : []), line].join('\n');
}

export interface Finding {
  code: string;
  detail: string;
}

/**
 * Structural problems in a description, for whoever reads it next to fix.
 * Advisory: a read never fails on these. Semantic drift (a comment asserting
 * something the description contradicts) is the reader's job; the drift
 * counts in get_issue say where to look.
 */
/**
 * Format findings for a ticket in a given workflow state type. A closed ticket
 * is not asked for sections it never had, and an open one written without any
 * gets one finding saying what to add before claiming or closing it, not one
 * per missing section on every read.
 */
export function lintForState(
  description: string,
  stateType: string | null,
  checks = false,
): Finding[] {
  const findings = lintDescription(description, checks);
  const missing = findings.filter((finding) => finding.code === 'missing_section');
  const rest = findings.filter((finding) => finding.code !== 'missing_section');
  if (stateType === 'completed' || stateType === 'canceled' || stateType === 'duplicate')
    return rest;
  if (missing.length === 2) {
    return [
      {
        code: 'unstructured',
        detail:
          'Written without Observed or Done when. Before you claim or close it, add them with set_state: Observed for what is established (dated and sourced), Done when for the checks that mean done.',
      },
      ...rest,
    ];
  }
  return findings;
}

function sectionExists(lines: string[], name: SectionName): boolean {
  try {
    return findSection(lines, name) !== null;
  } catch {
    return true;
  }
}

/** `checks`: the ticket's team uses ## Checks, which then stands in for Done when. */
export function lintDescription(description: string, checks = false): Finding[] {
  const findings: Finding[] = [];
  const lines = splitLines(description);

  for (const name of sectionOrder(checks)) {
    let span: SectionSpan | null;
    try {
      span = findSection(lines, name);
    } catch (error) {
      findings.push({ code: 'duplicate_section', detail: (error as Error).message });
      continue;
    }
    if (!span) {
      // A ## Checks section stands in for Done when on the teams that use one.
      const replaced = checks && name === 'Done when' && sectionExists(lines, 'Checks');
      if ((name === 'Observed' || name === 'Done when') && !replaced) {
        findings.push({ code: 'missing_section', detail: `No "${name}" section` });
      }
      continue;
    }
    if (name === 'Observed' || name === 'Done when') {
      const body = trimBlankEdges(lines.slice(span.start, span.end)).join('\n');
      if (body.trim() === '') {
        findings.push({ code: 'empty_section', detail: `"${name}" is empty` });
        continue;
      }
      for (const error of validateSectionBody(name, body))
        findings.push({ code: 'invalid_line', detail: error });
    }
  }
  return findings;
}

const TYPED_COMMENT =
  /^🤖 .+ · \d{4}-\d{2}-\d{2} · (evidence|correction|ask|answer|closed_by|descope)\b/;

/** The kind of a comment written by this server, or null for any other comment. */
export function commentKind(body: string): string | null {
  return TYPED_COMMENT.exec(body.trimStart())?.[1] ?? null;
}

export interface QuestionRow {
  id: string;
  open: boolean;
  line: string;
}

export function listQuestions(description: string): QuestionRow[] {
  const body = readSection(description, 'Open questions');
  if (body === null) return [];
  const rows: QuestionRow[] = [];
  for (const raw of splitLines(body)) {
    const line = raw.trim();
    const [, id, status] = QUESTION_ROW.exec(line) ?? [];
    if (id && status) rows.push({ id, open: status.trim() === 'OPEN', line });
  }
  return rows;
}

export function nextQuestionId(description: string): string {
  const max = listQuestions(description).reduce(
    (n, row) => Math.max(n, Number(row.id.slice(1))),
    0,
  );
  return `Q${max + 1}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Appends an OPEN row to Open questions, creating the section if needed. */
export function addQuestion(
  description: string,
  row: {
    id: string;
    date: string;
    askedBy: string;
    askedTo?: string | undefined;
    question: string;
    link: string;
  },
): string {
  const who = row.askedTo ? `${row.askedBy} → ${oneLine(row.askedTo)}` : row.askedBy;
  const text = `- ${row.id} · OPEN · ${row.date} · ${who} · ${oneLine(row.question)} · [ask](${row.link})`;
  return patchSection(description, 'Open questions', 'append', text);
}

/** Flips one OPEN row to ANSWERED with a link to the answer. */
export function answerQuestion(
  description: string,
  id: string,
  date: string,
  link: string,
): string {
  const rows = listQuestions(description);
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) {
    const known = rows
      .map((candidate) => `${candidate.id}${candidate.open ? '' : ' (answered)'}`)
      .join(', ');
    throw new Error(
      `No question ${id} under Open questions${known ? `; rows are ${known}` : '; the section is empty'}`,
    );
  }
  if (!row.open) throw new Error(`${id} is already answered: ${row.line}`);

  const lines = splitLines(description);
  const span = findSection(lines, 'Open questions');
  const index = span
    ? lines.findIndex((line, i) => i >= span.start && i < span.end && line.trim() === row.line)
    : -1;
  const target = lines[index];
  if (target === undefined)
    throw new Error(`Could not locate ${id} in the description to update it`);
  lines[index] = target.replace(/·\s+OPEN\s+·/, `· ANSWERED ${date} [answer](${link}) ·`);
  return lines.join('\n');
}

const TICKED = /^[-*]\s+\[[xX]\]\s+(.+)$/;
const EVIDENCE: RegExp[] = [
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/, // a commit: hex with a letter and a digit
  /(?:^|[\s(])#\d+\b|\/pull\/\d+/, // a pull request
  /\S+\.[A-Za-z0-9]+:\d+/, // file:line
  /https?:\/\/\S+/, // any link
  /\bObserved\s+\d+\b/i, // a line under Observed
  /\brun\s+#?\d{5,}\b/i, // a CI run
  /`[^`]+`\s*(?:→|->|=>|:)\s*\S/, // a command and what it printed
];

/** The part of a ticked item after its text: after " · " or " — ", or a closing parenthetical. */
function evidenceTail(item: string): string | null {
  const separated = /\s(?:·|—)\s(.+)$/.exec(item);
  if (separated?.[1]) return separated[1];
  const parenthetical = /\(([^()]+)\)\s*$/.exec(item);
  return parenthetical?.[1] ?? null;
}

export interface UncitedItem {
  item: string;
  reason: string;
}

/**
 * Ticked Done when items that do not say what showed them to be true. A tick
 * is a claim, and the citation after the item's text is what a reader checks
 * it against: a commit, a PR, a file:line, a link, a CI run, a line under Observed
 * ("Observed 2", counted from 1), or a command and its result.
 */
export function uncitedTicks(description: string): UncitedItem[] {
  const observed = (readSection(description, 'Observed') ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '').length;
  const uncited: UncitedItem[] = [];
  for (const line of (readSection(description, 'Done when') ?? '').split('\n')) {
    const item = TICKED.exec(line.trim())?.[1];
    if (item === undefined) continue;
    const tail = evidenceTail(item);
    if (tail === null) {
      uncited.push({ item, reason: 'no citation after the item' });
      continue;
    }
    if (!EVIDENCE.some((pattern) => pattern.test(tail))) {
      uncited.push({ item, reason: `"${tail}" gives a result but not where it came from` });
      continue;
    }
    for (const match of tail.matchAll(/\bObserved\s+(\d+)\b/gi)) {
      const n = Number(match[1]);
      if (n < 1 || n > observed)
        uncited.push({
          item,
          reason: `Observed has ${String(observed)} lines, so there is no Observed ${String(n)}`,
        });
    }
  }
  return uncited;
}

/** PR numbers cited in ticked Done when items. */
export function citedPullRequestNumbers(description: string): number[] {
  const numbers = new Set<number>();
  for (const line of (readSection(description, 'Done when') ?? '').split('\n')) {
    const tail = evidenceTail(TICKED.exec(line.trim())?.[1] ?? '');
    if (!tail) continue;
    for (const match of tail.matchAll(/(?:^|[\s(])#(\d+)\b|\/pull\/(\d+)/g))
      numbers.add(Number(match[1] ?? match[2]));
  }
  return [...numbers].sort((a, b) => a - b);
}
