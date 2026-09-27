#!/usr/bin/env node
// Moves reconciled-marker lines written by earlier versions out of ticket
// descriptions and into the marker attachment. Dry run unless --apply.
//
//   npm run build && LINEAR_API_TOKEN=... node scripts/migrate-marker.mjs            list what would move
//   ... node scripts/migrate-marker.mjs --apply --only ENG-123                      move one ticket
//   ... node scripts/migrate-marker.mjs --apply                                     move them all
//
// --repoint instead moves marker cards left at an earlier version's URL to the
// current one, keeping their metadata; descriptions are not touched.
//
// --mine keeps only tickets the token's user created or is assigned, and whose
// every subscriber is that user or an app, so no other person is subscribed to see the edit.
//
// Per ticket: the attachment is written first, then the description without the
// line, and the description write is skipped if the description changed since it
// was read. A ticket that fails between the two keeps its line and has an
// attachment agreeing with it, so running again finishes it.
import { LEGACY_MARKER_URLS, MARKER_URL, markerAttachmentInput, markerFromAttachment } from '../dist/marker.js';
import { readMarker, stripMarker } from '../dist/sections.js';
import { descriptionSha } from '../dist/strict-linear.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
const mine = args.includes('--mine');
const repoint = args.includes('--repoint');
const token = process.env.LINEAR_API_TOKEN;
if (!token) {
  console.error('Set LINEAR_API_TOKEN.');
  process.exit(2);
}

async function gql(query, variables = {}) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token.startsWith('lin_api_') ? token : `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const FIND = `query MarkerSweep($after: String) {
  issues(first: 100, after: $after, includeArchived: true, filter: { description: { contains: "strict:reconciled" } }) {
    nodes { id identifier description trashed assignee { id } creator { id } subscribers(first: 50) { nodes { id name app } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const { viewer } = await gql(`query { viewer { id } }`);
const isMine = (issue) =>
  (issue.assignee?.id === viewer.id || issue.creator?.id === viewer.id) &&
  issue.subscribers.nodes.every((person) => person.id === viewer.id || person.app);

if (repoint) {
  const OLD = `query OldMarkers($after: String, $urls: [String!]) {
    attachments(first: 100, after: $after, filter: { url: { in: $urls } }) {
      nodes { id metadata issue { id identifier trashed assignee { id } creator { id } subscribers(first: 50) { nodes { id app } } } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const cards = [];
  for (let after = null; ; ) {
    const { attachments } = await gql(OLD, { after, urls: LEGACY_MARKER_URLS });
    cards.push(...attachments.nodes);
    if (!attachments.pageInfo.hasNextPage) break;
    after = attachments.pageInfo.endCursor;
  }
  const todo = cards.filter(
    (card) => card.issue && !card.issue.trashed && markerFromAttachment(card) && (!only || card.issue.identifier === only) && (!mine || isMine(card.issue)),
  );
  console.log(`${cards.length} cards at an earlier URL; ${todo.length} to move to ${MARKER_URL}.`);
  if (!apply) {
    for (const card of todo) console.log(`  ${card.issue.identifier}`);
    console.log('Dry run. Pass --apply to move them.');
    process.exit(0);
  }
  const failedCards = [];
  for (const card of todo) {
    try {
      const marker = markerFromAttachment(card);
      const created = await gql(`mutation ($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }`, {
        input: markerAttachmentInput(card.issue.id, marker, marker.sha ?? ''),
      });
      if (!created.attachmentCreate.success) throw new Error('attachmentCreate unsuccessful');
      await gql(`mutation ($id: String!) { attachmentDelete(id: $id) { success } }`, { id: card.id });
      console.log(`  moved ${card.issue.identifier}`);
    } catch (error) {
      failedCards.push(card.issue.identifier);
      console.log(`  FAILED ${card.issue.identifier}: ${error.message}`);
    }
  }
  console.log(`${todo.length - failedCards.length} moved, ${failedCards.length} failed${failedCards.length ? `: ${failedCards.join(', ')}` : ''}.`);
  process.exit(failedCards.length ? 1 : 0);
}

const found = [];
for (let after = null; ; ) {
  const { issues } = await gql(FIND, { after });
  found.push(...issues.nodes);
  if (!issues.pageInfo.hasNextPage) break;
  after = issues.pageInfo.endCursor;
}

const targets = found.filter(
  (issue) => !issue.trashed && readMarker(issue.description ?? '') && (!only || issue.identifier === only) && (!mine || isMine(issue)),
);
console.log(`${found.length} descriptions mention the marker; ${targets.length} to move${only ? ` (only ${only})` : ''}${mine ? ' (mine, no other person subscribed)' : ''}.`);
if (!apply) {
  for (const issue of targets) console.log(`  ${issue.identifier} through=${readMarker(issue.description).through}`);
  console.log('Dry run. Pass --apply to move them.');
  process.exit(0);
}

let moved = 0;
const failed = [];
for (const issue of targets) {
  const marker = readMarker(issue.description);
  const next = stripMarker(issue.description);
  try {
    const created = await gql(
      `mutation StrictMarkerUpsert($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }`,
      { input: markerAttachmentInput(issue.id, marker, descriptionSha(next)) },
    );
    if (!created.attachmentCreate.success) throw new Error('attachmentCreate unsuccessful');
    const { issue: current } = await gql(`query ($id: String!) { issue(id: $id) { description } }`, { id: issue.id });
    if (current.description !== issue.description) throw new Error('description changed since it was read; run again');
    const updated = await gql(
      `mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { description } } }`,
      { id: issue.id, input: { description: next } },
    );
    if (!updated.issueUpdate.success) throw new Error('issueUpdate unsuccessful');
    // Linear may normalise the markdown it stores; the hash has to be of what it kept.
    const stored = updated.issueUpdate.issue.description ?? '';
    if (descriptionSha(stored) !== descriptionSha(next)) {
      await gql(`mutation StrictMarkerUpsert($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }`, {
        input: markerAttachmentInput(issue.id, marker, descriptionSha(stored)),
      });
    }
    moved += 1;
    console.log(`  moved ${issue.identifier}`);
  } catch (error) {
    failed.push(issue.identifier);
    console.log(`  FAILED ${issue.identifier}: ${error.message}`);
  }
}
console.log(`${moved} moved, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''}.`);
process.exit(failed.length ? 1 : 0);
