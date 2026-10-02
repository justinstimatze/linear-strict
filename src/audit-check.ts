/**
 * The offline half of the citation audit. Finds every `path:line` and
 * commit-shaped hex string a ticket cites, dates each one by the description
 * version or comment it first appeared in, and asks git whether it still
 * says what it said then. Nothing here reaches the network.
 */
import { execFileSync } from 'node:child_process';
import type { ExportedIssue } from './audit-export.js';

/** What the check needs from git. `gitRepo` is the real one. */
export interface Repo {
  /** The commit `ref` pointed at, following its first parents, at an ISO time. */
  revAt(ref: string, at: string): string | null;
  files(rev: string): string[];
  /** A file's lines at a commit, or null if it isn't there. */
  lines(rev: string, path: string): string[] | null;
  /** The full hash of a commit, or null if the string names none here. */
  commit(hex: string): string | null;
  isAncestor(commit: string, ref: string): boolean;
}

export type LineVerdict =
  | 'holds'
  | 'moved'
  | 'changed'
  | 'file_gone'
  | 'trivial_line'
  | 'line_missing_when_cited'
  | 'not_in_tree_when_cited'
  | 'ambiguous_path';

export type CommitVerdict = 'on_main' | 'off_main' | 'not_a_commit_here';

interface Where {
  issue: string;
  /** "description", or the comment's id. */
  in: string;
  cited_at: string;
  /** What fixed cited_at: the first description version with it, the comment, or the ticket's own dates. */
  dated_by: 'version' | 'comment' | 'updated';
}

export type Finding =
  | (Where & {
      kind: 'line';
      cite: string;
      verdict: LineVerdict;
      path?: string;
      was?: string;
      now?: string;
      now_line?: number;
      candidates?: string[];
    })
  | (Where & { kind: 'commit'; cite: string; verdict: CommitVerdict; commit?: string });

const EXTENSIONS =
  'ts|tsx|js|jsx|mjs|cjs|py|go|rs|svelte|vue|sql|sh|yml|yaml|json|toml|css|scss|html|md';
const LINE_CITE = new RegExp(
  `(?<![\\w/.-])((?:[\\w.@-]+/)*[\\w.@-]+\\.(?:${EXTENSIONS})):(\\d+)(?:-(\\d+))?(?![\\w.])`,
  'g',
);
const HEX = /(?<![\w/#.@-])[0-9a-f]{7,40}(?![\w-])/g;

/** Citations in one text, in order. Hex strings need a letter and a digit, so years and words don't count. */
export function citationsIn(text: string) {
  const lines = [...text.matchAll(LINE_CITE)].map((m) => ({
    cite: m[0],
    path: m[1] ?? '',
    from: Number(m[2]),
    to: m[3] ? Number(m[3]) : Number(m[2]),
  }));
  const hexes = [...text.matchAll(HEX)]
    .map((m) => m[0])
    .filter((hex) => /[a-f]/.test(hex) && /\d/.test(hex));
  return { lines, hexes };
}

// A line with no letters or digits (a brace, a blank) can't anchor a citation: it matches anywhere.
function trivial(line: string) {
  return !/[\p{L}\p{N}]{2}/u.test(line);
}

interface LineCite {
  cite: string;
  path: string;
  from: number;
  to: number;
}

export interface CheckOptions {
  /** The branch citations are read against, origin/main unless a repo lands work on another branch first. */
  ref: string;
  /** Where a commit has to be for on_main, e.g. origin/main. */
  main: string;
}

export function checkLine(repo: Repo, where: Where, c: LineCite, options: CheckOptions): Finding {
  const base = { ...where, kind: 'line' as const, cite: c.cite };
  const then = repo.revAt(options.ref, where.cited_at);
  if (!then) return { ...base, verdict: 'not_in_tree_when_cited' };
  const matches = (path: string) => path === c.path || path.endsWith(`/${c.path}`);
  const candidates = repo.files(then).filter(matches);
  if (candidates.length === 0) return { ...base, verdict: 'not_in_tree_when_cited' };
  if (candidates.length > 1) return { ...base, verdict: 'ambiguous_path', candidates };
  const path = candidates[0] ?? '';
  const old = repo.lines(then, path) ?? [];
  if (c.to > old.length || c.from < 1) return { ...base, path, verdict: 'line_missing_when_cited' };
  const was = old.slice(c.from - 1, c.to);
  const wasText = was.join('\n');
  if (was.every(trivial)) return { ...base, path, was: wasText, verdict: 'trivial_line' };

  const now = repo.lines(options.ref, path);
  if (!now) return { ...base, path, was: wasText, verdict: 'file_gone' };
  const nowText = now.slice(c.from - 1, c.to).join('\n');
  if (nowText === wasText) return { ...base, path, verdict: 'holds' };

  // The same lines, in the same order, somewhere else in the file now.
  const starts: number[] = [];
  for (let i = 0; i + was.length <= now.length; i++) {
    if (was.every((line, k) => line.trim() === (now[i + k] ?? '').trim())) starts.push(i + 1);
  }
  const [only, ...others] = starts;
  if (only !== undefined && others.length === 0)
    return { ...base, path, was: wasText, verdict: 'moved', now_line: only };
  return { ...base, path, was: wasText, now: nowText, verdict: 'changed' };
}

export function checkCommit(repo: Repo, where: Where, hex: string, options: CheckOptions): Finding {
  const commit = repo.commit(hex);
  if (!commit) return { ...where, kind: 'commit', cite: hex, verdict: 'not_a_commit_here' };
  return {
    ...where,
    kind: 'commit',
    cite: hex,
    commit,
    verdict: repo.isAncestor(commit, options.main) ? 'on_main' : 'off_main',
  };
}

/** When a description citation first appeared: the oldest saved version containing it. */
function firstSeen(issue: ExportedIssue, cite: string): Pick<Where, 'cited_at' | 'dated_by'> {
  const version = issue.versions.find((v) => v.text.includes(cite));
  return version
    ? { cited_at: version.at, dated_by: 'version' }
    : { cited_at: issue.updatedAt, dated_by: 'updated' };
}

/** Every citation in a ticket's current description and its comments, checked. */
export function checkIssue(repo: Repo, issue: ExportedIssue, options: CheckOptions): Finding[] {
  const findings: Finding[] = [];
  const texts = [
    { in: 'description', body: issue.description, comment: null as string | null },
    ...issue.comments.map((c) => ({ in: c.id, body: c.body, comment: c.createdAt })),
  ];
  for (const text of texts) {
    const { lines, hexes } = citationsIn(text.body);
    const seen = new Set<string>();
    const where = (cite: string): Where => ({
      issue: issue.identifier,
      in: text.in,
      ...(text.comment
        ? { cited_at: text.comment, dated_by: 'comment' as const }
        : firstSeen(issue, cite)),
    });
    for (const c of lines) {
      if (seen.has(c.cite)) continue;
      seen.add(c.cite);
      findings.push(checkLine(repo, where(c.cite), c, options));
    }
    for (const hex of hexes) {
      if (seen.has(hex)) continue;
      seen.add(hex);
      findings.push(checkCommit(repo, where(hex), hex, options));
    }
  }
  return findings;
}

/** The real repo, through the git CLI, with every answer cached for the run. */
export function gitRepo(dir: string): Repo {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };
  const memo = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const cache = new Map<string, R>();
    return (...args: A) => {
      const key = JSON.stringify(args);
      if (!cache.has(key)) cache.set(key, fn(...args));
      return cache.get(key) as R;
    };
  };
  return {
    revAt: memo(
      (ref: string, at: string) =>
        git(['rev-list', '-1', '--first-parent', `--before=${at}`, ref])?.trim() || null,
    ),
    files: memo((rev: string) => (git(['ls-tree', '-r', '--name-only', rev]) ?? '').split('\n')),
    lines: memo((rev: string, path: string) => {
      const out = git(['show', `${rev}:${path}`]);
      return out === null ? null : out.split('\n');
    }),
    commit: memo(
      (hex: string) => git(['rev-parse', '--verify', '--quiet', `${hex}^{commit}`])?.trim() || null,
    ),
    isAncestor: memo((commit: string, ref: string) => {
      try {
        execFileSync('git', ['-C', dir, 'merge-base', '--is-ancestor', commit, ref], {
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    }),
  };
}

const ATTENTION: string[] = ['changed', 'moved', 'file_gone'];

/** A plain-text report: counts by verdict, then each citation that no longer shows what it cited. */
export function report(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const key = `${f.kind} ${f.verdict}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = ['Citations by verdict:'];
  for (const [key, n] of [...counts].sort()) out.push(`  ${key.padEnd(34)} ${String(n)}`);
  const stale = findings.filter((f) => f.kind === 'line' && ATTENTION.includes(f.verdict));
  if (stale.length > 0) out.push('', 'Line citations that no longer show what they cited:');
  for (const f of stale) {
    if (f.kind !== 'line') continue;
    const head = `${f.issue} ${f.in === 'description' ? 'description' : `comment ${f.in}`} · ${f.cite} (cited ${f.cited_at.slice(0, 10)}, dated by ${f.dated_by})`;
    if (f.verdict === 'moved') out.push(`${head}: moved to line ${String(f.now_line)}`);
    else if (f.verdict === 'file_gone') out.push(`${head}: ${f.path ?? ''} is gone`);
    else out.push(`${head}: changed\n    was: ${f.was ?? ''}\n    now: ${f.now ?? ''}`);
  }
  return out.join('\n');
}
