import { existsSync } from 'node:fs';
import { memoryClaimStore } from '../claims.js';
import {
  type ChecksModule,
  checksRulesFromEnv,
  checksWriteProblems,
  droppedChecksById,
  notMigrated,
} from '../checks.js';
import { type SignOffRequest, StrictLinear } from '../strict-linear.js';
import { fakeGql, fakeState } from './strict-fake-linear.helper.js';

// A stand-in for the project's checks module: the same interface, a two-kind grammar. The real one
// is exercised at the bottom when LINEAR_STRICT_CHECKS_MODULE_TEST names one on this machine.
const LINE = /^- \[( |x)\] (C[1-9][0-9]*) · (walk|read) ([^·]+?) · (.+?)(?: <!-- (.+) -->)?$/;
const fake: ChecksModule = {
  parseChecks(description) {
    const m = /(?:^|\n)## Checks\n([\s\S]*?)(?=\n## |$)/.exec(description);
    if (!m?.[1]) return null;
    const checks = [];
    const problems = [];
    for (const raw of m[1].split('\n')) {
      const l = raw.trim();
      if (!l) continue;
      const p = LINE.exec(l);
      if (!p) {
        problems.push(`not a check line: ${l}`);
        continue;
      }
      const [, box, id = '', kind = '', target = '', claim = '', from] = p;
      const quotes = [...(from ?? '').matchAll(/impact "([^"]+)"/g)].map((q) => q[1] ?? '');
      checks.push({
        id,
        ticked: box === 'x',
        kind,
        target: target.trim(),
        claim,
        from: from ?? null,
        quotes,
        line: l,
      });
    }
    return { checks, problems };
  },
  impactCoverage(impact, checks) {
    const quotes = checks.flatMap((c) => c.quotes);
    return {
      misquoted: checks.flatMap((c) =>
        c.quotes.filter((q) => !(impact ?? '').includes(q)).map((quote) => ({ id: c.id, quote })),
      ),
      uncovered: (impact ?? '')
        .split(/\W+/)
        .filter((w) => w.length >= 4 && !quotes.some((q) => q.includes(w))),
    };
  },
  impactLine: (description) => /^Impact:\s*(.*)$/m.exec(description)?.[1] ?? null,
};

const IMPACT = 'Impact: a visitor sees the cap';
const C1 =
  '- [ ] C1 · walk alpha/visitor · the reply names the cap <!-- from impact "a visitor sees the cap" -->';
const C2 = '- [ ] C2 · read posthog-flag cap env=production · on <!-- from D2 -->';
const withChecks = (...lines: string[]) => `${IMPACT}\n\n## Checks\n\n${lines.join('\n')}`;

function setup(description: string, teams = ['ENG']) {
  const state = fakeState();
  state.issue.description = description;
  const asked: SignOffRequest[] = [];
  const strict = new StrictLinear({
    gql: fakeGql(state),
    claims: memoryClaimStore(),
    now: () => new Date('2026-11-07T12:00:00Z'),
    checks: { teams, module: fake },
    signOff: (request) => {
      asked.push(request);
      return Promise.resolve('approved');
    },
  });
  return { state, strict, asked };
}

describe('LINEAR_STRICT_CHECKS_TEAMS and LINEAR_STRICT_CHECKS_MODULE', () => {
  const load = () => Promise.resolve(fake);

  it('is off with neither set, and refuses to start with only one, a bad key, or a module that will not load', async () => {
    expect(await checksRulesFromEnv({}, load)).toBeUndefined();
    await expect(checksRulesFromEnv({ LINEAR_STRICT_CHECKS_TEAMS: 'CUR' }, load)).rejects.toThrow(
      'together, or neither',
    );
    await expect(
      checksRulesFromEnv(
        { LINEAR_STRICT_CHECKS_TEAMS: 'CUR,so-l', LINEAR_STRICT_CHECKS_MODULE: '/m.mjs' },
        load,
      ),
    ).rejects.toThrow('not a team key: SO-L');
    await expect(
      checksRulesFromEnv(
        { LINEAR_STRICT_CHECKS_TEAMS: 'CUR', LINEAR_STRICT_CHECKS_MODULE: '/m.mjs' },
        () => Promise.reject(new Error('ENOENT')),
      ),
    ).rejects.toThrow('/m.mjs did not load: ENOENT');
    await expect(
      checksRulesFromEnv(
        { LINEAR_STRICT_CHECKS_TEAMS: 'CUR', LINEAR_STRICT_CHECKS_MODULE: '/m.mjs' },
        () => Promise.resolve({ parseChecks: (d: string) => fake.parseChecks(d) }),
      ),
    ).rejects.toThrow('does not export impactCoverage, impactLine');
    expect(
      await checksRulesFromEnv(
        { LINEAR_STRICT_CHECKS_TEAMS: 'cur, sol', LINEAR_STRICT_CHECKS_MODULE: '/m.mjs' },
        load,
      ),
    ).toEqual({ teams: ['CUR', 'SOL'], module: fake });
  });
});

describe('a ## Checks write on a team that uses one', () => {
  it('refuses a line the project module cannot read, and lands one it can', async () => {
    const { strict, state } = setup(withChecks(C1));
    await expect(
      strict.setState('ENG-1', [
        { section: 'Checks', mode: 'append', body: '- [ ] C2 · eyeball it · fine' },
      ]),
    ).rejects.toThrow('Checks: not a check line: - [ ] C2 · eyeball it · fine');
    await strict.setState('ENG-1', [{ section: 'Checks', mode: 'append', body: C2 }]);
    expect(state.issue.description).toContain(C2);
  });

  it('refuses an Impact claim no check quotes, and a quote the Impact does not say', async () => {
    const { strict } = setup(withChecks(C1));
    await expect(
      strict.setState('ENG-1', [
        { section: 'Impact', mode: 'replace', body: 'a visitor sees the cap and a reset time' },
      ]),
    ).rejects.toThrow('Impact claim has no check: no check quotes "reset", "time"');
    await expect(
      strict.setState('ENG-1', [{ section: 'Impact', mode: 'replace', body: 'the cap shows' }]),
    ).rejects.toThrow('C1 quotes "a visitor sees the cap", which the Impact line does not say');
  });

  it('asks for sign-off on a reworded or retired check, by id, and not on a tick or a new check', async () => {
    const { strict, asked } = setup(withChecks(C1, C2));
    await strict.setState('ENG-1', [
      { section: 'Checks', mode: 'replace', body: [C1.replace('[ ]', '[x]'), C2].join('\n') },
    ]);
    expect(asked).toHaveLength(0);
    await strict.setState(
      'ENG-1',
      [
        {
          section: 'Checks',
          mode: 'replace',
          body: [C1.replace('names the cap', 'mentions a limit'), C2].join('\n'),
        },
      ],
      {
        descope_reason: 'the reply words it as a limit',
        descope_risk: 'a reply that never says cap passes',
      },
    );
    expect(asked[0]?.dropped).toEqual([
      'C1 · walk alpha/visitor · the reply names the cap (reworded)',
    ]);
    expect(asked[0]?.added).toEqual(['C1 · walk alpha/visitor · the reply mentions a limit']);
  });

  it('leaves Checks to the shape check alone on a team not listed', async () => {
    const { strict, state } = setup(withChecks(C1), ['CUR']);
    await strict.setState('ENG-1', [
      { section: 'Checks', mode: 'append', body: '- [ ] anything at all' },
    ]);
    expect(state.issue.description).toContain('- [ ] anything at all');
  });
});

describe('ids, retirement and migration', () => {
  it('never issues an id again, and only issues ids above the highest the ticket has had', () => {
    const before = withChecks(C1);
    const earlier = [withChecks(C1, C2, '- [ ] C3 · walk www/staff · seen <!-- from D3 -->')];
    expect(checksWriteProblems(fake, before, withChecks(C1, C2), earlier)).toEqual([
      'Checks: C2 was used before and retired; ids are never reused, so give this check C4',
    ]);
    expect(checksWriteProblems(fake, withChecks(C2), withChecks(C1, C2))).toEqual([
      'Checks: C1 is not above C2, the highest id this ticket has had; ids are assigned in increasing order',
    ]);
    expect(droppedChecksById(fake, withChecks(C1, C2), withChecks(C1))).toEqual([
      'C2 · read posthog-flag cap env=production · on (retired)',
    ]);
  });

  it('moves a Done when item into ## Checks without sign-off only when its text lands whole in exactly one claim', () => {
    const after = withChecks(
      '- [ ] C1 · read posthog-flag cap env=production · on, the flag is on in production <!-- from D1 -->',
    );
    expect(
      notMigrated(fake, after, [
        'the flag is on in production',
        'a walk sees the cap (already ticked)',
      ]),
    ).toEqual(['a walk sees the cap (already ticked)']);
  });

  it('migrates a ticket from Done when to Checks with no sign-off when every item moved whole', async () => {
    const { strict, asked, state } = setup(
      `${IMPACT}\n\n## Done when\n\n- [ ] the reply names the cap`,
    );
    await strict.setState('ENG-1', [
      { section: 'Checks', mode: 'replace', body: C1 },
      { section: 'Done when', mode: 'replace', body: '' },
    ]);
    expect(asked).toHaveLength(0);
    expect(state.issue.description).toContain('## Checks');
  });
});

// A real project module, when LINEAR_STRICT_CHECKS_MODULE_TEST names its path.
const REAL = process.env['LINEAR_STRICT_CHECKS_MODULE_TEST'] ?? '';
(REAL && existsSync(REAL) ? describe : describe.skip)('the project checks module itself', () => {
  it('loads, and refuses what the fake refuses', async () => {
    const rules = await checksRulesFromEnv({
      LINEAR_STRICT_CHECKS_TEAMS: 'ENG',
      LINEAR_STRICT_CHECKS_MODULE: REAL,
    });
    if (!rules) throw new Error('the checks module did not load');
    expect(checksWriteProblems(rules.module, '', withChecks(C1, C2))).toEqual([]);
    expect(
      checksWriteProblems(rules.module, '', withChecks('- [ ] C1 · eyeball x · y'))[0],
    ).toMatch(/^Checks: /);
  });
});
