import { existsSync } from 'node:fs';
import { memoryClaimStore } from '../claims.js';
import {
  asWritten,
  type ChecksModule,
  checksRulesFromEnv,
  checksWriteProblems,
  droppedChecksById,
  linearChecks,
  notMigrated,
} from '../checks.js';
import type { PmNode } from '../prosemirror.js';
import { lintDescription } from '../sections.js';
import { type SignOffRequest, StrictLinear } from '../strict-linear.js';
import { strictToolDefinitions, toolDefinitionsFor } from '../tools.js';
import { type FakeState, fakeGql, fakeState } from './strict-fake-linear.helper.js';

// A stand-in for the project's checks module: the same interface, a two-kind grammar. Like the real
// one, it reads a lower-case x only, so a test with Linear's \`- [X]\` shows the server copes. The real
// module is exercised at the bottom when LINEAR_STRICT_CHECKS_MODULE_TEST names one on this machine.
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

const SIGNED = {
  descope_reason: 'the check moved',
  descope_risk: 'a check nobody walks',
};

function setup(description: string, teams = ['ENG'], overrides: Partial<FakeState> = {}) {
  const state = fakeState(overrides);
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
    ).rejects.toThrow(
      /\/m\.mjs did not load: ENOENT\. linear-strict will not start with LINEAR_STRICT_CHECKS_TEAMS and LINEAR_STRICT_CHECKS_MODULE both set[\s\S]*unset both/,
    );
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

  it('refuses a broken ## Checks written through a comment patch, as set_state does', async () => {
    const { strict, state } = setup(withChecks(C1));
    await expect(
      strict.comment('ENG-1', {
        kind: 'correction',
        body: 'one more check',
        patch: [{ section: 'Checks', mode: 'append', body: '- [ ] C2 · eyeball it · fine' }],
      }),
    ).rejects.toThrow('Checks: not a check line: - [ ] C2 · eyeball it · fine');
    expect(state.issue.description).toBe(withChecks(C1));
  });

  it('refuses a broken ## Checks on a new ticket', async () => {
    const { strict, state } = setup('');
    await expect(
      strict.createIssue({
        team: 'ENG',
        title: 'The cap is never shown',
        project_id: 'p-alpha',
        new_because: 'nothing open covers the cap',
        distinct_from: [],
        sections: [{ section: 'Checks', mode: 'replace', body: '- [ ] C1 · eyeball it · fine' }],
      }),
    ).rejects.toThrow('Checks: not a check line: - [ ] C1 · eyeball it · fine');
    expect(state.created).toEqual([]);
  });

  it('refuses to drop Done when on a ticket that has no ## Checks to carry it', async () => {
    const { strict, state } = setup(`${IMPACT}\n\n## Done when\n\n- [ ] the reply names the cap`);
    await expect(
      strict.setState('ENG-1', [{ section: 'Done when', mode: 'replace', body: '' }]),
    ).rejects.toThrow('Only a ticket with a ## Checks section may drop Done when');
    expect(state.issue.description).toContain('## Done when');
  });
});

describe('a ## Checks section as Linear stores it', () => {
  // Linear hands a ticked item back as "- [X]", whatever was written.
  const ticked = (line: string) => line.replace('- [ ]', '- [X]');

  it('reads a ticked check stored as - [X], so a later write to another section lands', async () => {
    const { strict, state } = setup(withChecks(ticked(C1), C2));
    await strict.setState('ENG-1', [
      { section: 'Observed', mode: 'append', body: '2026-11-07 · get_issue · the cap shows' },
    ]);
    expect(state.issue.description).toContain('2026-11-07 · get_issue · the cap shows');
    await strict.comment('ENG-1', {
      kind: 'evidence',
      body: 'seen again',
      patch: [{ section: 'Observed', mode: 'append', body: '2026-11-07 · walk · seen again' }],
    });
    expect(state.issue.description).toContain('2026-11-07 · walk · seen again');
  });

  it('counts a ticked check stored as - [X] toward the Impact it quotes', async () => {
    const { strict, state } = setup(withChecks(ticked(C1)));
    const C2 =
      '- [ ] C2 · walk alpha/visitor · a reset time shows <!-- from impact "sees the cap and the reset time" -->';
    await strict.setState('ENG-1', [
      { section: 'Impact', mode: 'replace', body: 'a visitor sees the cap and the reset time' },
      { section: 'Checks', mode: 'append', body: C2 },
    ]);
    expect(state.issue.description).toContain('Impact: a visitor sees the cap and the reset time');
    expect(linearChecks(fake).parseChecks(withChecks(ticked(C1)))).toMatchObject({
      checks: [{ id: 'C1', ticked: true }],
      problems: [],
    });
  });

  it('asks for sign-off before a ticked check stored as - [X] is deleted', async () => {
    const { strict, asked, state } = setup(withChecks(C1, ticked(C2)));
    await strict.setState('ENG-1', [{ section: 'Checks', mode: 'replace', body: C1 }], SIGNED);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.dropped).toEqual(['C2 · read posthog-flag cap env=production · on (retired)']);
    expect(state.issue.description).not.toContain('C2');
  });

  it('asks for sign-off before deleting a check line the module cannot read, and never reissues its id', async () => {
    const unreadable = '- [ ] C2 · eyeball it · fine';
    const { strict, asked } = setup(withChecks(C1, unreadable));
    // A problem the ticket already had is not this write's to fix.
    await strict.setState('ENG-1', [
      { section: 'Observed', mode: 'append', body: '2026-11-07 · get_issue · the cap shows' },
    ]);
    expect(asked).toHaveLength(0);
    await strict.setState('ENG-1', [{ section: 'Checks', mode: 'replace', body: C1 }], SIGNED);
    expect(asked[0]?.dropped).toEqual(['C2 · eyeball it · fine (retired)']);
    // Repairing the line in place keeps its id: it is not a new one.
    expect(checksWriteProblems(fake, withChecks(C1, unreadable), withChecks(C1, C2))).toEqual([]);
  });

  it('refuses a Checks section the module cannot find, rather than reading it as no checks', async () => {
    const { strict } = setup(`${IMPACT}\n\n### Checks\n\n${C1}`);
    await expect(
      strict.setState('ENG-1', [{ section: 'Checks', mode: 'append', body: C2 }]),
    ).rejects.toThrow('the section heading must be exactly "## Checks"');
  });

  it('writes check lines back in the form they were written in', () => {
    expect(
      asWritten(
        '* \\[X\\] C1 · walk alpha/visitor · names \\[cap\\]\n- [X] not a check\n- [ ] C2 · a',
      ),
    ).toBe('- [x] C1 · walk alpha/visitor · names [cap]\n- [X] not a check\n- [ ] C2 · a');
  });
});

describe('a team not listed in LINEAR_STRICT_CHECKS_TEAMS', () => {
  it('has no Checks section to patch and cannot drop Done when, as before ## Checks existed', async () => {
    const { strict, state } = setup(`${IMPACT}\n\n## Done when\n\n- [ ] it works`, ['CUR']);
    await expect(
      strict.setState('ENG-1', [{ section: 'Checks', mode: 'append', body: '- [ ] it works' }]),
    ).rejects.toThrow(
      '"Checks" is not a known section (Impact, Observed, Cause, Fix, Done when, Open questions)',
    );
    await expect(
      strict.setState('ENG-1', [{ section: 'Done when', mode: 'replace', body: '' }]),
    ).rejects.toThrow('Done when: body is empty');
    expect(state.issue.description).toBe(`${IMPACT}\n\n## Done when\n\n- [ ] it works`);
  });

  it('still reports a missing Done when on a ticket with a Checks heading', async () => {
    const description = `${IMPACT}\n\n## Observed\n\n- 2026-11-07 · a · b\n\n## Checks\n\n${C1}`;
    const missing = { code: 'missing_section', detail: 'No "Done when" section' };
    expect(lintDescription(description)).toContainEqual(missing);
    expect(lintDescription(description, true)).not.toContainEqual(missing);
    const unlisted = setup(description, ['CUR']);
    expect((await unlisted.strict.getIssue('ENG-1')).findings).toContainEqual(missing);
    const listed = setup(description);
    expect((await listed.strict.getIssue('ENG-1')).findings).not.toContainEqual(missing);
  });

  it('offers no Checks section in the tool schemas unless the server has checks teams', () => {
    const sections = (defs: typeof strictToolDefinitions) =>
      JSON.stringify(defs.find((tool) => tool.name === 'set_state')?.input_schema);
    expect(toolDefinitionsFor(false)).toBe(strictToolDefinitions);
    expect(sections(strictToolDefinitions)).not.toContain('"Checks"');
    expect(sections(toolDefinitionsFor(true))).toContain('"Checks"');
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

  it('never reissues an id that an earlier version had, read from the whole text of every version', async () => {
    // v1 has a Done when; v2 adds C1 and a ticked C2 (Linear renders it "- [X]"); v3 retires C2.
    const t = (value: string): PmNode => ({ type: 'text', text: value });
    const para = (value: string): PmNode => ({ type: 'paragraph', content: [t(value)] });
    const heading = (value: string): PmNode => ({
      type: 'heading',
      attrs: { level: 2 },
      content: [t(value)],
    });
    const todos = (...items: [boolean, string][]): PmNode => ({
      type: 'todo_list',
      content: items.map(([done, line]) => ({
        type: 'todo_item',
        attrs: { done },
        content: [para(line)],
      })),
    });
    const doc = (...content: PmNode[]): PmNode => ({ type: 'doc', content });
    const item = (line: string) => line.replace(/^- \[[ x]\] /, '');
    const v1 = doc(para(IMPACT), heading('Done when'), todos([false, 'the reply names the cap']));
    const v2 = doc(para(IMPACT), heading('Checks'), todos([false, item(C1)], [true, item(C2)]));
    const v3 = doc(para(IMPACT), heading('Checks'), todos([false, item(C1)]));
    const { strict, state } = setup(withChecks(C1), ['ENG'], {
      snapshots: [
        { at: '2026-11-01T00:00:00.000Z', actorIds: [], doc: v1 },
        { at: '2026-11-02T00:00:00.000Z', actorIds: [], doc: v2 },
        { at: '2026-11-03T00:00:00.000Z', actorIds: [], doc: v3 },
      ],
    });
    const reissued = '- [ ] C2 · read posthog-flag other env=production · on <!-- from D2 -->';
    await expect(
      strict.setState('ENG-1', [{ section: 'Checks', mode: 'append', body: reissued }]),
    ).rejects.toThrow(
      'C2 was used before and retired; ids are never reused, so give this check C3',
    );
    await strict.setState('ENG-1', [
      { section: 'Checks', mode: 'append', body: reissued.replace('C2', 'C3') },
    ]);
    expect(state.issue.description).toContain('C3 · read posthog-flag other');
  });

  it('moves a Done when item into ## Checks without sign-off only when its text is the whole claim of exactly one new, unticked check', () => {
    const before = `${IMPACT}\n\n## Done when\n\n- [ ] the flag is on in production`;
    const check = (claim: string, box = ' ') =>
      `- [${box}] C1 · read posthog-flag cap env=production · ${claim} <!-- from D1 -->`;
    const dropped = ['the flag is on in production', 'a walk sees the cap (already ticked)'];
    expect(
      notMigrated(fake, before, withChecks(check('the flag is on in production')), dropped),
    ).toEqual(['a walk sees the cap (already ticked)']);
    // Narrowed, negated, or arriving ticked: not a move.
    for (const after of [
      withChecks(check('on, the flag is on in production')),
      withChecks(check('it is not true that the flag is on in production')),
      withChecks(check('the flag is on in production', 'x')),
    ])
      expect(notMigrated(fake, before, after, dropped)).toEqual(dropped);
    // A write that keeps Done when, or a ticket that already had Checks, migrates nothing.
    expect(
      notMigrated(
        fake,
        before,
        `${withChecks(check('the flag is on in production'))}\n\n## Done when\n\n- [ ] other`,
        dropped,
      ),
    ).toEqual(dropped);
    expect(
      notMigrated(
        fake,
        `${withChecks(check('the flag is on in production'))}\n\n## Done when\n\n- [ ] x`,
        withChecks(check('the flag is on in production')),
        dropped,
      ),
    ).toEqual(dropped);
  });

  it('asks for sign-off when a Done when item is dropped beside a check that only negates it', async () => {
    const negated =
      '- [ ] C1 · walk alpha/visitor · the reply never names the cap <!-- from impact "a visitor sees the cap" -->';
    const { strict, asked } = setup(
      `${withChecks(negated)}\n\n## Done when\n\n- [ ] names the cap\n- [ ] other`,
    );
    await strict.setState(
      'ENG-1',
      [{ section: 'Done when', mode: 'replace', body: '- [ ] other' }],
      SIGNED,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.dropped).toEqual(['names the cap']);
  });

  it('asks for sign-off on a migration whose check does not say what the item said', async () => {
    const { strict, asked } = setup(`${IMPACT}\n\n## Done when\n\n- [ ] names the cap`);
    await strict.setState(
      'ENG-1',
      [
        {
          section: 'Checks',
          mode: 'replace',
          body: '- [ ] C1 · walk alpha/visitor · the reply never names the cap <!-- from impact "a visitor sees the cap" -->',
        },
        { section: 'Done when', mode: 'replace', body: '' },
      ],
      SIGNED,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.dropped).toEqual(['names the cap']);
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
    // A ticked check as Linear stores it parses once read the way the server reads it.
    expect(
      linearChecks(rules.module).parseChecks(withChecks(C1.replace('[ ]', '[X]')))?.problems,
    ).toEqual([]);
    expect(
      checksWriteProblems(rules.module, '', withChecks('- [ ] C1 · eyeball x · y'))[0],
    ).toMatch(/^Checks: /);
  });
});
