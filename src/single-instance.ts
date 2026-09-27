import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Keeps one server per client connection alive. A client that reconnects a
 * stdio server by starting a new one, while it still holds the old one's
 * pipes open, leaves the old one running for as long as the client does
 * (Claude Code's `/mcp` reconnect, 2.1.283). Stdin never closes, so the usual
 * exit-on-EOF never fires.
 *
 * Each server writes its pid to a file keyed by its parent and its launch
 * command. An older server that finds a newer live one in that file, and has
 * served no tool call since the newer one started, exits. The idle condition
 * keeps a server the client is still calling alive if a client ever runs two
 * connections to the same command on purpose.
 */
export interface InstanceOptions {
  dir: string;
  /** What makes two servers the same one: the parent, the command, the credentials. */
  identity: string[];
  pid?: number;
  ppid?: number;
  /** How long the newer server must have been running with this one idle. */
  graceMs?: number;
  intervalMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  currentPpid?: () => number;
  lastCallAt: () => number;
  /** Called once when this server should go. */
  exit: (reason: string) => void;
}

export function instanceKey(identity: string[]): string {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface InstanceGuard {
  /** One check, as the timer runs it. Returns the reason when this server should exit. */
  check(): string | null;
  stop(): void;
}

export function guardInstance(options: InstanceOptions): InstanceGuard {
  const pid = options.pid ?? process.pid;
  const ppid = options.ppid ?? process.ppid;
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? alive;
  const currentPpid = options.currentPpid ?? (() => process.ppid);
  const grace = options.graceMs ?? 60_000;
  const file = path.join(options.dir, `${instanceKey([String(ppid), ...options.identity])}.pid`);

  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${String(pid)}.tmp`;
  writeFileSync(tmp, `${String(pid)}\n`, { mode: 0o600 });
  renameSync(tmp, file);

  const check = (): string | null => {
    if (currentPpid() !== ppid) return `its parent (pid ${String(ppid)}) exited`;
    let owner: number;
    let since: number;
    try {
      owner = Number(readFileSync(file, 'utf8').trim());
      since = statSync(file).mtimeMs;
    } catch {
      return null;
    }
    if (!Number.isInteger(owner) || owner === pid || !isAlive(owner)) return null;
    if (options.lastCallAt() >= since) return null;
    if (now() - since < grace) return null;
    return `a newer server (pid ${String(owner)}) replaced it for the same client`;
  };

  let done = false;
  const timer = setInterval(() => {
    const reason = check();
    if (reason && !done) {
      done = true;
      clearInterval(timer);
      options.exit(reason);
    }
  }, options.intervalMs ?? 15_000);
  timer.unref();

  return {
    check,
    stop() {
      clearInterval(timer);
      try {
        if (Number(readFileSync(file, 'utf8').trim()) === pid) rmSync(file, { force: true });
      } catch {
        // Already gone, or someone else's now.
      }
    },
  };
}
