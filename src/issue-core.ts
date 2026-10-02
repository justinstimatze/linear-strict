/** The ticket fields every strict read and write loads, and how people in them are named. */
import type { Connection } from './graphql.js';
import type { ReleaseNode } from './facts.js';
import type { MarkerAttachment } from './marker.js';

export interface Person {
  id: string;
  name: string;
  displayName?: string;
  app?: boolean | null;
}

export interface Viewer extends Person {
  app: boolean;
}

export interface IssueCore {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  trashed?: boolean | null;
  state: { id: string; name: string; type: string } | null;
  team: { id: string; key: string; name: string } | null;
  assignee: Person | null;
  delegate: Person | null;
  creator: Person | null;
  parent: { id: string; identifier: string; title: string } | null;
  project: { id: string; name: string; status?: { type: string } | null } | null;
  releases?: Connection<ReleaseNode>;
  labels: Connection<{ id: string; name: string }>;
  markerAttachment?: { nodes: MarkerAttachment[] };
}

export function authorName(comment: {
  user: Person | null;
  botActor: { name: string } | null;
  externalUser: { name: string } | null;
}) {
  if (comment.user) return comment.user.displayName || comment.user.name;
  if (comment.botActor) return `${comment.botActor.name} (bot)`;
  if (comment.externalUser) return `${comment.externalUser.name} (external)`;
  return null;
}

export function nameOf(person: Person) {
  return person.displayName || person.name;
}

export function personOut(person: Person | null) {
  return person ? { id: person.id, name: nameOf(person) } : null;
}
