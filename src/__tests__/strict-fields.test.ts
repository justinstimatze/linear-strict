import { memoryClaimStore } from '../claims.js';
import { StrictLinear } from '../strict-linear.js';
import { type FakeState, fakeGql, fakeState } from './strict-fake-linear.helper.js';

function setup(overrides: Partial<FakeState> = {}) {
  const state = fakeState(overrides);
  const strict = new StrictLinear({
    gql: fakeGql(state),
    claims: memoryClaimStore(),
    now: () => new Date('2026-09-24T12:00:00Z'),
  });
  return { state, strict };
}

describe('set_fields', () => {
  it('resolves names and applies every field change in one update', async () => {
    const { state, strict } = setup();
    const result = await strict.setFields('ENG-1', {
      priority: 2,
      add_labels: ['bug'],
      remove_labels: ['needs-triage'],
      cycle: 'current',
      project: 'alpha launch',
      milestone: 'Beta',
      due_date: '2026-10-01',
      estimate: 3,
    });

    expect(state.updates).toEqual([
      {
        priority: 2,
        addedLabelIds: ['l-bug'],
        removedLabelIds: ['l-triage'],
        cycleId: 'cy-7',
        projectId: 'p-alpha',
        projectMilestoneId: 'm-beta',
        dueDate: '2026-10-01',
        estimate: 3,
      },
    ]);
    expect(result.changed).toEqual([
      'priority (high)',
      'labels (+Bug, -needs-triage)',
      'cycle (7)',
      'project (Alpha launch)',
      'milestone (Beta)',
      'due date (2026-10-01)',
      'estimate (3)',
    ]);
  });

  it('clears fields with null', async () => {
    const { state, strict } = setup();
    await strict.setFields('ENG-1', { cycle: null, due_date: null, project: null, estimate: null });
    expect(state.updates).toEqual([
      { cycleId: null, dueDate: null, projectId: null, estimate: null },
    ]);
  });

  it('refuses the whole call, writing nothing, when any name does not resolve', async () => {
    const { state, strict } = setup();
    await expect(strict.setFields('ENG-1', { priority: 1, add_labels: ['bogus'] })).rejects.toThrow(
      /No label "bogus".*not created here/,
    );
    await expect(strict.setFields('ENG-1', { add_labels: ['Area'] })).rejects.toThrow(
      /label group/,
    );
    await expect(strict.setFields('ENG-1', { cycle: 99 })).rejects.toThrow(/no cycle 99/);
    await expect(strict.setFields('ENG-1', { project: 'Nope' })).rejects.toThrow(
      /No project "Nope"/,
    );
    await expect(strict.setFields('ENG-1', { milestone: 'Beta' })).rejects.toThrow(/in no project/);
    await expect(strict.setFields('ENG-1', { due_date: '1 October' })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    await expect(strict.setFields('ENG-1', { priority: 7 })).rejects.toThrow(/priority must be/);
    expect(state.updates).toEqual([]);
  });

  it('refuses an empty call and points at the content tools', async () => {
    const { strict } = setup();
    await expect(strict.setFields('ENG-1', {})).rejects.toThrow(/set_state[\s\S]*set_status/);
  });

  it('assigns by email or "me", and takes a person\'s ticket only with take_over', async () => {
    const { state, strict } = setup();
    await expect(
      strict.setFields('ENG-1', { assignee: 'GRACE@example.com' }),
    ).resolves.toMatchObject({ changed: ['assignee (Grace)'] });
    expect(state.issue.assignee?.id).toBe('u-grace');

    await expect(strict.setFields('ENG-1', { assignee: 'Ada' })).rejects.toThrow(
      /assigned to Grace.*take_over/,
    );
    await expect(strict.setFields('ENG-1', { assignee: null })).rejects.toThrow(/take_over/);
    await strict.setFields('ENG-1', { assignee: 'me', take_over: true });
    expect(state.issue.assignee?.id).toBe('u-agent');
  });

  it("never takes another agent's ticket or delegation", async () => {
    const agent = { id: 'u-agent-b', name: 'agent-b', displayName: 'agent-b', app: true };
    const assigned = setup();
    assigned.state.issue.assignee = agent;
    await expect(
      assigned.strict.setFields('ENG-1', { assignee: 'me', take_over: true }),
    ).rejects.toThrow(/another agent/);

    const delegated = setup();
    delegated.state.issue.delegate = agent;
    await expect(delegated.strict.setFields('ENG-1', { delegate: 'me' })).rejects.toThrow(
      /delegated to agent-b/,
    );
  });

  it("moves another agent's delegation only on the principal's own ticket, only with take_over, and records it", async () => {
    const agentB = { id: 'u-agent-b', name: 'agent-b', displayName: 'agent-b', app: true };
    const grace = { id: 'u-grace', name: 'Grace', displayName: 'Grace' };
    const forGrace = (overrides: Partial<FakeState> = {}) => {
      const state = fakeState(overrides);
      const gql = fakeGql(state);
      const strict = new StrictLinear({
        gql,
        claims: memoryClaimStore(),
        now: () => new Date('2026-09-24T12:00:00Z'),
        principal: { gql, userId: 'u-grace' },
      });
      return { state, strict };
    };

    const owned = forGrace();
    owned.state.issue.assignee = grace;
    owned.state.issue.delegate = agentB;
    await expect(owned.strict.setFields('ENG-1', { delegate: 'me' })).rejects.toThrow(
      /assigned to Grace, whom you act for[\s\S]*take_over: true/,
    );
    expect(owned.state.updates).toEqual([]);

    const result = await owned.strict.setFields('ENG-1', { delegate: 'me', take_over: true });
    expect(owned.state.issue.delegate.id).toBe('u-agent');
    expect(result.take_over_comment).toMatch(/#comment-/);
    expect(owned.state.comments.at(-1)?.body).toMatch(
      /take over[\s\S]*from agent-b on behalf of Grace/,
    );

    // A ticket assigned to someone the identity does not act for stays refused.
    const others = forGrace();
    others.state.issue.assignee = { id: 'u-ada', name: 'Ada', displayName: 'Ada' };
    others.state.issue.delegate = agentB;
    await expect(
      others.strict.setFields('ENG-1', { delegate: 'me', take_over: true }),
    ).rejects.toThrow(/release it first/);

    // So does any identity with no principal wired.
    const unwired = setup();
    unwired.state.issue.assignee = grace;
    unwired.state.issue.delegate = agentB;
    await expect(
      unwired.strict.setFields('ENG-1', { delegate: 'me', take_over: true }),
    ).rejects.toThrow(/release it first/);
  });

  it('adds relations in the direction Linear reads them', async () => {
    const { state, strict } = setup({
      others: [
        { id: 'issue-2', identifier: 'ENG-2' },
        { id: 'issue-3', identifier: 'ENG-3' },
        { id: 'issue-4', identifier: 'ENG-4' },
      ],
    });
    const result = await strict.setFields('ENG-1', {
      related_to: ['ENG-2'],
      blocks: ['ENG-3'],
      blocked_by: ['ENG-4'],
    });
    expect(state.relations).toEqual([
      { issueId: 'issue-1', relatedIssueId: 'issue-2', type: 'related' },
      { issueId: 'issue-1', relatedIssueId: 'issue-3', type: 'blocks' },
      { issueId: 'issue-4', relatedIssueId: 'issue-1', type: 'blocks' },
    ]);
    expect(result.relations_added).toEqual([
      'related to ENG-2',
      'blocks ENG-3',
      'blocked by ENG-4',
    ]);
    expect(state.updates).toEqual([]);
  });
});
