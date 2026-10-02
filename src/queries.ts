/** The GraphQL documents StrictLinear sends. Strings only; nothing here runs a request. */
import { PAGE_SIZE } from './graphql.js';
import { MARKER_URLS } from './marker.js';

export const MARKER_UPSERT = `mutation StrictMarkerUpsert($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success attachment { id } }
}`;
export const MARKER_DELETE = `mutation StrictMarkerDelete($id: String!) { attachmentDelete(id: $id) { success } }`;

export const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

const ISSUE_CORE = `
  id identifier title description url priority createdAt updatedAt archivedAt trashed
  state { id name type }
  team { id key name }
  assignee { id name displayName app }
  delegate { id name displayName }
  creator { id name displayName }
  parent { id identifier title }
  project { id name status { type } }
  releases(first: 20) { nodes { name version url completedAt stage { name type } } ${PAGE_INFO} }
  labels(first: 100) { nodes { id name } ${PAGE_INFO} }
  markerAttachment: attachments(first: 5, filter: { url: { in: ${JSON.stringify(MARKER_URLS)} } }) { nodes { id url metadata } }
`;

export const ISSUE_QUERY = `query StrictIssue($id: String!) { issue(id: $id) { ${ISSUE_CORE} } }`;

export function connectionQuery(field: string, nodeFields: string) {
  return `query StrictIssue_${field}($id: String!, $after: String) {
  issue(id: $id) { ${field}(first: ${PAGE_SIZE}, after: $after) { nodes { ${nodeFields} } ${PAGE_INFO} } }
}`;
}

export const COMMENTS_QUERY = connectionQuery(
  'comments',
  'id body createdAt updatedAt editedAt url parent { id } user { id name displayName app } botActor { name } externalUser { name }',
);

export const HISTORY_QUERY = connectionQuery(
  'history',
  'id createdAt updatedDescription actor { id name displayName } botActor { name }',
);
export const RELATIONS_QUERY = connectionQuery(
  'relations',
  'id type relatedIssue { identifier title }',
);
export const INVERSE_RELATIONS_QUERY = connectionQuery(
  'inverseRelations',
  'id type issue { identifier title }',
);
export const CHILDREN_QUERY = connectionQuery('children', 'identifier title state { name type }');
export const ATTACHMENTS_QUERY = connectionQuery(
  'attachments',
  'id title subtitle url createdAt sourceType metadata',
);

export const DESCRIPTION_DOC_QUERY = `query StrictDescriptionDoc($id: String!) {
  issue(id: $id) { id identifier description documentContent { id } }
}`;
export const CONTENT_HISTORY_QUERY = `query StrictContentHistory($id: String!) {
  documentContentHistory(id: $id) { success history { contentDataSnapshotAt actorIds contentData } }
}`;
export const USERS_BY_ID_QUERY = `query StrictUsersById($ids: [ID!]) {
  users(filter: { id: { in: $ids } }, includeDisabled: true, first: 100) { nodes { id name displayName } }
}`;

export const VIEWER_QUERY = `query StrictViewer { viewer { id name displayName app } }`;

export const ISSUE_UPDATE = `mutation StrictIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id identifier updatedAt description } }
}`;

export const COMMENT_CREATE = `mutation StrictCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url createdAt } }
}`;

export const TEAM_STATES_QUERY = `query StrictTeamStates($id: String!) {
  issue(id: $id) { team { states(first: 100) { nodes { id name type } } } }
}`;

export const ISSUE_ID_QUERY = `query StrictIssueId($id: String!) { issue(id: $id) { id identifier } }`;

// "contributes" links the PR without the magic-word automation "closes" carries, which would
// move the ticket when the PR merges.
export const PR_LINK = `mutation StrictPrLink($issueId: String!, $url: String!) {
  attachmentLinkGitHubPR(issueId: $issueId, url: $url, linkKind: contributes) { success attachment { url metadata } }
}`;

export const RELATION_CREATE = `mutation StrictRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`;

export const TEAM_BY_KEY_QUERY = `query StrictTeamByKey($key: String!) {
  teams(filter: { key: { eqIgnoreCase: $key } }) { nodes { id key name } }
}`;

export const ISSUE_CREATE = `mutation StrictIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url title } }
}`;

export const LIST_FIELDS = `identifier title updatedAt state { name type } assignee { name } delegate { name }`;

export const SEARCH_ISSUES_QUERY = `query StrictSearch($term: String!, $first: Int, $after: String, $filter: IssueFilter) {
  searchIssues(term: $term, first: $first, after: $after, filter: $filter) { nodes { ${LIST_FIELDS} } ${PAGE_INFO} }
}`;

export const LIST_ISSUES_QUERY = `query StrictList($first: Int, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) { nodes { ${LIST_FIELDS} } ${PAGE_INFO} }
}`;
