import { createHash } from 'node:crypto';
import { type FieldChanges, findUser, resolveFields } from './fields.js';
import type { ClaimRecord, ClaimStore } from './claims.js';
import { diffOps, lineDiff } from './diff.js';
import { type PmNode, renderMarkdown } from './prosemirror.js';
import {
  type Connection,
  type Gql,
  type Omission,
  PAGE_SIZE,
  errorMessage,
  paginate,
} from './graphql.js';
import {
  type SectionPatch,
  addQuestion,
  answerQuestion,
  applySectionPatches,
  commentKind,
  lintForState,
  citedPullRequestNumbers,
  uncitedTicks,
  listQuestions,
  nextQuestionId,
  stripMarker,
  readSection,
} from './sections.js';
import {
  type AttachmentNode,
  commentAuthorKind,
  pullRequests,
  shippedStateFindings,
} from './facts.js';
import { StrictWorkspace } from './workspace.js';
import { MARKER_URL, MARKER_URLS, type StoredMarker, markerAttachmentInput } from './marker.js';
import {
  ATTACHMENTS_QUERY,
  CHILDREN_QUERY,
  COMMENT_CREATE,
  COMMENTS_QUERY,
  connectionQuery,
  CONTENT_HISTORY_QUERY,
  DESCRIPTION_DOC_QUERY,
  HISTORY_QUERY,
  INVERSE_RELATIONS_QUERY,
  ISSUE_CREATE,
  ISSUE_ID_QUERY,
  ISSUE_QUERY,
  ISSUE_UPDATE,
  LIST_FIELDS,
  MARKER_DELETE,
  MARKER_UPSERT,
  PAGE_INFO,
  RELATION_CREATE,
  RELATIONS_QUERY,
  TEAM_BY_KEY_QUERY,
  TEAM_STATES_QUERY,
  USERS_BY_ID_QUERY,
  VIEWER_QUERY,
} from './queries.js';
import {
  addedChecks,
  CITING,
  DESCOPE_LINE,
  doneWhenItems,
  droppedChecks,
  REWORDING,
  uncitedWarning,
  UNTICKED,
} from './done-when.js';
import {
  authorName,
  type IssueCore,
  nameOf,
  type Person,
  personOut,
  type Viewer,
} from './issue-core.js';
import {
  type Accounting,
  checkAccounting,
  editedSince,
  findMarker,
  firstUncovered,
  type FoundMarker,
  isSelfApplied,
  type MarkerNode,
} from './reconcile.js';
import {
  checkCommentArgs,
  type CommentArgs,
  type CommentDraft,
  commentLabel,
  type Mention,
  mentionResult,
  patchSummary,
  questionFor,
} from './comment-rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PR statuses in Linear's GitHub attachment metadata that mean not merged.
 * The values seen on a real workspace's ~1,000 PR attachments were open,
 * merged, closed and draft, plus a few with no status at all (2026-09-27).
 */
const NOT_MERGED = ['open', 'closed', 'draft'];

/** Pages of issue history get_issue reads; see getIssue. */
const HISTORY_PAGES = 2;

interface ListNode {
  identifier: string;
  title: string;
  updatedAt: string;
  state: { name: string; type: string } | null;
  assignee: { name: string } | null;
  delegate: { name: string } | null;
}

export interface ListIssuesArgs {
  query?: string | undefined;
  team?: string | undefined;
  state?: string | undefined;
  assignee_is_me?: boolean | undefined;
  delegate_is_me?: boolean | undefined;
  /** Cycle number; needs team, since every team numbers its own cycles. */
  cycle?: number | undefined;
  /** Project name or id. */
  project?: string | undefined;
  /** Only tickets not in a completed or canceled state. */
  open?: boolean | undefined;
}

/** Past this many matches list_issues refuses rather than return part of the set. */
export const LIST_ISSUES_CAP = 2000;
const LIST_COLUMNS = ['identifier', 'title', 'state', 'assignee', 'delegate', 'updatedAt'] as const;

export interface ClaimArgs {
  as?: 'assignee' | 'delegate' | undefined;
  /** Take the assignment from the person who holds it, because they handed it over. */
  take_over?: boolean | undefined;
}

export interface CreateIssueArgs {
  team: string;
  title: string;
  sections?: SectionPatch[] | undefined;
  parent?: string | undefined;
  project_id?: string | undefined;
}

export interface StrictLinearOptions {
  gql: Gql;
  claims: ClaimStore;
  now?: () => Date;
  /** The branch "Done" means the work is on. Defaults to main. */
  mainBranch?: string;
  /** The environment in `posthog-<env>:<state>` flag labels that means users. Defaults to production. */
  productionEnv?: string;
  /** Labels that make a ticket people-only: every write to it is refused. Defaults to no-agents. */
  handsOffLabels?: string[];
  /**
   * Asks the person at the client to approve dropping unticked Done when
   * items. Without it, only a person editing in Linear can drop one.
   */
  signOff?: (request: SignOffRequest) => Promise<SignOffOutcome | SignOffAnswer>;
}

export interface SignOffRequest {
  identifier: string;
  title: string;
  /** Unticked items the patch removes or rewords. */
  dropped: string[];
  /** Items the patch puts in, in order, so a rewording can be shown as one. */
  added: string[];
  /** Why the agent wants it. */
  reason: string;
  /** What stops being checked if the person approves, in the agent's words. */
  risk: string;
  /** The description as it stands, for a judge to weigh the reason against. */
  description: string;
  /** set_state's sign_off: the token of a question asked earlier, on the retry. */
  token?: string | undefined;
}

/**
 * unavailable: the client cannot ask. unanswered: it asked and got no answer.
 * pending: the agent has to ask first; instructions say how.
 */
export type SignOffOutcome = 'approved' | 'declined' | 'unanswered' | 'unavailable' | 'pending';

export interface SignOffAnswer {
  outcome: SignOffOutcome;
  /** What the person wrote, or the judge's reason. */
  note?: string | undefined;
  /** For anything but approved: what the client sent back, as field names and types. */
  returned?: string | undefined;
  /** For pending: what the agent must do before retrying. */
  instructions?: string | undefined;
  /** Who approved: the person at the client, or a model standing in for them. */
  signer?: 'person' | 'judge' | undefined;
  /** For a judge: the model that decided. */
  model?: string | undefined;
}

/**
 * A short content hash of a description, as Linear stored it. get_issue
 * returns it, every description write returns the new one, and a write
 * passes the one it was built from as base.
 */
export function descriptionSha(text: string) {
  return createHash('sha256').update(text).digest('hex').substring(0, 12);
}

/** How many descriptions a server remembers by hash, to diff a stale base against. */
const REMEMBERED_DESCRIPTIONS = 500;

export class StrictLinear {
  private readonly gql: Gql;
  private readonly claims: ClaimStore;
  private readonly now: () => Date;
  private readonly mainBranch: string;
  private readonly productionEnv: string;
  private readonly handsOff: string[];
  private readonly signOff:
    ((request: SignOffRequest) => Promise<SignOffOutcome | SignOffAnswer>) | undefined;
  private viewerCache: Viewer | null = null;
  /** Descriptions this server has returned or written, by hash, so a stale base can be shown as a diff. */
  private readonly seen = new Map<string, string>();
  /** Teams, cycles, projects, initiatives and the notification inbox. */
  readonly workspace: StrictWorkspace;

  constructor(options: StrictLinearOptions) {
    this.gql = options.gql;
    this.claims = options.claims;
    this.now = options.now ?? (() => new Date());
    this.mainBranch = options.mainBranch ?? 'main';
    this.productionEnv = options.productionEnv ?? 'production';
    this.handsOff = (options.handsOffLabels ?? ['no-agents']).map((label) => label.toLowerCase());
    this.signOff = options.signOff;
    this.workspace = new StrictWorkspace(this.gql, this.now);
  }

  private today() {
    return this.now().toISOString().slice(0, 10);
  }

  async viewer(): Promise<Viewer> {
    if (!this.viewerCache) {
      const data = await this.gql<{ viewer: Viewer }>(VIEWER_QUERY);
      this.viewerCache = data.viewer;
    }
    return this.viewerCache;
  }

  private async core(id: string): Promise<IssueCore> {
    const data = await this.gql<{ issue: IssueCore | null }>(ISSUE_QUERY, { id });
    if (!data.issue)
      throw new Error(
        `Issue ${id} not found. Search for it with list_issues (query: words from its title).`,
      );
    return data.issue;
  }

  /** The issue, if agents may write to it: a ticket carrying a hands-off label is people-only. */
  private async writable(id: string): Promise<IssueCore> {
    const issue = await this.core(id);
    if (issue.trashed || issue.archivedAt) {
      throw new Error(
        `Nothing was written: ${issue.identifier} is ${issue.trashed ? 'in the trash' : 'archived'}. Reading it is fine; a person restores it in Linear before anyone works on it again.`,
      );
    }
    const fence = issue.labels.nodes.find((label) =>
      this.handsOff.includes(label.name.toLowerCase()),
    );
    if (fence) {
      throw new Error(
        `Nothing was written: ${issue.identifier} carries the "${fence.name}" label, which keeps agents from changing it. Reading it is fine. If it needs work, say so to a person; only a person can remove the label.`,
      );
    }
    return issue;
  }

  /** Records a description under its hash and returns the hash. */
  private remember(text: string) {
    const sha = descriptionSha(text);
    this.seen.delete(sha);
    this.seen.set(sha, text);
    const oldest = this.seen.keys().next().value;
    if (this.seen.size > REMEMBERED_DESCRIPTIONS && oldest !== undefined) this.seen.delete(oldest);
    return sha;
  }

  /**
   * Refuses a write built from a description other than the one the ticket
   * has now. Linear has no conditional update, so this is how a patch shows
   * it was written against the current text rather than an older read.
   */
  private checkBase(issue: IssueCore, base: string | undefined) {
    if (base === undefined) return;
    const current = issue.description ?? '';
    if (descriptionSha(current) === base) return;
    const read = this.seen.get(base);
    const what =
      read === undefined ? '' : ` What changed since then:\n${lineDiff(read, current)}\n`;
    throw new Error(
      `Nothing was written: ${issue.identifier}'s description is no longer the one your base (${base}) came from.${what}\nRead the ticket again with get_issue, check the patch still holds against what it says now, and repeat the call with its description_sha as base.`,
    );
  }

  private connection<N>(query: string, id: string, field: string) {
    return (after: string | null) =>
      this.gql<{ issue: Partial<Record<string, Connection<N>>> | null }>(query, { id, after }).then(
        (data) => {
          const connection = data.issue?.[field];
          if (!connection)
            throw new Error(`Linear returned no ${field} connection for issue ${id}`);
          return connection;
        },
      );
  }

  /** paginate(), but a failed first page becomes an Omission instead of an error. */
  // N is asserted from the query's selection set, the same trust Gql<T> takes; nothing here can check it.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  private async soft<N>(
    field: string,
    query: string,
    id: string,
    maxPages?: number,
    stoppedBecause?: string,
  ): Promise<{ nodes: N[]; omitted: Omission[] }> {
    try {
      return await paginate<N>(
        field,
        this.connection<N>(query, id, field),
        PAGE_SIZE,
        maxPages,
        stoppedBecause,
      );
    } catch (error) {
      return {
        nodes: [] as N[],
        omitted: [
          { field, reason: `not fetched: ${errorMessage(error)}`, fetched: 0 },
        ] as Omission[],
      };
    }
  }

  /**
   * The whole ticket: full description, every comment oldest-first, every
   * description edit with who made it, relations, children and attachments,
   * plus the caller's claim status. `omitted` lists anything not returned.
   */
  async getIssue(id: string) {
    const issue = await this.core(id);
    const viewer = await this.viewer();

    interface CommentNode {
      id: string;
      body: string;
      createdAt: string;
      updatedAt: string;
      editedAt: string | null;
      url: string;
      parent: { id: string } | null;
      user: (Person & { app: boolean | null }) | null;
      botActor: { name: string } | null;
      externalUser: { name: string } | null;
    }
    interface HistoryNode {
      id: string;
      createdAt: string;
      updatedDescription: boolean | null;
      actor: Person | null;
      botActor: { name: string } | null;
    }

    // Comments are the point of this read, so a failed first page fails the
    // call rather than degrading to a description-only answer.
    const [comments, history, relations, inverse, children, attachments] = await Promise.all([
      paginate<CommentNode>(
        'comments',
        this.connection<CommentNode>(COMMENTS_QUERY, issue.id, 'comments'),
      ),
      // Linear returns history newest first and logs every field change there, so a busy ticket's
      // history runs to many pages. The latest description edit is near the top; the whole record
      // of description versions is description_history's job.
      this.soft<HistoryNode>(
        'history',
        HISTORY_QUERY,
        issue.id,
        HISTORY_PAGES,
        `only the latest ${String(HISTORY_PAGES * PAGE_SIZE)} history entries were read; description_edits lists the edits among them, and description_history has every version`,
      ),
      this.soft<{ id: string; type: string; relatedIssue: { identifier: string; title: string } }>(
        'relations',
        RELATIONS_QUERY,
        issue.id,
      ),
      this.soft<{ id: string; type: string; issue: { identifier: string; title: string } }>(
        'inverseRelations',
        INVERSE_RELATIONS_QUERY,
        issue.id,
      ),
      this.soft<{
        identifier: string;
        title: string;
        state: { name: string; type: string } | null;
      }>('children', CHILDREN_QUERY, issue.id),
      this.soft<AttachmentNode>('attachments', ATTACHMENTS_QUERY, issue.id),
    ]);

    const omitted: Omission[] = [
      ...comments.omitted,
      ...history.omitted,
      ...relations.omitted,
      ...inverse.omitted,
      ...children.omitted,
      ...attachments.omitted,
    ];
    if (issue.releases?.pageInfo.hasNextPage) {
      omitted.push({
        field: 'releases',
        reason: 'more than 20 releases; later releases were not fetched',
        fetched: 20,
      });
    }
    if (issue.labels.pageInfo.hasNextPage) {
      omitted.push({
        field: 'labels',
        reason: 'more than 100 labels; later labels were not fetched',
        fetched: 100,
      });
    }

    const sortedComments = [...comments.nodes].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );

    const claim = this.claims.get(issue.id, viewer.id);
    const description = issue.description ?? '';
    const drift = this.drift(findMarker(issue), description, sortedComments, history.nodes);
    const prs = pullRequests(attachments.nodes);

    return {
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        state: issue.state,
        team: issue.team,
        priority: issue.priority,
        assignee: personOut(issue.assignee),
        delegate: personOut(issue.delegate),
        creator: personOut(issue.creator),
        parent: issue.parent,
        project: issue.project,
        labels: issue.labels.nodes.map((label) => label.name),
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        archivedAt: issue.archivedAt,
        description,
        description_sha: this.remember(description),
        open_questions: listQuestions(description)
          .filter((row) => row.open)
          .map((row) => row.line),
      },
      comments: sortedComments.map((comment) => ({
        id: comment.id,
        createdAt: comment.createdAt,
        author: authorName(comment),
        ...(({ kind, basis }) => ({ author_kind: kind, author_kind_basis: basis }))(
          commentAuthorKind(comment),
        ),
        edited_after_posting: comment.editedAt !== null,
        editedAt: comment.editedAt,
        parentId: comment.parent?.id ?? null,
        url: comment.url,
        body: comment.body,
      })),
      comment_order: 'oldest first, by createdAt',
      description_edits: history.nodes
        .filter((entry) => entry.updatedDescription)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((entry) => ({
          at: entry.createdAt,
          by: entry.actor
            ? entry.actor.displayName || entry.actor.name
            : (entry.botActor?.name ?? null),
        })),
      relations: [
        ...relations.nodes.map((r) => ({
          type: r.type,
          direction: 'outgoing',
          issue: r.relatedIssue,
        })),
        ...inverse.nodes.map((r) => ({ type: r.type, direction: 'incoming', issue: r.issue })),
      ],
      children: children.nodes,
      pull_requests: prs,
      releases: (issue.releases?.nodes ?? []).map((release) => ({
        name: release.name,
        version: release.version,
        stage: release.stage?.name ?? null,
        completed: release.stage?.type === 'completed',
        url: release.url,
      })),
      attachments: attachments.nodes
        .filter(
          (attachment) =>
            !MARKER_URLS.includes(attachment.url) && !prs.some((pr) => pr.url === attachment.url),
        )
        .map(({ id: attachmentId, title, subtitle, url, createdAt, sourceType }) => ({
          id: attachmentId,
          title,
          subtitle,
          url,
          createdAt,
          sourceType,
        })),
      claim: claim ? this.claimStatus(claim, description) : null,
      findings: [
        ...lintForState(description, issue.state?.type ?? null),
        ...shippedStateFindings(issue.state, prs, this.mainBranch, {
          labels: issue.labels.nodes.map((label) => label.name),
          releases: issue.releases?.nodes ?? [],
          text: [description, ...sortedComments.map((comment) => comment.body)],
          productionEnv: this.productionEnv,
        }),
      ],
      drift,
      omitted,
    };
  }

  /**
   * Where the description may lag the thread. With a reconciled marker, every
   * comment after the marked one is unreconciled. Without one, the fallback
   * is every comment posted after the last description edit, and the absence
   * of a marker is itself reported.
   */
  private drift(
    found: FoundMarker | null,
    description: string,
    comments: {
      id: string;
      createdAt: string;
      editedAt: string | null;
      body: string;
      url: string;
    }[],
    history: { createdAt: string; updatedDescription: boolean | null }[],
  ) {
    const marker = found?.marker ?? null;
    // The attachment records the hash of the description this server last wrote; another hash
    // means the description was changed elsewhere since, which may have undone a fold.
    const changedElsewhere =
      found?.in === 'attachment' &&
      marker?.sha !== undefined &&
      marker.sha !== descriptionSha(description);
    const lastEdit =
      history
        .filter((entry) => entry.updatedDescription)
        .map((entry) => entry.createdAt)
        .sort()
        .pop() ?? null;

    let pending: typeof comments;
    let basis: string;
    if (marker) {
      const index = comments.findIndex((comment) => comment.id === marker.through);
      if (index === -1) {
        pending = comments.filter((comment) => comment.createdAt > marker.at);
        basis = `reconciled marker names comment ${marker.through}, which is not on this issue; counting comments after ${marker.at}`;
      } else {
        pending = comments.slice(index + 1);
        basis = `comments after the reconciled marker (${marker.by}, ${marker.at})`;
      }
    } else {
      pending = lastEdit ? comments.filter((comment) => comment.createdAt > lastEdit) : comments;
      basis = lastEdit
        ? 'no reconciled marker; comments after the last description edit'
        : 'no reconciled marker and no description edit on record; every comment';
    }

    // A comment the description already accounts for can be edited afterwards; Linear keeps no
    // version of the old text, so the fold may no longer match what the comment says.
    const covered = comments.filter((comment) => !pending.includes(comment));
    const edited = marker
      ? editedSince(covered, marker.checked)
      : lastEdit
        ? editedSince(covered, lastEdit)
        : [];
    const editedAfter = edited.map((comment) => ({
      id: comment.id,
      createdAt: comment.createdAt,
      editedAt: comment.editedAt ?? null,
      kind: commentKind(comment.body),
      url: comment.url,
    }));

    const selfApplied = pending.filter((comment) => isSelfApplied(comment.body));
    const unreconciled = pending
      .filter((comment) => !isSelfApplied(comment.body))
      .map((comment) => ({
        id: comment.id,
        createdAt: comment.createdAt,
        kind: commentKind(comment.body),
        url: comment.url,
      }));
    const needsReconcile = unreconciled.length > 0 || editedAfter.length > 0;
    return {
      reconciled_through: marker
        ? {
            through: marker.through,
            at: marker.at,
            by: marker.by,
            ...(marker.checked ? { checked: marker.checked } : {}),
            stored_in: found?.in,
          }
        : null,
      last_description_edit_at: lastEdit,
      ...(changedElsewhere
        ? {
            description_changed_elsewhere:
              'The description was edited outside linear-strict after it was last reconciled. Check that what the covered comments established is still in it.',
          }
        : {}),
      basis,
      unreconciled_comments: unreconciled,
      ...(editedAfter.length > 0 ? { edited_after_reconcile: editedAfter } : {}),
      ...(marker && !marker.checked && covered.some((comment) => comment.editedAt)
        ? {
            edits_unchecked:
              'The marker predates edit tracking, so edits to comments it covers cannot be dated against it. The next reconcile records the time.',
          }
        : {}),
      ...(selfApplied.length > 0 ? { self_applied_after_marker: selfApplied.length } : {}),
      needs_reconcile: needsReconcile,
      ...(needsReconcile
        ? {
            next_step: `Read the ${[unreconciled.length > 0 ? 'unreconciled comments' : '', editedAfter.length > 0 ? 'comments edited after the description accounted for them' : ''].filter(Boolean).join(' and ')}. Fold what they establish into the description with set_state, passing reconciled_through (the newest comment id, even if the marker already names it) and accounts_for, which says for each comment whether it was folded or changes nothing and why.`,
          }
        : {}),
    };
  }

  private claimStatus(claim: ClaimRecord, currentDescription: string) {
    const changed = claim.description !== currentDescription;
    return {
      claimed_at: claim.claimedAt,
      edited_since_claim: changed,
      ...(changed ? { diff_since_claim: lineDiff(claim.description, currentDescription) } : {}),
    };
  }

  /**
   * The description's past versions, from the snapshots Linear saves as it is
   * edited: who made each one and what it changed. With blame, each line of the
   * current description names the version that introduced it.
   */
  async descriptionHistory(id: string, options: { blame?: boolean | undefined } = {}) {
    const data = await this.gql<{
      issue: {
        id: string;
        identifier: string;
        description: string | null;
        documentContent: { id: string } | null;
      } | null;
    }>(DESCRIPTION_DOC_QUERY, { id });
    if (!data.issue)
      throw new Error(
        `Issue ${id} not found. Search for it with list_issues (query: words from its title).`,
      );
    const { issue } = data;
    const description = issue.description ?? '';
    if (!issue.documentContent) {
      return {
        issue: issue.identifier,
        versions: [],
        current: { in_a_version: false },
        omitted: [
          { field: 'versions', reason: 'Linear keeps no document history for this ticket' },
        ],
      };
    }

    const history = await this.gql<{
      documentContentHistory: {
        success: boolean;
        history: { contentDataSnapshotAt: string; actorIds: string[]; contentData: PmNode }[];
      };
    }>(CONTENT_HISTORY_QUERY, { id: issue.documentContent.id });
    const snapshots = [...history.documentContentHistory.history].sort((a, b) =>
      a.contentDataSnapshotAt.localeCompare(b.contentDataSnapshotAt),
    );

    const actorIds = [...new Set(snapshots.flatMap((snapshot) => snapshot.actorIds))];
    const names = new Map<string, string>();
    if (actorIds.length > 0) {
      const users = await this.gql<{
        users: { nodes: { id: string; name: string; displayName: string }[] };
      }>(USERS_BY_ID_QUERY, { ids: actorIds });
      for (const user of users.users.nodes) names.set(user.id, user.displayName || user.name);
    }

    // A snapshot whose text matches the one before it changed only formatting or attribution; it is not a version.
    const unrendered = new Set<string>();
    const versions: { version: number; at: string; by: string[]; text: string }[] = [];
    for (const snapshot of snapshots) {
      const rendered = renderMarkdown(snapshot.contentData);
      for (const type of rendered.unknown) unrendered.add(type);
      if (rendered.markdown === versions.at(-1)?.text) continue;
      versions.push({
        version: versions.length + 1,
        at: snapshot.contentDataSnapshotAt,
        by: snapshot.actorIds.map((actor) => names.get(actor) ?? actor),
        text: rendered.markdown,
      });
    }

    const latest = versions.at(-1);
    const inAVersion = latest?.text === description;
    const result = {
      issue: issue.identifier,
      versions: versions.map((version, index) => {
        const previous = versions[index - 1];
        return previous
          ? {
              version: version.version,
              at: version.at,
              by: version.by,
              diff: lineDiff(previous.text, version.text),
            }
          : { version: version.version, at: version.at, by: version.by, text: version.text };
      }),
      current: inAVersion
        ? { in_a_version: true, version: latest.version }
        : {
            in_a_version: false,
            diff_from_latest_version: lineDiff(latest?.text ?? '', description),
          },
      ...(unrendered.size > 0 ? { unrendered: [...unrendered].sort() } : {}),
      note: 'Versions are the snapshots Linear saves of the description. Edits made close together can share one version, and the newest edit may not be in a version yet (current says). The text of version 1 is whole; each later version is a diff against the one before it.',
    };
    if (!options.blame) return result;

    // Walk the versions forward, carrying each line's origin through lines kept unchanged.
    let origins: (number | null)[] = [];
    let previousText: string | null = null;
    for (const version of [...versions, { version: null, text: description }]) {
      if (previousText === null) {
        origins = version.text.split('\n').map(() => version.version);
      } else {
        const next: (number | null)[] = [];
        let from = 0;
        for (const op of diffOps(previousText, version.text)) {
          if (op.tag === ' ') next.push(origins[from++] ?? null);
          else if (op.tag === '-') from++;
          else next.push(version.version);
        }
        origins = next;
      }
      previousText = version.text;
    }
    const byVersion = new Map(versions.map((version) => [version.version, version]));
    return {
      ...result,
      blame: description.split('\n').map((line, index) => {
        const origin = origins[index] ?? null;
        const version = origin === null ? undefined : byVersion.get(origin);
        return version
          ? { line, version: version.version, at: version.at, by: version.by }
          : { line, version: null };
      }),
    };
  }

  /**
   * Every matching ticket, walked to the last page here, so an agent never
   * holds a cursor it can stop following. Titles and state only, as rows
   * under `columns`: no description excerpts, because a cut body reads as a
   * whole one and triage goes through get_issue. A failed page, or more
   * matches than LIST_ISSUES_CAP, is refused outright rather than answered
   * with part of the set.
   */
  async listIssues(args: ListIssuesArgs) {
    if (args.cycle !== undefined && !args.team)
      throw new Error('cycle needs team: each team numbers its own cycles');

    const state = {
      ...(args.state ? { name: { eqIgnoreCase: args.state } } : {}),
      ...(args.open ? { type: { nin: ['completed', 'canceled'] } } : {}),
    };
    const filter = {
      ...(args.team ? { team: { key: { eqIgnoreCase: args.team } } } : {}),
      ...(Object.keys(state).length > 0 ? { state } : {}),
      ...(args.assignee_is_me ? { assignee: { isMe: { eq: true } } } : {}),
      ...(args.delegate_is_me ? { delegate: { isMe: { eq: true } } } : {}),
      ...(args.cycle !== undefined ? { cycle: { number: { eq: args.cycle } } } : {}),
      // Linear's id comparator accepts only a UUID, so a name has to go to the name comparator.
      ...(args.project
        ? {
            project: UUID.test(args.project)
              ? { id: { eq: args.project } }
              : { name: { eqIgnoreCase: args.project } },
          }
        : {}),
    };

    const fetchPage = async (after: string | null): Promise<Connection<ListNode>> => {
      if (args.query) {
        const data = await this.gql<{ searchIssues: Connection<ListNode> }>(
          `query StrictSearch($term: String!, $first: Int, $after: String, $filter: IssueFilter) {
  searchIssues(term: $term, first: $first, after: $after, filter: $filter) { nodes { ${LIST_FIELDS} } ${PAGE_INFO} }
}`,
          { term: args.query, first: PAGE_SIZE, after, filter },
        );
        return data.searchIssues;
      }
      const data = await this.gql<{ issues: Connection<ListNode> }>(
        `query StrictList($first: Int, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) { nodes { ${LIST_FIELDS} } ${PAGE_INFO} }
}`,
        { first: PAGE_SIZE, after, filter },
      );
      return data.issues;
    };

    const nodes: ListNode[] = [];
    let after: string | null = null;
    for (let page = 1; ; page++) {
      let connection: Connection<ListNode>;
      try {
        connection = await fetchPage(after);
      } catch (error) {
        throw new Error(
          `Linear failed on page ${String(page)} after ${String(nodes.length)} tickets (${errorMessage(error)}). Nothing is returned, so part of the set can't pass for all of it; call list_issues again.`,
        );
      }
      nodes.push(...connection.nodes);
      if (nodes.length > LIST_ISSUES_CAP) {
        throw new Error(
          `More than ${String(LIST_ISSUES_CAP)} tickets match, which is more than one answer can hold whole. Narrow the set with open: true, state, cycle, project, assignee_is_me or delegate_is_me, and list each part.`,
        );
      }
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }

    const byState: Record<string, number> = {};
    for (const node of nodes) {
      const name = node.state?.name ?? '(none)';
      byState[name] = (byState[name] ?? 0) + 1;
    }
    return {
      total: nodes.length,
      complete: true,
      by_state: byState,
      columns: LIST_COLUMNS,
      rows: nodes.map((node) => [
        node.identifier,
        node.title,
        node.state?.name ?? null,
        node.assignee?.name ?? null,
        node.delegate?.name ?? null,
        node.updatedAt,
      ]),
      order: args.query ? 'search relevance' : 'most recently updated first',
      note: `This is every matching ticket (${String(nodes.length)}). No descriptions here by design; read a ticket with get_issue before acting on it.`,
    };
  }

  private async updateIssue(id: string, input: Record<string, unknown>) {
    const data = await this.gql<{
      issueUpdate: {
        success: boolean;
        issue: { id: string; identifier: string; updatedAt: string; description: string | null };
      };
    }>(ISSUE_UPDATE, { id, input });
    if (!data.issueUpdate.success)
      throw new Error(`Linear reported issueUpdate as unsuccessful for ${id}`);
    return data.issueUpdate.issue;
  }

  /**
   * Takes the ticket for the caller and records what the description said at
   * that moment. An agent (app) identity becomes the delegate, whoever is
   * assignee: Linear's delegation model keeps a person accountable as
   * assignee and the agent as the one doing the work. A person's key, which
   * can't be a delegate, becomes the assignee. Claiming again refreshes the record, which
   * is how a claimant acknowledges a changed description. Never takes a
   * ticket another agent holds, and takes a person's assignment only with
   * `take_over`.
   */
  async claim(id: string, args: ClaimArgs = {}) {
    const issue = await this.writable(id);
    const viewer = await this.viewer();

    if (issue.delegate && issue.delegate.id !== viewer.id) {
      throw new Error(
        `${issue.identifier} is delegated to ${nameOf(issue.delegate)}. Ask them to release it before claiming.`,
      );
    }

    const otherOwner = issue.assignee && issue.assignee.id !== viewer.id ? issue.assignee : null;
    if (otherOwner?.app) {
      throw new Error(
        `${issue.identifier} is assigned to ${nameOf(otherOwner)}, another agent. Ask it to release the ticket before claiming.`,
      );
    }
    const as = args.as ?? (viewer.app ? 'delegate' : 'assignee');
    if (as === 'delegate' && !viewer.app) {
      throw new Error(
        `${issue.identifier} is assigned to ${otherOwner ? nameOf(otherOwner) : 'nobody'}, and only an agent (app) identity can be a delegate; this server is authenticated as ${viewer.name}, a user. If ${otherOwner ? nameOf(otherOwner) : 'the owner'} handed it to you, pass as: "assignee" with take_over: true.`,
      );
    }
    if (as === 'assignee' && otherOwner && !args.take_over) {
      throw new Error(
        `${issue.identifier} is assigned to ${nameOf(otherOwner)}; claiming as assignee would take it from them. Pass take_over: true only if they handed it to you.`,
      );
    }

    const field = as === 'assignee' ? 'assigneeId' : 'delegateId';
    const alreadyHeld =
      as === 'assignee' ? issue.assignee?.id === viewer.id : issue.delegate?.id === viewer.id;
    const updated = alreadyHeld
      ? { updatedAt: issue.updatedAt, description: issue.description }
      : await this.updateIssue(issue.id, { [field]: viewer.id });

    const record: ClaimRecord = {
      issueId: issue.id,
      identifier: issue.identifier,
      claimedAt: this.now().toISOString(),
      claimedBy: { id: viewer.id, name: viewer.displayName || viewer.name },
      updatedAt: updated.updatedAt,
      description: updated.description ?? '',
    };
    const previous = this.claims.get(issue.id, viewer.id);
    this.claims.put(record);

    return {
      identifier: issue.identifier,
      claimed_as: as,
      by: record.claimedBy.name,
      claimed_at: record.claimedAt,
      ...(previous
        ? {
            reclaimed: true,
            description_changed_since_previous_claim: previous.description !== record.description,
          }
        : {}),
    };
  }

  /** Whether the description changed since the caller's claim, with the diff. */
  async checkClaim(id: string) {
    const issue = await this.core(id);
    const viewer = await this.viewer();
    const claim = this.claims.get(issue.id, viewer.id);
    if (!claim) {
      return {
        identifier: issue.identifier,
        claimed: false,
        reason: `No claim by ${viewer.name} is recorded on this machine.`,
      };
    }
    return {
      identifier: issue.identifier,
      claimed: true,
      ...this.claimStatus(claim, issue.description ?? ''),
    };
  }

  /**
   * Writes a new description and keeps the caller's claim snapshot honest:
   * the snapshot advances to the written text only when the description the
   * patch was applied to is the one the claimant last saw. Otherwise someone
   * else changed it in between, and the snapshot stays where it was so the
   * Done check still reports that change.
   *
   * Linear has no conditional update, so the description is read again just
   * before the write, and the write is refused if it moved since this call
   * read it. That narrows the window in which a patch would overwrite another
   * writer's change to the time between those two requests.
   */
  private async writeDescription(issue: IssueCore, next: string, marker?: StoredMarker) {
    const viewer = await this.viewer();
    // A marker line left in the description from before markers moved to an attachment goes with this write.
    next = stripMarker(next);
    const before = issue.description ?? '';
    const current = (await this.core(issue.id)).description ?? '';
    if (current !== before) {
      throw new Error(
        `Nothing was written: ${issue.identifier}'s description changed after this call read it, and writing now would overwrite that change. What changed:\n${lineDiff(before, current)}\n\nRead the ticket again, then repeat the call against what it says now.`,
      );
    }
    // A write that changes nothing still rebuilds Linear's rich-text document, dropping its text
    // attribution, so the same text is not sent again. The marker below may still move.
    const updated =
      next === before
        ? { updatedAt: issue.updatedAt, description: before }
        : await this.updateIssue(issue.id, { description: next });
    const written = updated.description ?? '';

    const claim = this.claims.get(issue.id, viewer.id);
    let unseenChange: string | null = null;
    if (claim) {
      if (claim.description === before) {
        this.claims.put({ ...claim, description: written, updatedAt: updated.updatedAt });
      } else {
        unseenChange = lineDiff(claim.description, before);
      }
    }

    // The marker's hash follows the description this server wrote, so a later
    // read can tell a description changed elsewhere from one written here.
    const keep = marker ?? findMarker(issue)?.marker;
    let markerWarning: string | null = null;
    if (keep) {
      try {
        const data = await this.gql<{ attachmentCreate: { success: boolean } }>(MARKER_UPSERT, {
          input: markerAttachmentInput(issue.id, keep, descriptionSha(written)),
        });
        if (!data.attachmentCreate.success)
          throw new Error('Linear reported attachmentCreate as unsuccessful');
        // A card left at an earlier version's URL would show the ticket two markers.
        for (const old of issue.markerAttachment?.nodes ?? []) {
          if (old.url !== MARKER_URL) await this.gql(MARKER_DELETE, { id: old.id });
        }
      } catch (error) {
        if (marker) {
          throw new Error(
            `The description was written, but the reconciled marker was not: ${errorMessage(error)}. The section patches landed. Repeat the call with reconciled_through and no patch to move the marker.`,
          );
        }
        markerWarning = `The description was written, but its reconciled marker could not be updated (${errorMessage(error)}), so the next read may report the description as changed elsewhere.`;
      }
    }
    return { written, unseenChange, markerWarning };
  }

  /**
   * Patch named sections of the description, and optionally move the
   * reconciled marker. Every description write on this server, here or in
   * comment(), goes through the same validated section patches.
   */
  async setState(
    id: string,
    patches: SectionPatch[] = [],
    reconciledThrough?: string,
    accountsFor: Accounting[] = [],
    descopeReason?: string,
    base?: string,
    descopeRisk?: string,
    signOffToken?: string,
  ) {
    if (!Array.isArray(patches)) throw new Error('patch must be an array');
    if (patches.length === 0 && !reconciledThrough) {
      throw new Error(
        'Pass at least one section patch, or reconciled_through to confirm the description already reflects the thread',
      );
    }
    if (accountsFor.length > 0 && !reconciledThrough)
      throw new Error('accounts_for only applies with reconciled_through');
    const issue = await this.writable(id);
    this.checkBase(issue, base);
    const next = applySectionPatches(issue.description ?? '', patches);

    const reconciled = reconciledThrough
      ? await this.reconcile(issue, reconciledThrough, accountsFor, patches.length > 0)
      : null;

    const { dropped, note, signer, model } = await this.checkDescope(
      issue,
      next,
      descopeReason,
      'set_state',
      descopeRisk,
      signOffToken,
    );

    const { written, unseenChange, markerWarning } = await this.writeDescription(
      issue,
      next,
      reconciled?.moved,
    );
    const descope =
      dropped.length > 0 && descopeReason
        ? await this.postDescope(issue, dropped, descopeReason, descopeRisk, {
            note,
            signer,
            model,
          })
        : null;
    return {
      identifier: issue.identifier,
      updated_sections: patchSummary(patches),
      description_sha: this.remember(written),
      ...(reconciled
        ? { reconciled_through: reconciled.marker, accounted: reconciled.accounting }
        : {}),
      ...(descope ? { descope } : {}),
      ...(markerWarning ? { marker_warning: markerWarning } : {}),
      ...uncitedWarning(issue.description ?? '', written),
      ...(unseenChange
        ? {
            warning:
              'The description had changed since your claim before this patch. The patch landed, but the Done check will refuse until you re-read the ticket and claim again.',
            diff_since_claim: unseenChange,
          }
        : {}),
    };
  }

  /**
   * Checks that reconciled_through names a comment at or after the current
   * marker, and that every comment it newly covers is accounted for. Returns
   * the marker to store; writes nothing.
   */
  private async reconcile(
    issue: IssueCore,
    reconciledThrough: string,
    accountsFor: Accounting[],
    hasPatch: boolean,
  ) {
    const comments = await paginate<MarkerNode>(
      'comments',
      this.connection<MarkerNode>(
        connectionQuery(
          'comments',
          'id createdAt editedAt body user { name displayName app } botActor { name } externalUser { name }',
        ),
        issue.id,
        'comments',
      ),
    );
    const [gap] = comments.omitted;
    if (gap)
      throw new Error(`Could not read every comment to check reconciled_through: ${gap.reason}`);
    const ordered = [...comments.nodes].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const index = ordered.findIndex((comment) => comment.id === reconciledThrough);
    const through = ordered[index];
    if (!through)
      throw new Error(
        `reconciled_through: ${reconciledThrough} is not a comment on ${issue.identifier}`,
      );

    const previous = findMarker(issue)?.marker ?? null;
    const start = previous ? firstUncovered(ordered, previous) : 0;
    if (start > index + 1 || start === -1) {
      throw new Error(
        `The description is already reconciled through a later comment (${previous?.through ?? 'unknown'}); reconciled_through cannot move back.`,
      );
    }
    // Comments the previous marker already covered, edited since it was written, need accounting again.
    const edited = previous ? editedSince(ordered.slice(0, start), previous.checked) : [];
    const accounting = checkAccounting(
      [...edited, ...ordered.slice(start, index + 1)],
      accountsFor,
      hasPatch,
    );

    const viewer = await this.viewer();
    const moved: StoredMarker = {
      through: through.id,
      at: through.createdAt,
      by: viewer.displayName || viewer.name,
      checked: this.now().toISOString(),
    };
    const later = ordered.length - index - 1;
    const marker = later > 0 ? { ...moved, comments_still_after: later } : moved;
    return { moved, marker, accounting };
  }

  /** Records an approved descope as a comment, naming who signed off and why. */
  private async postDescope(
    issue: IssueCore,
    dropped: string[],
    reason: string,
    risk: string | undefined,
    {
      note,
      signer,
      model,
    }: { note?: string | undefined; signer?: string | undefined; model?: string | undefined },
  ) {
    const viewer = await this.viewer();
    const label = viewer.app ? nameOf(viewer) : `agent via ${nameOf(viewer)}`;
    const judged = signer === 'judge';
    const body = [
      `🤖 ${label} · ${this.today()} · descope`,
      '',
      judged
        ? `Dropped from Done when, approved by a model judge (${model ?? 'unknown model'}) standing in for the person, who was not asked:`
        : `Dropped from Done when, with sign-off from the person at the client:`,
      ...dropped.map((item) => `- ${item}`),
      '',
      `Reason: ${reason.trim()}`,
      ...(risk?.trim() ? ['', `What stops being checked: ${risk.trim()}`] : []),
      ...(note ? ['', `${judged ? 'The judge wrote' : 'They wrote'}: ${note}`] : []),
    ].join('\n');
    try {
      const comment = await this.postComment(issue.id, body);
      return {
        dropped,
        reason: reason.trim(),
        signed_off: true,
        signed_off_by: judged ? `judge (${model ?? 'unknown model'})` : 'person',
        comment_url: comment.url,
      };
    } catch (error) {
      throw new Error(
        `The description was written without ${dropped.join('; ')}, but the descope comment recording the reason did not post: ${errorMessage(error)}. Post the reason with comment kind evidence.`,
      );
    }
  }

  /**
   * Dropping or rewording an unticked Done when item is removing a check,
   * which the agent that would otherwise fail it does not get to do alone:
   * it needs a reason and a yes from the person at the client. Returns the
   * dropped items once approved; throws otherwise, before anything is written.
   */
  private async checkDescope(
    issue: IssueCore,
    next: string,
    reason: string | undefined,
    via = 'set_state',
    risk?: string,
    token?: string,
  ) {
    const dropped = droppedChecks(issue.description ?? '', next);
    if (dropped.length === 0) {
      if (reason)
        throw new Error(
          'descope_reason was given, but this patch drops no unticked Done when item.',
        );
      if (token)
        throw new Error('sign_off was given, but this patch drops no unticked Done when item.');
      return { dropped, note: undefined, signer: undefined, model: undefined };
    }
    const list = dropped.map((item) => `- [ ] ${item}`).join('\n');
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
    const raw = this.signOff
      ? await this.signOff({
          identifier: issue.identifier,
          title: issue.title,
          dropped,
          added: addedChecks(issue.description ?? '', next),
          reason: reason.trim(),
          risk: risk.trim(),
          description: issue.description ?? '',
          token,
        })
      : 'unavailable';
    const answer: SignOffAnswer = typeof raw === 'string' ? { outcome: raw } : raw;
    const { outcome, note, returned } = answer;
    if (outcome === 'approved')
      return { dropped, note, signer: answer.signer ?? 'person', model: answer.model };
    const ask = `Nothing was written. Dropping these items needs sign-off:\n${list}`;
    if (outcome === 'pending') throw new Error(`${ask}\n\n${answer.instructions ?? ''}`);
    const said = note
      ? `\n\n${answer.signer === 'judge' ? `The judge (${answer.model ?? 'a model'}) wrote` : 'They wrote'}: ${note}`
      : '';
    const client = returned ? `\n\nThe client returned ${returned}.` : '';
    if (outcome === 'declined' && answer.signer === 'judge') {
      throw new Error(
        `The sign-off judge declined. ${ask}${said}\n\nDo the checks, put the evidence the judge asked for in Observed and retry, or leave the items for a person.`,
      );
    }
    if (outcome === 'declined')
      throw new Error(
        `Your user declined. ${ask}${said}${client}\n\nDo the checks, or ask them what should change.`,
      );
    if (outcome === 'unanswered' && answer.signer === 'judge') {
      throw new Error(
        `The sign-off judge gave no verdict (${returned ?? 'no detail'}). ${ask}\n\nRetry in a while, or leave the items for a person.`,
      );
    }
    if (outcome === 'unanswered') {
      throw new Error(
        `The approval request got no answer. ${ask}${client}\n\nThe form may still be on your user's screen, and an answer to it now reaches nothing. Tell them to dismiss it, ask whether they want to approve, and retry once they are there to answer.`,
      );
    }
    throw new Error(
      `This client cannot ask your user to approve it. ${ask}\n\nAsk a person to remove or reword the items in Linear; their edit is the sign-off. Then claim again.`,
    );
  }

  private async postComment(issueId: string, body: string) {
    const data = await this.gql<{
      commentCreate: { success: boolean; comment: { id: string; url: string; createdAt: string } };
    }>(COMMENT_CREATE, { input: { issueId, body } });
    if (!data.commentCreate.success)
      throw new Error('Linear reported commentCreate as unsuccessful');
    return data.commentCreate.comment;
  }

  /**
   * A typed comment. A correction must carry the description patch that
   * makes the description say the corrected thing; an answer must name the
   * Open questions row it closes. The comment is the log, the description
   * is the state, and neither lands without the other.
   */
  async comment(id: string, args: CommentArgs) {
    const patch = args.patch ?? [];
    checkCommentArgs(args, patch);

    const issue = await this.writable(id);
    this.checkBase(issue, args.base);
    const viewer = await this.viewer();

    // Validate everything before the first write, so a refusal writes nothing.
    let description = issue.description ?? '';
    if (patch.length > 0) {
      description = applySectionPatches(description, patch);
      await this.checkDescope(issue, description, undefined, 'comment');
    }
    const questionId = questionFor(args, description);
    const closedBy =
      args.kind === 'closed_by' && args.closed_by
        ? await this.closingIssue(issue, args.closed_by)
        : null;
    const mention =
      args.kind === 'ask' && args.ask_to ? await this.mentionFor(args.ask_to, viewer) : null;

    const label = commentLabel(args, viewer);
    const date = this.today();
    const subject = questionId ?? closedBy?.identifier;
    const header = `🤖 ${label} · ${date} · ${args.kind}${subject ? ` ${subject}` : ''}`;
    const askLine = mention && 'url' in mention ? `\n\nAsking ${mention.url}` : '';
    const patchNote =
      patch.length > 0 ? `\n\nDescription updated: ${patchSummary(patch).join(', ')}.` : '';
    const draft: CommentDraft = {
      issue,
      args,
      patch,
      description,
      date,
      label,
      text: `${header}\n\n${args.body.trim()}${askLine}${patchNote}`,
    };

    if (args.kind === 'correction' || args.kind === 'evidence') return this.postLogged(draft);
    if (closedBy && args.relation) return this.postClosedBy(draft, closedBy, args.relation);
    return this.postQuestionRow(draft, questionId, mention);
  }

  private async closingIssue(issue: IssueCore, ref: string) {
    const found = await this.gql<{ issue: { id: string; identifier: string } | null }>(
      ISSUE_ID_QUERY,
      { id: ref },
    );
    if (!found.issue) throw new Error(`closed_by: ${ref} not found`);
    if (found.issue.id === issue.id) throw new Error('closed_by names this same ticket');
    return found.issue;
  }

  // Linear turns a profile URL in a comment into a mention, which notifies the person; a name
  // alone is plain text nobody is told about. A name that doesn't resolve to one member stays text.
  private async mentionFor(askTo: string, viewer: Viewer): Promise<Mention> {
    try {
      const person = await findUser(this.gql, askTo, viewer);
      return person.url ? { url: person.url } : { unresolved: 'Linear returned no profile URL' };
    } catch (error) {
      return { unresolved: errorMessage(error) };
    }
  }

  // A correction's patch lands before its comment: if the comment then
  // fails, the description is still right and only the log entry is missing.
  private async postLogged({ issue, args, patch, description, text }: CommentDraft) {
    const wrote = patch.length > 0 ? await this.writeDescription(issue, description) : null;
    let comment;
    try {
      comment = await this.postComment(issue.id, text);
    } catch (error) {
      throw new Error(
        `The description patch landed but the comment did not post (${errorMessage(error)}). Retry the comment as kind "evidence" without a patch.`,
      );
    }
    return {
      identifier: issue.identifier,
      kind: args.kind,
      comment_url: comment.url,
      ...(wrote
        ? {
            updated_sections: patchSummary(patch),
            description_sha: this.remember(wrote.written),
          }
        : {}),
      ...(patch.length > 0 ? uncitedWarning(issue.description ?? '', description) : {}),
      ...(wrote?.unseenChange
        ? {
            warning: 'The description had changed since your claim.',
            diff_since_claim: wrote.unseenChange,
          }
        : {}),
    };
  }

  private async postClosedBy(
    { issue, args, description, date, text }: CommentDraft,
    closedBy: { id: string; identifier: string },
    relation: 'duplicate' | 'fixed_there',
  ) {
    const comment = await this.postComment(issue.id, text);
    const steps: string[] = [];
    try {
      // Linear reads a duplicate relation as "issueId duplicates relatedIssueId".
      await this.gql(RELATION_CREATE, {
        input: {
          issueId: issue.id,
          relatedIssueId: closedBy.id,
          type: relation === 'duplicate' ? 'duplicate' : 'related',
        },
      });
      steps.push('relation');
      const line = `Closed by ${closedBy.identifier} (${relation === 'duplicate' ? 'duplicate' : 'fixed there'}) on ${date} · [comment](${comment.url})`;
      await this.writeDescription(
        issue,
        applySectionPatches(description, [{ section: 'Fix', mode: 'append', body: line }]),
      );
      steps.push('description');
    } catch (error) {
      throw new Error(
        `The comment posted (${comment.url}) but only [${steps.join(', ') || 'nothing'}] of [relation, description] landed: ${errorMessage(error)}`,
      );
    }
    return {
      identifier: issue.identifier,
      kind: args.kind,
      closed_by: closedBy.identifier,
      relation,
      comment_url: comment.url,
    };
  }

  // ask and answer need the comment's URL for the row, so the comment goes first.
  private async postQuestionRow(
    { issue, args, patch, description, date, label, text }: CommentDraft,
    questionId: string | null,
    mention: Mention | null,
  ) {
    const comment = await this.postComment(issue.id, text);
    const rowId = questionId ?? nextQuestionId(description);
    let sha: string;
    try {
      const next =
        args.kind === 'ask'
          ? addQuestion(description, {
              id: rowId,
              date,
              askedBy: label,
              askedTo: args.ask_to,
              question: args.body.split('\n')[0] ?? args.body,
              link: comment.url,
            })
          : answerQuestion(description, rowId, date, comment.url);
      sha = this.remember((await this.writeDescription(issue, next)).written);
    } catch (error) {
      throw new Error(
        `The comment posted (${comment.url}) but the Open questions row was not written: ${errorMessage(error)}. The description does not reflect this ${args.kind} yet.`,
      );
    }
    return {
      identifier: issue.identifier,
      kind: args.kind,
      question: questionId,
      comment_url: comment.url,
      ...mentionResult(mention, args.ask_to),
      description_sha: sha,
      ...(patch.length > 0 ? { updated_sections: patchSummary(patch) } : {}),
    };
  }

  /**
   * Changes the fields that are not the ticket's content: priority, owner,
   * labels, cycle, project, milestone, parent, dates, estimate, relations.
   * Everything is resolved and checked first; the field update is one write,
   * and relations follow it.
   */
  async setFields(id: string, changes: FieldChanges) {
    const issue = await this.writable(id);
    const viewer = await this.viewer();
    const { input, changed, relations } = await resolveFields(this.gql, issue, viewer, changes);

    let updatedAt = issue.updatedAt;
    if (Object.keys(input).length > 0)
      updatedAt = (await this.updateIssue(issue.id, input)).updatedAt;

    const added: string[] = [];
    for (const relation of relations) {
      try {
        await this.gql(RELATION_CREATE, {
          input: {
            issueId: relation.issueId,
            relatedIssueId: relation.relatedIssueId,
            type: relation.type,
          },
        });
      } catch (error) {
        throw new Error(
          `${changed.length > 0 ? `The field changes landed (${changed.join(', ')})` : 'No field changes were asked for'}, and ${added.length > 0 ? `only ${added.join(', ')}` : 'none'} of the relations did before "${relation.label}" failed: ${errorMessage(error)}`,
        );
      }
      added.push(relation.label);
    }
    return {
      identifier: issue.identifier,
      changed,
      ...(added.length > 0 ? { relations_added: added } : {}),
      updatedAt,
    };
  }

  /**
   * Moves the ticket to a workflow state by name. A completed state is the
   * Done gate, which needs the caller's claim and returns the diff instead of
   * moving the ticket if the description changed after it.
   */
  async setStatus(id: string, stateName: string, reason?: string) {
    const issue = await this.writable(id);
    const viewer = await this.viewer();
    const data = await this.gql<{
      issue: { team: { states: { nodes: { id: string; name: string; type: string }[] } } };
    }>(TEAM_STATES_QUERY, { id: issue.id });
    const states = data.issue.team.states.nodes;
    const target = states.find(
      (state) => state.name.toLowerCase() === stateName.trim().toLowerCase(),
    );
    if (!target) {
      throw new Error(
        `No state "${stateName}" on ${issue.team?.key ?? 'this team'}. States: ${states.map((s) => s.name).join(', ')}`,
      );
    }

    let unchecked: string[] = [];
    if (target.type === 'completed') {
      const doneWhen = readSection(issue.description ?? '', 'Done when');
      if (!doneWhen?.trim()) {
        throw new Error(
          `Refusing to move ${issue.identifier} to ${target.name}: the description has no Done when section, so nothing says what finished means. Add one with set_state (checklist items that each name the check that proves it), then retry.`,
        );
      }
      const claim = this.claims.get(issue.id, viewer.id);
      if (!claim) {
        throw new Error(
          `Refusing to move ${issue.identifier} to ${target.name}: no claim by ${viewer.name} is recorded, so there is nothing to check the description against. Claim it, re-read it, then retry.`,
        );
      }
      const status = this.claimStatus(claim, issue.description ?? '');
      if (status.edited_since_claim) {
        throw new Error(
          `Refusing to move ${issue.identifier} to ${target.name}: the description changed since your claim at ${claim.claimedAt}. Check the work against it, then claim again to acknowledge it.\n\n${status.diff_since_claim}`,
        );
      }
      const open = doneWhenItems(issue.description ?? '', UNTICKED);
      if (open.length > 0) {
        throw new Error(
          `Refusing to move ${issue.identifier} to ${target.name}: ${String(open.length)} Done when item${open.length === 1 ? ' is' : 's are'} not ticked:\n${open.map((item) => `- [ ] ${item}`).join('\n')}\n\nRun each check, add what it showed to Observed, and tick the item with set_state (replace the Done when section). If an item no longer applies, drop it with set_state and a descope_reason; your user is asked to approve it.`,
        );
      }
      const uncited = uncitedTicks(issue.description ?? '');
      if (uncited.length > 0) {
        throw new Error(
          `Refusing to move ${issue.identifier} to ${target.name}: ${String(uncited.length)} ticked Done when item${uncited.length === 1 ? ' does' : 's do'} not cite what showed ${uncited.length === 1 ? 'it' : 'them'} true:\n${uncited.map(({ item, reason }) => `- [x] ${item} (${reason})`).join('\n')}\n\n${CITING}`,
        );
      }
      unchecked = await this.citedPullRequestsMerged(
        issue.id,
        issue.identifier,
        target.name,
        issue.description ?? '',
      );
    }

    // Canceling ends the work without the Done checks, so it has to say why, where people will read it.
    const why = reason?.trim();
    if (target.type === 'canceled' && !why) {
      throw new Error(
        `Refusing to move ${issue.identifier} to ${target.name} without a reason: canceling skips the Done when checks, so pass reason saying why the work stops (duplicate of another ticket, no longer wanted, superseded by what).`,
      );
    }

    const updated = await this.updateIssue(issue.id, { stateId: target.id });
    if (target.type === 'completed' || target.type === 'canceled')
      this.claims.delete(issue.id, viewer.id);
    let reasonComment: string | null = null;
    if (why) {
      const label = viewer.app ? nameOf(viewer) : `agent via ${nameOf(viewer)}`;
      try {
        reasonComment = (
          await this.postComment(
            issue.id,
            `🤖 ${label} · ${this.today()} · ${target.name}\n\n${why}`,
          )
        ).url;
      } catch (error) {
        throw new Error(
          `${issue.identifier} moved to ${target.name}, but the comment giving the reason did not post: ${errorMessage(error)}. Post it with comment kind evidence.`,
        );
      }
    }
    return {
      identifier: issue.identifier,
      state: target.name,
      updatedAt: updated.updatedAt,
      ...(reasonComment ? { reason_comment: reasonComment } : {}),
      ...(unchecked.length > 0
        ? {
            unchecked_prs: `Linear's GitHub attachment gave no merge status for ${unchecked.join(', ')}, so whether ${unchecked.length === 1 ? 'it' : 'they'} merged was not checked.`,
          }
        : {}),
    };
  }

  /**
   * A PR cited on a ticked item and linked to this ticket has to be merged. A
   * PR linked elsewhere cannot be checked from here and passes; its citation
   * still tells a reader where to look. The status comes from the metadata
   * Linear's GitHub integration keeps on the attachment, which Linear doesn't
   * document, so only a status that says the PR is not merged refuses; a
   * missing or unfamiliar one passes and is named in the result.
   */
  private async citedPullRequestsMerged(
    id: string,
    identifier: string,
    stateName: string,
    description: string,
  ): Promise<string[]> {
    const cited = citedPullRequestNumbers(description);
    if (cited.length === 0) return [];
    const attachments = await this.soft<AttachmentNode>('attachments', ATTACHMENTS_QUERY, id);
    const linked = pullRequests(attachments.nodes).filter((pr) => cited.includes(pr.number));
    const unmerged = linked.filter((pr) => pr.draft || NOT_MERGED.includes(pr.status));
    if (unmerged.length > 0) {
      throw new Error(
        `Refusing to move ${identifier} to ${stateName}: a ticked Done when item cites ${unmerged.map((pr) => `PR #${String(pr.number)}, which is ${pr.draft ? 'a draft' : pr.status}`).join(' and ')}, not merged. Tick it once the PR merges, or cite the one that did.`,
      );
    }
    return linked
      .filter((pr) => pr.status !== 'merged' && !unmerged.includes(pr))
      .map((pr) => `PR #${String(pr.number)}`);
  }

  async createIssue(args: CreateIssueArgs) {
    const teams = await this.gql<{ teams: { nodes: { id: string; key: string }[] } }>(
      TEAM_BY_KEY_QUERY,
      {
        key: args.team,
      },
    );
    const team = teams.teams.nodes[0];
    if (!team) throw new Error(`No team with key "${args.team}". list_teams gives the keys.`);
    if (!args.title.trim()) throw new Error('title is empty');

    const description = args.sections?.length ? applySectionPatches('', args.sections) : undefined;
    const input = {
      teamId: team.id,
      title: args.title.trim(),
      ...(description !== undefined ? { description } : {}),
      ...(args.project_id ? { projectId: args.project_id } : {}),
      ...(args.parent ? { parentId: (await this.core(args.parent)).id } : {}),
    };

    const data = await this.gql<{
      issueCreate: {
        success: boolean;
        issue: { id: string; identifier: string; url: string; title: string };
      };
    }>(ISSUE_CREATE, { input });
    if (!data.issueCreate.success) throw new Error('Linear reported issueCreate as unsuccessful');
    return data.issueCreate.issue;
  }
}
