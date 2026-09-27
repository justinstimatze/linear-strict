import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { defaultSignOffDir } from './sign-off-store.js';

/** Every hook this installer writes ends with this, so it can find and replace its own entries and nothing else. */
const MARK = '# linear-strict-sign-off';

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookEntry[]> };

export function userSettingsPath(): string {
  return path.join(process.env['CLAUDE_CONFIG_DIR'] || path.join(homedir(), '.claude'), 'settings.json');
}

function quote(text: string) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command a hook runs this package with. A checkout or a global install
 * has a path that stays put, so the hook runs it with this node directly.
 * Under npx the script sits in npm's cache, which npm prunes, so a hook
 * pointing there would stop working without a word; those hooks run the
 * same pinned version through npx instead.
 */
export function hookRunner(script: string, version: string = pkg.version, node: string = process.execPath): string {
  if (/[\\/]_npx[\\/]/.test(script)) {
    const npx = path.join(path.dirname(node), 'npx');
    return `${existsSync(npx) ? quote(npx) : 'npx'} -y linear-strict@${version}`;
  }
  return `${quote(node)} ${quote(script)}`;
}

/**
 * The hooks sign-off needs: two on AskUserQuestion that check a sign-off
 * question on the way out and record the answer on the way back, and a
 * guard on file-writing tools so an answer can't be written by hand. The
 * guard is a grep, since it runs on every Bash call.
 */
export function signOffHooks(runner: string, dir = defaultSignOffDir()): Record<string, HookEntry[]> {
  // npx may have to fetch the package the first time a hook runs.
  const timeout = runner.includes(' -y linear-strict@') ? 120 : 30;
  const run = (event: string) => ({ type: 'command', command: `${runner} hook ${event} ${MARK}`, timeout });
  const guard = `grep -qF -e ${quote(dir)} -e 'linear-strict/sign-offs' && { echo 'linear-strict: sign-off answers are recorded by its hook when your user answers, never written by hand.' >&2; exit 2; } || exit 0 ${MARK}`;
  return {
    PreToolUse: [
      { matcher: 'AskUserQuestion', hooks: [run('ask-pre')] },
      { matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: guard }] },
    ],
    PostToolUse: [{ matcher: 'AskUserQuestion', hooks: [run('ask-post')] }],
  };
}

function ours(entry: HookEntry) {
  return entry.hooks.some((hook) => hook.command.endsWith(MARK));
}

/** Settings with this installer's entries removed, then `add` merged in. Everything else is left as it was. */
export function mergeHooks(settings: Settings, add: Record<string, HookEntry[]>): Settings {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = entries.filter((entry) => !ours(entry));
    if (kept.length > 0) hooks[event] = kept;
  }
  for (const [event, entries] of Object.entries(add)) hooks[event] = [...(hooks[event] ?? []), ...entries];
  const next: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

function load(file: string): Settings {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Settings;
  } catch (error) {
    throw new Error(`${file} is not valid JSON, so nothing was changed: ${(error as Error).message}`);
  }
}

function save(file: string, settings: Settings, now: Date) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file);
}

export interface HookHealth {
  /** Settings files that hold this installer's hooks. */
  files: string[];
  /** Why the installed hooks can't run, if they can't. Empty when they can. */
  problems: string[];
}

/** The quoted words at the start of a hook command: node and the script, when it runs them directly. */
function quotedWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'\s+/y;
  let match;
  while (words.length < 2 && (match = pattern.exec(command)) !== null) words.push((match[1] ?? '').replace(/'\\''/g, "'"));
  return words;
}

/**
 * Whether the sign-off hooks are installed where Claude Code reads settings
 * for this project, and whether the program they run is still there. A hook
 * whose script was deleted fails on every question, so a sign-off would wait
 * for an answer nothing records.
 */
export function signOffHookHealth(projectDir = process.env['CLAUDE_PROJECT_DIR'] || process.cwd(), version: string = pkg.version): HookHealth {
  const candidates = [userSettingsPath(), path.join(projectDir, '.claude', 'settings.json'), path.join(projectDir, '.claude', 'settings.local.json')];
  const health: HookHealth = { files: [], problems: [] };
  for (const file of candidates) {
    let settings: Settings;
    try {
      settings = load(file);
    } catch {
      continue;
    }
    const commands = Object.values(settings.hooks ?? {})
      .flat()
      .filter(ours)
      .flatMap((entry) => entry.hooks.map((hook) => hook.command))
      .filter((command) => / hook ask-(pre|post) /.test(command));
    if (commands.length === 0) continue;
    health.files.push(file);
    if (!commands.some((command) => command.includes(' hook ask-post '))) health.problems.push(`${file} has no ask-post hook, so no answer would be recorded.`);
    for (const command of commands) {
      const pinned = / -y linear-strict@(\S+) hook /.exec(command)?.[1];
      if (pinned !== undefined) {
        if (pinned !== version) health.problems.push(`${file} runs linear-strict@${pinned} for its hooks, but this server is ${version}.`);
        continue;
      }
      for (const word of quotedWords(command)) {
        if (!existsSync(word)) health.problems.push(`${file} runs ${word}, which no longer exists.`);
      }
    }
  }
  health.problems = [...new Set(health.problems)];
  return health;
}

/** Whether the sign-off hooks are installed and can run. */
export function signOffHooksInstalled(projectDir?: string): boolean {
  const health = signOffHookHealth(projectDir);
  return health.files.length > 0 && health.problems.length === 0;
}

/** `linear-strict install [--status | --uninstall]`. Returns the exit code. */
export function runInstallCli(args: string[], script = process.argv[1] ?? '', now = new Date()): number {
  const file = userSettingsPath();
  const settings = load(file);
  if (args.includes('--status')) {
    const health = signOffHookHealth();
    if (health.files.length === 0) {
      process.stdout.write(`Sign-off hooks are not installed (looked in ${file} and this project's .claude settings). Run \`linear-strict install\`.\n`);
      return 1;
    }
    process.stdout.write(`Sign-off hooks installed in ${health.files.join(', ')}.\n`);
    if (health.problems.length > 0) {
      process.stdout.write(`They can't run:\n${health.problems.map((problem) => `  - ${problem}`).join('\n')}\nRun \`linear-strict install\` again to fix them.\n`);
      return 1;
    }
    return 0;
  }
  const next = args.includes('--uninstall') ? mergeHooks(settings, {}) : mergeHooks(settings, signOffHooks(hookRunner(realpathSync(script))));
  if (JSON.stringify(next) === JSON.stringify(settings)) {
    process.stdout.write(`Nothing to change in ${file}.\n`);
    return 0;
  }
  save(file, next, now);
  process.stdout.write(`${args.includes('--uninstall') ? `Removed the sign-off hooks from ${file}.` : `Installed the sign-off hooks in ${file}.`}\n`);
  return 0;
}
