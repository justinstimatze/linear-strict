/**
 * Parse command line arguments to find a specific flag and its value
 * @param flag The flag to search for (e.g., '--token')
 * @returns The value of the flag or undefined if not found
 */
export function getCommandLineArg(flag: string): string | undefined {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      return args[i + 1];
    }
  }

  return undefined;
}

/**
 * Get the Linear API token from command-line arguments or environment variable
 * @returns The API token or undefined if not found
 */
export function getLinearApiToken(): string | undefined {
  // First try to get the token from command-line arguments
  const tokenFromArgs = getCommandLineArg('--token');

  // If not found, try to get it from environment variables
  // Accept either LINEAR_API_TOKEN or LINEAR_API_KEY.
  const tokenFromEnv = process.env['LINEAR_API_TOKEN'] || process.env['LINEAR_API_KEY'];

  // Only emit environment diagnostics in explicit debug mode.
  if (!tokenFromArgs && !tokenFromEnv) {
    logError('API token not found in command line args or environment variables');
    if (isDebugLoggingEnabled()) {
      console.error(
        'Environment variables:',
        Object.keys(process.env).filter((key) => key.includes('LINEAR')),
      );
    }
  }

  return tokenFromArgs || tokenFromEnv;
}

export type LinearAuthConfig = { type: 'oauth'; token: string } | { type: 'apiKey'; token: string };

/**
 * Resolve only explicitly supplied credentials (the --token CLI flag or the
 * LINEAR_API_TOKEN / LINEAR_API_KEY environment variables), without emitting
 * missing-credential diagnostics. Callers that support additional credential
 * sources (such as the OAuth credentials stored by `linear-strict auth login`)
 * use this to keep the explicit-over-implicit precedence intact.
 */
export function getExplicitLinearAuthConfig(): LinearAuthConfig | undefined {
  const oauthTokenFromArgs = getCommandLineArg('--oauth-token');
  if (oauthTokenFromArgs) {
    return { type: 'oauth', token: oauthTokenFromArgs };
  }

  const apiKeyFromArgs = getCommandLineArg('--token');
  if (apiKeyFromArgs) {
    return { type: 'apiKey', token: apiKeyFromArgs };
  }

  const oauthTokenFromEnv = process.env['LINEAR_OAUTH_ACCESS_TOKEN'];
  if (oauthTokenFromEnv) {
    return { type: 'oauth', token: oauthTokenFromEnv };
  }

  const apiKeyFromEnv = process.env['LINEAR_API_TOKEN'] || process.env['LINEAR_API_KEY'];
  if (apiKeyFromEnv) {
    // Tools that mint per-agent OAuth tokens (e.g. pennon) write them into
    // LINEAR_API_TOKEN. Linear expects those as a Bearer header, so route
    // them through the OAuth path instead of sending them as a raw API key.
    const type = apiKeyFromEnv.startsWith('lin_oauth_') ? 'oauth' : 'apiKey';
    return { type, token: apiKeyFromEnv };
  }

  return undefined;
}

export interface PrincipalConfig {
  token: string;
  userId: string;
}

/**
 * The human this identity acts for, if pennon's onboard has wired one
 * (LINEAR_PRINCIPAL_TOKEN + LINEAR_PRINCIPAL_ID). Absent for most
 * identities — only get_principal_notifications needs it. Both must be
 * set; one without the other is treated as absent rather than guessed at,
 * since it's a half-finished wiring rather than a usable principal.
 */
export function getPrincipalConfig(): PrincipalConfig | undefined {
  const token = process.env['LINEAR_PRINCIPAL_TOKEN'];
  const userId = process.env['LINEAR_PRINCIPAL_ID'];
  if (!token || !userId) return undefined;
  return { token, userId };
}

export function isDebugLoggingEnabled(): boolean {
  return (
    process.env['LINEAR_STRICT_DEBUG'] === '1' || process.env['LINEAR_STRICT_DEBUG'] === 'true'
  );
}

/**
 * Log error information
 * @param message The error message
 * @param error The error object (optional)
 */
export function logError(message: string, error?: unknown): void {
  if (error) {
    console.error(message, error);
  } else {
    console.error(message);
  }
}
