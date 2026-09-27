#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pkg from '../package.json' with { type: 'json' };
import { runAuthCli } from './auth/cli.js';
import { createRefreshingProvider } from './auth/refreshing-provider.js';
import { resolveLinearAuth } from './auth/resolve.js';
import { fileClaimStore } from './claims.js';
import { logError } from './config.js';
import { STRICT_INSTRUCTIONS } from './instructions.js';
import { linearGql } from './linear.js';
import { runServer } from './server.js';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { askPost, askPre } from './hook.js';
import { runInstallCli, signOffHookHealth } from './install.js';
import { DEFAULT_JUDGE_MODEL, judgeSignOff } from './judge.js';
import { resolveJudgeKey } from './judge-key.js';
import { type Elicitor, elicitSignOff, previewSignOff } from './sign-off.js';
import { defaultStateDir, fileSignOffStore } from './sign-off-store.js';
import { guardInstance } from './single-instance.js';
import { type SignOffRequest, StrictLinear } from './strict-linear.js';
import { strictToolDefinitions, strictToolHandlers } from './tools.js';

async function main(): Promise<void> {
  const auth = resolveLinearAuth();
  if (!auth) {
    throw new Error(
      'Linear credentials not found. Set LINEAR_API_TOKEN (or LINEAR_API_KEY), pass --token, or run `linear-strict auth login`.',
    );
  }

  const connection: { server?: Elicitor } = {};
  const claims = fileClaimStore();
  const signOff = chooseSignOff(() => connection.server);
  // One StrictLinear per access token, so its viewer lookup is cached until a
  // refresh rotates the token.
  const handlers = createRefreshingProvider({
    getConfig: () => auth.getConfig(),
    build: (config) =>
      strictToolHandlers(
        new StrictLinear({
          gql: linearGql({ token: config.token, kind: config.type }),
          claims,
          mainBranch: process.env['LINEAR_STRICT_MAIN_BRANCH'] || 'main',
          productionEnv: process.env['LINEAR_STRICT_PRODUCTION_ENV'] || 'production',
          handsOffLabels: (process.env['LINEAR_STRICT_HANDS_OFF_LABELS'] || 'no-agents')
            .split(',')
            .map((label) => label.trim())
            .filter(Boolean),
          signOff,
        }),
      ),
  });
  // Resolve now, so a stored login past its expiry is refreshed, or fails with
  // a re-login hint, before the server accepts calls.
  await handlers.get();

  let lastCallAt = 0;
  const guard =
    process.env['LINEAR_STRICT_SINGLE_INSTANCE'] === '0'
      ? undefined
      : guardInstance({
          dir: path.join(defaultStateDir(), 'instances'),
          identity: serverIdentity(),
          lastCallAt: () => lastCallAt,
          exit: (reason) => {
            process.stderr.write(`linear-strict: exiting because ${reason}.\n`);
            process.exit(0);
          },
        });
  process.on('exit', () => guard?.stop());

  connection.server = await runServer(
    {
      name: 'linear-strict',
      version: pkg.version,
      instructions: STRICT_INSTRUCTIONS,
      tools: strictToolDefinitions,
      call: async (name, args) => {
        lastCallAt = Date.now();
        const handler = (await handlers.get())[name];
        if (!handler) throw new Error(`Unknown tool: ${name}`);
        return handler(args);
      },
    },
    new StdioServerTransport(),
  );
  // A client that closes our stdin is done with us.
  process.stdin.on('end', () => process.exit(0));
}

/**
 * What makes two servers under one parent the same server: the program, its
 * arguments, the directory, and the Linear and judge settings it was given
 * (secrets hashed with the rest, never stored).
 */
function serverIdentity(): string[] {
  const script = process.argv[1] ?? '';
  let real = script;
  try {
    real = realpathSync(script);
  } catch {
    // Keep the path as given.
  }
  const env = Object.entries(process.env)
    .filter(([key]) => key.startsWith('LINEAR_') || key === 'ANTHROPIC_API_KEY')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value ?? ''}`);
  return [real, ...process.argv.slice(2), process.cwd(), ...env];
}

/**
 * Who approves dropping an unticked Done when item. LINEAR_STRICT_SIGN_OFF=judge
 * hands it to a model, so an unattended session never waits. Otherwise the
 * person decides: through AskUserQuestion's preview when the client is Claude
 * Code and the hooks are installed, else through the elicitation form.
 */
function chooseSignOff(getServer: () => Elicitor | undefined) {
  const mode = process.env['LINEAR_STRICT_SIGN_OFF'] || 'person';
  if (mode === 'judge') {
    const found = resolveJudgeKey();
    if (!found) {
      throw new Error(
        `LINEAR_STRICT_SIGN_OFF=judge needs an Anthropic API key: run \`linear-strict auth judge-key set\`, or set ANTHROPIC_API_KEY in the server's environment.`,
      );
    }
    return judgeSignOff({
      apiKey: found.key,
      model: process.env['LINEAR_STRICT_JUDGE_MODEL'] || DEFAULT_JUDGE_MODEL,
    });
  }
  if (mode !== 'person')
    throw new Error(`LINEAR_STRICT_SIGN_OFF must be person or judge, not ${mode}.`);
  const elicit = elicitSignOff(getServer);
  const preview = previewSignOff(fileSignOffStore());
  return (request: SignOffRequest) => {
    if (request.token) return preview(request);
    if (getServer()?.getClientVersion?.()?.name !== 'claude-code') return elicit(request);
    const health = signOffHookHealth();
    if (health.files.length > 0 && health.problems.length > 0) {
      // Hooks that can't run would leave the question unanswered for good; the form still works.
      process.stderr.write(
        `linear-strict: sign-off hooks can't run, asking through the form instead: ${health.problems.join(' ')}\n`,
      );
    }
    return health.files.length > 0 && health.problems.length === 0
      ? preview(request)
      : elicit(request);
  };
}

function runHook(event: string | undefined): number {
  if (event !== 'ask-pre' && event !== 'ask-post') {
    process.stderr.write(
      'Usage: linear-strict hook ask-pre|ask-post (run by Claude Code, with the hook payload on stdin)\n',
    );
    return 1;
  }
  let input: Parameters<typeof askPre>[0];
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as typeof input;
  } catch (error) {
    // Not a payload this hook can read, so it can't be a sign-off: let the question through.
    process.stderr.write(`linear-strict hook: unreadable input (${(error as Error).message})\n`);
    return 0;
  }
  const result = (event === 'ask-pre' ? askPre : askPost)(input, fileSignOffStore());
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  return result.code;
}

const args = process.argv.slice(2);
if (args[0] === 'install') {
  try {
    process.exit(runInstallCli(args.slice(1)));
  } catch (error) {
    logError('Install failed', error);
    process.exit(1);
  }
} else if (args[0] === 'hook') {
  process.exit(runHook(args[1]));
} else if (args[0] === 'auth') {
  runAuthCli(args.slice(1)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      logError('Auth command failed', error);
      process.exit(1);
    },
  );
} else {
  // Exit on these explicitly: a registered listener otherwise replaces Node's
  // default termination, and the server would ignore its parent's shutdown.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => process.exit(0));
  }
  process.on('unhandledRejection', (reason) => {
    logError('Unhandled rejection', reason);
  });
  main().catch((error: unknown) => {
    logError('linear-strict failed to start', error);
    process.exit(1);
  });
}
