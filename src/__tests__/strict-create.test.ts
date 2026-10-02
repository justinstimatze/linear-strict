import { memoryClaimStore } from '../claims.js';
import { type OverlapReader, overlapReader } from '../overlap-model.js';
import { StrictLinear } from '../strict-linear.js';
import { type FakeState, fakeGql, fakeState } from './strict-fake-linear.helper.js';

function setup(
  overrides: Partial<FakeState> = {},
  overlapReader?: OverlapReader,
  now = () => new Date('2026-09-24T12:00:00Z'),
) {
  const state = fakeState(overrides);
  const strict = new StrictLinear({
    gql: fakeGql(state),
    claims: memoryClaimStore(),
    now,
    overlapReader,
  });
  return { state, strict };
}

const close = [
  { identifier: 'ENG-7', title: 'Deleted chats survive in the logs', state: 'Triage' },
  { identifier: 'ENG-9', title: 'Log retention has no expiry', state: 'Todo' },
];

describe('create_issue', () => {
  it('refuses a ticket with no parent or project, before any call', async () => {
    const { state, strict } = setup();
    await expect(strict.createIssue({ team: 'ENG', title: 'Logs keep chats' })).rejects.toThrow(
      /needs a home.*parent.*project_id/,
    );
    expect(state.calls).toEqual([]);
  });

  it('refuses until the filer places the work against each close open ticket', async () => {
    const { state, strict } = setup({ closeTickets: close });
    const attempt = strict.createIssue({
      team: 'ENG',
      title: 'Logs keep chats',
      project_id: 'p-alpha',
    });
    await expect(attempt).rejects.toThrow(/Nothing was filed: these open tickets/);
    await expect(attempt).rejects.toThrow(/ENG-7 \[Triage\] Deleted chats[\s\S]*ENG-9 \[Todo\]/);
    await expect(attempt).rejects.toThrow(/parent set to it[\s\S]*file nothing[\s\S]*new_because/);
    await expect(attempt).rejects.toMatchObject({
      name: 'OverlapRefusal',
      candidates: [{ identifier: 'ENG-7' }, { identifier: 'ENG-9' }],
    });
    expect(state.created).toEqual([]);
  });

  it('refuses a new_because that leaves a close ticket out, naming only that one', async () => {
    const { state, strict } = setup({ closeTickets: close });
    const attempt = strict.createIssue({
      team: 'ENG',
      title: 'Logs keep chats',
      project_id: 'p-alpha',
      new_because: 'This is the backup tier, which neither covers.',
      distinct_from: ['eng-7'],
    });
    await expect(attempt).rejects.toThrow(/distinct_from leaves out:\n- ENG-9 /);
    await expect(attempt).rejects.not.toThrow(/- ENG-7 /);
    expect(state.created).toEqual([]);
  });

  it('files apart from every close ticket and posts why on the new one', async () => {
    const { state, strict } = setup({ closeTickets: close });
    const result = await strict.createIssue({
      team: 'ENG',
      title: 'Backups keep chats',
      project_id: 'p-alpha',
      new_because: '  This is the backup tier,\nwhich neither covers.  ',
      distinct_from: ['ENG-7', 'ENG-9'],
    });
    expect(state.created).toEqual([
      { teamId: 't-1', title: 'Backups keep chats', projectId: 'p-alpha' },
    ]);
    expect(state.otherComments).toEqual([
      {
        issueId: 'new-101',
        body: '🤖 agent-a · 2026-09-24 · filed new\n\nNot part of ENG-7, ENG-9: This is the backup tier, which neither covers.',
      },
    ]);
    expect(result).toMatchObject({
      identifier: 'ENG-101',
      filed_new: { comment_url: 'https://linear.app/x/comment/o-1' },
    });
  });

  it('files a sub-ticket without the search', async () => {
    const { state, strict } = setup({ closeTickets: close });
    await strict.createIssue({ team: 'ENG', title: 'Backups keep chats', parent: 'ENG-1' });
    expect(state.created).toEqual([
      { teamId: 't-1', title: 'Backups keep chats', parentId: 'issue-1' },
    ]);
    expect(state.calls.map((c) => c.operation)).not.toContain('StrictOverlap');
  });

  it('adds keyword matches the semantic search missed, after its own', async () => {
    const { strict } = setup({
      closeTickets: close,
      keywordTickets: [
        { identifier: 'ENG-9', title: 'Log retention has no expiry', state: 'Todo' },
        { identifier: 'ENG-12', title: 'Log drain keeps chats', state: 'Backlog' },
      ],
    });
    await expect(
      strict.createIssue({ team: 'ENG', title: 'Drain logs', project_id: 'p-alpha' }),
    ).rejects.toMatchObject({
      candidates: [{ identifier: 'ENG-7' }, { identifier: 'ENG-9' }, { identifier: 'ENG-12' }],
    });
  });

  it('checks against the keyword matches alone when the semantic search fails', async () => {
    const { state, strict } = setup({ closeTickets: 'fail', keywordTickets: close });
    await expect(
      strict.createIssue({ team: 'ENG', title: 'Logs keep chats', project_id: 'p-alpha' }),
    ).rejects.toMatchObject({ candidates: [{ identifier: 'ENG-7' }, { identifier: 'ENG-9' }] });
    expect(state.created).toEqual([]);
  });

  it('files without the check when both searches fail, and says so', async () => {
    const { state, strict } = setup({ closeTickets: 'fail', keywordTickets: 'fail' });
    const result = await strict.createIssue({
      team: 'ENG',
      title: 'Logs keep chats',
      project_id: 'p-alpha',
    });
    expect(state.created).toHaveLength(1);
    expect(result.overlap_unchecked).toMatch(/Rate limit exceeded/);
  });

  it('refuses an overlong new_because before any call', async () => {
    const { state, strict } = setup({ closeTickets: close });
    await expect(
      strict.createIssue({
        team: 'ENG',
        title: 'Logs keep chats',
        project_id: 'p-alpha',
        new_because: 'x'.repeat(301),
      }),
    ).rejects.toThrow(/301 characters/);
    expect(state.calls).toEqual([]);
  });

  it("returns the filer's waiting, unclaimed tickets, oldest first", async () => {
    const unclaimed = Array.from({ length: 12 }, (_, i) => ({
      identifier: `ENG-${String(50 + i)}`,
      title: `Filed ${String(i)}`,
      createdAt: new Date(Date.UTC(2026, 8, 24 - 12 + i)).toISOString(),
      state: 'Triage',
    }));
    const { state, strict } = setup({ unclaimed: [...unclaimed].reverse() });
    const result = await strict.createIssue({
      team: 'ENG',
      title: 'Something new',
      project_id: 'p-alpha',
    });
    const mine = result.your_unclaimed;
    if ('error' in mine) throw new Error(mine.error);
    expect(mine).toMatchObject({ total: 12, older_than_7_days: 5 });
    expect(mine.oldest).toHaveLength(10);
    expect(mine.oldest.slice(0, 2)).toEqual([
      ['ENG-50', 'Filed 0', 'Triage', 12],
      ['ENG-51', 'Filed 1', 'Triage', 11],
    ]);
    expect(mine.note).toMatch(/A ticket is not the work/);
    const call = state.calls.find((c) => c.operation === 'StrictUnclaimedFilings');
    expect(call?.variables).toMatchObject({ team: 'ENG' });
  });
});

describe('create_issue with a model reading the open titles', () => {
  const team = [
    {
      identifier: 'ENG-7',
      title: 'Deleted chats survive in the logs',
      state: 'Triage',
      stateType: 'triage',
      updatedAt: '2026-09-20T00:00:00Z',
    },
    {
      identifier: 'ENG-12',
      title: 'Log drain keeps chats',
      state: 'Backlog',
      stateType: 'backlog',
      updatedAt: '2026-09-21T00:00:00Z',
    },
    {
      identifier: 'ENG-3',
      title: 'Old and done',
      state: 'Done',
      stateType: 'completed',
      updatedAt: '2026-09-01T00:00:00Z',
    },
  ];

  it('puts the tickets the model names to the filer, from the open list, without the searches', async () => {
    const lists: string[] = [];
    const { state, strict } = setup(
      { teamTickets: structuredClone(team), closeTickets: close },
      (list, ticket) => {
        lists.push(list);
        expect(ticket).toBe('THE NEW TICKET\nTitle: Logs keep chats\n\n(no description)');
        return Promise.resolve(['eng-12', 'ENG-404', 'ENG-12']);
      },
    );
    await expect(
      strict.createIssue({ team: 'ENG', title: 'Logs keep chats', project_id: 'p-alpha' }),
    ).rejects.toMatchObject({
      name: 'OverlapRefusal',
      candidates: [{ identifier: 'ENG-12', state: 'Backlog' }],
    });
    expect(lists).toEqual([
      'ENG-7 Deleted chats survive in the logs\nENG-12 Log drain keeps chats',
    ]);
    const ops = state.calls.map((c) => c.operation);
    expect(ops).not.toContain('StrictOverlap');
    expect(ops).not.toContain('StrictOverlapKeyword');
  });

  it('reads only what changed on the next filing, and keeps the list frozen with the change in the message', async () => {
    const lists: string[] = [];
    const tickets: string[] = [];
    const { state, strict } = setup({ teamTickets: structuredClone(team) }, (list, ticket) => {
      lists.push(list);
      tickets.push(ticket);
      return Promise.resolve([]);
    });
    await strict.createIssue({ team: 'ENG', title: 'First', project_id: 'p-alpha' });
    state.teamTickets[0] = {
      identifier: 'ENG-7',
      title: 'Deleted chats survive in the logs',
      state: 'Done',
      stateType: 'completed',
      updatedAt: '2026-09-23T00:00:00Z',
    };
    await strict.createIssue({ team: 'ENG', title: 'Second', project_id: 'p-alpha' });
    const reads = state.calls.filter((c) => c.operation.startsWith('StrictTeamTitles'));
    expect(reads.map((c) => c.operation)).toEqual([
      'StrictTeamTitles',
      'StrictTeamTitlesClosedSince',
      'StrictTeamTitlesSince',
    ]);
    expect(reads[2]?.variables).toMatchObject({ since: '2026-09-21T00:00:00Z' });
    expect(lists[1]).toBe(lists[0]);
    expect(tickets[1]).toBe(
      'Closed since the list, so not open any more: ENG-7\n\nTHE NEW TICKET\nTitle: Second\n\n(no description)',
    );
  });

  it('gives a server started mid-hour the same list as one started on the hour, so they share the cache', async () => {
    const lists: string[] = [];
    const tickets: string[] = [];
    const reader: OverlapReader = (list, ticket) => {
      lists.push(list);
      tickets.push(ticket);
      return Promise.resolve([]);
    };
    const state = fakeState({ teamTickets: structuredClone(team) });
    const server = (at: string) =>
      new StrictLinear({
        gql: fakeGql(state),
        claims: memoryClaimStore(),
        now: () => new Date(at),
        overlapReader: reader,
      });
    await server('2026-09-24T12:05:00Z').createIssue({
      team: 'ENG',
      title: 'First',
      project_id: 'p-alpha',
    });
    state.teamTickets[0] = {
      identifier: 'ENG-7',
      title: 'Deleted chats survive in the logs',
      state: 'Done',
      stateType: 'completed',
      updatedAt: '2026-09-24T12:20:00Z',
      createdAt: '2026-09-20T00:00:00Z',
      closedAt: '2026-09-24T12:20:00Z',
    };
    await server('2026-09-24T12:40:00Z').createIssue({
      team: 'ENG',
      title: 'Second',
      project_id: 'p-alpha',
    });
    expect(lists[1]).toBe(lists[0]);
    expect(lists[0]).toContain('ENG-7 Deleted chats survive in the logs');
    expect(tickets[1]).toMatch(/^Closed since the list, so not open any more: ENG-7/);
  });

  it('lists a ticket opened since in the message, and takes a new list the next hour', async () => {
    const lists: string[] = [];
    const tickets: string[] = [];
    let clock = new Date('2026-09-24T12:00:00Z').getTime();
    const { state, strict } = setup(
      { teamTickets: structuredClone(team) },
      (list, ticket) => {
        lists.push(list);
        tickets.push(ticket);
        return Promise.resolve([]);
      },
      () => new Date(clock),
    );
    await strict.createIssue({ team: 'ENG', title: 'First', project_id: 'p-alpha' });
    state.teamTickets.push({
      identifier: 'ENG-40',
      title: 'Log export drops chats',
      state: 'Triage',
      stateType: 'triage',
      updatedAt: '2026-09-24T12:10:00Z',
    });
    clock += 30 * 60 * 1000;
    await strict.createIssue({ team: 'ENG', title: 'Second', project_id: 'p-alpha' });
    expect(lists[1]).toBe(lists[0]);
    expect(tickets[1]).toMatch(
      /^Opened or retitled since the list:\nENG-40 Log export drops chats\n\nTHE NEW TICKET/,
    );
    clock += 60 * 60 * 1000;
    await strict.createIssue({ team: 'ENG', title: 'Third', project_id: 'p-alpha' });
    expect(lists[2]).toContain('ENG-40 Log export drops chats');
    expect(tickets[2]).toMatch(/^THE NEW TICKET/);
  });

  it("falls back to Linear's searches when the model fails, and says so", async () => {
    const { strict } = setup({ teamTickets: structuredClone(team), closeTickets: [] }, () =>
      Promise.reject(new Error('529 overloaded')),
    );
    const result = await strict.createIssue({ team: 'ENG', title: 'Logs', project_id: 'p-alpha' });
    expect(result.overlap_note).toMatch(/529 overloaded.*searches/);
  });

  it('asks the API for a structured answer with the list in the cached system block', async () => {
    const sent: Record<string, unknown>[] = [];
    const read = overlapReader({
      apiKey: 'k',
      fetch: (_url, init) => {
        if (typeof init?.body === 'string')
          sent.push(JSON.parse(init.body) as Record<string, unknown>);
        return Promise.resolve(
          new Response(
            JSON.stringify({ content: [{ type: 'text', text: '{"identifiers":["ENG-7"]}' }] }),
          ),
        );
      },
    });
    expect(await read('ENG-7 [Triage] x', 'Title: y')).toEqual(['ENG-7']);
    expect(sent[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      output_config: { format: { type: 'json_schema' } },
      system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: 'Title: y' }],
    });
    const failing = overlapReader({
      apiKey: 'k',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
        ),
    });
    await expect(failing('l', 't')).rejects.toThrow(/401 bad key/);
  });
});
