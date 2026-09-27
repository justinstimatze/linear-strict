/**
 * How get_issue shapes what Linear returns: comments with their author kind,
 * description edits, relations both ways, releases, and the attachments that
 * are neither a PR nor the reconciled marker.
 */
import {
  type AttachmentNode,
  type PullRequest,
  type ReleaseNode,
  commentAuthorKind,
} from './facts.js';
import type { Omission } from './graphql.js';
import { type IssueCore, type Person, authorName } from './issue-core.js';
import { MARKER_URLS } from './marker.js';

export interface CommentNode {
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

export interface HistoryNode {
  id: string;
  createdAt: string;
  updatedDescription: boolean | null;
  actor: Person | null;
  botActor: { name: string } | null;
}

export interface RelationNode {
  id: string;
  type: string;
  relatedIssue: { identifier: string; title: string };
}

export interface InverseRelationNode {
  id: string;
  type: string;
  issue: { identifier: string; title: string };
}

export interface ChildNode {
  identifier: string;
  title: string;
  state: { name: string; type: string } | null;
}

/** Releases and labels come in one page with the ticket; say when there were more. */
export function cappedFields(issue: IssueCore): Omission[] {
  const omitted: Omission[] = [];
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
  return omitted;
}

export function commentOut(comment: CommentNode) {
  const { kind, basis } = commentAuthorKind(comment);
  return {
    id: comment.id,
    createdAt: comment.createdAt,
    author: authorName(comment),
    author_kind: kind,
    author_kind_basis: basis,
    edited_after_posting: comment.editedAt !== null,
    editedAt: comment.editedAt,
    parentId: comment.parent?.id ?? null,
    url: comment.url,
    body: comment.body,
  };
}

/** The history entries that changed the description, oldest first. */
export function descriptionEdits(history: HistoryNode[]) {
  return history
    .filter((entry) => entry.updatedDescription)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((entry) => ({
      at: entry.createdAt,
      by: entry.actor
        ? entry.actor.displayName || entry.actor.name
        : (entry.botActor?.name ?? null),
    }));
}

export function relationsOut(relations: RelationNode[], inverse: InverseRelationNode[]) {
  return [
    ...relations.map((r) => ({
      type: r.type,
      direction: 'outgoing',
      issue: r.relatedIssue,
    })),
    ...inverse.map((r) => ({ type: r.type, direction: 'incoming', issue: r.issue })),
  ];
}

export function releasesOut(releases: ReleaseNode[]) {
  return releases.map((release) => ({
    name: release.name,
    version: release.version,
    stage: release.stage?.name ?? null,
    completed: release.stage?.type === 'completed',
    url: release.url,
  }));
}

/** Attachments other than PRs, which are listed on their own, and the reconciled marker. */
export function otherAttachments(attachments: AttachmentNode[], prs: PullRequest[]) {
  return attachments
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
    }));
}
