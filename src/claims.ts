import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultStateDir } from './sign-off-store.js';

/**
 * What the claimant read when they took the ticket. `description` is the full
 * text as Linear returned it, so a later check can show exactly what changed
 * rather than only that something did.
 */
export interface ClaimRecord {
  issueId: string;
  identifier: string;
  claimedAt: string;
  claimedBy: { id: string; name: string };
  /** The issue's updatedAt at claim. Moves on any change, so it is kept for reference, not compared. */
  updatedAt: string;
  description: string;
}

export interface ClaimStore {
  get(issueId: string, userId: string): ClaimRecord | null;
  put(record: ClaimRecord): void;
  delete(issueId: string, userId: string): void;
}

function key(issueId: string, userId: string) {
  return `${userId}:${issueId}`;
}

export function memoryClaimStore(): ClaimStore {
  const records = new Map<string, ClaimRecord>();
  return {
    get: (issueId, userId) => records.get(key(issueId, userId)) ?? null,
    put: (record) => void records.set(key(record.issueId, record.claimedBy.id), record),
    delete: (issueId, userId) => void records.delete(key(issueId, userId)),
  };
}

/**
 * Claims live on the machine running the server, one JSON file keyed by
 * user and issue. The claimant is the one who later asks "did this change
 * under me", so local state is enough; a claim made on another machine is
 * reported as missing rather than guessed at.
 */
export function defaultClaimsPath(): string {
  return path.join(defaultStateDir(), 'claims.json');
}

export function fileClaimStore(file = defaultClaimsPath()): ClaimStore {
  const load = (): Record<string, ClaimRecord> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, ClaimRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`Claims file ${file} is unreadable: ${(error as Error).message}`, {
        cause: error,
      });
    }
  };
  const save = (records: Record<string, ClaimRecord>) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };

  return {
    get: (issueId, userId) => load()[key(issueId, userId)] ?? null,
    put: (record) => {
      const records = load();
      records[key(record.issueId, record.claimedBy.id)] = record;
      save(records);
    },
    delete: (issueId, userId) => {
      const target = key(issueId, userId);
      save(
        Object.fromEntries(Object.entries(load()).filter(([candidate]) => candidate !== target)),
      );
    },
  };
}
