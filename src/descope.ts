/**
 * The rules for dropping or rewording a Done when item, or rewording the Impact line: what a
 * descope must say before anyone is asked, and what the agent is told when sign-off is not given.
 */
import { DESCOPE_LINE, REWORDING, WAS_TICKED } from './done-when.js';
import type { ImpactChange, SignOffAnswer } from './strict-linear.js';

function checklist(dropped: string[]) {
  return dropped
    .map((item) =>
      item.endsWith(WAS_TICKED) ? `- [x] ${item.slice(0, -WAS_TICKED.length)}` : `- [ ] ${item}`,
    )
    .join('\n');
}

function impactLines(impact: ImpactChange) {
  return `  Impact today: ${impact.before}\n  Becomes: ${impact.after}`;
}

/** What the patch changes that needs sign-off, as the refusals show it. */
function changes(dropped: string[], impact: ImpactChange | undefined) {
  return [
    ...(dropped.length > 0
      ? [`This patch drops or rewords Done when items:\n${checklist(dropped)}`]
      : []),
    ...(impact ? [`This patch changes the Impact line:\n${impactLines(impact)}`] : []),
  ].join('\n\n');
}

/** A patch that drops nothing must not carry the arguments for dropping something. */
export function checkNothingDropped(reason: string | undefined, token: string | undefined) {
  const none = 'this patch drops or rewords no Done when item and changes no Impact line.';
  if (reason) throw new Error(`descope_reason was given, but ${none}`);
  if (token) throw new Error(`sign_off was given, but ${none}`);
}

/**
 * A descope goes through set_state, with a reason and a risk short enough to
 * read on one line each. Returns both trimmed; throws before anyone is asked.
 */
export function checkDescopeArgs(
  dropped: string[],
  via: string,
  reason: string | undefined,
  risk: string | undefined,
  impact?: ImpactChange,
) {
  const list = changes(dropped, impact);
  const rewording = dropped.length > 0 ? `\n\n${REWORDING}` : '';
  const what = [
    dropped.length > 0 ? 'Removing or rewording a check, passed or not,' : null,
    impact ? 'Rewording what the ticket says people will notice' : null,
  ]
    .filter(Boolean)
    .join(' and ');
  if (via !== 'set_state') {
    throw new Error(
      `${list}\n\nMake this change with set_state and a descope_reason instead, so the person at the client can approve it.${rewording}`,
    );
  }
  if (!reason?.trim()) {
    throw new Error(
      `${list}\n\n${what} needs a reason and a yes from your user. Retry with descope_reason saying why; they will be asked to approve it.${rewording}`,
    );
  }
  if (!risk?.trim()) {
    throw new Error(
      `${list}\n\nYour user decides this from what you tell them, so descope_risk is needed too: what stops being checked or promised if they approve, and what could get through because of it, in a sentence they can weigh without the ticket open. Retry with it.`,
    );
  }
  const long = [
    ['descope_reason', reason.trim()],
    ['descope_risk', risk.trim()],
  ].filter(([, text]) => (text ?? '').length > DESCOPE_LINE);
  if (long.length > 0) {
    throw new Error(
      `Nothing was asked or written: ${long.map(([name, text]) => `${name ?? ''} is ${String((text ?? '').length)} characters`).join(' and ')}. Your user sees each on one line of about ${String(DESCOPE_LINE)} characters, so say it in that: the decision, not the story. Keep the detail in Observed or in the patch itself.`,
    );
  }
  return { reason: reason.trim(), risk: risk.trim() };
}

/** What the agent is told when a descope was not approved, by outcome and by who answered. */
export function signOffRefusal(
  answer: SignOffAnswer,
  dropped: string[],
  impact?: ImpactChange,
): string {
  const { outcome, note, returned } = answer;
  const judge = answer.signer === 'judge';
  const items = dropped.length > 0;
  const needs = [items ? 'Dropping these items' : null, impact ? 'Changing the Impact line' : null]
    .filter(Boolean)
    .join(' and ');
  const shown = [
    ...(items ? [checklist(dropped)] : []),
    ...(impact ? [impactLines(impact)] : []),
  ].join('\n');
  const ask = `Nothing was written. ${needs} needs sign-off:\n${shown}`;
  if (outcome === 'pending') return `${ask}\n\n${answer.instructions ?? ''}`;
  const said = note
    ? `\n\n${judge ? `The judge (${answer.model ?? 'a model'}) wrote` : 'They wrote'}: ${note}`
    : '';
  const client = returned ? `\n\nThe client returned ${returned}.` : '';
  const them = items ? 'the items' : 'the Impact line';
  if (outcome === 'declined' && judge)
    return `The sign-off judge declined. ${ask}${said}\n\n${items ? 'Do the checks, put' : 'Put'} the evidence the judge asked for in Observed and retry, or leave ${them} for a person.`;
  if (outcome === 'declined')
    return `Your user declined. ${ask}${said}${client}\n\n${items ? 'Do the checks' : 'Keep the Impact line'}, or ask them what should change.`;
  if (outcome === 'unanswered' && judge)
    return `The sign-off judge gave no verdict (${returned ?? 'no detail'}). ${ask}\n\nRetry in a while, or leave ${them} for a person.`;
  if (outcome === 'unanswered')
    return `The approval request got no answer. ${ask}${client}\n\nThe form may still be on your user's screen, and an answer to it now reaches nothing. Tell them to dismiss it, ask whether they want to approve, and retry once they are there to answer.`;
  return `This client cannot ask your user to approve it. ${ask}\n\nAsk a person to ${items ? 'remove or reword the items' : 'reword the Impact line'} in Linear; their edit is the sign-off. Then claim again.`;
}
