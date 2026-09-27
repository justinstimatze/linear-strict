import {
  addQuestion,
  answerQuestion,
  applySectionPatches,
  commentKind,
  lintDescription,
  listQuestions,
  lintForState,
  uncitedTicks,
  nextQuestionId,
  readMarker,
  readSection,
  validateSectionBody,
  writeMarker,
} from '../sections.js';

const TICKET = [
  'Intro paragraph.',
  '',
  '## Observed',
  '',
  '- 2026-09-01 · `curl /health` · 200',
  '',
  '## Done when',
  '',
  '- [ ] `npm test` passes',
  '',
  '<!-- ticket-facts:begin -->',
  'generated, do not touch',
  '<!-- ticket-facts:end -->',
].join('\n');

describe('section patches', () => {
  it('appends to an existing section and leaves the generated block alone', () => {
    const next = applySectionPatches(TICKET, [
      { section: 'Observed', mode: 'append', body: '- 2026-09-02 · `git log -1` · abc123 on main' },
    ]);
    expect(readSection(next, 'Observed')).toBe(
      '- 2026-09-01 · `curl /health` · 200\n- 2026-09-02 · `git log -1` · abc123 on main',
    );
    expect(next).toContain(
      '<!-- ticket-facts:begin -->\ngenerated, do not touch\n<!-- ticket-facts:end -->',
    );
  });

  it('replaces a section that runs into a generated block without eating the block', () => {
    const next = applySectionPatches(TICKET, [
      { section: 'done when', mode: 'replace', body: '- [x] `npm test` passes' },
    ]);
    expect(readSection(next, 'Done when')).toBe('- [x] `npm test` passes');
    expect(next).toContain('generated, do not touch');
  });

  it('inserts a missing section in canonical order', () => {
    const next = applySectionPatches(TICKET, [
      { section: 'Cause', mode: 'replace', body: 'not established' },
    ]);
    const order = ['## Observed', '## Cause', '## Done when', '<!-- ticket-facts:begin -->'].map(
      (marker) => next.indexOf(marker),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
  });

  it('ignores headings inside code fences', () => {
    const text = '## Fix\n\n```\n## Observed\n```\n';
    expect(readSection(text, 'Observed')).toBeNull();
  });

  it('refuses an Observed line without a source, and says what to do instead', () => {
    expect(() =>
      applySectionPatches(TICKET, [
        { section: 'Observed', mode: 'append', body: '- the endpoint is fine now' },
      ]),
    ).toThrow(/not "YYYY-MM-DD · <source> · <result>".*hypothesis/s);
  });

  it('refuses a Done when line that is not a checklist item', () => {
    expect(() =>
      applySectionPatches(TICKET, [{ section: 'Done when', mode: 'append', body: 'tests pass' }]),
    ).toThrow(/not a checklist item/);
  });

  it('refuses direct edits to Open questions, generated markers and headings in bodies', () => {
    expect(() =>
      applySectionPatches(TICKET, [{ section: 'Open questions', mode: 'append', body: '- Q1' }]),
    ).toThrow(/only through comment kind "ask"/);
    expect(() =>
      applySectionPatches(TICKET, [
        { section: 'Fix', mode: 'replace', body: 'x\n<!-- ticket-facts:end -->' },
      ]),
    ).toThrow(/generated-block marker/);
    expect(() =>
      applySectionPatches(TICKET, [{ section: 'Fix', mode: 'replace', body: 'x\n## Cause\ny' }]),
    ).toThrow(/would split the section/);
  });

  it('refuses to guess between two headings with the same name', () => {
    const doubled = `${TICKET}\n\n## Observed\n\n- 2026-09-03 · a · b`;
    expect(() =>
      applySectionPatches(doubled, [
        { section: 'Observed', mode: 'append', body: '- 2026-09-04 · a · b' },
      ]),
    ).toThrow(/2 "Observed" headings/);
  });

  it('reports every validation error at once', () => {
    expect(() =>
      applySectionPatches(TICKET, [
        { section: 'Observed', mode: 'append', body: 'no source' },
        { section: 'Done when', mode: 'append', body: 'not a box' },
      ]),
    ).toThrow(/Observed[\s\S]*Done when/);
  });
});

describe('open questions', () => {
  it('adds numbered rows and flips one to answered with a link', () => {
    let text = addQuestion(TICKET, {
      id: nextQuestionId(TICKET),
      date: '2026-09-24',
      askedBy: 'agent-a',
      askedTo: 'Ada',
      question: 'Are upload limits enforced server-side?\nmore detail',
      link: 'https://l/c1',
    });
    text = addQuestion(text, {
      id: nextQuestionId(text),
      date: '2026-09-24',
      askedBy: 'agent-a',
      question: 'Second?',
      link: 'https://l/c2',
    });

    expect(listQuestions(text).map((row) => [row.id, row.open])).toEqual([
      ['Q1', true],
      ['Q2', true],
    ]);
    expect(readSection(text, 'Open questions')).toContain(
      'agent-a → Ada · Are upload limits enforced server-side? more detail',
    );

    const answered = answerQuestion(text, 'Q1', '2026-09-25', 'https://l/c3');
    expect(listQuestions(answered).map((row) => [row.id, row.open])).toEqual([
      ['Q1', false],
      ['Q2', true],
    ]);
    expect(answered).toContain('Q1 · ANSWERED 2026-09-25 [answer](https://l/c3) ·');
    expect(nextQuestionId(answered)).toBe('Q3');
    expect(() => answerQuestion(answered, 'Q1', '2026-09-25', 'x')).toThrow(/already answered/);
    expect(() => answerQuestion(answered, 'Q9', '2026-09-25', 'x')).toThrow(/No question Q9/);
  });
});

describe('reconciled marker and lint', () => {
  it('writes one marker at the end and reads it back', () => {
    const once = writeMarker(TICKET, { through: 'c-1', at: '2026-09-24T00:00:01Z', by: 'agent-a' });
    const twice = writeMarker(once, { through: 'c-2', at: '2026-09-24T00:00:02Z', by: 'agent-b' });
    expect(readMarker(twice)).toEqual({
      through: 'c-2',
      at: '2026-09-24T00:00:02Z',
      by: 'agent-b',
    });
    expect(twice.match(/strict:reconciled/g)).toHaveLength(1);
  });

  it('keeps the marker out of sections and inserts new sections above it', () => {
    const marked = writeMarker(TICKET.split('\n<!-- ticket-facts')[0] ?? '', {
      through: 'c-1',
      at: 't',
      by: 'agent-a',
    });
    const asked = addQuestion(marked, {
      id: 'Q1',
      date: '2026-09-24',
      askedBy: 'agent-a',
      question: 'Why?',
      link: 'https://l/c',
    });
    expect(readSection(asked, 'Done when')).toBe('- [ ] `npm test` passes');
    expect(asked.indexOf('## Open questions')).toBeLessThan(asked.indexOf('strict:reconciled'));
    expect(lintDescription(asked)).toEqual([]);
    expect(readMarker(asked)?.through).toBe('c-1');
  });

  it('flags a description written without the format', () => {
    const codes = lintDescription('Just some prose.\n\n## Observed\n\n- it works').map(
      (finding) => finding.code,
    );
    expect(codes).toEqual(expect.arrayContaining(['invalid_line', 'missing_section']));
    expect(lintDescription(TICKET)).toEqual([]);
  });

  it('recognises comments this server wrote', () => {
    expect(commentKind('🤖 agent-a · 2026-09-24 · correction\n\nbody')).toBe('correction');
    expect(commentKind('looks good to me')).toBeNull();
  });
});

describe('the Impact line', () => {
  const BODY = '## Observed\n\n- 2026-09-20 · `curl x` · English\n\n## Done when\n\n- [ ] a check';

  it('sets it first, replaces it rather than adding a second, and takes the body with or without the prefix', () => {
    const set = applySectionPatches(BODY, [
      {
        section: 'Impact',
        mode: 'replace',
        body: 'Portuguese speakers get answers they can read.',
      },
    ]);
    expect(set).toBe(`Impact: Portuguese speakers get answers they can read.\n\n${BODY}`);

    const replaced = applySectionPatches(set, [
      { section: 'impact', mode: 'replace', body: 'Impact: none, internal maintenance.' },
    ]);
    expect(replaced).toBe(`Impact: none, internal maintenance.\n\n${BODY}`);
    expect(lintDescription(replaced)).toEqual([]);
  });

  it('moves an Impact line written elsewhere to the top instead of keeping two', () => {
    const buried = `${BODY}\n\n🤖 Impact: old claim`;
    expect(
      applySectionPatches(buried, [{ section: 'Impact', mode: 'replace', body: 'new claim' }]),
    ).toBe(`Impact: new claim\n\n${BODY}`);
  });

  it('refuses append, several lines, and markup', () => {
    expect(() =>
      applySectionPatches(BODY, [{ section: 'Impact', mode: 'append', body: 'x' }]),
    ).toThrow(/mode "replace"/);
    expect(() =>
      applySectionPatches(BODY, [{ section: 'Impact', mode: 'replace', body: 'one\ntwo' }]),
    ).toThrow(/one line/);
    expect(() =>
      applySectionPatches(BODY, [{ section: 'Impact', mode: 'replace', body: '## big' }]),
    ).toThrow(/plain text/);
  });
});

describe('Observed bullets', () => {
  const STARRED = '## Observed\n\n* 2026-09-24 · a.ts:1 · first\n\n## Done when\n\n- [ ] x';

  it('bullets appended lines to match the section, so Linear does not fold them into the last one', () => {
    const out = applySectionPatches(STARRED, [
      {
        section: 'Observed',
        mode: 'append',
        body: '2026-09-25 · git log · second\n2026-09-25 · curl - · third',
      },
    ]);
    expect(readSection(out, 'Observed')).toBe(
      '* 2026-09-24 · a.ts:1 · first\n* 2026-09-25 · git log · second\n* 2026-09-25 · curl - · third',
    );
  });

  it('uses "-" for a new section and keeps lines that already have a bullet', () => {
    const out = applySectionPatches('', [
      {
        section: 'Observed',
        mode: 'replace',
        body: '2026-09-25 · git log · one\n- 2026-09-25 · git log · two',
      },
    ]);
    expect(readSection(out, 'Observed')).toBe(
      '- 2026-09-25 · git log · one\n- 2026-09-25 · git log · two',
    );
  });

  it('accepts a time after the date, and does not call a sourced line a hypothesis', () => {
    const timed = '- 2026-09-25 04:40Z · `role-probe.mjs`, 32 requests · every shape about 350ms';
    expect(validateSectionBody('Observed', timed)).toEqual([]);
    expect(validateSectionBody('Observed', '2026-09-25T04:40:12+02:00 · git log · ok')).toEqual([]);
    const [error] = validateSectionBody('Observed', '2026-09-25 at noon · git log · ok');
    expect(error).toContain('is not "YYYY-MM-DD');
    expect(error).not.toContain('hypothesis');
    expect(validateSectionBody('Observed', '2026-09-25 · it probably broke')[0]).toContain(
      'hypothesis',
    );
  });
});

describe('list markers', () => {
  it('rewrites an appended line to the bullet the section uses, so the list stays one list', () => {
    const out = applySectionPatches('## Observed\n\n* 2026-09-24 · a.ts:1 · first', [
      { section: 'Observed', mode: 'append', body: '- 2026-09-25 · git log · second' },
    ]);
    expect(readSection(out, 'Observed')).toBe(
      '* 2026-09-24 · a.ts:1 · first\n* 2026-09-25 · git log · second',
    );
  });

  it('does the same for Done when items', () => {
    const out = applySectionPatches('## Done when\n\n* [x] one', [
      { section: 'Done when', mode: 'append', body: '- [ ] two' },
    ]);
    expect(readSection(out, 'Done when')).toBe('* [x] one\n* [ ] two');
  });
});

describe('lintForState', () => {
  const plain = 'Folks asked for this. Steps below.\n\n- do a\n- do b';

  it('asks an open ticket with no sections for them once, not once per section', () => {
    const findings = lintForState(plain, 'started');
    expect(findings.map((finding) => finding.code)).toEqual(['unstructured']);
  });

  it('asks a closed ticket for nothing it never had', () => {
    for (const type of ['completed', 'canceled', 'duplicate'])
      expect(lintForState(plain, type)).toEqual([]);
  });

  it('keeps the specific finding when only one section is missing, and format problems when closed', () => {
    expect(
      lintForState('## Observed\n\n- 2026-09-25 · a · b', 'started').map(
        (finding) => finding.detail,
      ),
    ).toEqual(['No "Done when" section']);
    expect(
      lintForState('## Observed\n\nnot a line', 'completed').map((finding) => finding.code),
    ).toEqual(['invalid_line']);
  });
});

describe('uncitedTicks', () => {
  const ticket = (doneWhen: string) =>
    `## Observed\n\n- 2026-09-25 · a · b\n- 2026-09-25 · c · d\n\n## Done when\n\n${doneWhen}`;
  const reasons = (doneWhen: string) =>
    uncitedTicks(ticket(doneWhen)).map((uncited) => uncited.reason);

  it('accepts each kind of citation after the item', () => {
    for (const cited of [
      '- [x] merged · PR #1315 @ 63d5cf5b14',
      '- [x] on main · 63d5cf5',
      '- [x] handles empty input · src/parse.ts:42',
      '- [x] live — https://example.com/runs/1',
      '- [x] suite passes · Observed 2',
      '- [x] suite passes (run 36087655179)',
      '- [x] health is green · `curl /health` → 200',
    ]) {
      expect([cited, reasons(cited)]).toEqual([cited, []]);
    }
  });

  it('refuses a tick with nothing after it, or evidence only inside the item text', () => {
    expect(reasons('- [x] `npm test` passes')).toEqual(['no citation after the item']);
    expect(reasons('- [x] suite passes · looked fine')).toEqual([
      '"looked fine" gives a result but not where it came from',
    ]);
    expect(reasons('- [x] suite passes · 1234567')).toEqual([
      '"1234567" gives a result but not where it came from',
    ]);
  });

  it('refuses a reference to an Observed line that is not there, and ignores unticked items', () => {
    expect(reasons('- [x] suite passes · Observed 3')).toEqual([
      'Observed has 2 lines, so there is no Observed 3',
    ]);
    expect(reasons('- [ ] not yet')).toEqual([]);
  });
});
