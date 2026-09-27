import { authorizationHeader, linearGql } from '../linear.js';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fetch = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return Promise.resolve(next);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('authorizationHeader', () => {
  it('sends a personal API key raw and anything else as a Bearer token', () => {
    expect(authorizationHeader('lin_api_abc')).toBe('lin_api_abc');
    expect(authorizationHeader('lin_oauth_abc')).toBe('Bearer lin_oauth_abc');
    expect(authorizationHeader('opaque', 'oauth')).toBe('Bearer opaque');
    expect(authorizationHeader('opaque', 'apiKey')).toBe('opaque');
  });
});

describe('linearGql', () => {
  it('posts the query and variables and returns data', async () => {
    const { fetch, calls } = fakeFetch([json({ data: { viewer: { id: 'u1' } } })]);
    const gql = linearGql({ token: 'lin_api_x', fetch });

    await expect(gql('query { viewer { id } }', { a: 1 })).resolves.toEqual({ viewer: { id: 'u1' } });
    expect(calls[0]?.url).toBe('https://api.linear.app/graphql');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ query: 'query { viewer { id } }', variables: { a: 1 } });
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBe('lin_api_x');
  });

  it('fails on any GraphQL error, even with partial data, using the user-facing message', async () => {
    const { fetch } = fakeFetch([
      json({
        data: { issue: null },
        errors: [{ message: 'Entity not found', extensions: { userPresentableMessage: 'Could not find referenced Issue.' } }],
      }),
    ]);
    await expect(linearGql({ token: 't', fetch })('q')).rejects.toThrow('Could not find referenced Issue.');
  });

  it('names the HTTP status when there is no GraphQL error to report', async () => {
    const { fetch } = fakeFetch([new Response('bad gateway', { status: 502 })]);
    await expect(linearGql({ token: 't', fetch })('q')).rejects.toThrow('HTTP 502');
  });

  it('retries a read after a gateway error, and never a mutation', async () => {
    const slept: number[] = [];
    const sleep = (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    };
    const read = fakeFetch([new Response('upstream connect error', { status: 503 }), json({ data: { ok: true } })]);
    await expect(linearGql({ token: 't', fetch: read.fetch, sleep })('query Q { ok }')).resolves.toEqual({ ok: true });
    expect(read.calls).toHaveLength(2);

    const write = fakeFetch([new Response('upstream connect error', { status: 503 }), json({ data: { ok: true } })]);
    await expect(linearGql({ token: 't', fetch: write.fetch, sleep })('mutation M { ok }')).rejects.toThrow('HTTP 503');
    expect(write.calls).toHaveLength(1);
  });

  it('waits for the reset header and retries a rate-limited call', async () => {
    let now = 1_000_000;
    const slept: number[] = [];
    const { fetch, calls } = fakeFetch([
      json({ errors: [{ message: 'limited', extensions: { code: 'RATELIMITED' } }] }, 400, {
        'X-RateLimit-Requests-Reset': String(now + 5_000),
      }),
      json({ data: { ok: true } }),
    ]);
    const gql = linearGql({
      token: 't',
      fetch,
      now: () => now,
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });

    await expect(gql('q')).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([5_000]);
  });

  it('gives up after two retries and says when the limit resets', async () => {
    const now = Date.UTC(2026, 8, 25, 4, 0, 0);
    const limited = () => new Response('', { status: 429, headers: { 'X-RateLimit-Requests-Reset': String(now + 1_000) } });
    const { fetch, calls } = fakeFetch([limited(), limited(), limited()]);
    const gql = linearGql({ token: 't', fetch, now: () => now, sleep: () => Promise.resolve() });

    await expect(gql('q')).rejects.toThrow('resets at 2026-09-25T04:00:01.000Z');
    expect(calls).toHaveLength(3);
  });
});
