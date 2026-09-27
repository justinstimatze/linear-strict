import { memoryClaimStore } from '../claims.js';
import { MARKER_URL } from '../marker.js';
import {
  type SignOffRequest,
  StrictLinear,
  type StrictLinearOptions,
  descriptionSha,
} from '../strict-linear.js';
import {
  addComments,
  editOutOfBand,
  fakeGql,
  fakeState,
  touchWithoutContentChange,
  type FakeState,
} from './strict-fake-linear.helper.js';

function setup(overrides: Partial<FakeState> = {}, signOff?: StrictLinearOptions['signOff']) {
  const state = fakeState(overrides);
  const strict = new StrictLinear({
    gql: fakeGql(state),
    claims: memoryClaimStore(),
    now: () => new Date('2026-09-24T12:00:00Z'),
    ...(signOff ? { signOff } : {}),
  });
  return { state, strict };
}

describe('get_issue', () => {
  it('returns every comment across pages, oldest first, with nothing omitted', async () => {
    const { state, strict } = setup();
    addComments(state, 230);

    const result = await strict.getIssue('ENG-1');

    expect(result.comments).toHaveLength(230);
    expect(result.comments.map((c) => c.body).slice(0, 2)).toEqual(['comment 1', 'comment 2']);
    expect(result.comments.at(-1)?.body).toBe('comment 230');
    expect(result.omitted).toEqual([]);
    expect(state.calls.filter((call) => call.operation === 'StrictIssue_comments')).toHaveLength(3);
  });

  it('reports a failed later page in omitted instead of returning a shorter list silently', async () => {
    const { state, strict } = setup();
    addComments(state, 230);
    state.failCommentPages.add(2);

    const result = await strict.getIssue('ENG-1');

    expect(result.comments).toHaveLength(100);
    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0]).toMatchObject({ field: 'comments', fetched: 100 });
    expect(result.omitted[0]?.reason).toContain('page 2 failed');
  });

  it('marks comment authors and flags a Done ticket with no linked PR', async () => {
    const { state, strict } = setup();
    state.issue.stateId = 's-done';
    addComments(state, 1, 'Ada');
    await strict.comment('ENG-1', { kind: 'evidence', body: 'saw it' });

    const result = await strict.getIssue('ENG-1');

    expect(result.comments.map((c) => c.author_kind)).toEqual(['person', 'agent']);
    expect(result.findings.map((f) => f.code)).toContain('no_linked_pr');

    state.attachments.push({
      title: 'fix',
      url: 'https://github.com/o/r/pull/7',
      sourceType: 'github',
      metadata: { number: 7, status: 'merged', targetBranch: 'main' },
    });
    const linked = await strict.getIssue('ENG-1');
    expect(linked.findings).toEqual([]);
    expect(linked.pull_requests).toMatchObject([
      { number: 7, status: 'merged', targetBranch: 'main' },
    ]);
    expect(linked.attachments).toEqual([]);
  });

  it('fails outright when the first comment page fails', async () => {
    const { state, strict } = setup();
    addComments(state, 3);
    state.failCommentPages.add(1);
    await expect(strict.getIssue('ENG-1')).rejects.toThrow(/page 1/);
  });

  it('marks comments posted after the reconciled marker as unreconciled', async () => {
    const { state, strict } = setup();
    addComments(state, 2);
    await strict.setState('ENG-1', [], {
      reconciled_through: 'seed-2',
      accounts_for: [{ comment: '*', how: 'no_state_change', reason: 'setup chatter' }],
    });
    addComments(state, 1, 'official-mcp-user');

    const result = await strict.getIssue('ENG-1');

    expect(result.drift.reconciled_through).toMatchObject({ through: 'seed-2', by: 'agent-a' });
    expect(result.drift.unreconciled_comments.map((c) => c.id)).toEqual(['seed-3']);
    expect(result.drift.needs_reconcile).toBe(true);
  });

  it('without a marker, counts comments after the last description edit', async () => {
    const { state, strict } = setup();
    addComments(state, 1);
    editOutOfBand(state, state.issue.description);
    addComments(state, 2);

    const result = await strict.getIssue('ENG-1');

    expect(result.drift.reconciled_through).toBeNull();
    expect(result.drift.unreconciled_comments).toHaveLength(2);
  });
});

describe('the reconciled marker attachment', () => {
  const OBSERVED = {
    section: 'Observed',
    mode: 'append' as const,
    body: '- 2026-09-24 · `curl /health` · 200',
  };
  const marker = (state: ReturnType<typeof fakeState>) =>
    state.attachments.filter((a) => a.url === MARKER_URL);

  it('keeps the marker in one attachment, out of the description and the attachments list', async () => {
    const { state, strict } = setup();
    addComments(state, 2);
    await strict.setState('ENG-1', [], {
      reconciled_through: 'seed-1',
      accounts_for: [{ comment: '*', how: 'no_state_change', reason: 'setup' }],
    });
    await strict.setState('ENG-1', [OBSERVED], {
      reconciled_through: 'seed-2',
      accounts_for: [{ comment: 'seed-2', how: 'folded' }],
    });

    expect(state.issue.description).not.toContain('strict:reconciled');
    expect(marker(state)).toHaveLength(1);
    expect(marker(state)[0]?.metadata).toMatchObject({
      version: 1,
      through: 'seed-2',
      by: 'agent-a',
      sha: descriptionSha(state.issue.description),
    });
    const read = await strict.getIssue('ENG-1');
    expect(read.drift.reconciled_through).toMatchObject({
      through: 'seed-2',
      stored_in: 'attachment',
    });
    expect(read.drift).not.toHaveProperty('description_changed_elsewhere');
    expect(read.attachments).toEqual([]);
  });

  it('replaces a card left at the earlier npm URL on the next write', async () => {
    const { state, strict } = setup();
    addComments(state, 1);
    state.attachments.push({
      title: 'old',
      url: 'https://www.npmjs.com/package/linear-strict',
      sourceType: 'api',
      metadata: { version: 1, through: 'seed-1', at: '2026-09-24T00:00:01.000Z', by: 'agent-a' },
    });
    expect((await strict.getIssue('ENG-1')).drift.reconciled_through).toMatchObject({
      through: 'seed-1',
      stored_in: 'attachment',
    });
    await strict.setState('ENG-1', [OBSERVED]);
    expect(state.attachments.map((a) => a.url)).toEqual([MARKER_URL]);
    expect(marker(state)[0]?.metadata).toMatchObject({ through: 'seed-1' });
  });

  it('reads a marker line left in the description, and moves it to the attachment on the next write', async () => {
    const { state, strict } = setup();
    addComments(state, 1);
    const before = state.issue.description;
    editOutOfBand(
      state,
      `${before}\n\n<!-- strict:reconciled through=seed-1 at=2026-09-24T00:00:01.000Z by="agent-a" -->`,
    );
    expect((await strict.getIssue('ENG-1')).drift.reconciled_through).toMatchObject({
      through: 'seed-1',
      stored_in: 'description',
    });

    await strict.setState('ENG-1', [OBSERVED]);

    expect(state.issue.description).not.toContain('strict:reconciled');
    expect(marker(state)[0]?.metadata).toMatchObject({
      through: 'seed-1',
      at: '2026-09-24T00:00:01.000Z',
      sha: descriptionSha(state.issue.description),
    });
    expect((await strict.getIssue('ENG-1')).drift.reconciled_through).toMatchObject({
      through: 'seed-1',
      stored_in: 'attachment',
    });
  });

  it('says when the description changed outside this server since the marker was written', async () => {
    const { state, strict } = setup();
    addComments(state, 1);
    await strict.setState('ENG-1', [], {
      reconciled_through: 'seed-1',
      accounts_for: [{ comment: '*', how: 'no_state_change', reason: 'setup' }],
    });
    editOutOfBand(state, `${state.issue.description}\n\nA line someone typed in Linear.`);

    const read = await strict.getIssue('ENG-1');
    expect(read.drift.description_changed_elsewhere).toMatch(/edited outside linear-strict/);
    expect(read.drift.needs_reconcile).toBe(false);
  });

  it('refuses a marker move whose attachment write fails, and warns on a plain patch', async () => {
    const { state, strict } = setup();
    addComments(state, 1);
    await strict.setState('ENG-1', [], {
      reconciled_through: 'seed-1',
      accounts_for: [{ comment: '*', how: 'no_state_change', reason: 'setup' }],
    });
    addComments(state, 1, 'agent-a');
    state.failMarkerUpsert = true;

    const patched = await strict.setState('ENG-1', [OBSERVED]);
    expect(patched.marker_warning).toMatch(/could not be updated/);
    await expect(
      strict.setState('ENG-1', [], {
        reconciled_through: 'seed-2',
        accounts_for: [{ comment: '*', how: 'no_state_change', reason: 'x' }],
      }),
    ).rejects.toThrow(/the reconciled marker was not/);
    expect(marker(state)[0]?.metadata).toMatchObject({ through: 'seed-1' });
  });
});

describe('reconciled_through accounting', () => {
  const OBSERVED = {
    section: 'Observed',
    mode: 'append' as const,
    body: '- 2026-09-24 · `curl /health` · 200',
  };

  it('refuses to move the marker past a comment nobody accounted for, naming it', async () => {
    const { state, strict } = setup();
    addComments(state, 2);
    await expect(strict.setState('ENG-1', [], { reconciled_through: 'seed-2' })).rejects.toThrow(
      /not accounted for: seed-1, seed-2/,
    );
    expect(state.issue.description).not.toContain('strict:reconciled');
  });

  it('needs a patch in the same call for a comment marked folded', async () => {
    const { state, strict } = setup();
    addComments(state, 1);
    await expect(
      strict.setState('ENG-1', [], {
        reconciled_through: 'seed-1',
        accounts_for: [{ comment: 'seed-1', how: 'folded' }],
      }),
    ).rejects.toThrow(/no patch to fold them into/);
    const result = await strict.setState('ENG-1', [OBSERVED], {
      reconciled_through: 'seed-1',
      accounts_for: [{ comment: 'seed-1', how: 'folded' }],
    });
    expect(result.accounted).toMatchObject({ folded: 1, self_applied: 0, no_state_change: [] });
  });

  it('asks again about a covered comment edited after the description accounted for it', async () => {
    const state = fakeState();
    let now = '2026-09-24T12:00:00.000Z';
    const strict = new StrictLinear({
      gql: fakeGql(state),
      claims: memoryClaimStore(),
      now: () => new Date(now),
    });
    addComments(state, 2);
    const [first] = state.comments;
    if (!first) throw new Error('no comment');
    first.editedAt = '2026-09-24T11:00:00.000Z';
    await strict.setState('ENG-1', [], {
      reconciled_through: 'seed-2',
      accounts_for: [{ comment: '*', how: 'no_state_change', reason: 'setup' }],
    });
    expect(state.attachments.find((a) => a.url === MARKER_URL)?.metadata).toMatchObject({
      checked: '2026-09-24T12:00:00.000Z',
    });
    expect((await strict.getIssue('ENG-1')).drift.needs_reconcile).toBe(false);

    first.editedAt = '2026-09-24T13:00:00.000Z';
    const read = await strict.getIssue('ENG-1');
    expect(read.drift.needs_reconcile).toBe(true);
    expect(read.drift.unreconciled_comments).toEqual([]);
    expect(read.drift.edited_after_reconcile).toEqual([
      expect.objectContaining({ id: 'seed-1', editedAt: '2026-09-24T13:00:00.000Z' }),
    ]);
    expect(read.drift.next_step).toMatch(/edited after the description accounted for them/);

    now = '2026-09-24T14:00:00.000Z';
    await expect(strict.setState('ENG-1', [], { reconciled_through: 'seed-2' })).rejects.toThrow(
      /not accounted for: seed-1/,
    );
    await strict.setState('ENG-1', [], {
      reconciled_through: 'seed-2',
      accounts_for: [{ comment: 'seed-1', how: 'no_state_change', reason: 'typo fix only' }],
    });
    expect((await strict.getIssue('ENG-1')).drift.needs_reconcile).toBe(false);
  });

  it('cannot date edits against a marker written before it recorded a check time, and says so', async () => {
    const { state, strict } = setup();
    addComments(state, 1);
    editOutOfBand(
      state,
      `${state.issue.description}\n\n<!-- strict:reconciled through=seed-1 at=2026-09-24T00:00:01.000Z by="agent-a" -->`,
    );
    const [first] = state.comments;
    if (!first) throw new Error('no comment');
    first.editedAt = '2026-09-24T13:00:00.000Z';
    const read = await strict.getIssue('ENG-1');
    expect(read.drift.needs_reconcile).toBe(false);
    expect(read.drift.edits_unchecked).toMatch(/next reconcile records the time/);
  });

  it("needs a reason for no_state_change, and flags people's comments waved through", async () => {
    const { state, strict } = setup();
    addComments(state, 1, 'Ada');
    await expect(
      strict.setState('ENG-1', [], {
        reconciled_through: 'seed-1',
        accounts_for: [{ comment: 'seed-1', how: 'no_state_change' }],
      }),
    ).rejects.toThrow(/needs a reason/);
    const result = await strict.setState('ENG-1', [], {
      reconciled_through: 'seed-1',
      accounts_for: [{ comment: '*', how: 'no_state_change', reason: 'thanks note' }],
    });
    expect(result.accounted?.no_state_change).toEqual([
      { comment: 'seed-1', author: 'Ada', author_kind: 'person', reason: 'thanks note' },
    ]);
    expect(result.accounted?.review).toMatch(/first-hand record/);
  });

  it('counts typed comments that already changed the description, in drift and in accounting', async () => {
    const { state, strict } = setup();
    addComments(state, 1);
    await strict.setState('ENG-1', [], {
      reconciled_through: 'seed-1',
      accounts_for: [{ comment: 'seed-1', how: 'no_state_change', reason: 'setup' }],
    });
    await strict.comment('ENG-1', {
      kind: 'correction',
      body: 'It was the cache.',
      patch: [OBSERVED],
    });

    const read = await strict.getIssue('ENG-1');
    expect(read.drift.needs_reconcile).toBe(false);
    expect(read.drift.self_applied_after_marker).toBe(1);

    const newest = state.comments.at(-1)?.id ?? '';
    const moved = await strict.setState('ENG-1', [], { reconciled_through: newest });
    expect(moved.accounted).toMatchObject({ self_applied: 1, folded: 0 });
  });

  it('refuses to move the marker back, and refuses entries outside the range', async () => {
    const { state, strict } = setup();
    addComments(state, 2);
    await strict.setState('ENG-1', [], {
      reconciled_through: 'seed-2',
      accounts_for: [{ comment: '*', how: 'no_state_change', reason: 'setup' }],
    });
    await expect(strict.setState('ENG-1', [], { reconciled_through: 'seed-1' })).rejects.toThrow(
      /cannot move back/,
    );
    addComments(state, 1);
    await expect(
      strict.setState('ENG-1', [], {
        reconciled_through: 'seed-3',
        accounts_for: [
          { comment: 'seed-1', how: 'no_state_change', reason: 'x' },
          { comment: 'seed-3', how: 'no_state_change', reason: 'x' },
        ],
      }),
    ).rejects.toThrow(/seed-1 is not between/);
  });
});

describe('dropping an unticked Done when item', () => {
  const TWO_CHECKS =
    '- [x] `npm test` passes\n- [ ] a Portuguese question gets a Portuguese answer on the live site';
  const ONE_CHECK = '- [x] `npm test` passes';

  function withTwoChecks(signOff?: StrictLinearOptions['signOff']) {
    const env = setup({}, signOff);
    env.state.issue.description = `## Observed\n\n- 2026-09-01 · \`curl /health\` · 200\n\n## Done when\n\n${TWO_CHECKS}`;
    return env;
  }

  it('refuses without a reason and writes nothing', async () => {
    const { state, strict } = withTwoChecks(() => Promise.resolve('approved'));
    const before = state.issue.description;
    await expect(
      strict.setState('ENG-1', [{ section: 'Done when', mode: 'replace', body: ONE_CHECK }]),
    ).rejects.toThrow(
      /drops unticked Done when items:\n- \[ \] a Portuguese question[\s\S]*descope_reason/,
    );
    expect(state.issue.description).toBe(before);
  });

  it('asks for sign-off with the items and reason, then records a descope comment that is not drift', async () => {
    const asked: SignOffRequest[] = [];
    const { state, strict } = withTwoChecks((request) => {
      asked.push(request);
      return Promise.resolve('approved');
    });
    const result = await strict.setState(
      'ENG-1',
      [{ section: 'Done when', mode: 'replace', body: ONE_CHECK }],
      {
        descope_reason: 'Portuguese moved to its own ticket',
        descope_risk: 'nobody checks Portuguese here',
      },
    );

    expect(asked).toEqual([
      {
        identifier: 'ENG-1',
        title: 'A ticket',
        dropped: ['a Portuguese question gets a Portuguese answer on the live site'],
        added: [],
        reason: 'Portuguese moved to its own ticket',
        risk: 'nobody checks Portuguese here',
        description: expect.stringContaining('## Done when') as string,
        token: undefined,
      },
    ]);
    expect(result.descope).toMatchObject({
      signed_off: true,
      reason: 'Portuguese moved to its own ticket',
    });
    expect(state.issue.description).not.toMatch(/Portuguese/);
    expect(state.comments.at(-1)?.body).toMatch(
      /· descope\n[\s\S]*- a Portuguese question[\s\S]*Reason: Portuguese moved to its own ticket/,
    );
    const read = await strict.getIssue('ENG-1');
    expect(read.drift.unreconciled_comments).toEqual([]);
  });

  it('counts rewording as dropping, and ticking as not', async () => {
    const { strict } = withTwoChecks(() => Promise.resolve('declined'));
    await expect(
      strict.setState(
        'ENG-1',
        [
          {
            section: 'Done when',
            mode: 'replace',
            body: `${ONE_CHECK}\n- [ ] a Portuguese question gets some answer`,
          },
        ],
        { descope_reason: 'looser', descope_risk: 'any answer passes' },
      ),
    ).rejects.toThrow(/Your user declined/);
    await expect(
      strict.setState('ENG-1', [
        { section: 'Done when', mode: 'replace', body: TWO_CHECKS.replace('- [ ]', '- [x]') },
      ]),
    ).resolves.toMatchObject({ identifier: 'ENG-1' });
  });

  it('sends a rewording as the old item and its replacement, and relays what the person wrote either way', async () => {
    const asked: SignOffRequest[] = [];
    const reworded = `${ONE_CHECK}\n- [ ] a Portuguese question gets a Portuguese answer on staging`;
    const declining = withTwoChecks((request) => {
      asked.push(request);
      return Promise.resolve({
        outcome: 'declined',
        note: 'keep it on the live site',
        returned: 'action=decline, content {change_1: string}',
      });
    });
    await expect(
      declining.strict.setState(
        'ENG-1',
        [{ section: 'Done when', mode: 'replace', body: reworded }],
        { descope_reason: 'staging is enough', descope_risk: 'the live site goes unchecked' },
      ),
    ).rejects.toThrow(
      /Your user declined[\s\S]*They wrote: keep it on the live site[\s\S]*The client returned action=decline/,
    );
    expect(asked[0]).toMatchObject({
      dropped: ['a Portuguese question gets a Portuguese answer on the live site'],
      added: ['a Portuguese question gets a Portuguese answer on staging'],
      risk: 'the live site goes unchecked',
    });

    const approving = withTwoChecks(() =>
      Promise.resolve({ outcome: 'approved', note: 'staging is fine for now' }),
    );
    await approving.strict.setState(
      'ENG-1',
      [{ section: 'Done when', mode: 'replace', body: reworded }],
      { descope_reason: 'staging is enough', descope_risk: 'the live site goes unchecked' },
    );
    expect(approving.state.comments.at(-1)?.body).toMatch(
      /Reason: staging is enough\n\nWhat stops being checked: the live site goes unchecked\n\nThey wrote: staging is fine for now$/,
    );
  });

  it('refuses a reason or risk too long for the one line the person sees, before asking anyone', async () => {
    const asked: SignOffRequest[] = [];
    const { strict } = withTwoChecks((request) => {
      asked.push(request);
      return Promise.resolve('approved');
    });
    await expect(
      strict.setState('ENG-1', [{ section: 'Done when', mode: 'replace', body: ONE_CHECK }], {
        descope_reason: 'x'.repeat(101),
        descope_risk: 'short',
      }),
    ).rejects.toThrow(/descope_reason is 101 characters[\s\S]*about 100/);
    expect(asked).toEqual([]);
  });

  it('refuses a descope with a reason but no risk, before asking anyone', async () => {
    const asked: SignOffRequest[] = [];
    const { strict } = withTwoChecks((request) => {
      asked.push(request);
      return Promise.resolve('approved');
    });
    await expect(
      strict.setState('ENG-1', [{ section: 'Done when', mode: 'replace', body: ONE_CHECK }], {
        descope_reason: 'moved elsewhere',
      }),
    ).rejects.toThrow(/descope_risk is needed/);
    expect(asked).toEqual([]);
  });

  it('keeps an item ticked with a citation after it, but not one reworded in the middle', async () => {
    const { strict } = withTwoChecks();
    await expect(
      strict.setState('ENG-1', [
        {
          section: 'Done when',
          mode: 'replace',
          body: `${ONE_CHECK}\n- [x] a Portuguese question gets a Portuguese answer on the live site (run 36087655179)`,
        },
      ]),
    ).resolves.toMatchObject({ identifier: 'ENG-1' });

    const reworded = withTwoChecks();
    await expect(
      reworded.strict.setState('ENG-1', [
        {
          section: 'Done when',
          mode: 'replace',
          body: `${ONE_CHECK}\n- [x] a Portuguese question gets an answer on the live site`,
        },
      ]),
    ).rejects.toThrow(/drops unticked[\s\S]*keep its text as it is and add the citation after it/);
  });

  it('sends the change to a person in Linear when the client cannot ask', async () => {
    const { state, strict } = withTwoChecks();
    const before = state.issue.description;
    await expect(
      strict.setState('ENG-1', [{ section: 'Done when', mode: 'replace', body: ONE_CHECK }], {
        descope_reason: 'no longer needed',
        descope_risk: 'the live site goes unchecked',
      }),
    ).rejects.toThrow(
      /cannot ask your user[\s\S]*Ask a person to remove or reword the items in Linear/,
    );
    expect(state.issue.description).toBe(before);
  });

  it('hands back what the agent must do first when sign-off is pending, and passes its token on the retry', async () => {
    const asked: SignOffRequest[] = [];
    const { state, strict } = withTwoChecks((request) => {
      asked.push(request);
      return Promise.resolve(
        request.token
          ? { outcome: 'approved', signer: 'person' }
          : { outcome: 'pending', instructions: 'Ask with AskUserQuestion.' },
      );
    });
    const call = (token?: string) =>
      strict.setState('ENG-1', [{ section: 'Done when', mode: 'replace', body: ONE_CHECK }], {
        descope_reason: 'moved elsewhere',
        descope_risk: 'nobody checks it',
        sign_off: token,
      });
    const before = state.issue.description;
    await expect(call()).rejects.toThrow(/Nothing was written[\s\S]*Ask with AskUserQuestion\./);
    expect(state.issue.description).toBe(before);
    await expect(call('0123456789ab')).resolves.toMatchObject({
      descope: { signed_off_by: 'person' },
    });
    expect(asked.map((request) => request.token)).toEqual([undefined, '0123456789ab']);
  });

  it('records a judge as the signer, and relays its reason when it declines', async () => {
    const approving = withTwoChecks(() =>
      Promise.resolve({
        outcome: 'approved',
        signer: 'judge',
        model: 'claude-opus-5-5',
        note: 'Observed 1 shows the site is gone.',
      }),
    );
    const result = await approving.strict.setState(
      'ENG-1',
      [{ section: 'Done when', mode: 'replace', body: ONE_CHECK }],
      { descope_reason: 'site retired', descope_risk: 'nothing checks Portuguese' },
    );
    expect(result.descope).toMatchObject({ signed_off_by: 'judge (claude-opus-5-5)' });
    expect(approving.state.comments.at(-1)?.body).toMatch(
      /approved by a model judge \(claude-opus-5-5\)[\s\S]*The judge wrote: Observed 1 shows the site is gone\.$/,
    );

    const declining = withTwoChecks(() =>
      Promise.resolve({
        outcome: 'declined',
        signer: 'judge',
        model: 'claude-opus-5-5',
        note: 'Nothing shows the site is gone.',
      }),
    );
    await expect(
      declining.strict.setState(
        'ENG-1',
        [{ section: 'Done when', mode: 'replace', body: ONE_CHECK }],
        { descope_reason: 'site retired', descope_risk: 'nothing checks Portuguese' },
      ),
    ).rejects.toThrow(
      /sign-off judge declined[\s\S]*The judge \(claude-opus-5-5\) wrote: Nothing shows the site is gone\./,
    );
  });

  it('refuses a stray descope_reason, and refuses a drop through a comment patch', async () => {
    const { strict } = withTwoChecks(() => Promise.resolve('approved'));
    await expect(
      strict.setState('ENG-1', [{ section: 'Cause', mode: 'replace', body: 'unknown' }], {
        descope_reason: 'why not',
      }),
    ).rejects.toThrow(/drops no unticked Done when item/);
    await expect(
      strict.comment('ENG-1', {
        kind: 'correction',
        body: 'scope change',
        patch: [{ section: 'Done when', mode: 'replace', body: ONE_CHECK }],
      }),
    ).rejects.toThrow(/with set_state and a descope_reason/);
  });
});

describe('claim and the Done gate', () => {
  it('refuses a patch when the description changed between reading and writing it', async () => {
    const { state } = setup();
    // Another writer lands between this call's read and its write: the second read of the ticket sees it.
    const gql = fakeGql(state);
    let reads = 0;
    const racing = new StrictLinear({
      gql: (query, variables) => {
        if (query.includes('query StrictIssue(') && ++reads === 2)
          state.issue.description += '\n- 2026-09-25 · another writer · landed first';
        return gql(query, variables);
      },
      claims: memoryClaimStore(),
      now: () => new Date('2026-09-24T12:00:00Z'),
    });
    await expect(
      racing.setState('ENG-1', [
        { section: 'Cause', mode: 'replace', body: 'The cache key omits the locale.' },
      ]),
    ).rejects.toThrow(
      /Nothing was written: ENG-1's description changed after this call read it[\s\S]*another writer/,
    );
    expect(state.issue.description).toContain('landed first');
    expect(state.issue.description).not.toContain('The cache key omits the locale.');
  });

  it('names a tick written without a citation when it is written, not only at Done', async () => {
    const { state, strict } = setup();
    state.issue.description = '## Done when\n\n- [ ] the export finishes';
    const bare = await strict.setState('ENG-1', [
      { section: 'Done when', mode: 'replace', body: '- [x] the export finishes · 6 passed' },
    ]);
    expect(bare).toMatchObject({
      uncited_ticks: [
        '- [x] the export finishes · 6 passed ("6 passed" gives a result but not where it came from)',
      ],
    });
    expect(bare).toHaveProperty(
      'cite_before_done',
      expect.stringContaining('Moving to Done will refuse this tick'),
    );

    const cited = await strict.setState('ENG-1', [
      {
        section: 'Done when',
        mode: 'replace',
        body: '- [x] the export finishes · run 36087655179',
      },
    ]);
    expect(cited).not.toHaveProperty('uncited_ticks');
  });

  it('refuses Done with a diff after an out-of-band description edit', async () => {
    const { state, strict } = setup();
    await strict.claim('ENG-1');
    editOutOfBand(state, `${state.issue.description}\n- [ ] also handle the empty case`);

    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(
      /changed since your claim[\s\S]*\+ - \[ \] also handle the empty case/,
    );
    expect(state.issue.stateId).toBe('s-todo');

    const read = await strict.getIssue('ENG-1');
    expect(read.claim).toMatchObject({ edited_since_claim: true });
  });

  it('allows Done after a label-only change', async () => {
    const { state, strict } = setup();
    await strict.claim('ENG-1');
    touchWithoutContentChange(state);

    await expect(strict.setStatus('ENG-1', 'Done')).resolves.toMatchObject({ state: 'Done' });
    expect(state.issue.stateId).toBe('s-done');
  });

  it('allows Done after the claimant re-claims to acknowledge the change', async () => {
    const { state, strict } = setup();
    await strict.claim('ENG-1');
    editOutOfBand(state, `${state.issue.description}\n- [x] new criterion · a1b2c3d`);
    await expect(strict.claim('ENG-1')).resolves.toMatchObject({
      reclaimed: true,
      description_changed_since_previous_claim: true,
    });
    await expect(strict.setStatus('ENG-1', 'Done')).resolves.toMatchObject({ state: 'Done' });
  });

  it("does not trip the gate on the claimant's own set_state writes", async () => {
    const { strict } = setup();
    await strict.claim('ENG-1');
    await strict.setState('ENG-1', [
      { section: 'Cause', mode: 'replace', body: 'not established' },
    ]);
    await expect(strict.setStatus('ENG-1', 'Done')).resolves.toMatchObject({ state: 'Done' });
  });

  it('keeps the gate armed when someone else edited before the claimant patched', async () => {
    const { state, strict } = setup();
    await strict.claim('ENG-1');
    editOutOfBand(state, `${state.issue.description}\n- [ ] sneaky`);
    const result = await strict.setState('ENG-1', [
      { section: 'Fix', mode: 'replace', body: 'do the thing' },
    ]);
    expect(result).toHaveProperty('warning');
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(/sneaky/);
  });

  it('refuses Done on a ticket with no Done when section', async () => {
    const { state, strict } = setup();
    state.issue.description = '## Observed\n\n- 2026-09-01 · `curl /health` · 200';
    await strict.claim('ENG-1');
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(/no Done when section/);
    expect(state.issue.stateId).toBe('s-todo');
  });

  it('refuses Done while a Done when item is unticked, then allows it once ticked', async () => {
    const { state, strict } = setup();
    await strict.setState('ENG-1', [
      {
        section: 'Done when',
        mode: 'replace',
        body: '- [x] `npm test` passes\n- [ ] a Portuguese question gets a Portuguese answer on the live site',
      },
    ]);
    await strict.claim('ENG-1');
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(
      /1 Done when item is not ticked:\n- \[ \] a Portuguese question gets a Portuguese answer on the live site/,
    );
    expect(state.issue.stateId).toBe('s-todo');

    await strict.setState('ENG-1', [
      {
        section: 'Done when',
        mode: 'replace',
        body: '- [x] `npm test` passes · Observed 1\n- [x] a Portuguese question gets a Portuguese answer on the live site (run 36087655179)',
      },
    ]);
    await expect(strict.setStatus('ENG-1', 'Done')).resolves.toMatchObject({ state: 'Done' });
  });

  it('refuses Done while a cited PR linked to the ticket is not merged', async () => {
    const { state, strict } = setup();
    state.attachments.push({
      title: 'Fix it',
      url: 'https://github.com/o/r/pull/12',
      sourceType: 'github',
      metadata: { number: 12, status: 'open', draft: false },
    });
    await strict.setState('ENG-1', [
      { section: 'Done when', mode: 'replace', body: '- [x] shipped · PR #12' },
    ]);
    await strict.claim('ENG-1');
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(
      /cites PR #12, which is open, not merged/,
    );

    const pr = state.attachments[0];
    if (pr) pr.metadata = { ...pr.metadata, status: 'merged' };
    await expect(strict.setStatus('ENG-1', 'Done')).resolves.toMatchObject({ state: 'Done' });
  });

  it('passes a cited PR whose merge status Linear did not give, and says so', async () => {
    const { state, strict } = setup();
    state.attachments.push({
      title: 'Fix it',
      url: 'https://github.com/o/r/pull/13',
      sourceType: 'github',
      metadata: { number: 13 },
    });
    await strict.setState('ENG-1', [
      { section: 'Done when', mode: 'replace', body: '- [x] shipped · PR #13' },
    ]);
    await strict.claim('ENG-1');
    const done = await strict.setStatus('ENG-1', 'Done');
    expect(done.state).toBe('Done');
    expect(done.unchecked_prs).toMatch(/PR #13/);
  });

  it('needs a reason to cancel, and posts it', async () => {
    const { state, strict } = setup();
    await expect(strict.setStatus('ENG-1', 'Canceled')).rejects.toThrow(/without a reason/);
    const result = await strict.setStatus('ENG-1', 'Canceled', 'Duplicate of ENG-2');
    expect(result.state).toBe('Canceled');
    expect(result.reason_comment).toBeDefined();
    expect(state.comments.at(-1)?.body).toMatch(/· Canceled\n\nDuplicate of ENG-2/);
  });

  it('refuses Done with no claim on record', async () => {
    const { strict } = setup();
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(/no claim/);
  });

  it('delegates when a human owns the ticket and the caller is an app; a user needs take_over', async () => {
    const owned = { id: 'u-ada', name: 'Ada', displayName: 'Ada' };
    const agent = setup();
    agent.state.issue.assignee = owned;
    await expect(agent.strict.claim('ENG-1')).resolves.toMatchObject({ claimed_as: 'delegate' });
    expect(agent.state.issue.delegate?.id).toBe('u-agent');
    expect(agent.state.issue.assignee).toMatchObject({ id: 'u-ada' });

    const human = setup({
      viewer: { id: 'u-grace', name: 'Grace', displayName: 'Grace', app: false },
    });
    human.state.issue.assignee = owned;
    await expect(human.strict.claim('ENG-1')).rejects.toThrow(/would take it from them/);
    await expect(human.strict.claim('ENG-1', { as: 'delegate' })).rejects.toThrow(
      /only an agent \(app\) identity can be a delegate/,
    );
  });

  it('claims an unowned ticket as delegate for an app, leaving the assignee to a person', async () => {
    const agent = setup();
    await expect(agent.strict.claim('ENG-1')).resolves.toMatchObject({ claimed_as: 'delegate' });
    expect(agent.state.issue.delegate?.id).toBe('u-agent');
    expect(agent.state.issue.assignee).toBeNull();

    const human = setup({
      viewer: { id: 'u-grace', name: 'Grace', displayName: 'Grace', app: false },
    });
    await expect(human.strict.claim('ENG-1')).resolves.toMatchObject({ claimed_as: 'assignee' });
  });

  it('refuses writes to an archived or trashed ticket', async () => {
    const archived = setup();
    archived.state.issue.archivedAt = '2026-09-25T00:00:00.000Z';
    await expect(archived.strict.claim('ENG-1')).rejects.toThrow(/is archived/);
    const trashed = setup();
    trashed.state.issue.trashed = true;
    await expect(trashed.strict.setState('ENG-1', [])).rejects.toThrow();
    await expect(trashed.strict.comment('ENG-1', { kind: 'evidence', body: 'x' })).rejects.toThrow(
      /in the trash/,
    );
  });

  it("never takes a ticket another agent holds, and takes a person's only with take_over", async () => {
    const agent = setup();
    agent.state.issue.assignee = {
      id: 'u-agent-b',
      name: 'agent-b',
      displayName: 'agent-b',
      app: true,
    };
    await expect(agent.strict.claim('ENG-1')).rejects.toThrow(/another agent/);
    await expect(agent.strict.claim('ENG-1', { as: 'assignee', take_over: true })).rejects.toThrow(
      /another agent/,
    );
    expect(agent.state.issue.delegate).toBeNull();

    const human = setup({
      viewer: { id: 'u-grace', name: 'Grace', displayName: 'Grace', app: false },
    });
    human.state.issue.assignee = { id: 'u-ada', name: 'Ada', displayName: 'Ada' };
    await expect(human.strict.claim('ENG-1', { as: 'assignee' })).rejects.toThrow(
      /take_over: true/,
    );
    expect(human.state.issue.assignee.id).toBe('u-ada');
    await expect(
      human.strict.claim('ENG-1', { as: 'assignee', take_over: true }),
    ).resolves.toMatchObject({ claimed_as: 'assignee' });
    expect(human.state.issue.assignee.id).toBe('u-grace');
  });
});

describe('typed comments', () => {
  it('refuses a correction without a description patch and writes nothing', async () => {
    const { state, strict } = setup();
    await expect(
      strict.comment('ENG-1', { kind: 'correction', body: 'limits exist since 09-15' }),
    ).rejects.toThrow(/must carry a description patch/);
    expect(state.comments).toHaveLength(0);
  });

  it('lands both the patch and the comment for a correction', async () => {
    const { state, strict } = setup();
    const result = await strict.comment('ENG-1', {
      kind: 'correction',
      body: 'Size limits exist; the earlier comment was wrong.',
      patch: [
        {
          section: 'Observed',
          mode: 'append',
          body: '- 2026-09-24 · `rg MAX_ constants.ts` · limits defined since 09-15',
        },
      ],
      author_label: 'claude-opus',
    });

    expect(state.issue.description).toContain('limits defined since 09-15');
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]?.body).toMatch(/^🤖 claude-opus · 2026-09-24 · correction\n/);
    expect(state.comments[0]?.body).toContain('Description updated: Observed (append).');
    expect(result.comment_url).toContain('#comment-c-1');
  });

  it('refuses an invalid patch before posting anything', async () => {
    const { state, strict } = setup();
    await expect(
      strict.comment('ENG-1', {
        kind: 'correction',
        body: 'x',
        patch: [{ section: 'Observed', mode: 'append', body: 'unsourced' }],
      }),
    ).rejects.toThrow(/refused/);
    expect(state.comments).toHaveLength(0);
  });

  it('labels a comment posted with a personal key as the agent acting via the person', async () => {
    const { state, strict } = setup({
      viewer: { id: 'u-grace', name: 'Grace', displayName: 'Grace', app: false },
    });
    await strict.comment('ENG-1', {
      kind: 'evidence',
      body: 'saw it',
      author_label: 'claude-opus',
    });
    expect(state.comments[0]?.body).toMatch(/^🤖 claude-opus via Grace · 2026-09-24 · evidence\n/);
  });

  it('closed_by sets the relation, records it under Fix, and needs both arguments', async () => {
    const { state, strict } = setup();
    await expect(
      strict.comment('ENG-1', { kind: 'closed_by', body: 'shipped in ENG-2', closed_by: 'ENG-2' }),
    ).rejects.toThrow(/relation/);
    await expect(
      strict.comment('ENG-1', {
        kind: 'evidence',
        body: 'x',
        closed_by: 'ENG-2',
        relation: 'duplicate',
      }),
    ).rejects.toThrow(/only valid with kind "closed_by"/);

    const result = await strict.comment('ENG-1', {
      kind: 'closed_by',
      body: 'Same bug; fixed under ENG-2.',
      closed_by: 'ENG-2',
      relation: 'duplicate',
    });

    expect(result).toMatchObject({ closed_by: 'ENG-2', relation: 'duplicate' });
    expect(state.relations).toEqual([
      { issueId: 'issue-1', relatedIssueId: 'issue-2', type: 'duplicate' },
    ]);
    expect(state.comments[0]?.body).toMatch(/· closed_by ENG-2\n/);
    expect(state.issue.description).toMatch(
      /## Fix\n\nClosed by ENG-2 \(duplicate\) on 2026-09-24 · \[comment\]/,
    );
  });

  it('opens a question with ask and closes it with answer', async () => {
    const { state, strict } = setup();
    await expect(
      strict.comment('ENG-1', { kind: 'ask', body: 'Is the limit per file?', ask_to: 'Ada' }),
    ).resolves.toMatchObject({
      question: 'Q1',
    });
    expect(state.issue.description).toContain(
      'Q1 · OPEN · 2026-09-24 · agent-a → Ada · Is the limit per file?',
    );
    // A profile URL is how Linear markdown mentions someone, which notifies them.
    expect(state.comments[0]?.body).toContain('Asking https://linear.app/x/profiles/ada');

    await expect(
      strict.comment('ENG-1', { kind: 'answer', body: 'Per file, 25 MB.' }),
    ).rejects.toThrow(/must name the Open questions row/);
    await strict.comment('ENG-1', { kind: 'answer', body: 'Per file, 25 MB.', answers: 'Q1' });
    expect(state.issue.description).toMatch(
      /Q1 · ANSWERED 2026-09-24 \[answer\]\(\S+#comment-c-2\)/,
    );

    const read = await strict.getIssue('ENG-1');
    expect(read.issue.open_questions).toEqual([]);
  });
});

describe('the hands-off label', () => {
  it('refuses every write to a ticket carrying it, and still reads it', async () => {
    const { state, strict } = setup();
    state.issue.labels = ['No-Agents'];
    const writes: [string, () => Promise<unknown>][] = [
      ['claim', () => strict.claim('ENG-1')],
      [
        'set_state',
        () =>
          strict.setState('ENG-1', [
            { section: 'Observed', mode: 'append', body: '- 2026-09-24 · a · b' },
          ]),
      ],
      ['comment', () => strict.comment('ENG-1', { kind: 'evidence', body: 'x' })],
      ['set_fields', () => strict.setFields('ENG-1', { priority: 2 })],
      ['set_status', () => strict.setStatus('ENG-1', 'In Progress')],
    ];
    for (const [name, write] of writes) {
      await expect(write().then(() => name)).rejects.toThrow(
        /Nothing was written: ENG-1 carries the "No-Agents" label/,
      );
    }
    expect(state.updates).toEqual([]);
    expect(state.comments).toEqual([]);
    await expect(strict.getIssue('ENG-1')).resolves.toMatchObject({
      issue: { identifier: 'ENG-1' },
    });
  });

  it('takes its label names from the options', async () => {
    const state = fakeState();
    state.issue.labels = ['no-agents'];
    const strict = new StrictLinear({
      gql: fakeGql(state),
      claims: memoryClaimStore(),
      handsOffLabels: ['human-only'],
    });
    await expect(strict.claim('ENG-1')).resolves.toBeDefined();
    state.issue.labels = ['Human-Only'];
    await expect(strict.setFields('ENG-1', { priority: 2 })).rejects.toThrow(/"Human-Only" label/);
  });
});

describe('base: the description a patch was written against', () => {
  const observed = (line: string) => [
    {
      section: 'Observed' as const,
      mode: 'append' as const,
      body: `- 2026-09-24 · \`${line}\` · ok`,
    },
  ];

  it('lands a patch whose base is the current description, and returns the next one', async () => {
    const { state, strict } = setup();
    const read = await strict.getIssue('ENG-1');
    expect(read.issue.description_sha).toBe(descriptionSha(state.issue.description));

    const first = await strict.setState('ENG-1', observed('first'), {
      base: read.issue.description_sha,
    });
    expect(first.description_sha).toBe(descriptionSha(state.issue.description));
    await expect(
      strict.setState('ENG-1', observed('second'), { base: first.description_sha }),
    ).resolves.toMatchObject({
      updated_sections: ['Observed (append)'],
    });
  });

  it('refuses a patch built from an older read, shows what changed, and writes nothing', async () => {
    const { state, strict } = setup();
    const read = await strict.getIssue('ENG-1');
    editOutOfBand(state, `${state.issue.description}\n- [ ] a check someone added`);
    const before = state.issue.description;

    await expect(
      strict.setState('ENG-1', observed('late'), { base: read.issue.description_sha }),
    ).rejects.toThrow(
      /no longer the one your base[\s\S]*\+ - \[ \] a check someone added[\s\S]*get_issue/,
    );
    expect(state.issue.description).toBe(before);
  });

  it('refuses a base this server never returned, without a diff', async () => {
    const { strict } = setup();
    await expect(strict.setState('ENG-1', observed('x'), { base: '000000000000' })).rejects.toThrow(
      /your base \(000000000000\) came from\.\nRead the ticket again/,
    );
  });

  it('refuses a correction built from an older read before posting anything', async () => {
    const { state, strict } = setup();
    const read = await strict.getIssue('ENG-1');
    editOutOfBand(state, `${state.issue.description}\n\n## Fix\n\nsomeone else's fix`);

    await expect(
      strict.comment('ENG-1', {
        kind: 'correction',
        body: 'It was wrong.',
        patch: observed('corrected'),
        base: read.issue.description_sha,
      }),
    ).rejects.toThrow(/no longer the one your base/);
    expect(state.comments).toHaveLength(0);
  });
});
