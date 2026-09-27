// From tacticlaunch/mcp-linear (MIT, Copyright (c) 2025 Alexey Elizarov); see LICENSE.md.
import { createHash, randomBytes } from 'node:crypto';

/**
 * Random bytes behind a verifier. RFC 7636 section 4.1 recommends 32 octets,
 * base64url-encoded, which gives 43 characters from its unreserved set with
 * every character equally likely; mapping bytes onto the 66-character set with
 * % would favour some characters, since 256 is not a multiple of 66.
 */
const VERIFIER_BYTES = 32;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Generate a cryptographically random PKCE code verifier and its S256 challenge.
 */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(VERIFIER_BYTES).toString('base64url');

  const challenge = createHash('sha256').update(verifier).digest('base64url');

  return { verifier, challenge };
}

/**
 * Generate a cryptographically random, URL-safe OAuth state value.
 */
export function generateState(): string {
  return randomBytes(24).toString('base64url');
}
