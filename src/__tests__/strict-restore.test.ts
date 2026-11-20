import { memoryClaimStore } from '../claims.js';
import { restoreRecordProblem, type RestoreRule } from '../restore.js';
import { StrictLinear } from '../strict-linear.js';
import { fakeGql, fakeState, type FakeState } from './strict-fake-linear.helper.js';

const REASON = 'restored: a release moved it out of Done; no new verification claimed';
const NOW = new Date('2026-11-20T12:00:00Z');
const DONE = { id: 's-done', type: 'completed' };
const VERIFY = { id: 's-verify', name: 'Verify', type: 'started' };

function record(over: Record<string, unknown> = {}, asOf = '2026-11-20T11:50:00Z') {
  return JSON.stringify({
    asOf,
    served: { via: 'Vercel API (githubCommitSha)' },
    ticket: { id: 'ENG-1', verdict: 'close', reasons: [], evidence: [REASON], ...over },
  });
}

/** A ticket a release moved to Verify, delegated to another agent, with no Done when section. */
function setup(text: string | undefined, overrides: Partial<FakeState> = {}) {
  const state = fakeState({
    states: [
      { id: 's-todo', name: 'Todo', type: 'unstarted' },
      VERIFY,
      { id: 's-done', name: 'Done', type: 'completed' },
      { id: 's-canceled', name: 'Canceled', type: 'canceled' },
    ],
    stateMoves: [{ createdAt: '2026-11-19T20:00:00Z', bot: true, from: DONE, to: VERIFY }],
    ...overrides,
  });
  state.issue.stateId = 's-verify';
  state.issue.description = '## Observed\n\nnothing recorded';
  state.issue.delegate = { id: 'u-other', name: 'agent-b', displayName: 'agent-b', app: true };
  const rule: RestoreRule = { reason: REASON, readRecord: () => text };
  const strict = new StrictLinear({
    gql: fakeGql(state),
    claims: memoryClaimStore(),
    now: () => NOW,
    restore: rule,
  });
  return { state, strict, rule };
}

describe('set_status honours a closer restore', () => {
  it('moves a delegated ticket with no Done when back to Done on a fresh restore record', async () => {
    const { state, strict } = setup(record());
    await expect(strict.setStatus('ENG-1', 'Done')).resolves.toMatchObject({ state: 'Done' });
    expect(state.issue.stateId).toBe('s-done');
    expect(state.issue.delegate?.name).toBe('agent-b');
    expect(state.issue.description).toBe('## Observed\n\nnothing recorded');
    expect(state.otherComments).toEqual([]);
    expect(state.comments).toEqual([]);
  });

  it('still refuses a close that is not a restore on the same ticket', async () => {
    const { state, strict } = setup(record({ evidence: ['the closer checked the build'] }));
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(/no Done when section/);
    expect(state.issue.stateId).toBe('s-verify');
  });

  it('refuses a restore record older than thirty minutes', async () => {
    const { strict } = setup(record({}, '2026-11-20T11:20:00Z'));
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(/no Done when section/);
  });

  it('refuses when the closer left no record', async () => {
    const { strict } = setup(undefined);
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(/no Done when section/);
  });

  it('refuses a record that says hold or names another ticket', async () => {
    await expect(
      setup(record({ verdict: 'hold' })).strict.setStatus('ENG-1', 'Done'),
    ).rejects.toThrow(/no Done when section/);
    await expect(setup(record({ id: 'ENG-2' })).strict.setStatus('ENG-1', 'Done')).rejects.toThrow(
      /no Done when section/,
    );
  });

  it('refuses when a person made the latest move to Verify', async () => {
    const { strict } = setup(record(), {
      stateMoves: [{ createdAt: '2026-11-19T20:00:00Z', bot: false, from: DONE, to: VERIFY }],
    });
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(/no Done when section/);
  });

  it('refuses when a later move followed the release move', async () => {
    const { strict } = setup(record(), {
      stateMoves: [
        { createdAt: '2026-11-19T20:00:00Z', bot: true, from: DONE, to: VERIFY },
        {
          createdAt: '2026-11-19T21:00:00Z',
          bot: false,
          from: VERIFY,
          to: { id: 's-todo', name: 'Todo', type: 'unstarted' },
        },
      ],
    });
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(/no Done when section/);
  });

  it('does nothing for a server with no restore rule', async () => {
    const { state } = setup(record());
    const plain = new StrictLinear({
      gql: fakeGql(state),
      claims: memoryClaimStore(),
      now: () => NOW,
    });
    await expect(plain.setStatus('ENG-1', 'Done')).rejects.toThrow(/no Done when section/);
  });
});

describe('each refusal condition of a restore is held by its own test', () => {
  const stuck = async (strict: StrictLinear, state: FakeState) => {
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(/no Done when section/);
    expect(state.issue.stateId).not.toBe('s-done');
  };
  const move = (over: Partial<NonNullable<FakeState['stateMoves']>[number]>) => [
    { createdAt: '2026-11-19T20:00:00Z', bot: true, from: DONE, to: VERIFY, ...over },
  ];

  it('refuses a move back to a state other than the one the ticket left', async () => {
    const { state, strict } = setup(record(), {
      stateMoves: move({ from: { id: 's-merged', type: 'completed' } }),
    });
    await stuck(strict, state);
  });

  it('refuses when the integration moved it somewhere other than Verify', async () => {
    const { state, strict } = setup(record(), {
      stateMoves: move({ to: { id: 's-todo', name: 'Todo', type: 'unstarted' } }),
    });
    await stuck(strict, state);
  });

  it('refuses when the move was out of a state that is not completed', async () => {
    const { state, strict } = setup(record(), {
      stateMoves: move({ from: { id: 's-done', type: 'started' } }),
    });
    await stuck(strict, state);
  });

  it('refuses when the ticket is already in a completed state', async () => {
    const { state, strict } = setup(record());
    state.issue.stateId = 's-done';
    await expect(strict.setStatus('ENG-1', 'Done')).rejects.toThrow(/no Done when section/);
    expect(state.updates).toEqual([]);
  });

  it('refuses when the latest move was by a bot that is not a workflow', async () => {
    const { state, strict } = setup(record(), { stateMoves: move({ botType: 'integration' }) });
    await stuck(strict, state);
  });

  it('refuses a record made with a served-build override', async () => {
    const text = JSON.stringify({
      ...JSON.parse(record()),
      served: { via: 'override --served-sha' },
    });
    const { state, strict } = setup(text);
    await stuck(strict, state);
  });

  it('refuses when the history read throws', async () => {
    const { state, rule } = setup(record());
    const gql = fakeGql(state);
    const failing = new StrictLinear({
      gql: (query, variables) => {
        if (query.includes('StrictRestoreMoves')) throw new Error('Linear returned 503');
        return gql(query, variables);
      },
      claims: memoryClaimStore(),
      now: () => NOW,
      restore: rule,
    });
    await stuck(failing, state);
  });

  it('refuses a record dated in the future', async () => {
    const { state, strict } = setup(record({}, '2026-11-20T13:00:00Z'));
    await stuck(strict, state);
  });

  it('refuses a record that is not JSON', async () => {
    const { state, strict } = setup('{not json');
    await stuck(strict, state);
  });

  it('refuses a record with no usable time', async () => {
    const { state, strict } = setup(
      JSON.stringify({ ticket: { id: 'ENG-1', verdict: 'close', evidence: [REASON] } }),
    );
    await stuck(strict, state);
  });
});

describe('restoreRecordProblem', () => {
  const rule = (text: string | undefined): RestoreRule => ({
    reason: REASON,
    readRecord: () => text,
  });
  it('accepts a fresh restore and names why it refuses the rest', () => {
    expect(restoreRecordProblem(rule(record()), 'ENG-1', NOW)).toBe('');
    expect(restoreRecordProblem(rule('{'), 'ENG-1', NOW)).toMatch(/could not be read/);
    expect(restoreRecordProblem(rule(record({}, '2026-11-20T12:30:00Z')), 'ENG-1', NOW)).toMatch(
      /future/,
    );
  });
});
