import { isDeepStrictEqual } from 'node:util';
import { type AskQuestion, type SignOffStore, tokenIn } from './sign-off-store.js';

/** The part of a Claude Code hook's stdin these hooks read. */
export interface AskHookInput {
  tool_name?: string;
  tool_input?: {
    questions?: (Omit<AskQuestion, 'multiSelect'> & { multiSelect?: boolean })[];
    answers?: Record<string, string>;
    annotations?: Record<string, { preview?: string | undefined; notes?: string | undefined }>;
  };
  tool_response?: {
    answers?: Record<string, string>;
    annotations?: Record<string, { preview?: string | undefined; notes?: string | undefined }>;
  } | null;
}

export interface HookResult {
  stdout?: string;
  stderr?: string;
  code: number;
}

function deny(reason: string): HookResult {
  return {
    code: 0,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  };
}

/** The sign-off questions in a call, with their tokens. Other questions pass through untouched. */
function signOffQuestions(input: AskHookInput) {
  return (input.tool_input?.questions ?? []).flatMap((question) => {
    const token = typeof question.question === 'string' ? tokenIn(question.question) : null;
    return token ? [{ token, question }] : [];
  });
}

/**
 * PreToolUse on AskUserQuestion: a sign-off question is shown exactly as the
 * server issued it, or not at all, so the person approves the change the
 * server will write and not the agent's retelling of it.
 */
export function askPre(input: AskHookInput, store: SignOffStore): HookResult {
  for (const { token, question } of signOffQuestions(input)) {
    const pending = store.get(token);
    if (!pending) return deny(`linear-strict: sign-off ${token} is not pending. It was already answered, or was never issued. Retry set_state without sign_off to get a new question.`);
    const shown = { question: question.question, header: question.header, multiSelect: question.multiSelect ?? false, options: question.options };
    if (!isDeepStrictEqual(shown, pending.ask)) {
      return deny(`linear-strict: sign-off ${token} must be asked exactly as set_state issued it, with every option, description and preview unchanged. Ask again with these arguments: ${JSON.stringify({ questions: [pending.ask] })}`);
    }
  }
  return { code: 0 };
}

/**
 * PostToolUse on AskUserQuestion: records what the person picked and the
 * preview in front of them, for set_state to read on the retry. The record
 * comes from Claude Code's own report of the answer, never from the model.
 */
export function askPost(input: AskHookInput, store: SignOffStore, now: () => Date = () => new Date()): HookResult {
  const answers = input.tool_response?.answers ?? input.tool_input?.answers ?? {};
  const annotations = input.tool_response?.annotations ?? input.tool_input?.annotations ?? {};
  for (const { token, question } of signOffQuestions(input)) {
    const answer = answers[question.question];
    if (answer === undefined || !store.get(token)) continue;
    const note = annotations[question.question];
    store.record({ token, answer, notes: note?.notes, preview: note?.preview, at: now().toISOString() });
  }
  return { code: 0 };
}
