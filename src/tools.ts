import type { FieldChanges } from './fields.js';
import type { SectionPatch } from './sections.js';
import { IMPACT, PATCHABLE_SECTIONS } from './sections.js';
import { type Accounting, COMMENT_KINDS, type CommentKind, type StrictLinear } from './strict-linear.js';
import { CYCLE_WHEN, type CycleWhen } from './workspace.js';

/**
 * MCP tool behavior hints. All four are required so every tool ships an
 * explicit classification; clients use them to auto-allow reads and gate writes.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  output_schema: {
    type: string;
    properties?: Record<string, unknown>;
    items?: unknown;
  };
  annotations: ToolAnnotations;
  /** Passed through as the tool's `_meta`, e.g. `anthropic/maxResultSizeChars`. */
  meta?: Record<string, unknown>;
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// destructiveHint follows the MCP spec: true when a call can overwrite what is there,
// not only delete it. A section patch in replace mode, a state move and a claim all can.
const ADDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const OVERWRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const OVERWRITES_IDEMPOTENT: ToolAnnotations = { ...OVERWRITES, idempotentHint: true };
const ANY_OBJECT = { type: 'object' };

/** Top-level shape of a result, with what each field means; nested shapes stay open. */
function shape(fields: Record<string, [type: string | string[], description: string]>) {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(fields).map(([name, [type, description]]) => [name, { type, description }]),
    ),
  };
}

const PAGE_FIELDS = {
  has_more: ['boolean', 'True when more results exist; pass next_cursor as after'],
  next_cursor: [['string', 'null'], 'Cursor for the next page'],
  order: ['string', 'How results are ordered'],
  note: ['string', 'How to use these results'],
} satisfies Record<string, [string | string[], string]>;

const GET_ISSUE_OUTPUT = shape({
  issue: ['object', 'Full description and fields, description_sha (pass it as base when you patch the description), and open_questions parsed from the description'],
  comments: ['array', 'Every comment, oldest first, each with author_kind (agent or person) and its basis'],
  comment_order: ['string', 'Always oldest first'],
  description_edits: ['array', 'Who changed the description and when, oldest first'],
  relations: ['array', 'Blocks, duplicates and related tickets, both directions'],
  children: ['array', 'Sub-issues'],
  pull_requests: ['array', 'Linked GitHub PRs with status, target branch and merge time'],
  attachments: ['array', 'Other attachments'],
  claim: [['object', 'null'], "Your claim on this ticket and whether the description changed since"],
  findings: ['array', 'Format and shipped-state problems to fix with set_state'],
  drift: ['object', 'Comments after the reconciled marker, needs_reconcile and next_step'],
  omitted: ['array', 'Anything not fetched, with the reason; empty means nothing was left out'],
});

const LIST_ISSUES_OUTPUT = shape({
  total: ['integer', 'How many tickets match; rows holds every one of them'],
  complete: ['boolean', 'Always true: a partial set is refused, never returned'],
  by_state: ['object', 'Count of matching tickets per workflow state'],
  columns: ['array', 'Names of the values in each row, in order'],
  rows: ['array', 'One array per ticket: identifier, title, state, assignee, delegate, updatedAt; no descriptions'],
});

const NOTIFICATIONS_OUTPUT = shape({
  notifications: ['array', 'Pointers: id, type, time, read, actor, actor_kind and the ticket'],
  unread_count: ['integer', "Linear's unread count"],
  stopped_early: ['string', 'Present when a later page failed; next_cursor resumes there'],
  ...PAGE_FIELDS,
});

const ISSUE_ARG = { type: 'string', description: 'Issue identifier (e.g. ENG-123) or UUID' };

const PATCH_SCHEMA = {
  type: 'array',
  description:
    'Description sections to change. Impact is the one plain-language line at the top saying who notices this work (mode replace). Observed lines must be "YYYY-MM-DD · <source: command, SHA or query> · <what it showed>". Done when lines must be checklist items ("- [ ] <check that proves it>"). Open questions changes only through comment kinds ask and answer.',
  items: {
    type: 'object',
    properties: {
      section: { type: 'string', enum: [IMPACT, ...PATCHABLE_SECTIONS] },
      mode: { type: 'string', enum: ['replace', 'append'] },
      body: { type: 'string' },
    },
    required: ['section', 'mode', 'body'],
  },
};

const BASE_ARG = {
  type: 'string',
  description:
    'description_sha of the description this patch was written against: from get_issue, or from your last write to this ticket. The write is refused, with what changed, if the description has moved since.',
};

export const strictToolDefinitions: MCPToolDefinition[] = [
  {
    name: 'get_issue',
    description:
      'Read one ticket whole: full description, every comment oldest-first (all pages), who edited the description and when, relations, children, attachments. `omitted` lists anything not returned; an empty list means nothing was left out. `findings` lists format problems in the description and `drift.unreconciled_comments` lists comments the description may not reflect yet, and `drift.edited_after_reconcile` comments edited after it accounted for them. When drift.needs_reconcile is true, fold what those comments establish into the description with set_state (reconciled_through = newest comment id) before acting on the ticket. Tickets written from other clients get repaired this way. Pass issue.description_sha as base to the write that patches the description.',
    input_schema: { type: 'object', properties: { issue: ISSUE_ARG }, required: ['issue'] },
    output_schema: GET_ISSUE_OUTPUT,
    annotations: READ,
    // A whole ticket can pass Claude Code's default 25k-token cutoff, above which the result goes to a
    // file. Raising the limit keeps it in context instead of truncating anything.
    meta: { 'anthropic/maxResultSizeChars': 200_000 },
  },
  {
    name: 'description_history',
    description:
      "The description's past versions, from the snapshots Linear saves as it is edited: when, by whom, and a line diff against the version before. `current` says whether the live description is in a version yet, with a diff if not. With blame, every line of the current description names the version that introduced it and who made that version. Use it to see when and by whom a section or tick changed before overwriting or disputing it.",
    input_schema: {
      type: 'object',
      properties: {
        issue: ISSUE_ARG,
        blame: { type: 'boolean', description: 'Also attribute each current line to the version that introduced it' },
      },
      required: ['issue'],
    },
    output_schema: ANY_OBJECT,
    annotations: READ,
    meta: { 'anthropic/maxResultSizeChars': 200_000 },
  },
  {
    name: 'list_issues',
    description:
      'Every ticket matching the filters, in one call: the server pages through Linear to the end, so the answer is the whole set (total, by_state, and one row per ticket under columns). Rows hold identifier, title, state, assignee, delegate and updatedAt; there are no description excerpts, so read a ticket with get_issue before acting on it. More than 2000 matches is refused; narrow with open, state, cycle, project, assignee_is_me or delegate_is_me. When a task covers a set, work every row.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Full-text search term. Omit to list by most recently updated.' },
        team: { type: 'string', description: 'Team key, e.g. ENG' },
        state: { type: 'string', description: 'Workflow state name, e.g. "In Progress"' },
        assignee_is_me: { type: 'boolean' },
        delegate_is_me: { type: 'boolean' },
        cycle: { type: 'integer', minimum: 1, description: 'Cycle number within team (list_cycles gives them); needs team' },
        project: { type: 'string', description: 'Project name or id' },
        open: { type: 'boolean', description: 'Only tickets not in a completed or canceled state' },
      },
    },
    output_schema: LIST_ISSUES_OUTPUT,
    annotations: READ,
    // 2000 rows run to about 260,000 characters.
    meta: { 'anthropic/maxResultSizeChars': 400_000 },
  },
  {
    name: 'whoami',
    description:
      'Who this server acts as: the Linear user or app behind the token. Claims, assignee_is_me and delegate_is_me all mean this identity.',
    input_schema: { type: 'object', properties: {} },
    output_schema: shape({
      id: ['string', 'Linear user id'],
      name: ['string', 'User name'],
      displayName: ['string', 'Display name'],
      app: ['boolean', 'True for an app (agent) identity, false for a person'],
    }),
    annotations: READ,
  },
  {
    name: 'list_teams',
    description: 'Every team with its key and workflow states in board order. State names are what set_status takes.',
    input_schema: { type: 'object', properties: {} },
    output_schema: ANY_OBJECT,
    annotations: READ,
  },
  {
    name: 'list_cycles',
    description:
      'Cycles, earliest first. Defaults to the active and next cycle. Use a cycle number with list_issues (cycle + team) to see its tickets.',
    input_schema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team key; omit for every team' },
        when: { type: 'string', enum: [...CYCLE_WHEN], description: 'current (active and next, default), upcoming, past or all' },
      },
    },
    output_schema: ANY_OBJECT,
    annotations: READ,
  },
  {
    name: 'list_projects',
    description: 'Projects with status, lead, teams, dates and progress. Open projects only unless include_closed.',
    input_schema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team key' },
        include_closed: { type: 'boolean', description: 'Include completed and canceled projects' },
      },
    },
    output_schema: ANY_OBJECT,
    annotations: READ,
  },
  {
    name: 'list_initiatives',
    description: 'Initiatives with status, owner and target date. Unfinished ones only unless include_closed.',
    input_schema: {
      type: 'object',
      properties: { include_closed: { type: 'boolean', description: 'Include completed initiatives' } },
    },
    output_schema: ANY_OBJECT,
    annotations: READ,
  },
  {
    name: 'notifications',
    description:
      'Your Linear inbox, newest first, as pointers: ticket, notification type, who did it (agent or person) and when. Excerpt text is left out, so read the ticket with get_issue before acting. Unread only by default; paginated with next_cursor.',
    input_schema: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: 'Default true' },
        since: { type: 'string', description: 'Only notifications created on or after this date, e.g. 2026-09-24' },
        first: { type: 'integer', minimum: 1, maximum: 100, description: 'How many to return, default 50' },
        after: { type: 'string', description: 'next_cursor from the previous call' },
      },
    },
    output_schema: NOTIFICATIONS_OUTPUT,
    annotations: READ,
  },
  {
    name: 'mark_notifications_read',
    description: 'Mark notifications read once you have handled them. Reports each id separately.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ids from notifications' } },
      required: ['ids'],
    },
    output_schema: ANY_OBJECT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'claim',
    description:
      'Take a ticket and record the description as it stands, so a later Done check can tell whether it changed underneath you. Sets assignee to you when the ticket is unowned; sets delegate to you when a human owns it and you are an agent (app) identity. Refuses a ticket another agent holds. Claiming again after a change is how you acknowledge the new description.',
    input_schema: {
      type: 'object',
      properties: {
        issue: ISSUE_ARG,
        as: { type: 'string', enum: ['assignee', 'delegate'], description: 'Override the automatic choice' },
        take_over: {
          type: 'boolean',
          description: 'Take the assignment from the person who holds it. Only when they handed it to you; a ticket held by another agent is never taken.',
        },
      },
      required: ['issue'],
    },
    output_schema: ANY_OBJECT,
    annotations: OVERWRITES,
  },
  {
    name: 'check_claim',
    description:
      'Whether the description changed since your claim, with a line diff. Run before opening or merging a PR for the ticket.',
    input_schema: { type: 'object', properties: { issue: ISSUE_ARG }, required: ['issue'] },
    output_schema: ANY_OBJECT,
    annotations: READ,
  },
  {
    name: 'set_state',
    description:
      'Change what the ticket says is true by patching named description sections (Observed, Cause, Fix, Done when). The description is current state; comments are the log. Pass reconciled_through (a comment id) to record that the description now reflects the thread through that comment, with accounts_for saying how each skipped comment was handled. Tick a Done when item only once its check has run, and cite what showed it after the item text: "- [x] <item> · <evidence>", where evidence is a commit SHA, a PR (#123), a file:line, a link, a CI run, "Observed 2" for a line under Observed, or `command` → result. A merge, a deploy, or being told something shipped is not the check; if nobody has run it, leave it open and say so. Removing or rewording an unticked Done when item needs descope_reason and descope_risk, and your user is asked to approve it from those two alone, so write them for someone without the ticket open. In Claude Code the call may come back asking you to put a question to your user with AskUserQuestion first; do exactly that, then retry with the sign_off token it gives.',
    input_schema: {
      type: 'object',
      properties: {
        issue: ISSUE_ARG,
        patch: PATCH_SCHEMA,
        base: BASE_ARG,
        reconciled_through: { type: 'string', description: 'Id of the newest comment the description now reflects' },
        descope_risk: {
          type: 'string',
          description:
            'Required with descope_reason: what stops being checked if your user approves, and what could get through because of it. At most 100 characters; they see it on one line as "If you accept".',
          maxLength: 100,
        },
        descope_reason: {
          type: 'string',
          description:
            'Required when the patch removes or rewords an unticked Done when item: why that check no longer applies. At most 100 characters; your user sees it on one line as "Why the agent wants it", and it is recorded as a comment. Keep the detail in Observed.',
          maxLength: 100,
        },
        sign_off: {
          type: 'string',
          description:
            'The token from a set_state refusal that asked you to put a sign-off question to your user. Retry the same call with it after they answer.',
          pattern: '^[0-9a-f]{12}$',
        },
        accounts_for: {
          type: 'array',
          description:
            'With reconciled_through: for each comment the marker moves past, whether it was folded into this call\'s patch or changes nothing (with a reason). Typed comments that already changed the description count on their own. {comment: "*"} covers every comment not named.',
          items: {
            type: 'object',
            properties: {
              comment: { type: 'string', description: 'Comment id, or * for the rest' },
              how: { type: 'string', enum: ['folded', 'no_state_change'] },
              reason: { type: 'string', description: 'Required for no_state_change' },
            },
            required: ['comment', 'how'],
          },
        },
      },
      required: ['issue', 'base'],
    },
    output_schema: ANY_OBJECT,
    annotations: OVERWRITES,
  },
  {
    name: 'comment',
    description:
      'Post a typed comment. evidence: a finding, optionally with an Observed patch. correction: must carry the description patch that makes the description say the corrected thing. ask: adds an OPEN row to Open questions. answer: must name the row it closes (answers: "Q3") and flips it to ANSWERED with a link. closed_by: this ticket\'s work landed under another ticket; names it (closed_by), sets the Linear relation (relation "duplicate" or "fixed_there") and records it under Fix. Move the state separately with set_status.',
    input_schema: {
      type: 'object',
      properties: {
        issue: ISSUE_ARG,
        kind: { type: 'string', enum: [...COMMENT_KINDS] },
        body: { type: 'string', description: 'Comment text. For ask, the first line becomes the question row.' },
        patch: PATCH_SCHEMA,
        base: { ...BASE_ARG, description: `Required with patch. ${BASE_ARG.description}` },
        answers: { type: 'string', description: 'For kind answer: the question id, e.g. Q3' },
        ask_to: { type: 'string', description: 'For kind ask: who should answer' },
        closed_by: { type: 'string', description: 'For kind closed_by: the ticket that carried the work' },
        relation: {
          type: 'string',
          enum: ['duplicate', 'fixed_there'],
          description: 'For kind closed_by: duplicate (same problem) or fixed_there (a different ticket whose change fixed this one)',
        },
        author_label: {
          type: 'string',
          description:
            'Agent name for the comment header, e.g. the model. With a personal API key the header reads "<author_label> via <you>"; with an agent (app) token it defaults to the agent identity.',
        },
      },
      required: ['issue', 'kind', 'body'],
    },
    output_schema: ANY_OBJECT,
    annotations: OVERWRITES,
  },
  {
    name: 'set_status',
    description:
      'Move a ticket to a workflow state by name. Moving to a completed state (Done) needs a Done when section with every item ticked and cited, any cited PR linked here merged, and your claim, and refuses, returning the diff, if the description changed since you claimed it. This call carries no evidence of its own: write it into the description with set_state first, where this check and any close gate a project hooks onto this tool read it. Moving to a canceled state skips those checks, so it needs reason, which is posted as a comment.',
    input_schema: {
      type: 'object',
      properties: {
        issue: ISSUE_ARG,
        state: { type: 'string', description: 'Workflow state name' },
        reason: { type: 'string', description: 'Why the work stops. Required for a canceled state, optional otherwise; posted as a comment.' },
      },
      required: ['issue', 'state'],
    },
    output_schema: ANY_OBJECT,
    annotations: OVERWRITES_IDEMPOTENT,
  },
  {
    name: 'set_fields',
    description:
      "Change a ticket's fields other than its content: title, priority, assignee or delegate, labels, cycle, project, milestone, parent, due date, estimate, and relations to other tickets. The description changes only through set_state and the workflow state only through set_status. Names are resolved to ids first and the whole call is refused if any is unknown or ambiguous, so nothing is half-applied. Taking a ticket from its current assignee needs take_over; another agent's ticket, or one delegated to someone else, is refused.",
    input_schema: {
      type: 'object',
      properties: {
        issue: ISSUE_ARG,
        title: { type: 'string' },
        priority: { type: 'integer', description: '0 none, 1 urgent, 2 high, 3 medium, 4 low' },
        assignee: { type: ['string', 'null'], description: 'Name, display name, email or id, "me", or null to unassign' },
        delegate: { type: ['string', 'null'], description: 'Agent (app) user to delegate to, "me", or null to clear' },
        take_over: { type: 'boolean', description: "Required to change a person's assignment to someone else" },
        add_labels: { type: 'array', items: { type: 'string' }, description: 'Label names on the team or workspace. Labels are not created here.' },
        remove_labels: { type: 'array', items: { type: 'string' } },
        cycle: { type: ['integer', 'string', 'null'], description: 'Cycle number, "current", "next", or null to remove it from its cycle' },
        project: { type: ['string', 'null'], description: 'Project name or id, or null' },
        milestone: { type: ['string', 'null'], description: "Milestone name in the ticket's project (or the project set in this call), or null" },
        parent: { type: ['string', 'null'], description: 'Parent issue identifier, or null' },
        due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null' },
        estimate: { type: ['integer', 'null'] },
        related_to: { type: 'array', items: { type: 'string' }, description: 'Issue identifiers to mark as related' },
        blocks: { type: 'array', items: { type: 'string' }, description: 'Issue identifiers this ticket blocks' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Issue identifiers that block this ticket' },
      },
      required: ['issue'],
    },
    output_schema: ANY_OBJECT,
    annotations: OVERWRITES,
  },
  {
    name: 'create_issue',
    description:
      'Create a ticket. Its description is built from named sections (Observed, Cause, Fix, Done when), checked the same way set_state checks them, so the ticket starts in the form every other tool expects. Include a Done when section if the ticket will be closed through set_status.',
    input_schema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team key, e.g. ENG' },
        title: { type: 'string' },
        sections: PATCH_SCHEMA,
        parent: { type: 'string', description: 'Parent issue identifier or UUID' },
        project_id: { type: 'string' },
      },
      required: ['team', 'title'],
    },
    output_schema: ANY_OBJECT,
    annotations: ADDS,
  },
];

type Args = Record<string, unknown>;

function opt(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} must be a non-empty string`);
  return value;
}

function req(args: Args, key: string): string {
  const value = opt(args, key);
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
}

/** A description write must say which description it was written against. */
function baseArg(args: Args): string {
  const base = opt(args, 'base');
  if (base === undefined) {
    throw new Error(
      'Nothing was written: base is required. Pass the description_sha from your get_issue read of this ticket, or from your last write to it. It shows the patch was written against the description as it stands now.',
    );
  }
  return base;
}

function relationArg(args: Args): 'duplicate' | 'fixed_there' | undefined {
  const relation = opt(args, 'relation');
  if (relation === undefined || relation === 'duplicate' || relation === 'fixed_there') return relation;
  throw new Error('relation must be "duplicate" or "fixed_there"');
}

function commentKindArg(args: Args): CommentKind {
  const kind = req(args, 'kind');
  const known = COMMENT_KINDS.find((candidate) => candidate === kind);
  if (!known) throw new Error(`kind must be one of ${COMMENT_KINDS.join(', ')}`);
  return known;
}

function patches(args: Args, key: string): SectionPatch[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of {section, mode, body}`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`${key}[${index}] must be an object`);
    const { section, mode, body } = item as Args;
    if (typeof section !== 'string' || typeof mode !== 'string' || typeof body !== 'string') {
      throw new Error(`${key}[${index}] needs string section, mode and body`);
    }
    if (mode !== 'replace' && mode !== 'append') throw new Error(`${key}[${index}].mode must be "replace" or "append"`);
    return { section, mode, body };
  });
}

function accountsFor(args: Args): Accounting[] {
  const value = args['accounts_for'];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('accounts_for must be a list of {comment, how, reason?}');
  return value.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`accounts_for[${String(index)}] must be an object`);
    const item = entry as Args;
    const how = req(item, 'how');
    if (how !== 'folded' && how !== 'no_state_change') throw new Error(`accounts_for[${String(index)}].how must be folded or no_state_change`);
    return { comment: req(item, 'comment'), how, reason: opt(item, 'reason') };
  });
}

function int(args: Args, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function bool(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  return value;
}

function strings(args: Args, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${key} must be a list of non-empty strings`);
  }
  return value as string[];
}

/** A value that may be null to clear the field: undefined means leave it alone. */
function clearable<T>(args: Args, key: string, parse: (args: Args, key: string) => T | undefined): T | null | undefined {
  if (!(key in args)) return undefined;
  if (args[key] === null) return null;
  return parse(args, key);
}

function cycleArg(args: Args): number | string | null | undefined {
  if (!('cycle' in args)) return undefined;
  const value = args['cycle'];
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (value === 'current' || value === 'next') return value;
  throw new Error('cycle must be a cycle number, "current", "next", or null');
}

function fieldChanges(args: Args): FieldChanges {
  return {
    title: opt(args, 'title'),
    priority: int(args, 'priority'),
    assignee: clearable(args, 'assignee', opt),
    delegate: clearable(args, 'delegate', opt),
    take_over: bool(args, 'take_over'),
    add_labels: strings(args, 'add_labels'),
    remove_labels: strings(args, 'remove_labels'),
    cycle: cycleArg(args),
    project: clearable(args, 'project', opt),
    milestone: clearable(args, 'milestone', opt),
    parent: clearable(args, 'parent', opt),
    due_date: clearable(args, 'due_date', opt),
    estimate: clearable(args, 'estimate', int),
    related_to: strings(args, 'related_to'),
    blocks: strings(args, 'blocks'),
    blocked_by: strings(args, 'blocked_by'),
  };
}

export function strictToolHandlers(strict: StrictLinear): Record<string, (raw: unknown) => Promise<unknown>> {
  const withArgs =
    (fn: (args: Args) => Promise<unknown>) =>
    (raw: unknown): Promise<unknown> => {
      const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Args) : {};
      return fn(args);
    };

  return {
    get_issue: withArgs((args) => strict.getIssue(req(args, 'issue'))),
    description_history: withArgs((args) => strict.descriptionHistory(req(args, 'issue'), { blame: bool(args, 'blame') })),
    list_issues: withArgs((args) =>
      strict.listIssues({
        query: opt(args, 'query'),
        team: opt(args, 'team'),
        state: opt(args, 'state'),
        assignee_is_me: bool(args, 'assignee_is_me'),
        delegate_is_me: bool(args, 'delegate_is_me'),
        cycle: int(args, 'cycle'),
        project: opt(args, 'project'),
        open: bool(args, 'open'),
      }),
    ),
    whoami: withArgs(() => strict.viewer()),
    list_teams: withArgs(() => strict.workspace.listTeams()),
    list_cycles: withArgs((args) => {
      const when = opt(args, 'when');
      if (when !== undefined && !(CYCLE_WHEN as readonly string[]).includes(when)) {
        throw new Error(`when must be one of ${CYCLE_WHEN.join(', ')}`);
      }
      return strict.workspace.listCycles({ team: opt(args, 'team'), when: when as CycleWhen | undefined });
    }),
    list_projects: withArgs((args) =>
      strict.workspace.listProjects({ team: opt(args, 'team'), include_closed: bool(args, 'include_closed') }),
    ),
    list_initiatives: withArgs((args) => strict.workspace.listInitiatives({ include_closed: bool(args, 'include_closed') })),
    notifications: withArgs((args) =>
      strict.workspace.notifications({
        unread_only: bool(args, 'unread_only'),
        since: opt(args, 'since'),
        first: int(args, 'first'),
        after: opt(args, 'after'),
      }),
    ),
    mark_notifications_read: withArgs((args) => {
      const ids = args['ids'];
      if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string' && id !== '')) {
        throw new Error('ids must be a list of notification ids from the notifications tool');
      }
      return strict.workspace.markNotificationsRead(ids);
    }),
    claim: withArgs((args) => {
      const as = opt(args, 'as');
      if (as !== undefined && as !== 'assignee' && as !== 'delegate') throw new Error('as must be assignee or delegate');
      return strict.claim(req(args, 'issue'), { as, take_over: bool(args, 'take_over') });
    }),
    check_claim: withArgs((args) => strict.checkClaim(req(args, 'issue'))),
    set_state: withArgs((args) =>
      strict.setState(
        req(args, 'issue'),
        patches(args, 'patch') ?? [],
        opt(args, 'reconciled_through'),
        accountsFor(args),
        opt(args, 'descope_reason'),
        baseArg(args),
        opt(args, 'descope_risk'),
        opt(args, 'sign_off'),
      ),
    ),
    comment: withArgs((args) => {
      const patch = patches(args, 'patch');
      return strict.comment(req(args, 'issue'), {
        kind: commentKindArg(args),
        body: req(args, 'body'),
        patch,
        base: patch && patch.length > 0 ? baseArg(args) : opt(args, 'base'),
        answers: opt(args, 'answers'),
        ask_to: opt(args, 'ask_to'),
        closed_by: opt(args, 'closed_by'),
        relation: relationArg(args),
        author_label: opt(args, 'author_label'),
      });
    }),
    set_status: withArgs((args) => strict.setStatus(req(args, 'issue'), req(args, 'state'), opt(args, 'reason'))),
    set_fields: withArgs((args) => strict.setFields(req(args, 'issue'), fieldChanges(args))),
    create_issue: withArgs((args) =>
      strict.createIssue({
        team: req(args, 'team'),
        title: req(args, 'title'),
        sections: patches(args, 'sections'),
        parent: opt(args, 'parent'),
        project_id: opt(args, 'project_id'),
      }),
    ),
  };
}
