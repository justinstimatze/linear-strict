/**
 * Reading the Done when checklist: which unticked items a write drops or
 * rewords, what it adds in their place, and which ticks it leaves uncited.
 */
import { readSection, uncitedTicks } from './sections.js';

export const UNTICKED = /^[-*]\s+\[ \]\s+(.+)$/;
const CHECK_ITEM = /^[-*]\s+\[[ xX]\]\s+(.+)$/;
const TICKED_ITEM = /^[-*]\s+\[[xX]\]\s+(.+)$/;

export function doneWhenItems(description: string, pattern: RegExp): string[] {
  return (readSection(description, 'Done when') ?? '')
    .split('\n')
    .map((line) => pattern.exec(line.trim())?.[1])
    .filter((item): item is string => item !== undefined);
}

/**
 * Unticked Done when items in before whose text is gone from after, ticked or not. An item kept
 * word for word with a citation added after it, such as "(run 123)", is still the same check.
 */
export function droppedChecks(before: string, after: string): string[] {
  const kept = doneWhenItems(after, CHECK_ITEM);
  const survives = (item: string) =>
    kept.some(
      (line) =>
        line === item || (line.startsWith(item) && /^[\s,;:.(—-]/.test(line.slice(item.length))),
    );
  return doneWhenItems(before, UNTICKED).filter((item) => !survives(item));
}

/**
 * Done when items in after whose text is not in before: what a rewording put
 * in place of a dropped item. A ticked one says so, since that changes what
 * approving it means.
 */
export function addedChecks(before: string, after: string): string[] {
  const had = doneWhenItems(before, CHECK_ITEM);
  const isNew = (item: string) => !had.some((line) => item === line || item.startsWith(line));
  const ticked = new Set(doneWhenItems(after, TICKED_ITEM));
  return doneWhenItems(after, CHECK_ITEM)
    .filter(isNew)
    .map((item) => (ticked.has(item) ? `${item} (already ticked)` : item));
}

export const CITING =
  'Add the evidence after each item\'s text with set_state, after " · ": a commit SHA, a PR (#123), a file:line, a link, a CI run, "Observed 2" for a line already under Observed, or `command` → result. If nothing showed it, untick it.';
/**
 * Ticks a write leaves without a citation. The Done check refuses them, so
 * they are named when written, while the evidence is still at hand.
 */
export function uncitedWarning(before: string, after: string) {
  const known = new Set(uncitedTicks(before).map(({ item }) => item));
  const fresh = uncitedTicks(after).filter(({ item }) => !known.has(item));
  if (fresh.length === 0) return {};
  return {
    uncited_ticks: fresh.map(({ item, reason }) => `- [x] ${item} (${reason})`),
    cite_before_done: `Moving to Done will refuse ${fresh.length === 1 ? 'this tick' : 'these ticks'} until each cites its evidence. ${CITING}`,
  };
}

/**
 * How long descope_reason and descope_risk may be. The sign-off form shows
 * each on one line, cut at the terminal's width, about this many characters
 * in a typical pane; past it the person decides on half a sentence.
 */
export const DESCOPE_LINE = 100;

export const REWORDING =
  'To cite evidence on an item, keep its text as it is and add the citation after it. If the check you ran is not the one an item names, do not tick the item as written: reword it with a descope_reason that says what you ran instead, or leave it open.';
