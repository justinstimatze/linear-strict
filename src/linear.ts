import type { Gql } from './graphql.js';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';

const RATE_LIMIT_RESET_HEADERS = [
  'X-RateLimit-Requests-Reset',
  'X-RateLimit-Endpoint-Requests-Reset',
  'X-RateLimit-Complexity-Reset',
];
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;
const BASE_RETRY_DELAY_MS = 1_000;
/** Gateway statuses Linear's edge returns while the API behind it is briefly unreachable. */
const GATEWAY_STATUSES = [502, 503, 504];

class GatewayError extends Error {}

/** A query, or the `{ … }` shorthand for one. Only these are retried after a gateway error. */
function isRead(query: string) {
  return /^\s*(query\b|\{)/.test(query);
}

export interface LinearGqlOptions {
  token: string;
  /** How the token is sent. Defaults by prefix: `lin_api_` keys go raw, anything else as Bearer. */
  kind?: 'apiKey' | 'oauth';
  url?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface GraphQLError {
  message?: string;
  extensions?: { code?: string; type?: string; userPresentableMessage?: string };
}

class RateLimited extends Error {
  readonly resetAt: number | undefined;
  constructor(resetAt: number | undefined) {
    super(
      resetAt === undefined
        ? 'Linear rate limit reached. Wait a minute before retrying.'
        : `Linear rate limit reached; it resets at ${new Date(resetAt).toISOString()}.`,
    );
    this.resetAt = resetAt;
  }
}

export function authorizationHeader(token: string, kind?: 'apiKey' | 'oauth'): string {
  const raw = kind ? kind === 'apiKey' : token.startsWith('lin_api_');
  return raw ? token : `Bearer ${token}`;
}

/**
 * Talks to Linear with plain fetch. A rate-limited request waits for Linear's
 * reset header (capped at a minute) and retries twice; after that the error
 * names the reset time. Any GraphQL error fails the call, partial data included,
 * so a half-answered query is never read as a whole one.
 */
export function linearGql(options: LinearGqlOptions): Gql {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const headers = {
    'Content-Type': 'application/json',
    Authorization: authorizationHeader(options.token, options.kind),
  };
  let blockedUntil = 0;

  const once = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const response = await doFetch(options.url ?? LINEAR_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
    const body = (await response.json().catch(() => undefined)) as
      { data?: T; errors?: GraphQLError[] } | undefined;
    const errors = body?.errors ?? [];
    const limited =
      response.status === 429 ||
      errors.some(
        (error) =>
          error.extensions?.code === 'RATELIMITED' || error.extensions?.type === 'Ratelimited',
      );
    if (limited) throw new RateLimited(resetAt(response.headers, now()));
    if (errors.length > 0) {
      throw new Error(
        errors
          .map(
            (error) => error.extensions?.userPresentableMessage ?? error.message ?? 'unknown error',
          )
          .join('; '),
      );
    }
    if (!response.ok) {
      const message = `Linear API returned HTTP ${String(response.status)}`;
      throw GATEWAY_STATUSES.includes(response.status)
        ? new GatewayError(message)
        : new Error(message);
    }
    if (body?.data === undefined) throw new Error('Linear API returned no data');
    return body.data;
  };

  return async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      if (blockedUntil > now()) await sleep(blockedUntil - now());
      try {
        return await once<T>(query, variables);
      } catch (error) {
        // A mutation is never retried after a gateway error: the edge may have passed it on before
        // failing, and a second attempt could post the same comment twice.
        const retryable =
          error instanceof RateLimited || (error instanceof GatewayError && isRead(query));
        if (!retryable || attempt === MAX_RETRIES) throw error;
        const delay =
          !(error instanceof RateLimited) || error.resetAt === undefined
            ? BASE_RETRY_DELAY_MS * 2 ** attempt
            : Math.max(0, error.resetAt - now());
        blockedUntil = now() + Math.min(delay, MAX_RETRY_DELAY_MS);
      }
    }
  };
}

function resetAt(headers: Headers, now: number): number | undefined {
  const times = RATE_LIMIT_RESET_HEADERS.map((name) => Number(headers.get(name) ?? NaN)).filter(
    (value) => Number.isFinite(value) && value > now,
  );
  return times.length > 0 ? Math.max(...times) : undefined;
}
