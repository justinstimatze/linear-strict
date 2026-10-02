import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkIssue, citationsIn, gitRepo, report } from '../audit-check.js';
import { type ExportedIssue, exportTeam } from '../audit-export.js';

let dir = '';
const commits: Record<string, string> = {};

function commit(at: string, files: Record<string, string | null>, name: string) {
  for (const [file, body] of Object.entries(files)) {
    const full = path.join(dir, file);
    if (body === null) rmSync(full);
    else {
      execFileSync('mkdir', ['-p', path.dirname(full)]);
      writeFileSync(full, body);
    }
  }
  const env = { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  execFileSync('git', ['-C', dir, 'add', '-A'], { env });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', name], { env });
  commits[name] = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'strict-audit-'));
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'ada@example.invalid']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Ada']);
  commit(
    '2026-09-01T00:00:00Z',
    {
      'src/limits.ts':
        'export const A = 1;\nexport const TIMEOUT_MS = 8_000;\n}\nexport const B = 2;\n',
      'src/gone.ts': 'export const OLD = true;\n',
      'web/a/util.ts': 'x\n',
      'web/b/util.ts': 'y\n',
    },
    'first',
  );
  execFileSync('git', ['-C', dir, 'branch', 'develop']);
  execFileSync('git', ['-C', dir, 'checkout', '-q', 'develop']);
  commit(
    '2026-09-10T00:00:00Z',
    {
      'src/limits.ts':
        'export const A = 1;\n// a new line above\nexport const TIMEOUT_MS = 8_000;\n}\nexport const B = 3;\n',
      'src/gone.ts': null,
    },
    'second',
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function issue(description: string, comments: ExportedIssue['comments'] = []): ExportedIssue {
  return {
    identifier: 'ENG-1',
    url: 'https://linear.app/x/issue/ENG-1',
    createdAt: '2026-09-02T00:00:00Z',
    updatedAt: '2026-09-20T00:00:00Z',
    description,
    versions: [{ at: '2026-09-02T00:00:00Z', text: description }],
    comments,
    omitted: [],
  };
}

const options = { ref: 'develop', main: 'main' };

describe('citation audit', () => {
  it('finds path:line and commit-shaped citations, and skips years, words and URLs', () => {
    const found = citationsIn(
      'see `src/limits.ts:2` and web/a/util.ts:1-1, commit abc1234 in 2026; not deadbeef or https://x.io/a.ts:3',
    );
    expect(found.lines.map((l) => l.cite)).toEqual(['src/limits.ts:2', 'web/a/util.ts:1-1']);
    expect(found.hexes).toEqual(['abc1234']);
  });

  it('judges each line citation against the tree on the day it was cited', () => {
    const findings = checkIssue(
      gitRepo(dir),
      issue('limits.ts:2 limits.ts:4 limits.ts:3 gone.ts:1 util.ts:1 limits.ts:40 nowhere.ts:1'),
      options,
    );
    const verdicts = Object.fromEntries(findings.map((f) => [f.cite, f.verdict]));
    expect(verdicts).toEqual({
      'limits.ts:2': 'moved',
      'limits.ts:4': 'changed',
      'limits.ts:3': 'trivial_line',
      'gone.ts:1': 'file_gone',
      'util.ts:1': 'ambiguous_path',
      'limits.ts:40': 'line_missing_when_cited',
      'nowhere.ts:1': 'not_in_tree_when_cited',
    });
    expect(findings.find((f) => f.cite === 'limits.ts:2')).toMatchObject({ now_line: 3 });
    expect(findings.find((f) => f.cite === 'limits.ts:4')).toMatchObject({
      was: 'export const B = 2;',
      now: '}',
    });
  });

  it('dates a comment citation by the comment, so one written after the edit holds', () => {
    const [finding] = checkIssue(
      gitRepo(dir),
      issue('nothing here', [
        { id: 'c-1', createdAt: '2026-09-11T00:00:00Z', body: 'limits.ts:5' },
      ]),
      options,
    );
    expect(finding).toMatchObject({ in: 'c-1', dated_by: 'comment', verdict: 'holds' });
  });

  it('dates a description citation by the first version that has it', () => {
    const later = issue('limits.ts:5 is B');
    later.versions = [
      { at: '2026-09-02T00:00:00Z', text: 'no citation yet' },
      { at: '2026-09-12T00:00:00Z', text: 'limits.ts:5 is B' },
    ];
    const [finding] = checkIssue(gitRepo(dir), later, options);
    expect(finding).toMatchObject({ dated_by: 'version', verdict: 'holds' });
  });

  it('says whether a cited commit exists and is on main', () => {
    const first = commits['first'] ?? '';
    const second = commits['second'] ?? '';
    const findings = checkIssue(gitRepo(dir), issue(`${first} ${second} 0abc1234ff`), options);
    expect(findings.map((f) => f.verdict)).toEqual(['on_main', 'off_main', 'not_a_commit_here']);
  });

  it('reports counts by verdict and spells out each stale line', () => {
    const text = report(checkIssue(gitRepo(dir), issue('limits.ts:4 limits.ts:2'), options));
    expect(text).toMatch(/line changed\s+1/);
    expect(text).toMatch(
      /limits\.ts:4 \(cited 2026-09-02, dated by version\): changed\n {4}was: export const B = 2;/,
    );
    expect(text).toMatch(/limits\.ts:2 .*: moved to line 3/);
  });
});

describe('citation audit export', () => {
  // ENG-1 is closed, so it comes last; the open ones come newest first.
  const refs = ['ENG-1', 'ENG-2', 'ENG-3'].map((identifier, i) => ({
    id: `i-${String(i)}`,
    identifier,
    updatedAt: `2026-09-0${String(i + 1)}T00:00:00Z`,
    state: { type: identifier === 'ENG-1' ? 'completed' : 'started' },
  }));
  // A stub Linear: the issue list, then each issue, its comments and its (absent) history.
  function stub(failOn?: string) {
    const calls: string[] = [];
    const gql = <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      const op = /query (\w+)/.exec(query)?.[1] ?? '';
      const id = typeof variables['id'] === 'string' ? variables['id'] : '';
      calls.push(`${op} ${id}`);
      if (op === 'StrictAuditTeamIssues')
        return Promise.resolve({
          issues: { nodes: refs, pageInfo: { hasNextPage: false, endCursor: '' } },
        } as T);
      const ref = refs.find((r) => r.id === variables['id']);
      if (!ref) throw new Error(`unexpected ${op}`);
      if (ref.identifier === failOn) return Promise.reject(new Error('Linear rate limit reached'));
      if (op === 'StrictAuditIssue')
        return Promise.resolve({
          issue: {
            ...ref,
            url: 'u',
            createdAt: ref.updatedAt,
            description: `${ref.identifier} body`,
            documentContent: null,
          },
        } as T);
      return Promise.resolve({
        issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: '' } } },
      } as T);
    };
    return { gql, calls };
  }

  it('stops at a failure, keeps what it has, and a rerun fetches only the rest', async () => {
    const first = await exportTeam(stub('ENG-2').gql, 'ENG', new Map(), {
      maxFetch: 10,
      paceMs: 0,
    });
    expect(first.issues.map((i) => i.identifier)).toEqual(['ENG-3']);
    expect(first).toMatchObject({ fetched: 1, pending: 2 });
    expect(first.stopped).toMatch(/ENG-2: Linear rate limit/);

    const again = stub();
    const second = await exportTeam(
      again.gql,
      'ENG',
      new Map(first.issues.map((i) => [i.identifier, i])),
      { maxFetch: 10, paceMs: 0 },
    );
    expect(second.issues.map((i) => i.identifier)).toEqual(['ENG-3', 'ENG-2', 'ENG-1']);
    expect(second).toMatchObject({ fetched: 2, pending: 0, stopped: null });
    expect(again.calls.some((call) => call.endsWith('i-2'))).toBe(false);
  });

  it('fetches at most maxFetch tickets, pacing each, and checkpoints without dropping unreached records', async () => {
    const waits: number[] = [];
    const saves: string[][] = [];
    const full = await exportTeam(stub().gql, 'ENG', new Map(), { maxFetch: 3, paceMs: 0 });
    const closed = full.issues.find((i) => i.identifier === 'ENG-1');
    if (!closed) throw new Error('ENG-1 missing from the full export');
    const old = { ...closed, updatedAt: 'stale' };
    const run = await exportTeam(stub().gql, 'ENG', new Map([['ENG-1', old]]), {
      maxFetch: 2,
      paceMs: 20_000,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      checkpointEvery: 1,
      checkpoint: (issues) => saves.push(issues.map((i) => i.identifier)),
    });
    expect(run).toMatchObject({ fetched: 2, pending: 1, stopped: null });
    expect(waits).toEqual([20_000, 20_000]);
    expect(saves).toEqual([
      ['ENG-3', 'ENG-1'],
      ['ENG-3', 'ENG-2', 'ENG-1'],
    ]);
    expect(run.issues.map((i) => i.identifier)).toEqual(['ENG-3', 'ENG-2', 'ENG-1']);
  });
});
