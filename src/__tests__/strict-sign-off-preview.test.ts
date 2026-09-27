import { askPost, askPre } from '../hook.js';
import { ACCEPT, DECLINE, previewSignOff, previewText } from '../sign-off.js';
import { type AskQuestion, memorySignOffStore, tokenIn } from '../sign-off-store.js';
import type { SignOffRequest } from '../strict-linear.js';

const REQUEST: SignOffRequest = {
  identifier: 'ENG-1',
  title: 'Sign-in drops the session',
  dropped: ['the same test fails against develop, proving it goes red for this defect'],
  added: ['the same test fails against a preview built with the fix removed, proving it goes red for this defect'],
  reason: 'develop lacks the test switch',
  risk: 'only the preview proves it; nothing reruns it',
  description: '## Done when\n\n- [ ] the same test fails against develop, proving it goes red for this defect',
};

/** Issues a question and returns it, as the agent would read it from the refusal. */
async function issue(store = memorySignOffStore()) {
  const signOff = previewSignOff(store, () => new Date('2026-09-26T00:00:00Z'));
  const first = await signOff(REQUEST);
  expect(first.outcome).toBe('pending');
  const json = /\{"questions":.*\}/.exec(first.instructions ?? '')?.[0] ?? '';
  const ask = (JSON.parse(json) as { questions: AskQuestion[] }).questions[0];
  if (!ask) throw new Error('no question issued');
  const token = tokenIn(ask.question) ?? '';
  expect(first.instructions).toContain(`sign_off: "${token}"`);
  return { store, signOff, ask, token };
}

/** Claude Code's PostToolUse payload after the person picks `answer` on `ask`. */
function answered(ask: AskQuestion, answer: string, notes?: string) {
  const preview = ask.options.find((option) => option.label === answer)?.preview;
  return { tool_input: { questions: [ask], answers: { [ask.question]: answer }, annotations: { [ask.question]: { preview, notes } } } };
}

describe('the sign-off preview', () => {
  it('labels each part and wraps it, so nothing depends on the width of a row', () => {
    const text = previewText(REQUEST);
    expect(text).toMatch(/^Ticket\n {2}Sign-in drops the session\n\nCheck today\n {2}the same test/);
    expect(text).toContain('If you accept\n  only the preview proves it; nothing reruns it');
    expect(Math.max(...text.split('\n').map((line) => line.length))).toBeLessThanOrEqual(62);
  });
});

describe('sign-off through AskUserQuestion and its hooks', () => {
  it('approves on Accept once the hook has recorded it, and only once', async () => {
    const { store, signOff, ask, token } = await issue();
    expect(askPre({ tool_input: { questions: [ask] } }, store)).toEqual({ code: 0 });
    askPost(answered(ask, ACCEPT, 'fine'), store);
    await expect(signOff({ ...REQUEST, token })).resolves.toEqual({ outcome: 'approved', note: 'fine', signer: 'person' });
    const again = await signOff({ ...REQUEST, token });
    expect(again).toMatchObject({ outcome: 'pending', instructions: expect.stringMatching(/already used/) as string });
  });

  it('refuses to show a question whose text was changed', async () => {
    const { store, ask } = await issue();
    const softened = { ...ask, options: ask.options.map((option) => (option.label === ACCEPT ? { ...option, preview: 'A small wording fix.' } : option)) };
    const result = askPre({ tool_input: { questions: [softened] } }, store);
    expect(JSON.parse(result.stdout ?? '{}')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(askPre({ tool_input: { questions: [{ ...ask, question: ask.question.replace(/[0-9a-f]{12}/, 'ffffffffffff') }] } }, store).stdout).toMatch(/not pending/);
  });

  it('lets other questions through untouched', () => {
    const store = memorySignOffStore();
    const other: AskQuestion = { question: 'Which parser?', header: 'Parser', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] };
    expect(askPre({ tool_input: { questions: [other] } }, store)).toEqual({ code: 0 });
    expect(askPost({ tool_input: { questions: [other], answers: { 'Which parser?': 'A' } } }, store)).toEqual({ code: 0 });
  });

  it('says so when no answer is recorded, and declines on Decline or on what was typed under Other', async () => {
    const pending = await issue();
    await expect(pending.signOff({ ...REQUEST, token: pending.token })).resolves.toMatchObject({
      outcome: 'pending',
      instructions: expect.stringMatching(/No answer is recorded[\s\S]*linear-strict install/) as string,
    });

    askPost(answered(pending.ask, DECLINE, 'keep develop'), pending.store);
    await expect(pending.signOff({ ...REQUEST, token: pending.token })).resolves.toMatchObject({ outcome: 'declined', note: 'keep develop' });

    const other = await issue();
    askPost({ tool_input: { questions: [other.ask], answers: { [other.ask.question]: 'only if CI reruns it' } } }, other.store);
    await expect(other.signOff({ ...REQUEST, token: other.token })).resolves.toMatchObject({ outcome: 'declined', note: 'only if CI reruns it' });
  });

  it('does not let an answer approve a different change', async () => {
    const { store, signOff, ask, token } = await issue();
    askPost(answered(ask, ACCEPT), store);
    const swapped = await signOff({ ...REQUEST, risk: 'none', token });
    expect(swapped).toMatchObject({ outcome: 'pending', instructions: expect.stringMatching(/doesn't match this change/) as string });
  });
});
