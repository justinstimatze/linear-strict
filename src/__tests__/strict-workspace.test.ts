import type { Gql } from '../graphql.js';
import { memoryClaimStore } from '../claims.js';
import { StrictLinear } from '../strict-linear.js';
import { StrictWorkspace } from '../workspace.js';

interface Call {
  op: string;
  variables: Record<string, unknown>;
}

/** A Gql that answers by operation name and records every call. */
function fakeGql(answer: (op: string, variables: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const gql = ((query: string, variables: Record<string, unknown> = {}) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'unknown';
    calls.push({ op, variables });
    return Promise.resolve(answer(op, variables));
  }) as Gql;
  return { gql, calls };
}

function page<N>(nodes: N[], next: string | null) {
  return { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } };
}

interface Note {
  __typename: string;
  id: string;
  type: string;
  createdAt: string;
  readAt: string | null;
  snoozedUntilAt: string | null;
  actor: { name: string; app: boolean } | null;
  botActor: null;
  issue: {
    identifier: string;
    title: string;
    url: string;
    state: { name: string; type: string };
  } | null;
  comment: { id: string; url: string } | null;
}

function note(n: number, read: boolean, app = false): Note {
  return {
    __typename: 'IssueNotification',
    id: `n-${String(n)}`,
    type: 'issueCommentMention',
    createdAt: `2026-09-${String(30 - n).padStart(2, '0')}T00:00:00.000Z`,
    readAt: read ? '2026-09-29T00:00:00.000Z' : null,
    snoozedUntilAt: null,
    actor: { name: app ? 'agent-b' : 'Ada', app },
    botActor: null,
    issue: {
      identifier: `ENG-${String(n)}`,
      title: `Ticket ${String(n)}`,
      url: `https://l/ENG-${String(n)}`,
      state: { name: 'Todo', type: 'unstarted' },
    },
    comment: { id: `c-${String(n)}`, url: `https://l/c-${String(n)}` },
  };
}

describe('workspace lists', () => {
  it('walks every page of teams and names a team whose states were cut off', async () => {
    const states = [
      { name: 'Done', type: 'completed', position: 3 },
      { name: 'Todo', type: 'unstarted', position: 1 },
    ];
    const { gql, calls } = fakeGql((_op, variables) =>
      variables['after'] === null
        ? {
            teams: page(
              [{ id: 't1', key: 'ENG', name: 'Eng', states: page(states, null) }],
              'cursor-1',
            ),
          }
        : {
            teams: page(
              [{ id: 't2', key: 'OPS', name: 'Ops', states: page(states, 'more') }],
              null,
            ),
          },
    );
    const result = await new StrictWorkspace(gql).listTeams();

    expect(calls).toHaveLength(2);
    expect(result.teams.map((team) => team.key)).toEqual(['ENG', 'OPS']);
    expect(result.teams[0]?.states.map((state) => state.name)).toEqual(['Todo', 'Done']);
    expect(result.omitted).toEqual([expect.objectContaining({ field: 'OPS.states' })]);
  });

  it('asks for the active and next cycle by default', async () => {
    const { gql, calls } = fakeGql(() => ({ cycles: page([], null) }));
    await new StrictWorkspace(gql).listCycles({ team: 'ENG' });
    expect(calls[0]?.variables['filter']).toEqual({
      or: [{ isActive: { eq: true } }, { isNext: { eq: true } }],
      team: { key: { eqIgnoreCase: 'ENG' } },
    });
  });
});

describe('notifications', () => {
  it('returns unread pointers without excerpt text, paging until it has first, with a cursor past the last page', async () => {
    const { gql, calls } = fakeGql((_op, variables) => ({
      notificationsUnreadCount: 3,
      notifications:
        variables['after'] === null
          ? page([note(1, false, true), note(2, true)], 'cursor-1')
          : variables['after'] === 'cursor-1'
            ? page([note(3, false), note(4, true)], 'cursor-2')
            : page([note(5, false)], null),
    }));
    const result = await new StrictWorkspace(gql).notifications({ first: 2 });

    expect(calls).toHaveLength(2);
    expect(result.notifications.map((n) => [n.id, n.actor_kind])).toEqual([
      ['n-1', 'agent'],
      ['n-3', 'person'],
    ]);
    expect(result).toMatchObject({ has_more: true, next_cursor: 'cursor-2', unread_count: 3 });
    expect(JSON.stringify(result)).not.toMatch(/subtitle/);

    const rest = await new StrictWorkspace(gql).notifications({ first: 2, after: 'cursor-2' });
    expect(rest.notifications.map((n) => n.id)).toEqual(['n-5']);
    expect(rest).toMatchObject({ has_more: false, next_cursor: null });
  });

  it('leaves out notifications still snoozed', async () => {
    const snoozed = { ...note(1, false), snoozedUntilAt: '2026-10-01T00:00:00.000Z' };
    const woke = { ...note(2, false), snoozedUntilAt: '2026-09-01T00:00:00.000Z' };
    const { gql } = fakeGql(() => ({
      notificationsUnreadCount: 1,
      notifications: page([snoozed, woke], null),
    }));
    const result = await new StrictWorkspace(
      gql,
      () => new Date('2026-09-24T00:00:00.000Z'),
    ).notifications({});
    expect(result.notifications.map((n) => n.id)).toEqual(['n-2']);
  });

  it('returns what it has with a resumable cursor when a later page fails', async () => {
    const { gql } = fakeGql((_op, variables) => {
      if (variables['after'] !== null) throw new Error('rate limited');
      return { notificationsUnreadCount: 5, notifications: page([note(1, false)], 'cursor-1') };
    });
    const result = await new StrictWorkspace(gql).notifications({ first: 5 });
    expect(result.notifications).toHaveLength(1);
    expect(result).toMatchObject({ has_more: true, next_cursor: 'cursor-1' });
    expect(result.stopped_early).toMatch(/rate limited/);
  });

  it('refuses a since that is not a date', async () => {
    const { gql } = fakeGql(() => ({}));
    await expect(new StrictWorkspace(gql).notifications({ since: 'yesterday' })).rejects.toThrow(
      /ISO date/,
    );
  });

  it('marks each notification read and reports failures per id', async () => {
    const { gql } = fakeGql((_op, variables) => {
      if (variables['id'] === 'n-bad') throw new Error('not found');
      return { notificationUpdate: { success: true } };
    });
    const now = () => new Date('2026-09-24T12:00:00.000Z');
    const result = await new StrictWorkspace(gql, now).markNotificationsRead(['n-1', 'n-bad']);
    expect(result.results).toEqual([
      { id: 'n-1', read: true },
      { id: 'n-bad', read: false, error: 'not found' },
    ]);
    expect(result.read_at).toBe('2026-09-24T12:00:00.000Z');
  });
});

describe('list_issues cycle and project filters', () => {
  it('filters by cycle within a team and by project name or id', async () => {
    const { gql, calls } = fakeGql(() => ({ issues: page([], null) }));
    const strict = new StrictLinear({ gql, claims: memoryClaimStore() });

    await expect(strict.listIssues({ cycle: 12 })).rejects.toThrow(/cycle needs team/);
    await strict.listIssues({ team: 'ENG', cycle: 12, project: 'Uploads' });
    expect(calls.at(-1)?.variables['filter']).toEqual({
      team: { key: { eqIgnoreCase: 'ENG' } },
      cycle: { number: { eq: 12 } },
      project: { name: { eqIgnoreCase: 'Uploads' } },
    });
    const id = '0f2c7a52-1d3e-4b8a-9c11-5e6f7a8b9c0d';
    await strict.listIssues({ project: id });
    expect(calls.at(-1)?.variables['filter']).toEqual({ project: { id: { eq: id } } });
    await strict.listIssues({ team: 'ENG', state: 'Todo', open: true });
    expect(calls.at(-1)?.variables['filter']).toEqual({
      team: { key: { eqIgnoreCase: 'ENG' } },
      state: { name: { eqIgnoreCase: 'Todo' }, type: { nin: ['completed', 'canceled'] } },
    });
  });
});

describe('list_issues returns the whole set', () => {
  const ticket = (n: number, state: string) => ({
    identifier: `ENG-${String(n)}`,
    title: `Ticket ${String(n)}`,
    updatedAt: '2026-09-27T00:00:00.000Z',
    state: { name: state, type: 'unstarted' },
    assignee: null,
    delegate: null,
  });

  it('walks every page itself and hands back no cursor to stop at', async () => {
    const pages: Record<string, ReturnType<typeof page>> = {
      start: page([ticket(1, 'Todo'), ticket(2, 'Todo')], 'c1'),
      c1: page([ticket(3, 'Done')], 'c2'),
      c2: page([ticket(4, 'Todo')], null),
    };
    const { gql, calls } = fakeGql((_op, variables) => ({
      issues: pages[(variables['after'] as string | null) ?? 'start'],
    }));
    const strict = new StrictLinear({ gql, claims: memoryClaimStore() });

    const result = await strict.listIssues({ team: 'ENG', cycle: 4 });
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ total: 4, complete: true, by_state: { Todo: 3, Done: 1 } });
    expect(result.columns).toEqual([
      'identifier',
      'title',
      'state',
      'assignee',
      'delegate',
      'updatedAt',
    ]);
    expect(result.rows.map((row) => row[0])).toEqual(['ENG-1', 'ENG-2', 'ENG-3', 'ENG-4']);
    expect(result).not.toHaveProperty('next_cursor');
  });

  it('refuses rather than return part of the set when a later page fails', async () => {
    const { gql } = fakeGql((_op, variables) => {
      if (variables['after'] === 'c1') throw new Error('Linear is down');
      return { issues: page([ticket(1, 'Todo')], 'c1') };
    });
    const strict = new StrictLinear({ gql, claims: memoryClaimStore() });
    await expect(strict.listIssues({ team: 'ENG' })).rejects.toThrow(
      /page 2 after 1 tickets \(Linear is down\)\. Nothing is returned/,
    );
  });

  it('refuses a set too large to return whole and says how to narrow it', async () => {
    let n = 0;
    const { gql } = fakeGql(() => ({
      issues: page(
        Array.from({ length: 100 }, () => ticket((n += 1), 'Todo')),
        'more',
      ),
    }));
    const strict = new StrictLinear({ gql, claims: memoryClaimStore() });
    await expect(strict.listIssues({ team: 'ENG' })).rejects.toThrow(
      /More than 2000 tickets match.*open: true/,
    );
  });
});
