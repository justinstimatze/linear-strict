/**
 * The rules for dropping an unticked Done when item: what a descope must say
 * before anyone is asked, and what the agent is told when sign-off is not given.
 */
import { DESCOPE_LINE, REWORDING } from './done-when.js';
import type { SignOffAnswer } from './strict-linear.js';

function checklist(dropped: string[]) {
  return dropped.map((item) => `- [ ] ${item}`).join('\n');
}

/** A patch that drops nothing must not carry the arguments for dropping something. */
export function checkNothingDropped(reason: string | undefined, token: string | undefined) {
  if (reason)
    throw new Error('descope_reason was given, but this patch drops no unticked Done when item.');
  if (token)
    throw new Error('sign_off was given, but this patch drops no unticked Done when item.');
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
) {
  const list = checklist(dropped);
  if (via !== 'set_state') {
    throw new Error(
      `This patch drops unticked Done when items:\n${list}\n\nDrop or reword them with set_state and a descope_reason instead, so the person at the client can approve it.\n\n${REWORDING}`,
    );
  }
  if (!reason?.trim()) {
    throw new Error(
      `This patch drops unticked Done when items:\n${list}\n\nRemoving or rewording a check that has not passed needs a reason and a yes from your user. Retry with descope_reason saying why it no longer applies; they will be asked to approve it.\n\n${REWORDING}`,
    );
  }
  if (!risk?.trim()) {
    throw new Error(
      `This patch drops unticked Done when items:\n${list}\n\nYour user decides this from what you tell them, so descope_risk is needed too: what stops being checked if they approve, and what could get through because of it, in a sentence they can weigh without the ticket open. Retry with it.`,
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
export function signOffRefusal(answer: SignOffAnswer, dropped: string[]): string {
  const { outcome, note, returned } = answer;
  const judge = answer.signer === 'judge';
  const ask = `Nothing was written. Dropping these items needs sign-off:\n${checklist(dropped)}`;
  if (outcome === 'pending') return `${ask}\n\n${answer.instructions ?? ''}`;
  const said = note
    ? `\n\n${judge ? `The judge (${answer.model ?? 'a model'}) wrote` : 'They wrote'}: ${note}`
    : '';
  const client = returned ? `\n\nThe client returned ${returned}.` : '';
  if (outcome === 'declined' && judge)
    return `The sign-off judge declined. ${ask}${said}\n\nDo the checks, put the evidence the judge asked for in Observed and retry, or leave the items for a person.`;
  if (outcome === 'declined')
    return `Your user declined. ${ask}${said}${client}\n\nDo the checks, or ask them what should change.`;
  if (outcome === 'unanswered' && judge)
    return `The sign-off judge gave no verdict (${returned ?? 'no detail'}). ${ask}\n\nRetry in a while, or leave the items for a person.`;
  if (outcome === 'unanswered')
    return `The approval request got no answer. ${ask}${client}\n\nThe form may still be on your user's screen, and an answer to it now reaches nothing. Tell them to dismiss it, ask whether they want to approve, and retry once they are there to answer.`;
  return `This client cannot ask your user to approve it. ${ask}\n\nAsk a person to remove or reword the items in Linear; their edit is the sign-off. Then claim again.`;
}
