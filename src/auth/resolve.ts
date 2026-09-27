// From tacticlaunch/mcp-linear (MIT, Copyright (c) 2025 Alexey Elizarov); see LICENSE.md.
import {
  getExplicitLinearAuthConfig,
  getLinearApiToken,
  type LinearAuthConfig,
} from '../config.js';
import { createStoredCredentialAuth } from './managed-auth.js';

export interface ResolvedLinearAuth {
  source: 'explicit' | 'store';
  /** Current auth config; store-backed auth refreshes transparently. */
  getConfig(): Promise<LinearAuthConfig>;
}

/**
 * Resolve the server's Linear credential.
 *
 * Precedence: explicit CLI flags, then explicit environment variables (the
 * existing rules in getExplicitLinearAuthConfig), then credentials stored by
 * `linear-strict auth login`.
 */
export function resolveLinearAuth(): ResolvedLinearAuth | undefined {
  const explicit = getExplicitLinearAuthConfig();
  if (explicit) {
    return {
      source: 'explicit',
      getConfig: () => Promise.resolve(explicit),
    };
  }

  const stored = createStoredCredentialAuth();
  if (stored) {
    return {
      source: 'store',
      getConfig: () => stored.getConfig(),
    };
  }

  // Preserve the existing missing-credential diagnostics (no values logged).
  getLinearApiToken();
  return undefined;
}
