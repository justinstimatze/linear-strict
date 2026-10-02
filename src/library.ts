/**
 * The strict rules for a program rather than an agent: a script that files
 * tickets (a CI job turning findings into tickets, say) imports these and
 * gets the same refusals the MCP tools give, with the close tickets of an
 * overlap refusal as data on `OverlapRefusal.candidates`.
 *
 *   import { StrictLinear, linearGql, memoryClaimStore } from 'linear-strict/library';
 *   const strict = new StrictLinear({ gql: linearGql({ token }), claims: memoryClaimStore() });
 */
export { StrictLinear, type CreateIssueArgs, type StrictLinearOptions } from './strict-linear.js';
export { linearGql, type LinearGqlOptions } from './linear.js';
export { memoryClaimStore } from './claims.js';
export { OverlapRefusal, type Candidate } from './overlap.js';
export type { UnclaimedFilings } from './filings.js';
