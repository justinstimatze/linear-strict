import { createHash } from 'node:crypto';
import type {
  ClientCapabilities,
  ElicitRequestFormParams,
  ElicitResult,
  Implementation,
} from '@modelcontextprotocol/sdk/types.js';
import { type AskQuestion, type SignOffStore, newToken } from './sign-off-store.js';
import type { SignOffAnswer, SignOffRequest } from './strict-linear.js';

/** The calls sign-off needs from the MCP server that owns the connection. */
export interface Elicitor {
  getClientCapabilities(): ClientCapabilities | undefined;
  getClientVersion?(): Implementation | undefined;
  elicitInput(
    params: ElicitRequestFormParams,
    options?: { timeout?: number },
  ): Promise<ElicitResult>;
}

/**
 * How long the server waits for an answer. Claude Code leaves the form on
 * screen after the server stops waiting, and an Accept pressed then reaches
 * nothing, so this is set for someone who reads the rows and asks about them
 * before answering, not for a glance.
 */
const ANSWER_WAIT_MS = 30 * 60 * 1000;

/**
 * The longest line a row's description gets. Claude Code shows a field's
 * description on one line and cuts it at about a hundred characters, so
 * anything longer continues on the next row.
 */
export const ROW_WIDTH = 90;

/**
 * Text broken at spaces into as few lines of at most `width` characters as
 * it needs, with the lines about equal in length, so a continuation row
 * never holds one stranded word. A word longer than `width` gets a line to itself.
 */
export function wrap(text: string, width = ROW_WIDTH): string[] {
  const needed = greedy(text, width).length;
  for (let narrower = Math.ceil(text.length / needed); narrower < width; narrower += 1) {
    const lines = greedy(text, narrower);
    if (lines.length === needed) return lines;
  }
  return greedy(text, width);
}

function greedy(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

/** A row of the form: a short title that survives the client's cut, and one line of text under it. */
export interface Row {
  title: string;
  text: string;
}

const CONTINUED = '↳';

/**
 * The form's rows. Claude Code cuts a field's title at about fifty columns
 * and a description at about a hundred, so every title is a fixed label and
 * the substance goes in the descriptions, wrapped onto continuation rows:
 * the ticket, each check in full and what replaces it, then why the agent
 * wants it and what approving gives up, then room for the person to answer.
 */
export function signOffRows(
  request: Pick<SignOffRequest, 'title' | 'dropped' | 'added' | 'reason' | 'risk'>,
): Row[] {
  const rows: Row[] = [];
  const push = (title: string, text: string) => {
    wrap(text).forEach((line, index) =>
      rows.push({ title: index === 0 ? title : CONTINUED, text: line }),
    );
  };
  push('Ticket', request.title);
  const count = Math.max(request.dropped.length, request.added.length);
  const numbered = (label: string, index: number) =>
    count > 1 ? `${label} ${String(index + 1)}` : label;
  for (let index = 0; index < count; index += 1) {
    const dropped = request.dropped[index];
    const added = request.added[index];
    if (dropped !== undefined && added !== undefined) {
      push(numbered('Check today', index), dropped);
      push('Becomes', added);
    } else if (dropped !== undefined) {
      push(numbered('Check today', index), dropped);
      push('Becomes', 'nothing: this check is removed');
    } else if (added !== undefined) {
      push(numbered('New check', index), added);
    }
  }
  push('Why the agent wants it', request.reason);
  push('If you accept', request.risk);
  push(
    'Your note (optional)',
    'Write what should change instead and press Decline, or leave a note with an approval.',
  );
  return rows;
}

/** How wide the preview's text runs: Claude Code shows it in a box beside the options. */
const PREVIEW_WIDTH = 60;

/** The change as one block of labelled, wrapped text, for AskUserQuestion's preview box. */
export function previewText(
  request: Pick<SignOffRequest, 'title' | 'dropped' | 'added' | 'reason' | 'risk'>,
): string {
  const blocks: string[] = [];
  const block = (label: string, text: string) =>
    blocks.push([label, ...wrap(text, PREVIEW_WIDTH).map((line) => `  ${line}`)].join('\n'));
  block('Ticket', request.title);
  const count = Math.max(request.dropped.length, request.added.length);
  const numbered = (label: string, index: number) =>
    count > 1 ? `${label} ${String(index + 1)}` : label;
  for (let index = 0; index < count; index += 1) {
    const dropped = request.dropped[index];
    const added = request.added[index];
    if (dropped !== undefined) block(numbered('Check today', index), dropped);
    if (dropped !== undefined) block('Becomes', added ?? 'nothing: this check is removed');
    else if (added !== undefined) block(numbered('New check', index), added);
  }
  block('Why the agent wants it', request.reason);
  block('If you accept', request.risk);
  return blocks.join('\n\n');
}

export const ACCEPT = 'Accept';
export const DECLINE = 'Decline';

/** The question a sign-off asks, with its token at the end so the hooks can find it. */
export function signOffQuestion(request: SignOffRequest, token: string): AskQuestion {
  const kept = request.dropped
    .map((item) =>
      wrap(item, PREVIEW_WIDTH)
        .map((line) => `  ${line}`)
        .join('\n'),
    )
    .join('\n\n');
  return {
    question: `${request.identifier}: approve this Done when change? (sign-off ${token})`,
    header: 'Sign-off',
    multiSelect: false,
    options: [
      {
        label: ACCEPT,
        description: 'Approve the change exactly as shown.',
        preview: previewText(request),
      },
      {
        label: DECLINE,
        description: 'Keep the check. Or choose Other and say what should change instead.',
        preview: `Nothing is written. The check stays:\n\n${kept}`,
      },
    ],
  };
}

/** A hash of what is being approved, so an answer can't be carried over to a different change. */
function bindingOf(request: SignOffRequest) {
  const { identifier, dropped, added, reason, risk } = request;
  return createHash('sha256')
    .update(JSON.stringify({ identifier, dropped, added, reason, risk }))
    .digest('hex');
}

function askInstructions(ask: AskQuestion, token: string) {
  return [
    'Your user approves this through a question. Call AskUserQuestion with exactly these arguments; the linear-strict hook refuses the question if any of its text is changed:',
    JSON.stringify({ questions: [ask] }),
    `Then retry this same set_state, unchanged, with sign_off: "${token}".`,
  ].join('\n\n');
}

/**
 * Sign-off through Claude Code's AskUserQuestion, which shows the change in
 * a multi-line preview instead of the elicitation form's one-line rows. The
 * model asks the question, so the answer must not come from the model: the
 * server issues the question with a token, a PreToolUse hook refuses the
 * question unless it is shown exactly as issued, a PostToolUse hook records
 * what the person picked, and the retry is approved from that record only.
 */
export function previewSignOff(store: SignOffStore, now: () => Date = () => new Date()) {
  return (request: SignOffRequest): Promise<SignOffAnswer> => {
    const binding = bindingOf(request);
    const issue = (lead: string): SignOffAnswer => {
      const token = newToken();
      const ask = signOffQuestion(request, token);
      store.put({
        token,
        identifier: request.identifier,
        binding,
        ask,
        created: now().toISOString(),
      });
      return { outcome: 'pending', instructions: `${lead}${askInstructions(ask, token)}` };
    };
    const token = request.token;
    if (!token) return Promise.resolve(issue(''));
    const pending = store.get(token);
    if (pending?.binding !== binding) {
      return Promise.resolve(
        issue(
          `sign_off ${token} doesn't match this change: it was issued for a different patch, reason or risk, or it was already used. A new question is issued below.\n\n`,
        ),
      );
    }
    const answer = store.answer(token);
    const accepted = pending.ask.options.find((option) => option.label === ACCEPT)?.preview;
    if (!answer) {
      return Promise.resolve({
        outcome: 'pending',
        instructions: `No answer is recorded for sign-off ${token}. If you haven't asked yet, ask now. ${askInstructions(pending.ask, token)}\n\nIf you asked and your user answered, the linear-strict hooks are not installed where this session runs: tell them to run \`linear-strict install\` and restart the session.`,
      });
    }
    store.delete(token);
    const note = answer.notes?.trim() || undefined;
    if (answer.answer === ACCEPT && answer.preview === accepted)
      return Promise.resolve({ outcome: 'approved', note, signer: 'person' });
    if (answer.answer === ACCEPT) {
      return Promise.resolve({
        outcome: 'declined',
        note,
        returned: 'Accept, but the recorded preview differs from the one issued',
      });
    }
    const wrote =
      answer.answer === DECLINE ? note : [answer.answer, note].filter(Boolean).join(' — ');
    return Promise.resolve({
      outcome: 'declined',
      note: wrote,
      returned: `answer ${answer.answer === DECLINE ? DECLINE : 'Other'}`,
    });
  };
}

/** What the client sent back, as field names and types only, for the agent to read on a refusal. */
function shapeOf(result: ElicitResult): string {
  const content = result.content ?? {};
  const fields = Object.entries(content).map(([key, value]) => `${key}: ${typeof value}`);
  return `action=${result.action}${fields.length > 0 ? `, content {${fields.join(', ')}}` : ', no content'}`;
}

/**
 * Sign-off through MCP elicitation: the client shows the person the change
 * directly, so the model relaying the request cannot answer it for them.
 * Accept approves the change as shown; there is nothing to tick first, since
 * a required checkbox under an Accept button reads as approval when left
 * unticked. Every row is an optional text field, so the person can say what
 * should differ instead of only yes or no.
 */
export function elicitSignOff(getServer: () => Elicitor | undefined) {
  return async (request: SignOffRequest): Promise<SignOffAnswer> => {
    const server = getServer();
    if (!server?.getClientCapabilities()?.elicitation) return { outcome: 'unavailable' };
    // Claude Code shows only the first line of the message, cut at the
    // terminal's width, so it says what is being asked and how to read it;
    // the substance is in the rows.
    const count = request.dropped.length;
    const message = `${request.identifier}: the agent wants to change ${count === 1 ? 'a Done when check' : `${String(count)} Done when checks`}. Read each row (↓), then Accept or Decline.`;
    const fields = signOffRows(request).map(
      (row, index) => [`row_${String(index + 1)}`, row] as const,
    );
    try {
      const result = await server.elicitInput(
        {
          mode: 'form',
          message,
          requestedSchema: {
            type: 'object',
            properties: Object.fromEntries(
              fields.map(([key, row]) => [
                key,
                { type: 'string', title: row.title, description: row.text },
              ]),
            ),
          },
        },
        { timeout: ANSWER_WAIT_MS },
      );
      const note = Object.values(result.content ?? {})
        .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
        .map((value) => value.trim())
        .join('\n');
      const said = note ? { note } : {};
      if (result.action === 'accept') return { outcome: 'approved', signer: 'person', ...said };
      return {
        outcome: result.action === 'decline' ? 'declined' : 'unanswered',
        returned: shapeOf(result),
        ...said,
      };
    } catch (error) {
      return {
        outcome: 'unanswered',
        returned: `error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}
