import { memoryClaimStore } from '../claims.js';
import {
  type RouteJudge,
  type RouteVerdict,
  routeJudge,
  routePrompt,
  teamRoutingFromEnv,
} from '../route.js';
import { StrictLinear } from '../strict-linear.js';
import { type FakeState, fakeGql, fakeState } from './strict-fake-linear.helper.js';

// The fake workspace has one team, ENG; here it is the product team and SOL the agents' team.
function setup(judge?: RouteJudge, overrides: Partial<FakeState> = {}) {
  const state = fakeState(overrides);
  const asked: Parameters<RouteJudge>[0][] = [];
  const strict = new StrictLinear({
    gql: fakeGql(state),
    claims: memoryClaimStore(),
    now: () => new Date('2026-10-03T12:00:00Z'),
    teamRouting: {
      productTeams: ['ENG'],
      fleetTeam: 'SOL',
      judge: judge
        ? async (request) => {
            asked.push(request);
            return judge(request);
          }
        : undefined,
    },
  });
  return { state, strict, asked };
}

const says =
  (verdict: RouteVerdict): RouteJudge =>
  () =>
    Promise.resolve(verdict);

function reply(body: unknown) {
  const sent: RequestInit[] = [];
  const fake = ((_url: string, init: RequestInit) => {
    sent.push(init);
    return Promise.resolve(new Response(JSON.stringify(body)));
  }) as unknown as typeof fetch;
  return { fake, sent };
}

const filing = {
  team: 'ENG',
  title: 'The sign-in code field is not focused',
  project_id: 'p-alpha',
};

describe('create_issue team routing', () => {
  it('refuses an agent filing onto a product team without saying who notices, and names the fleet team', async () => {
    const { state, strict, asked } = setup(says({ route: 'product', reason: 'ok', model: 'm' }));
    await expect(strict.createIssue(filing)).rejects.toThrow(/noticed_by.*team SOL/s);
    expect(state.created).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("refuses when the reviewer reads the filing as the agents' own work, quoting its reason", async () => {
    const { state, strict } = setup(
      says({ route: 'fleet', reason: 'This only changes a CI gate.', model: 'judge-m' }),
    );
    const attempt = strict.createIssue({
      ...filing,
      title: 'The scenario check waives a regression',
      noticed_by: 'Visitors get fewer regressions.',
    });
    await expect(attempt).rejects.toThrow(/judge-m.*This only changes a CI gate\..*team SOL/s);
    expect(state.created).toEqual([]);
  });

  it('files what the reviewer reads as product work and posts who notices on the new ticket', async () => {
    const { state, strict, asked } = setup(
      says({ route: 'product', reason: 'Every email sign-in changes.', model: 'judge-m' }),
    );
    const result = await strict.createIssue({
      ...filing,
      noticed_by: '  Anyone signing in by email code\ncan type the code at once. ',
    });
    expect(asked[0]).toMatchObject({
      team: 'ENG',
      fleetTeam: 'SOL',
      noticedBy: 'Anyone signing in by email code can type the code at once.',
    });
    expect(state.created).toHaveLength(1);
    expect(state.otherComments).toEqual([
      {
        issueId: 'new-101',
        body: '🤖 agent-a · 2026-10-03 · filed on ENG\n\nWho notices: Anyone signing in by email code can type the code at once.\n\nReviewed by judge-m: Every email sign-in changes.',
      },
    ]);
    expect(result).toMatchObject({ routed: { comment_url: 'https://linear.app/x/comment/o-1' } });
  });

  it('files when the reviewer errors, and says the routing went unreviewed', async () => {
    const { state, strict } = setup(
      says({ route: 'unknown', error: '529 overloaded', model: 'm' }),
    );
    const result = await strict.createIssue({ ...filing, noticed_by: 'Signing in is faster.' });
    expect(state.created).toHaveLength(1);
    expect(result).toMatchObject({ route_unchecked: '529 overloaded' });
    expect(state.otherComments[0]?.body).toMatch(/Routing not reviewed.*path check still applies/s);
  });

  it('asks nothing of a person filing on the product team', async () => {
    const { state, strict, asked } = setup(says({ route: 'fleet', reason: 'no', model: 'm' }), {
      viewer: { id: 'u-1', name: 'Justin', displayName: 'justin', app: false },
    });
    await strict.createIssue(filing);
    expect(state.created).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it('refuses an overlong noticed_by before any call', async () => {
    const { state, strict } = setup();
    await expect(strict.createIssue({ ...filing, noticed_by: 'x'.repeat(301) })).rejects.toThrow(
      /noticed_by is 301 characters/,
    );
    expect(state.calls).toEqual([]);
  });
});

describe('teamRoutingFromEnv', () => {
  it('is off unless both the fleet team and a product team are set', () => {
    expect(teamRoutingFromEnv({ LINEAR_STRICT_FLEET_TEAM: 'SOL' })).toBeUndefined();
    expect(teamRoutingFromEnv({ LINEAR_STRICT_PRODUCT_TEAMS: 'CUR' })).toBeUndefined();
    expect(
      teamRoutingFromEnv({
        LINEAR_STRICT_FLEET_TEAM: 'sol',
        LINEAR_STRICT_PRODUCT_TEAMS: 'cur, ENG',
      }),
    ).toEqual({ productTeams: ['CUR', 'ENG'], fleetTeam: 'SOL', judge: undefined });
  });
});

describe('routeJudge', () => {
  it('asks for a structured verdict with the instructions in the cached system block', async () => {
    const { fake, sent: calls } = reply({
      content: [{ type: 'text', text: '{"route":"fleet","reason":"Tests only."}' }],
    });
    const judge = routeJudge({ apiKey: 'k', model: 'm', fetch: fake });
    const request = { team: 'ENG', fleetTeam: 'SOL', title: 't', description: 'd', noticedBy: 'n' };
    await expect(judge(request)).resolves.toEqual({
      route: 'fleet',
      reason: 'Tests only.',
      model: 'm',
    });
    const sent = JSON.parse(calls[0]?.body as string) as Record<string, unknown>;
    expect(sent['system']).toEqual([
      expect.objectContaining({ cache_control: { type: 'ephemeral' } }),
    ]);
    expect(sent['output_config']).toMatchObject({ format: { type: 'json_schema' } });
    expect((sent['messages'] as { content: string }[])[0]?.content).toBe(routePrompt(request));
  });

  it('reports an error rather than a verdict when the reply has no route', async () => {
    const judge = routeJudge({
      apiKey: 'k',
      fetch: reply({ content: [{ type: 'text', text: '{}' }] }).fake,
    });
    await expect(
      judge({ team: 'ENG', fleetTeam: 'SOL', title: 't', description: '', noticedBy: 'n' }),
    ).resolves.toMatchObject({ route: 'unknown', error: 'the reply carried no verdict' });
  });
});
