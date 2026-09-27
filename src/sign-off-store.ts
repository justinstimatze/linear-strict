import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Where this server keeps state on the machine it runs on: claims and sign-offs. */
export function defaultStateDir(): string {
  const stateDir = process.env['LINEAR_STRICT_STATE_DIR'];
  if (stateDir) return stateDir;
  const stateHome = process.env['XDG_STATE_HOME'] || path.join(homedir(), '.local', 'state');
  return path.join(stateHome, 'linear-strict');
}

export function defaultSignOffDir(): string {
  return path.join(defaultStateDir(), 'sign-offs');
}

/** One AskUserQuestion question, as the tool takes it. */
export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string; preview?: string }[];
}

/** A sign-off the server has asked for and not yet seen answered. */
export interface PendingSignOff {
  token: string;
  identifier: string;
  /** A hash of the change asked about, so the answer only approves that change. */
  binding: string;
  ask: AskQuestion;
  created: string;
}

/** What the person picked, as the PostToolUse hook saw it. */
export interface RecordedAnswer {
  token: string;
  /** The option label, or the text typed under Other. */
  answer: string;
  notes?: string | undefined;
  /** The preview the person had in front of them when they answered. */
  preview?: string | undefined;
  at: string;
}

export interface SignOffStore {
  put(pending: PendingSignOff): void;
  get(token: string): PendingSignOff | null;
  record(answer: RecordedAnswer): void;
  answer(token: string): RecordedAnswer | null;
  delete(token: string): void;
}

const TOKEN = /^[0-9a-f]{12}$/;

export function newToken(): string {
  return randomBytes(6).toString('hex');
}

/** The token a sign-off question carries at the end of its text. */
export function tokenIn(question: string): string | null {
  return /\(sign-off ([0-9a-f]{12})\)$/.exec(question)?.[1] ?? null;
}

/**
 * Pending sign-offs and their answers, one small file each. The server
 * writes the pending one, the PostToolUse hook writes the answer, and the
 * server reads and deletes both when the agent retries.
 */
export function fileSignOffStore(dir = defaultSignOffDir()): SignOffStore {
  const file = (token: string, kind: 'pending' | 'answer') => {
    if (!TOKEN.test(token)) throw new Error(`Not a sign-off token: ${token}`);
    return path.join(dir, `${token}.${kind}.json`);
  };
  const read = (target: string): unknown => {
    try {
      return JSON.parse(readFileSync(target, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Sign-off file ${target} is unreadable: ${(error as Error).message}`, {
        cause: error,
      });
    }
  };
  const write = (target: string, value: unknown) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${target}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, target);
  };
  return {
    put: (pending) => {
      write(file(pending.token, 'pending'), pending);
    },
    get: (token) =>
      TOKEN.test(token) ? (read(file(token, 'pending')) as PendingSignOff | null) : null,
    record: (answer) => {
      write(file(answer.token, 'answer'), answer);
    },
    answer: (token) =>
      TOKEN.test(token) ? (read(file(token, 'answer')) as RecordedAnswer | null) : null,
    delete: (token) => {
      rmSync(file(token, 'pending'), { force: true });
      rmSync(file(token, 'answer'), { force: true });
    },
  };
}

export function memorySignOffStore(): SignOffStore {
  const pending = new Map<string, PendingSignOff>();
  const answers = new Map<string, RecordedAnswer>();
  return {
    put: (record) => {
      pending.set(record.token, record);
    },
    get: (token) => pending.get(token) ?? null,
    record: (answer) => {
      answers.set(answer.token, answer);
    },
    answer: (token) => answers.get(token) ?? null,
    delete: (token) => {
      pending.delete(token);
      answers.delete(token);
    },
  };
}
