import { memoryClaimStore } from '../claims.js';
import { StrictLinear } from '../strict-linear.js';
import { type FakeState, fakeGql, fakeState } from './strict-fake-linear.helper.js';

function setup(overrides: Partial<FakeState> = {}) {
  const state = fakeState(overrides);
  const strict = new StrictLinear({ gql: fakeGql(state), claims: memoryClaimStore(), now: () => new Date('2026-09-24T12:00:00Z') });
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
    expect(state.updates).toEqual([{ cycleId: null, dueDate: null, projectId: null, estimate: null }]);
  });

  it('refuses the whole call, writing nothing, when any name does not resolve', async () => {
    const { state, strict } = setup();
    await expect(strict.setFields('ENG-1', { priority: 1, add_labels: ['bogus'] })).rejects.toThrow(/No label "bogus".*not created here/);
    await expect(strict.setFields('ENG-1', { add_labels: ['Area'] })).rejects.toThrow(/label group/);
    await expect(strict.setFields('ENG-1', { cycle: 99 })).rejects.toThrow(/no cycle 99/);
    await expect(strict.setFields('ENG-1', { project: 'Nope' })).rejects.toThrow(/No project "Nope"/);
    await expect(strict.setFields('ENG-1', { milestone: 'Beta' })).rejects.toThrow(/in no project/);
    await expect(strict.setFields('ENG-1', { due_date: '1 October' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(strict.setFields('ENG-1', { priority: 7 })).rejects.toThrow(/priority must be/);
    expect(state.updates).toEqual([]);
  });

  it('refuses an empty call and points at the content tools', async () => {
    const { strict } = setup();
    await expect(strict.setFields('ENG-1', {})).rejects.toThrow(/set_state[\s\S]*set_status/);
  });

  it('assigns by email or "me", and takes a person\'s ticket only with take_over', async () => {
    const { state, strict } = setup();
    await expect(strict.setFields('ENG-1', { assignee: 'GRACE@example.com' })).resolves.toMatchObject({ changed: ['assignee (Grace)'] });
    expect(state.issue.assignee?.id).toBe('u-grace');

    await expect(strict.setFields('ENG-1', { assignee: 'Ada' })).rejects.toThrow(/assigned to Grace.*take_over/);
    await expect(strict.setFields('ENG-1', { assignee: null })).rejects.toThrow(/take_over/);
    await strict.setFields('ENG-1', { assignee: 'me', take_over: true });
    expect(state.issue.assignee?.id).toBe('u-agent');
  });

  it("never takes another agent's ticket or delegation", async () => {
    const agent = { id: 'u-agent-b', name: 'agent-b', displayName: 'agent-b', app: true };
    const assigned = setup();
    assigned.state.issue.assignee = agent;
    await expect(assigned.strict.setFields('ENG-1', { assignee: 'me', take_over: true })).rejects.toThrow(/another agent/);

    const delegated = setup();
    delegated.state.issue.delegate = agent;
    await expect(delegated.strict.setFields('ENG-1', { delegate: 'me' })).rejects.toThrow(/delegated to agent-b/);
  });

  it('adds relations in the direction Linear reads them', async () => {
    const { state, strict } = setup({
      others: [
        { id: 'issue-2', identifier: 'ENG-2' },
        { id: 'issue-3', identifier: 'ENG-3' },
        { id: 'issue-4', identifier: 'ENG-4' },
      ],
    });
    const result = await strict.setFields('ENG-1', { related_to: ['ENG-2'], blocks: ['ENG-3'], blocked_by: ['ENG-4'] });
    expect(state.relations).toEqual([
      { issueId: 'issue-1', relatedIssueId: 'issue-2', type: 'related' },
      { issueId: 'issue-1', relatedIssueId: 'issue-3', type: 'blocks' },
      { issueId: 'issue-4', relatedIssueId: 'issue-1', type: 'blocks' },
    ]);
    expect(result.relations_added).toEqual(['related to ENG-2', 'blocks ENG-3', 'blocked by ENG-4']);
    expect(state.updates).toEqual([]);
  });
});
