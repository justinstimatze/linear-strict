/**
 * The comment tool's rules that need no I/O: which arguments each kind takes,
 * which Open questions row it writes, and how its header and result read.
 */
import { type SectionPatch, commentKind, listQuestions, nextQuestionId } from './sections.js';
import { type IssueCore, nameOf, type Viewer } from './issue-core.js';

export const COMMENT_KINDS = ['evidence', 'correction', 'ask', 'answer', 'closed_by'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export interface CommentArgs {
  kind: CommentKind;
  body: string;
  patch?: SectionPatch[] | undefined;
  answers?: string | undefined;
  ask_to?: string | undefined;
  closed_by?: string | undefined;
  relation?: 'duplicate' | 'fixed_there' | undefined;
  author_label?: string | undefined;
  /** description_sha of the description a patch was written against. */
  base?: string | undefined;
}

export type Mention = { url: string } | { unresolved: string };

/** A comment with every check passed and its text composed, ready to post. */
export interface CommentDraft {
  issue: IssueCore;
  args: CommentArgs;
  patch: SectionPatch[];
  /** The description with the patch applied. */
  description: string;
  date: string;
  label: string;
  text: string;
}

/** Refuses argument combinations the kind doesn't allow, before anything is read. */
export function checkCommentArgs(args: CommentArgs, patch: SectionPatch[]) {
  if (!COMMENT_KINDS.includes(args.kind))
    throw new Error(`kind must be one of ${COMMENT_KINDS.join(', ')}`);
  if (typeof args.body !== 'string' || args.body.trim() === '') throw new Error('body is empty');
  if (args.kind === 'correction' && patch.length === 0) {
    throw new Error(
      'A correction must carry a description patch in the same call, so the description says the corrected thing and the thread cannot contradict it.',
    );
  }
  if (args.kind === 'answer' && !args.answers) {
    throw new Error('An answer must name the Open questions row it closes (answers: "Q3")');
  }
  if (args.kind !== 'answer' && args.answers)
    throw new Error('answers is only valid with kind "answer"');
  if (args.kind !== 'ask' && args.ask_to) throw new Error('ask_to is only valid with kind "ask"');
  const closing = args.kind === 'closed_by';
  if (closing && !(args.closed_by && args.relation)) {
    throw new Error(
      'closed_by needs closed_by (the ticket that carried the work) and relation ("duplicate" or "fixed_there")',
    );
  }
  if (!closing && (args.closed_by || args.relation)) {
    throw new Error('closed_by and relation are only valid with kind "closed_by"');
  }
}

/** The Open questions row this comment writes: a new one for an ask, the named open one for an answer. */
export function questionFor(args: CommentArgs, description: string): string | null {
  if (args.kind === 'ask') return nextQuestionId(description);
  const answering = args.answers;
  if (!answering) return null;
  const row = listQuestions(description).find((candidate) => candidate.id === answering);
  if (!row) throw new Error(`No question ${answering} under Open questions`);
  if (!row.open) throw new Error(`${answering} is already answered: ${row.line}`);
  return answering;
}

// An app identity is the agent, so its own name is the author. A user
// token means an agent posting as a person; say so, so the thread never
// reads as the person having typed it.
export function commentLabel(args: CommentArgs, viewer: Viewer) {
  const agentName =
    cleanAuthorLabel(args.author_label ?? '') || (viewer.app ? nameOf(viewer) : 'agent');
  return viewer.app ? agentName : `${agentName} via ${nameOf(viewer)}`;
}

const DATE_PART = /^\d{4}-\d{2}-\d{2}$/;
const KIND_PART = /^(evidence|correction|ask|answer|closed_by|descope)\b/;

// An agent told to write the header sometimes passes a whole one as its label.
// Keep the name: drop the robot, the date and the kind, which the header adds itself.
function cleanAuthorLabel(label: string) {
  const [name = '', ...rest] = label.split(' · ').map((part) => part.trim());
  const kept = rest.filter((part) => !DATE_PART.test(part) && !KIND_PART.test(part));
  return [name.replace(/^(🤖\s*)+/u, ''), ...kept].filter((part) => part !== '').join(' · ');
}

const PATCH_NOTE_LINE = /^Description updated: .*$/;

/**
 * The body as posted under the server's header. Agents are often told to open a
 * comment with that header, so the body can arrive with its own copy, sometimes
 * of another kind; the header built from `kind` is the one whose rules were
 * checked, so a copy in the body is dropped. With a patch, a hand-typed
 * "Description updated" line is dropped too, since the server writes its own.
 */
export function commentBody(body: string, patched: boolean) {
  const lines = body.trim().split('\n');
  while (lines.length > 0 && commentKind(lines[0] ?? '') !== null) {
    lines.shift();
    while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();
  }
  if (patched) {
    while (lines.length > 0 && PATCH_NOTE_LINE.test(lines.at(-1)?.trim() ?? '')) {
      lines.pop();
      while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
    }
  }
  return lines.join('\n').trim();
}

export function patchSummary(patch: SectionPatch[]) {
  return patch.map((p) => `${p.section} (${p.mode})`);
}

export function mentionResult(mention: Mention | null, askTo: string | undefined) {
  if (!mention) return {};
  if ('url' in mention) return { ask_to_mentioned: true };
  return {
    ask_to_mentioned: false,
    ask_to_note: `${askTo ?? ''} was written as text and not notified: ${mention.unresolved}`,
  };
}
