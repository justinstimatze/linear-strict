import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Undoing a mistaken automated move out of Done. A release integration can move finished tickets to
 * Verify; putting one back must not need a fresh claim, a Done when section or cited ticks, because
 * nothing is being newly claimed. The exemption is narrow: a recorded verdict from the project's
 * closer that says so, fresh, plus the ticket's live history showing that move as its latest state
 * change, and the write going back to the state it was moved out of.
 */

export interface RestoreRule {
  /** The reason text the closer's record carries when it restores a ticket instead of verifying it. */
  reason: string;
  /** The closer's record for a ticket, as JSON text, or undefined when there is none. */
  readRecord: (identifier: string) => string | undefined;
  /** How old a record may be. Defaults to thirty minutes, the close gate's own limit. */
  maxAgeMs?: number | undefined;
}

export const RESTORE_RECORD_MAX_AGE_MS = 30 * 60 * 1000;

/** The restore rule the environment asks for, or undefined when LINEAR_STRICT_RESTORE_REASON is unset. */
export function restoreRuleFromEnv(
  env: Record<string, string | undefined>,
): RestoreRule | undefined {
  const reason = env['LINEAR_STRICT_RESTORE_REASON']?.trim();
  if (!reason) return undefined;
  const dir =
    [env['LINEAR_STRICT_RESTORE_RECORDS'], env['VERIFY_CLOSER_RECORDS']].find(Boolean) ??
    path.join(homedir(), '.cache', 'verify-closer');
  return {
    reason,
    readRecord: (identifier) => {
      try {
        return readFileSync(path.join(dir, `${identifier}.json`), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/** Why the closer's record does not vouch for restoring this ticket now; '' when it does. */
export function restoreRecordProblem(rule: RestoreRule, identifier: string, now: Date): string {
  const text = rule.readRecord(identifier);
  if (text === undefined) return 'the closer left no record for it';
  let record: {
    asOf?: unknown;
    served?: { via?: unknown };
    ticket?: { id?: unknown; verdict?: unknown; evidence?: unknown; reasons?: unknown };
  };
  try {
    record = JSON.parse(text) as typeof record;
  } catch {
    return 'the closer record could not be read';
  }
  const ticket = record.ticket;
  if (ticket?.id !== identifier) return 'the closer record names another ticket';
  if (typeof record.served?.via === 'string' && record.served.via.includes('override'))
    return 'the closer record was made with a served-build override';
  if (ticket.verdict !== 'close') return 'the closer did not say close';
  const said = [ticket.evidence, ticket.reasons].some(
    (list) => Array.isArray(list) && list.includes(rule.reason),
  );
  if (!said) return 'the closer record is not a restore';
  const at = typeof record.asOf === 'string' ? Date.parse(record.asOf) : Number.NaN;
  if (Number.isNaN(at)) return 'the closer record has no time';
  const age = now.getTime() - at;
  if (age > (rule.maxAgeMs ?? RESTORE_RECORD_MAX_AGE_MS)) return 'the closer record is stale';
  if (age < -60_000) return 'the closer record is dated in the future';
  return '';
}

export interface StateMove {
  createdAt: string;
  actor: { id: string } | null;
  botActor: { type: string | null } | null;
  fromState: { id: string; type: string } | null;
  toState: { id: string; name: string; type: string } | null;
}

/**
 * The state Done-to-Verify move an integration made, when it is the ticket's latest state change;
 * undefined otherwise. Returns the state it moved the ticket out of.
 */
export function releaseMovedOutOf(moves: StateMove[]): { id: string } | undefined {
  const last = moves
    .filter((move) => move.fromState !== null || move.toState !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (
    last &&
    !last.actor &&
    last.botActor?.type === 'workflow' &&
    last.fromState?.type === 'completed' &&
    last.toState?.name === 'Verify'
  )
    return { id: last.fromState.id };
  return undefined;
}
