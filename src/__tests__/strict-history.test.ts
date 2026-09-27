import { memoryClaimStore } from '../claims.js';
import { type PmNode, renderMarkdown } from '../prosemirror.js';
import { StrictLinear } from '../strict-linear.js';
import { type FakeState, fakeGql, fakeState } from './strict-fake-linear.helper.js';

const text = (value: string, ...marks: string[]): PmNode => ({ type: 'text', text: value, marks: marks.map((type) => ({ type })) });
const para = (...content: PmNode[]): PmNode => ({ type: 'paragraph', content });
const heading = (value: string): PmNode => ({ type: 'heading', attrs: { level: 2 }, content: [text(value)] });
const bullets = (...lines: string[]): PmNode => ({
  type: 'bullet_list',
  content: lines.map((line) => ({ type: 'list_item', content: [para(text(line))] })),
});
const todos = (...items: [boolean, string][]): PmNode => ({
  type: 'todo_list',
  content: items.map(([done, line]) => ({ type: 'todo_item', attrs: { done }, content: [para(text(line))] })),
});
const doc = (...content: PmNode[]): PmNode => ({ type: 'doc', content });

describe('renderMarkdown', () => {
  it("writes Linear's markdown dialect, so an unchanged version matches the live description", () => {
    const rendered = renderMarkdown(
      doc(
        para(text('Impact: [x] ~30 turns, '), text('npx [a]', 'code'), text(' and '), {
          type: 'issueMention',
          attrs: { label: 'ENG-9', href: 'https://linear.app/x/issue/ENG-9/slug' },
        }),
        heading('Observed'),
        bullets('2026-09-01 · `a` · b'),
        todos([true, 'done'], [false, 'open']),
        { type: 'paragraph', content: [{ type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
        { type: 'code_block', attrs: { language: 'ts' }, content: [text('x = [1]; ~y')] },
        {
          type: 'table',
          content: [
            { type: 'table_row', content: [{ type: 'table_header', content: [para(text('Q'))] }, { type: 'table_header', content: [para(text('A'))] }] },
            { type: 'table_row', content: [{ type: 'table_cell', content: [para(text('one'))] }, { type: 'table_cell', content: [para(text('two'))] }] },
          ],
        },
      ),
    );
    expect(rendered.markdown).toBe(
      [
        'Impact: \\[x\\] \\~30 turns, `npx [a]` and [ENG-9](https://linear.app/x/issue/ENG-9/slug)',
        '',
        '## Observed',
        '',
        '* 2026-09-01 · `a` · b',
        '',
        '- [X] done',
        '- [ ] open',
        '',
        '[docs](<https://example.com>)',
        '',
        '```ts',
        'x = [1]; ~y',
        '```',
        '',
        '| Q | A |',
        '| -- | -- |',
        '| one | two |',
      ].join('\n'),
    );
    expect(rendered.unknown).toEqual([]);
  });

  it('keeps the text of a node type it does not know, and names the type', () => {
    const rendered = renderMarkdown(doc({ type: 'callout', content: [para(text('kept'))] }));
    expect(rendered).toEqual({ markdown: 'kept', unknown: ['callout'] });
  });
});

function setup(overrides: Partial<FakeState> = {}) {
  const state = fakeState(overrides);
  const strict = new StrictLinear({ gql: fakeGql(state), claims: memoryClaimStore() });
  return { state, strict };
}

const v1 = doc(heading('Observed'), bullets('2026-09-01 · a · b'), heading('Done when'), todos([false, 'tests pass']));
const v2 = doc(heading('Observed'), bullets('2026-09-01 · a · b', '2026-09-02 · c · d'), heading('Done when'), todos([true, 'tests pass · 12 passed']));

describe('description_history', () => {
  it('lists versions oldest first with who made each and what changed, skipping snapshots that changed no text', async () => {
    const { strict } = setup({
      snapshots: [
        { at: '2026-09-01T00:00:00.000Z', actorIds: ['u-ada'], doc: v1 },
        { at: '2026-09-01T01:00:00.000Z', actorIds: ['u-grace'], doc: v1 },
        { at: '2026-09-02T00:00:00.000Z', actorIds: ['u-agent-b', 'u-gone'], doc: v2 },
      ],
    });

    const result = await strict.descriptionHistory('ENG-1');

    expect(result.versions).toHaveLength(2);
    expect(result.versions[0]).toEqual({
      version: 1,
      at: '2026-09-01T00:00:00.000Z',
      by: ['Ada'],
      text: renderMarkdown(v1).markdown,
    });
    expect(result.versions[1]).toMatchObject({ version: 2, at: '2026-09-02T00:00:00.000Z', by: ['agent-b', 'u-gone'] });
    const diff = (result.versions[1] as { diff: string }).diff;
    expect(diff).toContain('+ * 2026-09-02 · c · d');
    expect(diff).toContain('- - [ ] tests pass');
    expect(diff).toContain('+ - [X] tests pass · 12 passed');
  });

  it('says whether the live description is in a version yet, and blames each line on the version that added it', async () => {
    const latest = renderMarkdown(v2).markdown;
    const { state, strict } = setup({
      snapshots: [
        { at: '2026-09-01T00:00:00.000Z', actorIds: ['u-ada'], doc: v1 },
        { at: '2026-09-02T00:00:00.000Z', actorIds: ['u-agent-b'], doc: v2 },
      ],
    });
    state.issue.description = latest;
    expect((await strict.descriptionHistory('ENG-1')).current).toEqual({ in_a_version: true, version: 2 });

    state.issue.description = `${latest}\n- [ ] a newer item`;
    const result = await strict.descriptionHistory('ENG-1', { blame: true });
    expect(result.current).toEqual({ in_a_version: false, diff_from_latest_version: expect.stringContaining('+ - [ ] a newer item') as unknown });
    const blame = 'blame' in result ? result.blame : [];
    const line = (value: string) => blame.find((entry) => entry.line === value);
    expect(line('* 2026-09-01 · a · b')).toEqual({ line: '* 2026-09-01 · a · b', version: 1, at: '2026-09-01T00:00:00.000Z', by: ['Ada'] });
    expect(line('* 2026-09-02 · c · d')).toMatchObject({ version: 2, by: ['agent-b'] });
    expect(line('- [X] tests pass · 12 passed')).toMatchObject({ version: 2 });
    expect(line('- [ ] a newer item')).toEqual({ line: '- [ ] a newer item', version: null });
    expect(blame).toHaveLength(state.issue.description.split('\n').length);
  });

  it('says so when Linear keeps no document for the ticket', async () => {
    const { strict } = setup({ snapshots: null });
    const result = await strict.descriptionHistory('ENG-1');
    expect(result.versions).toEqual([]);
    expect(result).toMatchObject({ omitted: [{ field: 'versions' }] });
  });
});
