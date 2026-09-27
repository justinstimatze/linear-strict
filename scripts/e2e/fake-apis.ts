/**
 * Loaded into the server process under test with `node --import tsx --import
 * <this file>`. It answers Linear's GraphQL endpoint from the in-memory fake
 * the unit tests use, so the server runs unchanged against a workspace that
 * can't be damaged. The judge's Anthropic call gets a canned verdict when
 * E2E_JUDGE=fake, and goes to the real API otherwise.
 */
import { fakeGql, fakeState } from '../../src/__tests__/strict-fake-linear.helper.ts';

const state = fakeState();
if (process.env['E2E_DESCRIPTION']) state.issue.description = process.env['E2E_DESCRIPTION'];
const gql = fakeGql(state);
const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://api.linear.app/')) {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
    try {
      return json({ data: await gql(query, variables ?? {}) });
    } catch (error) {
      return json({ errors: [{ message: error instanceof Error ? error.message : String(error) }] });
    }
  }
  if (url.startsWith('https://api.anthropic.com/') && process.env['E2E_JUDGE'] === 'fake') {
    const verdict = { approve: true, reason: 'Observed shows develop was retired, and the preview check tests the same behavior.' };
    return json({ content: [{ type: 'text', text: JSON.stringify(verdict) }], stop_reason: 'end_turn' });
  }
  return realFetch(input, init);
}) as typeof fetch;
