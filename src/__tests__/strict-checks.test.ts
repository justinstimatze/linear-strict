import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { memoryClaimStore } from '../claims.js';
import {
  asWritten,
  BOTH_SECTIONS,
  type Check,
  type ChecksModule,
  checksInterpreter,
  checksRulesFromEnv,
  checksWriteProblems,
  droppedChecksById,
  notMigrated,
  parseChecksRulebook,
} from '../checks.js';
import type { PmNode } from '../prosemirror.js';
import { lintDescription, readSection } from '../sections.js';
import { type SignOffRequest, StrictLinear } from '../strict-linear.js';
import { strictToolDefinitions, toolDefinitionsFor } from '../tools.js';
import { type FakeState, fakeGql, fakeState } from './strict-fake-linear.helper.js';

// The rulebook the conformance fixtures were generated against, read by the server's own interpreter.
const RULEBOOK_URL = new URL('./fixtures/checks-rulebook.json', import.meta.url);
const RULEBOOK_TEXT = readFileSync(RULEBOOK_URL, 'utf8');
const fake: ChecksModule = checksInterpreter(parseChecksRulebook(RULEBOOK_TEXT));

const IMPACT = 'Impact: a visitor sees the cap';
const C1 =
  '- [ ] C1 · walk alpha/visitor · the reply names the cap <!-- from impact "a visitor sees the cap" -->';
const C2 = '- [ ] C2 · read posthog-flag cap env=production · on <!-- from D2 -->';
const withChecks = (...lines: string[]) => `${IMPACT}\n\n## Checks\n\n${lines.join('\n')}`;

const SIGNED = {
  descope_reason: 'the check moved',
  descope_risk: 'a check nobody walks',
};

// One saved version, so a write that adds an id has a history to read; a test of no history overrides it.
const FIRST_VERSION = {
  at: '2026-11-01T00:00:00.000Z',
  actorIds: [],
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'v1' }] }] },
};

function setup(description: string, teams = ['ENG'], overrides: Partial<FakeState> = {}) {
  const state = fakeState({ snapshots: [FIRST_VERSION], ...overrides });
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

describe('LINEAR_STRICT_CHECKS_TEAMS and LINEAR_STRICT_CHECKS_RULEBOOK', () => {
  const both = { LINEAR_STRICT_CHECKS_TEAMS: 'cur, sol', LINEAR_STRICT_CHECKS_RULEBOOK: '/r.json' };
  const fromEnv = (env: Record<string, string>, text: string | Error = RULEBOOK_TEXT) => {
    const lines: string[] = [];
    const rules = checksRulesFromEnv(
      env,
      () => {
        if (text instanceof Error) throw text;
        return Buffer.from(text);
      },
      (line) => lines.push(line),
    );
    return { rules, lines };
  };
  const OFF = /^linear-strict: ## CHECKS ARE OFF FOR EVERY TEAM: /;

  it('is off and silent with neither set', () => {
    expect(fromEnv({})).toEqual({ rules: undefined, lines: [] });
  });

  it('reads the rulebook once, accepts the bare block or a whole file, and logs its sha256', () => {
    const block = JSON.stringify((JSON.parse(RULEBOOK_TEXT) as { checks: unknown }).checks);
    for (const text of [RULEBOOK_TEXT, block]) {
      const { rules, lines } = fromEnv(both, text);
      expect(rules?.teams).toEqual(['CUR', 'SOL']);
      expect(rules?.module.parseChecks(withChecks(C1, C2))?.problems).toEqual([]);
      const sha = createHash('sha256').update(text).digest('hex');
      expect(lines).toEqual([
        `linear-strict: ## Checks on for CUR, SOL, rulebook /r.json sha256 ${sha}`,
      ]);
    }
    // The default reader reads the file from disk.
    const env = {
      LINEAR_STRICT_CHECKS_TEAMS: 'ENG',
      LINEAR_STRICT_CHECKS_RULEBOOK: RULEBOOK_URL.pathname,
    };
    expect(checksRulesFromEnv(env, undefined, () => undefined)?.teams).toEqual(['ENG']);
  });

  it('is off for every team, with one loud line, when only one of the two is set', () => {
    for (const env of [
      { LINEAR_STRICT_CHECKS_TEAMS: 'CUR' },
      { LINEAR_STRICT_CHECKS_RULEBOOK: '/r.json' },
    ]) {
      const { rules, lines } = fromEnv(env);
      expect(rules).toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(OFF);
      expect(lines[0]).toContain('together, or neither');
    }
  });

  it('is off for every team, with one loud line saying why, on a rulebook it cannot use', () => {
    const block = JSON.parse(RULEBOOK_TEXT) as { checks: Record<string, unknown> };
    const without = (field: string) =>
      JSON.stringify({ checks: { ...block.checks, [field]: undefined } });
    const cases: [string | Error, string, Record<string, string>?][] = [
      [new Error('ENOENT: no such file'), '/r.json could not be read: ENOENT: no such file'],
      ['{ not json', '/r.json is not JSON'],
      ['[]', '/r.json is not a JSON object'],
      [
        without('coverage'),
        'checks.coverage.stopwords (an array of strings), checks.coverage.min_word_length',
      ],
      [without('line'), 'checks.line (string)'],
      [without('kinds'), 'checks.kinds (an object of kinds)'],
      [
        JSON.stringify({ checks: { ...block.checks, line: '^- \\[( |x)\\] (C[1-9]' } }),
        'checks.line (a valid regular expression)',
      ],
      [
        JSON.stringify({ checks: { ...block.checks, line: '^- (C1)$' } }),
        'checks.line (a pattern with 6 capture groups)',
      ],
      [
        RULEBOOK_TEXT,
        'not a team key: SO-L',
        { LINEAR_STRICT_CHECKS_TEAMS: 'CUR,so-l', LINEAR_STRICT_CHECKS_RULEBOOK: '/r.json' },
      ],
    ];
    for (const [text, why, env = both] of cases) {
      const { rules, lines } = fromEnv(env, text);
      expect(rules).toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(OFF);
      expect(lines[0]).toContain(why);
    }
    // A file on disk that is not there.
    const lines: string[] = [];
    expect(
      checksRulesFromEnv(
        { LINEAR_STRICT_CHECKS_TEAMS: 'ENG', LINEAR_STRICT_CHECKS_RULEBOOK: '/nonexistent/r.json' },
        undefined,
        (line) => lines.push(line),
      ),
    ).toBeUndefined();
    expect(lines[0]).toMatch(OFF);
  });

  it('names a rulebook that has the checks block but not the coverage constants', () => {
    const { checks } = JSON.parse(RULEBOOK_TEXT) as {
      checks: { provenance: Record<string, unknown> };
    };
    const old = {
      ...checks,
      coverage: undefined,
      provenance: { pattern: checks.provenance['pattern'] },
    };
    expect(() => parseChecksRulebook(JSON.stringify(old))).toThrow(
      'missing or malformed: checks.provenance.quote_pattern (string), checks.coverage.stopwords (an array of strings), checks.coverage.min_word_length (a positive integer)',
    );
  });
});

describe('a rulebook pattern that cannot yield what the interpreter reads', () => {
  it('refuses a quote_pattern with no capture group, since the group is the quoted Impact text', () => {
    const rb = JSON.parse(RULEBOOK_TEXT) as { checks: { provenance: Record<string, string> } };
    rb.checks.provenance['quote_pattern'] = 'impact "[^"]+"';
    expect(() => parseChecksRulebook(JSON.stringify(rb))).toThrow(
      'checks.provenance.quote_pattern (a pattern with 1 capture groups)',
    );
  });
});

describe('a ## Checks write on a team that uses one', () => {
  it('refuses a line the rulebook cannot read, and lands one it can', async () => {
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

  it('asks for sign-off on a reworded or retired check, by id, and not on an untick or a new check', async () => {
    const { strict, asked } = setup(withChecks(C1.replace('[ ]', '[X]'), C2));
    await strict.setState('ENG-1', [
      { section: 'Checks', mode: 'replace', body: [C1, C2].join('\n') },
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

  it('asks for sign-off on a check whose kind alone changes, since the kind picks the grader', async () => {
    const { strict, asked } = setup(withChecks(C1, C2));
    const asMonitor = C1.replace('walk alpha/visitor', 'monitor cap.alert');
    await strict.setState(
      'ENG-1',
      [{ section: 'Checks', mode: 'replace', body: [asMonitor, C2].join('\n') }],
      SIGNED,
    );
    expect(asked[0]?.dropped).toEqual([
      'C1 · walk alpha/visitor · the reply names the cap (reworded)',
    ]);
    expect(asked[0]?.added).toEqual(['C1 · monitor cap.alert · the reply names the cap']);
  });

  it('asks for sign-off on a check whose target alone changes, such as visitor to staff', async () => {
    const { strict, asked } = setup(withChecks(C1, C2));
    await strict.setState(
      'ENG-1',
      [
        {
          section: 'Checks',
          mode: 'replace',
          body: [C1.replace('alpha/visitor', 'www/staff'), C2].join('\n'),
        },
      ],
      SIGNED,
    );
    expect(asked[0]?.dropped).toEqual([
      'C1 · walk alpha/visitor · the reply names the cap (reworded)',
    ]);
    expect(asked[0]?.added).toEqual(['C1 · walk www/staff · the reply names the cap']);
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

describe('a generated block after ## Checks', () => {
  const FACTS =
    '<!-- ticket-facts:begin -->\n**Live state**\n- Linear: Verify\n<!-- ticket-facts:end -->';
  const RECONCILED = '<!-- strict:reconciled through=2026-11-07T00:00:00.000Z -->';

  it('ends the section, so a check appended above a Live state block lands', async () => {
    const { strict, state } = setup(`${withChecks(C1)}\n\n${FACTS}`);
    await strict.setState('ENG-1', [{ section: 'Checks', mode: 'append', body: C2 }]);
    expect(state.issue.description).toContain(C2);
    expect(state.issue.description).toContain(FACTS);
    expect(fake.parseChecks(state.issue.description)).toMatchObject({ problems: [] });
  });

  it('ends the section at the reconciled marker, so a migration on a reconciled ticket lands', async () => {
    const { strict, asked, state } = setup(
      `${IMPACT}\n\n## Done when\n\n- [ ] the reply names the cap\n\n${RECONCILED}`,
    );
    await strict.setState('ENG-1', [
      { section: 'Checks', mode: 'replace', body: C1 },
      { section: 'Done when', mode: 'replace', body: '' },
    ]);
    expect(asked).toHaveLength(0);
    expect(state.issue.description).toContain('## Checks');
    expect(state.issue.description).not.toContain('## Done when');
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
    expect(fake.parseChecks(withChecks(ticked(C1)))).toMatchObject({
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

  it('asks for sign-off before deleting a check line the rulebook cannot read, and never reissues its id', async () => {
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

  it('asks for sign-off before deleting an unreadable check line stored as * \\[X\\]', async () => {
    const { strict, asked } = setup(withChecks(C1, '* \\[X\\] C2 · eyeball it · fine'));
    await strict.setState('ENG-1', [{ section: 'Checks', mode: 'replace', body: C1 }], SIGNED);
    expect(asked[0]?.dropped).toEqual(['C2 · eyeball it · fine (retired)']);
  });

  it('refuses a Checks section the rulebook cannot find, rather than reading it as no checks', async () => {
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

  it('refuses a new id when Linear cannot return the whole history, rather than read it as empty', async () => {
    const { strict, state } = setup(withChecks(C1), ['ENG'], { historyIncomplete: true });
    await expect(
      strict.setState('ENG-1', [{ section: 'Checks', mode: 'append', body: C2 }]),
    ).rejects.toThrow("Linear did not return the description's whole history");
    expect(state.issue.description).toBe(withChecks(C1));
  });

  it('refuses a new id when Linear keeps no document history for the ticket, rather than read it as empty', async () => {
    const ticked = withChecks(C1.replace('[ ]', '[X]'));
    const { strict, state } = setup(ticked, ['ENG'], { snapshots: null });
    await expect(
      strict.setState('ENG-1', [{ section: 'Checks', mode: 'append', body: C2 }]),
    ).rejects.toThrow('Linear returned no document history for this ticket');
    expect(state.issue.description).toBe(ticked);
    // An untick adds no id, so it needs no history.
    await strict.setState('ENG-1', [{ section: 'Checks', mode: 'replace', body: C1 }]);
    expect(state.issue.description).toContain('- [ ] C1');
  });

  it('refuses a new id when Linear returns a history with no versions in it, as when it returns none', async () => {
    const { strict, state } = setup(withChecks(C1), ['ENG'], { snapshots: [] });
    await expect(
      strict.setState('ENG-1', [{ section: 'Checks', mode: 'append', body: C2 }]),
    ).rejects.toThrow('Linear returned no document history for this ticket');
    expect(state.issue.description).toBe(withChecks(C1));
  });

  it('moves a Done when item into ## Checks without sign-off only when its text is the whole claim of exactly one new, unticked check', () => {
    const before = `${IMPACT}\n\n## Done when\n\n- [ ] the flag is on in production\n- [x] a walk sees the cap · run 1`;
    const check = (claim: string, box = ' ') =>
      `- [${box}] C1 · walk alpha/visitor · ${claim} <!-- from D1 -->`;
    const dropped = ['the flag is on in production', 'a walk sees the cap (already ticked)'];
    expect(notMigrated(fake, before, withChecks(check('the flag is on in production')))).toEqual([
      'a walk sees the cap (already ticked)',
    ]);
    // Narrowed, negated, arriving ticked, or split across two checks: not a move.
    for (const after of [
      withChecks(
        check('the flag is on in production'),
        check('the flag is on in production').replace('C1', 'C2'),
      ),
      withChecks(check('on, the flag is on in production')),
      withChecks(check('it is not true that the flag is on in production')),
      withChecks(check('the flag is on in production', 'x')),
    ])
      expect(notMigrated(fake, before, after)).toEqual(dropped);
    // A write that keeps Done when, or a ticket that already had Checks, migrates nothing.
    expect(
      notMigrated(
        fake,
        before,
        `${withChecks(check('the flag is on in production'))}\n\n## Done when\n\n- [ ] other`,
      ),
    ).toEqual(dropped);
    expect(
      notMigrated(
        fake,
        `${withChecks(check('the flag is on in production'))}\n\n## Done when\n\n- [ ] x`,
        withChecks(check('the flag is on in production')),
      ),
    ).toEqual(['x']);
  });

  it('moves a ticked Done when item only into an unticked check: its tick does not carry over', () => {
    const before = `${IMPACT}\n\n## Done when\n\n- [x] the reply names the cap · run 1`;
    expect(notMigrated(fake, before, withChecks(C1))).toEqual([]);
    expect(notMigrated(fake, before, withChecks(C1.replace('[ ]', '[x]')))).toEqual([
      'the reply names the cap (already ticked)',
    ]);
  });

  it('reads whether an item was ticked from its line, never from text that ends in "(already ticked)"', () => {
    const before = `${IMPACT}\n\n## Done when\n\n- [ ] the reply names the cap (already ticked)`;
    // The item's whole text is its claim: a check that leaves the suffix off says something else.
    expect(notMigrated(fake, before, withChecks(C1))).toEqual([
      'the reply names the cap (already ticked)',
    ]);
  });

  it('moves an item with no sign-off only into a walk check as a visitor: every other kind or profile is a choice a person approves', () => {
    const before = `${IMPACT}\n\n## Done when\n\n- [ ] a visitor on alpha sees the cap`;
    const dropped = ['a visitor on alpha sees the cap'];
    const as = (kindTarget: string) =>
      withChecks(`- [ ] C1 · ${kindTarget} · a visitor on alpha sees the cap <!-- from D1 -->`);
    expect(notMigrated(fake, before, as('walk alpha/visitor'))).toEqual([]);
    expect(notMigrated(fake, before, as('walk www/visitor'))).toEqual([]);
    for (const kindTarget of [
      'walk alpha/staff',
      'walk alpha/signed-out',
      'read posthog-flag cap env=production',
      'read healthz https://x.test/visitor',
      'run pr-ci tests/chat.spec.ts:42',
      'fault none_at_all @preview',
      'telemetry cap-hits until 2026-12-01',
      'monitor some-alert',
    ])
      expect(notMigrated(fake, before, as(kindTarget))).toEqual(dropped);
  });

  it('matches a migrated item to its claim whatever the case and spacing', () => {
    const before = `${IMPACT}\n\n## Done when\n\n- [ ] The reply  names the cap`;
    expect(notMigrated(fake, before, withChecks(C1))).toEqual([]);
  });

  it('migrates nothing on a ticket with two Checks headings, which it cannot read as one section', () => {
    const before = `${IMPACT}\n\n## Checks\n\nx\n\n### checks\n\ny\n\n## Done when\n\n- [ ] the reply names the cap`;
    expect(notMigrated(fake, before, withChecks(C1))).toEqual(['the reply names the cap']);
  });

  it('asks for sign-off when a Done when item is dropped beside a check that only negates it', async () => {
    const negated =
      '- [ ] C1 · walk alpha/visitor · the reply never names the cap <!-- from impact "a visitor sees the cap" -->';
    const { strict, asked } = setup(
      `${withChecks(negated)}\n\n## Done when\n\n- [ ] names the cap\n- [ ] other`,
    );
    await strict.setState('ENG-1', [{ section: 'Done when', mode: 'replace', body: '' }], SIGNED);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.dropped).toEqual(['names the cap', 'other']);
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

describe('a ticket holds ## Done when or ## Checks, never both', () => {
  const OPEN = `${IMPACT}\n\n## Done when\n\n- [ ] a visitor on www sees the cap and the reset time\n- [ ] the e2e spec covers the reset`;
  const READ =
    '- [ ] C1 · read posthog-flag cap env=production · on <!-- from impact "a visitor sees the cap" -->';

  it('refuses adding ## Checks beside an open Done when, and asks no sign-off, since no item would be read again', async () => {
    const { strict, state, asked } = setup(OPEN);
    await expect(
      strict.setState('ENG-1', [{ section: 'Checks', mode: 'replace', body: READ }]),
    ).rejects.toThrow(BOTH_SECTIONS);
    expect(asked).toHaveLength(0);
    expect(state.issue.description).toBe(OPEN);
  });

  it('lands the same checks as a migration that removes Done when, with every dropped item signed off', async () => {
    const { strict, state, asked } = setup(OPEN);
    await strict.setState(
      'ENG-1',
      [
        { section: 'Checks', mode: 'replace', body: READ },
        { section: 'Done when', mode: 'replace', body: '' },
      ],
      SIGNED,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.dropped).toEqual([
      'a visitor on www sees the cap and the reset time',
      'the e2e spec covers the reset',
    ]);
    expect(state.issue.description).not.toContain('## Done when');
  });

  it('refuses any write to a ticket that already has both, unless it removes Done when', async () => {
    const start = `${withChecks(C1)}\n\n## Done when\n\n- [ ] the reply names the cap`;
    const { strict, state, asked } = setup(start);
    await expect(
      strict.setState('ENG-1', [
        { section: 'Observed', mode: 'append', body: '- 2026-11-07 · probe · the cap shows' },
      ]),
    ).rejects.toThrow(BOTH_SECTIONS);
    expect(state.issue.description).toBe(start);
    await strict.setState('ENG-1', [{ section: 'Done when', mode: 'replace', body: '' }], SIGNED);
    expect(asked[0]?.dropped).toEqual(['the reply names the cap']);
    expect(state.issue.description).toBe(withChecks(C1));
  });

  it('refuses a new ticket written with both', async () => {
    const { strict, state } = setup('');
    await expect(
      strict.createIssue({
        team: 'ENG',
        title: 'The cap is never shown',
        project_id: 'p-alpha',
        new_because: 'nothing open covers the cap',
        distinct_from: [],
        sections: [
          { section: 'Impact', mode: 'replace', body: 'a visitor sees the cap' },
          { section: 'Checks', mode: 'replace', body: C1 },
          { section: 'Done when', mode: 'replace', body: '- [ ] the reply names the cap' },
        ],
      }),
    ).rejects.toThrow(BOTH_SECTIONS);
    expect(state.created).toEqual([]);
  });
});

describe('Impact coverage reads the text as it is displayed', () => {
  const EXPORT = 'every visitor can export their whole chat history as markdown';
  const broken = (mark: string) => EXPORT.replace(/(\p{L}{3})(?=\p{L})/gu, `$1${mark}`);
  const READ_D1 = '- [ ] C1 · read posthog-flag export env=production · on <!-- from D1 -->';
  const INVISIBLE = ['­', '​', '‌', '‍', '⁠', '﻿'];

  it.each(INVISIBLE.map((c) => [`U+${c.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`, c]))(
    'reads an Impact word broken by %s as the whole word, which some check must quote',
    (_, mark) => {
      const ticket = `Impact: ${broken(mark)}\n\n## Checks\n\n${READ_D1}`;
      const parsed = fake.parseChecks(ticket);
      expect(fake.impactCoverage(fake.impactLine(ticket), parsed?.checks ?? []).uncovered).toEqual([
        'every',
        'visitor',
        'export',
        'whole',
        'chat',
        'history',
        'markdown',
      ]);
    },
  );

  it('refuses the write that adds one trivial check beside such an Impact', async () => {
    const { strict } = setup(`Impact: ${broken('­')}`);
    await expect(
      strict.setState('ENG-1', [{ section: 'Checks', mode: 'replace', body: READ_D1 }]),
    ).rejects.toThrow('Impact claim has no check');
  });

  it('matches a quote with an invisible character in it against the Impact without one', () => {
    const quoted = `- [ ] C1 · walk www/visitor · exported <!-- from impact "${broken('​')}" -->`;
    const ticket = `Impact: ${EXPORT}\n\n## Checks\n\n${quoted}`;
    const parsed = fake.parseChecks(ticket);
    expect(fake.impactCoverage(fake.impactLine(ticket), parsed?.checks ?? [])).toEqual({
      misquoted: [],
      uncovered: [],
    });
  });
});

describe('an Impact that says none', () => {
  const READ_D1 = '- [ ] C1 · read posthog-flag cap env=production · on <!-- from D1 -->';
  const uncovered = (impact: string) => {
    const ticket = `Impact: ${impact}\n\n## Checks\n\n${READ_D1}`;
    return fake.impactCoverage(fake.impactLine(ticket), fake.parseChecks(ticket)?.checks ?? [])
      .uncovered;
  };

  it('exempts the opening clause of an Impact whose first word is "none"; after its first colon is a claim', () => {
    expect(uncovered('none')).toEqual([]);
    expect(uncovered('none.')).toEqual([]);
    expect(uncovered('none, internal tooling only')).toEqual([]);
    expect(uncovered('none for visitors')).toEqual([]);
    expect(uncovered('none yet, no fix shipped')).toEqual([]);
    expect(uncovered('none for visitors: but staff see the cap')).toEqual(['staff']);
    expect(uncovered('none: but staff see the cap')).toEqual(['staff']);
  });

  it('reads "none of …" and a word that only starts with none as a claim like any other', () => {
    expect(
      uncovered('none of the forty thousand visitors can lose their chat history any more'),
    ).toEqual(['none', 'forty', 'thousand', 'visitors', 'lose', 'chat', 'history']);
    expect(uncovered('None Of the visitors can sign in')).toEqual(['none', 'visitors', 'sign']);
    expect(uncovered('nonetheless visitors see the cap')).toEqual(['nonetheless', 'visitors']);
  });
});

describe('a generated-block marker on a check line', () => {
  const ESCAPED = '- [ ] C2 · walk www/visitor · x <!-- a\\_b:begin -->';
  const TICKED = '- [x] C3 · monitor anything · whatever';

  it('is a boundary for ## Checks exactly when it is one for readSection, so an escaped one hides nothing', () => {
    const ticket = withChecks(C1, ESCAPED, TICKED);
    expect(readSection(ticket, 'Checks')?.split('\n')).toHaveLength(3);
    const parsed = fake.parseChecks(ticket);
    expect(parsed?.checks.map((c) => `${c.id}${c.ticked ? 'x' : ''}`)).toEqual(['C1', 'C2', 'C3x']);
    expect(parsed?.problems).toEqual([
      'C2: "a_b:begin" is not a source the rulebook reads',
      'C3 names no source (<!-- from impact "…" --> or <!-- from D<n> -->)',
    ]);
  });

  it('refuses the check line that carries an escaped marker, which reads as no source the rulebook reads', async () => {
    const { strict, state } = setup(withChecks(C1));
    await expect(
      strict.setState('ENG-1', [{ section: 'Checks', mode: 'append', body: ESCAPED }]),
    ).rejects.toThrow('C2');
    expect(state.issue.description).toBe(withChecks(C1));
  });
});

describe('a Checks heading behind leading whitespace in another section', () => {
  it.each([
    ['three spaces', '   ## Checks'],
    ['an NBSP', ' ## Checks'],
    ['a tab', '\t### checks'],
  ])('is refused in Fix behind %s, since Linear may store it at column 0', async (_, line) => {
    const start = `${IMPACT}\n\n## Fix\n\nthe fix`;
    const { strict, state } = setup(start);
    await expect(
      strict.setState('ENG-1', [
        {
          section: 'Fix',
          mode: 'append',
          body: `${line}\n- [x] C1 · monitor x · anything <!-- from impact "a visitor sees the cap" -->`,
        },
      ]),
    ).rejects.toThrow('behind leading whitespace, which Linear may store as a heading');
    expect(state.issue.description).toBe(start);
  });
});

describe('the Done gate on a team that uses ## Checks', () => {
  const done = (description: string, teams = ['ENG']) => {
    const s = setup(description, teams);
    return {
      ...s,
      close: async () => {
        await s.strict.claim('ENG-1');
        return s.strict.setStatus('ENG-1', 'Done');
      },
    };
  };
  const DONE_WHEN = '## Done when\n\n- [x] the export finishes · run 36087655179';
  const GRADER = 'the grader closes tickets with Checks once every check has its evidence';
  const ticked = (line: string) => line.replace('[ ]', '[x]');

  it('never closes a ticket with ## Checks, even with every check ticked: the grader closes it', async () => {
    const { close, state } = done(withChecks(ticked(C1), C2.replace('[ ]', '[X]')));
    await expect(close()).rejects.toThrow(GRADER);
    expect(state.issue.stateId).toBe('s-todo');
  });

  it('never closes one beside a ticked and cited Done when either', async () => {
    const { close, state } = done(`${withChecks(ticked(C1), ticked(C2))}\n\n${DONE_WHEN}`);
    await expect(close()).rejects.toThrow(GRADER);
    expect(state.issue.stateId).toBe('s-todo');
  });

  it('refuses a Checks section under a heading the rulebook does not read, or with no check in it', async () => {
    for (const description of [
      `${IMPACT}\n\n### Checks\n\n${ticked(C1)}\n\n${DONE_WHEN}`,
      `${IMPACT}\n\n## checks\n\n${C1}\n\n${DONE_WHEN}`,
      `${IMPACT}\n\n## Checks\n\n${DONE_WHEN}`,
    ]) {
      const { close, state } = done(description);
      await expect(close()).rejects.toThrow(GRADER);
      expect(state.issue.stateId).toBe('s-todo');
    }
  });

  it('closes a ticket with no ## Checks through the Done when gate, as before', async () => {
    const { close } = done(`${IMPACT}\n\n${DONE_WHEN}`);
    await expect(close()).resolves.toMatchObject({ state: 'Done' });
    const none = done(IMPACT);
    await expect(none.close()).rejects.toThrow('the description has no Done when section');
  });

  it('on a team not listed, still reads only Done when', async () => {
    const { close } = done(withChecks(ticked(C1)), ['CUR']);
    await expect(close()).rejects.toThrow('the description has no Done when section');
    const both = done(`${withChecks(C1)}\n\n${DONE_WHEN}`, ['CUR']);
    await expect(both.close()).resolves.toMatchObject({ state: 'Done' });
  });
});

describe('a writer never grades a check', () => {
  const ticked = (line: string) => line.replace('[ ]', '[x]');
  const BY_HAND = 'checks are ticked by the grader that reads their evidence, not by hand';

  it('refuses a write that ticks a check, by set_state or by a comment patch', async () => {
    const { strict, state } = setup(withChecks(C1, C2));
    await expect(
      strict.setState('ENG-1', [
        { section: 'Checks', mode: 'replace', body: [ticked(C1), C2].join('\n') },
      ]),
    ).rejects.toThrow(`this write ticks C1; ${BY_HAND}`);
    await expect(
      strict.comment('ENG-1', {
        kind: 'evidence',
        body: 'walked it',
        patch: [{ section: 'Checks', mode: 'replace', body: [C1, ticked(C2)].join('\n') }],
      }),
    ).rejects.toThrow(`this write ticks C2; ${BY_HAND}`);
    expect(state.issue.description).toBe(withChecks(C1, C2));
  });

  it('refuses a tick on a check line the rulebook cannot read, which is still a check', async () => {
    const unreadable = '- [ ] C2 · eyeball it · fine';
    const { strict } = setup(withChecks(C1, unreadable));
    await expect(
      strict.setState('ENG-1', [
        { section: 'Checks', mode: 'replace', body: [C1, ticked(unreadable)].join('\n') },
      ]),
    ).rejects.toThrow(`this write ticks C2; ${BY_HAND}`);
  });

  it('lands an untick, and keeps a tick the grader wrote on a check the write leaves alone', async () => {
    const { strict, state, asked } = setup(withChecks(C1.replace('[ ]', '[X]'), C2));
    await strict.setState('ENG-1', [
      { section: 'Observed', mode: 'append', body: '2026-11-07 · get_issue · the cap shows' },
    ]);
    const C3 = '- [ ] C3 · read healthz https://x.test · 200 <!-- from D3 -->';
    await strict.setState('ENG-1', [{ section: 'Checks', mode: 'append', body: C3 }]);
    expect(state.issue.description).toContain(C3);
    await strict.setState('ENG-1', [
      { section: 'Checks', mode: 'replace', body: [C1, C2, C3].join('\n') },
    ]);
    expect(state.issue.description).toContain(C1);
    expect(asked).toHaveLength(0);
  });

  it('refuses a new check that arrives ticked, on an existing ticket or a new one', async () => {
    const { strict, state } = setup(withChecks(C1));
    await expect(
      strict.setState('ENG-1', [{ section: 'Checks', mode: 'append', body: ticked(C2) }]),
    ).rejects.toThrow(`C2 is new and arrives ticked`);
    expect(state.issue.description).toBe(withChecks(C1));
    await expect(
      setup('').strict.createIssue({
        team: 'ENG',
        title: 'The cap is never shown',
        project_id: 'p-alpha',
        new_because: 'nothing open covers the cap',
        distinct_from: [],
        sections: [
          { section: 'Impact', mode: 'replace', body: 'a visitor sees the cap' },
          { section: 'Checks', mode: 'replace', body: ticked(C1) },
        ],
      }),
    ).rejects.toThrow('C1 is new and arrives ticked');
  });

  it('refuses a reworded check that stays ticked, since the reword voids its grade', async () => {
    const { strict } = setup(withChecks(ticked(C1)));
    await expect(
      strict.setState(
        'ENG-1',
        [{ section: 'Checks', mode: 'replace', body: ticked(C1).replace('names', 'shows') }],
        SIGNED,
      ),
    ).rejects.toThrow('C1 is reworded and stays ticked');
  });

  it('refuses a migration that carries a ticked Done when item into a ticked check', async () => {
    const before = `${IMPACT}\n\n## Done when\n\n- [x] the reply names the cap · run 1`;
    const { strict, state, asked } = setup(before);
    await expect(
      strict.setState('ENG-1', [
        { section: 'Checks', mode: 'replace', body: ticked(C1) },
        { section: 'Done when', mode: 'replace', body: '' },
      ]),
    ).rejects.toThrow('C1 is new and arrives ticked');
    expect(state.issue.description).toBe(before);
    // Arriving unticked, it moves with no sign-off.
    await strict.setState('ENG-1', [
      { section: 'Checks', mode: 'replace', body: C1 },
      { section: 'Done when', mode: 'replace', body: '' },
    ]);
    expect(asked).toHaveLength(0);
    expect(state.issue.description).toContain(C1);
  });

  it('on a team not listed, a Checks heading is plain text and the Done when gate is unchanged', async () => {
    const { strict, state } = setup(`${withChecks(C1)}\n\n## Done when\n\n- [ ] it works`, ['CUR']);
    await strict.setState('ENG-1', [
      { section: 'Done when', mode: 'replace', body: '- [x] it works · run 36087655179' },
    ]);
    await strict.claim('ENG-1');
    await expect(strict.setStatus('ENG-1', 'Done')).resolves.toMatchObject({ state: 'Done' });
    expect(state.issue.stateId).toBe('s-done');
  });
});

describe('the Checks section is the span every other section reader sees', () => {
  // A line that is not a heading for sections.ts (indented, behind an NBSP or a BOM, or inside a code
  // fence) is not one for ## Checks either, so it cannot stand in for the real section.
  const DECOYS = [
    ['a leading NBSP', '\u00a0## Checks'],
    ['a leading BOM', '\ufeff## Checks'],
    ['four spaces', '    ## Checks'],
    ['a code fence', '```\n## Checks'],
  ] as const;
  const decoyed = (decoy: string, ...lines: string[]) => {
    const close = decoy.startsWith('```') ? '\n```' : '';
    return `${IMPACT}\n\n## Fix\n\nthe fix\n${decoy}\n${lines.join('\n')}${close}\n\n## Checks\n\n${C1}\n${C2}`;
  };

  it.each(DECOYS)('reads the real ## Checks, not a decoy behind %s in Fix', (_, decoy) => {
    const description = decoyed(decoy, '- [ ] C9 · walk www/visitor · decoy <!-- from D9 -->');
    expect(fake.parseChecks(description)?.checks.map((c) => c.id)).toEqual(['C1', 'C2']);
  });

  it.each(DECOYS)(
    'asks for sign-off when the real C2 is retired beside a decoy behind %s',
    async (_, decoy) => {
      const { strict, asked } = setup(decoyed(decoy, C1, C2));
      await strict.setState('ENG-1', [{ section: 'Checks', mode: 'replace', body: C1 }], SIGNED);
      expect(asked[0]?.dropped).toEqual([
        'C2 · read posthog-flag cap env=production · on (retired)',
      ]);
    },
  );

  it.each(DECOYS)(
    'refuses a tick on the real checks beside ticked copies behind %s',
    async (_, decoy) => {
      const { strict } = setup(decoyed(decoy, C1, C2));
      await expect(
        strict.setState('ENG-1', [
          { section: 'Checks', mode: 'replace', body: [C1.replace('[ ]', '[x]'), C2].join('\n') },
        ]),
      ).rejects.toThrow('this write ticks C1');
    },
  );

  it('reads a ### line inside ## Checks as part of the section, as Done when does, and every check below it', () => {
    const description = `${withChecks(C1)}\n\n### more\n\n${C2}`;
    expect(fake.parseChecks(description)).toMatchObject({
      checks: [{ id: 'C1' }, { id: 'C2' }],
      problems: ['not a check line: ### more'],
    });
    // Retiring the check below it is a retirement, asked for like any other.
    expect(droppedChecksById(fake, description, withChecks(C1))).toEqual([
      'C2 · read posthog-flag cap env=production · on (retired)',
    ]);
  });

  it('reads two ## Checks headings as a problem, never as one of them', () => {
    expect(fake.parseChecks(`${withChecks(C1)}\n\n## Checks\n\n${C2}`)).toEqual({
      checks: [],
      problems: ['the description has 2 "Checks" headings; merge them into one'],
    });
  });

  it('reads an empty Impact line as no Impact, never the line after it', () => {
    expect(fake.impactLine('Impact:\n- a visitor sees the cap')).toBeNull();
    expect(fake.impactLine('Impact:   \nsomething else')).toBeNull();
    expect(fake.impactLine('Impact: a visitor sees the cap')).toBe('a visitor sees the cap');
  });
});

interface Case {
  description: string;
  ticket: string;
  stored?: string;
  parse: {
    checks: Pick<Check, 'id' | 'ticked' | 'kind' | 'target' | 'claim' | 'quotes'>[];
    problems: string[];
  } | null;
  coverage: { misquoted: { id: string; quote: string }[]; uncovered: string[] };
}
const CASES = (
  JSON.parse(
    readFileSync(new URL('./fixtures/checks-conformance.json', import.meta.url), 'utf8'),
  ) as { cases: Case[] }
).cases;

/** What a case expects, read with one interpreter. */
function reading(m: ChecksModule, ticket: string) {
  const parsed = m.parseChecks(ticket);
  return {
    parse: parsed && {
      checks: parsed.checks.map(({ id, ticked, kind, target, claim, quotes }) => ({
        id,
        ticked,
        kind,
        target,
        claim,
        quotes,
      })),
      problems: parsed.problems,
    },
    coverage: m.impactCoverage(m.impactLine(ticket), parsed?.checks ?? []),
  };
}

function conformance(rulebook: () => ChecksModule) {
  it.each(CASES.map((c) => [c.description, c] as const))('%s', (_, c) => {
    const m = rulebook();
    const expected = { parse: c.parse, coverage: c.coverage };
    expect(reading(m, c.ticket)).toEqual(expected);
    if (c.stored !== undefined) expect(reading(m, c.stored)).toEqual(expected);
  });
}

describe('the conformance fixtures, read with the fixture rulebook', () => {
  it('has the cases it was generated with', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(58);
  });
  conformance(() => fake);
});

// A project's own rulebook, when LINEAR_STRICT_CHECKS_RULEBOOK_TEST names its path.
const REAL = process.env['LINEAR_STRICT_CHECKS_RULEBOOK_TEST'] ?? '';
(REAL && existsSync(REAL) ? describe : describe.skip)(
  'the conformance fixtures, read with LINEAR_STRICT_CHECKS_RULEBOOK_TEST',
  () => {
    conformance(() => checksInterpreter(parseChecksRulebook(readFileSync(REAL, 'utf8'))));
  },
);
