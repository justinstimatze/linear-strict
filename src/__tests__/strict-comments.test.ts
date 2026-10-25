import { memoryClaimStore } from '../claims.js';
import * as rules from '../comment-rules.js';
import { StrictLinear } from '../strict-linear.js';
import { fakeGql, fakeState, type FakeState } from './strict-fake-linear.helper.js';

const ROOT = 'ebe62837-6208-476c-9be4-003f875f7d51';
const REPLY = '7a1c0f2e-1111-4222-8333-944455556666';

function setup(overrides: Partial<FakeState> = {}) {
  const state = fakeState(overrides);
  const strict = new StrictLinear({
    gql: fakeGql(state),
    claims: memoryClaimStore(),
    now: () => new Date('2026-09-24T12:00:00Z'),
  });
  return { state, strict };
}

function commentCreates(state: FakeState) {
  return state.calls
    .filter((call) => call.operation === 'StrictCommentCreate')
    .map((call) => call.variables['input'] as { body: string; parentId?: string });
}

function updates(state: FakeState) {
  return state.calls.filter((call) => call.operation === 'StrictCommentUpdate');
}

describe('replying in a thread', () => {
  function threaded() {
    return setup({
      comments: [
        {
          id: ROOT,
          body: 'Which limit applies?',
          createdAt: '2026-09-02T00:00:00Z',
          userName: 'Ada',
        },
        {
          id: REPLY,
          body: 'Per file, I think.',
          createdAt: '2026-09-03T00:00:00Z',
          userName: 'Grace',
          parentId: ROOT,
        },
      ],
    });
  }

  it('sets parentId from the 8-character prefix a comment URL shows', async () => {
    const { state, strict } = threaded();
    const result = await strict.comment('ENG-1', {
      kind: 'evidence',
      body: 'Per file: 25 MB.',
      parent: 'ebe62837',
    });
    expect(commentCreates(state)[0]?.parentId).toBe(ROOT);
    expect(result).toMatchObject({ reply_to: ROOT });
  });

  it('takes the comment URL as parent too', async () => {
    const { state, strict } = threaded();
    await strict.comment('ENG-1', {
      kind: 'evidence',
      body: 'Per file: 25 MB.',
      parent: 'https://linear.app/x/issue/ENG-1#comment-ebe62837',
    });
    expect(commentCreates(state)[0]?.parentId).toBe(ROOT);
  });

  it('puts a reply to a reply under the comment that opened the thread', async () => {
    const { state, strict } = threaded();
    await strict.comment('ENG-1', { kind: 'evidence', body: 'Confirmed.', parent: REPLY });
    expect(commentCreates(state)[0]?.parentId).toBe(ROOT);
  });

  it('refuses a parent that is not a comment on this ticket, writing nothing', async () => {
    const { state, strict } = threaded();
    await expect(
      strict.comment('ENG-1', { kind: 'evidence', body: 'Confirmed.', parent: 'deadbeef' }),
    ).rejects.toThrow(/parent deadbeef is not a comment on ENG-1/);
    expect(commentCreates(state)).toEqual([]);
  });

  it('carries parent on an ask, whose Open questions row still links the reply', async () => {
    const { state, strict } = threaded();
    await strict.comment('ENG-1', { kind: 'ask', body: 'Per file or per upload?', parent: ROOT });
    expect(commentCreates(state)[0]?.parentId).toBe(ROOT);
    expect(state.issue.description).toMatch(/Q1 · OPEN .* Per file or per upload\?/);
  });
});

describe('editing a comment', () => {
  const header = '🤖 agent-a · 2026-09-20 · evidence';

  function withComment(body: string, userName = 'agent-a', id = ROOT) {
    return setup({ comments: [{ id, body, createdAt: '2026-09-20T00:00:00Z', userName }] });
  }

  it('replaces the text of a comment this identity posted, keeping its header', async () => {
    const { state, strict } = withComment(`${header}\n\nThe limit is 52 MB.`);
    const result = await strict.comment('ENG-1', {
      kind: 'evidence',
      body: 'The limit is 25 MB.',
      edit: 'ebe62837',
    });
    expect(state.comments[0]?.body).toBe(`${header}\n\nThe limit is 25 MB.`);
    expect(state.comments[0]?.editedAt).toBeDefined();
    expect(commentCreates(state)).toEqual([]);
    expect(result).toMatchObject({ edited: ROOT, kind: 'evidence' });
  });

  it('keeps the lines the server added to the original post', async () => {
    const { state, strict } = withComment(
      `${header}\n\nSeen twice.\n\nDescription updated: Observed (append).`,
    );
    await strict.comment('ENG-1', { kind: 'evidence', body: 'Seen three times.', edit: ROOT });
    expect(state.comments[0]?.body).toBe(
      `${header}\n\nSeen three times.\n\nDescription updated: Observed (append).`,
    );
  });

  it('drops a header typed into the new body, as a new comment does', async () => {
    const { state, strict } = withComment(`${header}\n\nOld.`);
    await strict.comment('ENG-1', {
      kind: 'evidence',
      body: '🤖 agent-a · 2026-09-24 · correction\n\nNew.',
      edit: ROOT,
    });
    expect(state.comments[0]?.body).toBe(`${header}\n\nNew.`);
  });

  it('refuses to edit a comment another identity wrote', async () => {
    const { state, strict } = withComment(
      '🤖 agent-b · 2026-09-20 · evidence\n\nTheirs.',
      'agent-b',
    );
    await expect(
      strict.comment('ENG-1', { kind: 'evidence', body: 'Mine now.', edit: ROOT }),
    ).rejects.toThrow(/was written by agent-b, not agent-a\. Only its author edits a comment/);
    expect(updates(state)).toEqual([]);
  });

  it('refuses to edit a comment the person typed under the same personal key', async () => {
    const { state, strict } = setup({
      viewer: { id: 'u-ada', name: 'Ada', displayName: 'Ada', app: false },
      comments: [
        { id: ROOT, body: 'My own words.', createdAt: '2026-09-20T00:00:00Z', userName: 'Ada' },
      ],
    });
    await expect(
      strict.comment('ENG-1', { kind: 'evidence', body: 'Reworded.', edit: ROOT }),
    ).rejects.toThrow(/has no 🤖 header/);
    expect(updates(state)).toEqual([]);
  });

  it('refuses an edit that changes the kind', async () => {
    const { state, strict } = withComment(`${header}\n\nOld.`);
    await expect(
      strict.comment('ENG-1', { kind: 'ask', body: 'New.', edit: ROOT }),
    ).rejects.toThrow(/is an evidence comment, and an edit keeps its kind\. Pass kind "evidence"/);
    expect(updates(state)).toEqual([]);
  });

  it('refuses an edit that carries a patch, writing nothing', async () => {
    const { state, strict } = withComment(`${header}\n\nOld.`);
    const description = state.issue.description;
    await expect(
      strict.comment('ENG-1', {
        kind: 'evidence',
        body: 'New.',
        edit: ROOT,
        patch: [{ section: 'Observed', mode: 'append', body: '- 2026-09-24 · `ls` · ok' }],
        base: 'x',
      }),
    ).rejects.toThrow(/an edit changes only the comment's text, so it takes no patch, base/);
    expect(updates(state)).toEqual([]);
    expect(state.issue.description).toBe(description);
  });

  it("refuses an edit that rewrites an ask's question line", async () => {
    const { state, strict } = withComment(
      '🤖 agent-a · 2026-09-20 · ask Q1\n\nIs the limit per file?\n\nAsking @Ada',
    );
    await expect(
      strict.comment('ENG-1', { kind: 'ask', body: 'Is it per upload?', edit: ROOT }),
    ).rejects.toThrow(/first line of an ask is its row under Open questions/);
    expect(updates(state)).toEqual([]);

    await strict.comment('ENG-1', {
      kind: 'ask',
      body: 'Is the limit per file?\n\nContext: uploads over 25 MB fail.',
      edit: ROOT,
    });
    expect(state.comments[0]?.body).toBe(
      '🤖 agent-a · 2026-09-20 · ask Q1\n\nIs the limit per file?\n\nContext: uploads over 25 MB fail.\n\nAsking @Ada',
    );
  });

  it('runs the new text through the mention check, refusing an @name that names nobody', async () => {
    const { state, strict } = withComment(`${header}\n\nOld.`);
    await expect(
      strict.comment('ENG-1', { kind: 'evidence', body: '@nobody please look.', edit: ROOT }),
    ).rejects.toThrow(/@nobody matches nobody/);
    expect(updates(state)).toEqual([]);

    const result = await strict.comment('ENG-1', {
      kind: 'evidence',
      body: '@grace please look.',
      edit: ROOT,
    });
    expect(state.comments[0]?.body).toBe(`${header}\n\n@Grace please look.`);
    expect(result).toMatchObject({ mentioned: ['@Grace'] });
  });

  it('refuses an edit id that is not a comment on this ticket', async () => {
    const { strict } = withComment(`${header}\n\nOld.`);
    await expect(
      strict.comment('ENG-1', { kind: 'evidence', body: 'New.', edit: 'c0ffee00' }),
    ).rejects.toThrow(/edit c0ffee00 is not a comment on ENG-1/);
  });
});

describe('@mentions', () => {
  const people = (extra: FakeState['users'] = []) =>
    setup({
      users: [
        {
          id: 'u-ada',
          name: 'Ada Lovelace',
          displayName: 'ada',
          email: 'ada@example.com',
          active: true,
        },
        {
          id: 'u-grace',
          name: 'Grace Hopper',
          displayName: 'grace',
          email: 'grace@example.com',
          active: true,
        },
        ...extra,
      ],
    });

  it('writes each @name as the member handle, which Linear turns into a notifying mention', async () => {
    const { state, strict } = people();
    const result = await strict.comment('ENG-1', {
      kind: 'evidence',
      body: '@Ada and @grace hopper: see below. Also @Grace.',
    });
    expect(state.comments[0]?.body).toContain('@ada and @grace hopper: see below. Also @grace.');
    expect(result).toMatchObject({ mentioned: ['@ada', '@grace'] });
  });

  it('refuses an @name that matches nobody, listing who is close, and writes nothing', async () => {
    const { state, strict } = people();
    await expect(
      strict.comment('ENG-1', { kind: 'evidence', body: 'Thanks @gra and @zed.' }),
    ).rejects.toThrow(
      /@gra matches nobody in the workspace; close: @grace \(Grace Hopper\)\. @zed matches nobody in the workspace\./,
    );
    expect(commentCreates(state)).toEqual([]);
  });

  it('refuses an @name that matches several people, listing them, and writes nothing', async () => {
    const { state, strict } = people([
      {
        id: 'u-ada-2',
        name: 'Ada Byron',
        displayName: 'ada.b',
        email: 'adab@example.com',
        active: true,
      },
    ]);
    await expect(
      strict.comment('ENG-1', { kind: 'evidence', body: 'Ask @Ada?' }),
    ).resolves.toMatchObject({ mentioned: ['@ada'] });
    // The handle "ada" wins outright; a first name shared by two people does not.
    const { state: two, strict: strict2 } = setup({
      users: [
        {
          id: 'u-1',
          name: 'Julie A',
          displayName: 'julie.a',
          email: 'a@example.com',
          active: true,
        },
        {
          id: 'u-2',
          name: 'Julie B',
          displayName: 'julie.b',
          email: 'b@example.com',
          active: true,
        },
      ],
    });
    await expect(
      strict2.comment('ENG-1', { kind: 'evidence', body: '@julie can you check?' }),
    ).rejects.toThrow(/@julie matches 2 people: @julie\.a \(Julie A\), @julie\.b \(Julie B\)/);
    expect(commentCreates(two)).toEqual([]);
    expect(commentCreates(state)).toHaveLength(1);
  });

  it('leaves @ in code, email addresses, agent names and npm scopes alone', () => {
    expect(
      rules.mentionsIn(
        [
          'Mail ada@example.com, ask mayor@justin, bump @types/node.',
          'Run `npm i @scope/pkg @inline` first.',
          '```',
          '@fenced stays',
          '```',
          'But (@grace) and @ada.',
        ].join('\n'),
      ),
    ).toEqual(['grace', 'ada']);
  });

  it('refuses an ask_to that names nobody, like an @name, writing nothing', async () => {
    const { state, strict } = people();
    await expect(
      strict.comment('ENG-1', { kind: 'ask', body: 'Per file?', ask_to: 'Zed' }),
    ).rejects.toThrow(/Nothing was written: ask_to No active user "Zed"/);
    expect(commentCreates(state)).toEqual([]);
  });

  it('writes ask_to as an @handle mention and reports it', async () => {
    const { state, strict } = people();
    const result = await strict.comment('ENG-1', {
      kind: 'ask',
      body: 'Per file?',
      ask_to: 'grace@example.com',
    });
    expect(state.comments[0]?.body).toMatch(/\n\nAsking @grace$/);
    expect(result).toMatchObject({ mentioned: ['@grace'] });
  });
});
