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
