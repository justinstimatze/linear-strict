// End-to-end check of the strict tools against a real Linear workspace.
// Creates one temporary issue, exercises every strict tool on it, and moves it
// to the trash at the end, including when a step fails.
//
//   LINEAR_API_TOKEN=... LIVE_TEAM=ENG [LIVE_HUMAN_ID=<user id>] npm run test:live
//
// LIVE_HUMAN_ID is only used with an agent (app) token: the issue is assigned to
// that person so the claim has to take the delegate path.
//
// The issue goes in LIVE_PROJECT_ID, or else the team's first open project,
// and the two it files for the duplicate step go under it.
//
// LIVE_PR_URL, a merged GitHub PR in a repository the workspace's GitHub
// integration sees, adds a link_prs step. Linear's bot may comment on that PR
// when it is linked, so pick one where a comment from a test issue is fine.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileClaimStore } from '../dist/claims.js';
import { getExplicitLinearAuthConfig } from '../dist/config.js';
import { linearGql } from '../dist/linear.js';
import { StrictLinear } from '../dist/strict-linear.js';
import { strictToolHandlers } from '../dist/tools.js';

const COMMENT_COUNT = Number(process.env.LIVE_COMMENTS ?? 110);
const team = process.env.LIVE_TEAM;
if (!team) throw new Error('Set LIVE_TEAM to a team key the token can write to');

const auth = getExplicitLinearAuthConfig();
if (!auth) throw new Error('Set LINEAR_API_TOKEN');
const gql = linearGql({ token: auth.token, kind: auth.type });
const stateDir = mkdtempSync(path.join(process.env.LIVE_STATE_DIR ?? tmpdir(), 'strict-live-'));
const strict = new StrictLinear({ gql, claims: fileClaimStore(path.join(stateDir, 'claims.json')) });

const step = (name) => console.log(`\n== ${name}`);
const raw = (query, variables) => gql(query, variables);
const outOfBand = (id, input) =>
  raw(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, { id, input });

let created = null;
let other = null;
try {
  const viewer = await strict.viewer();
  console.log(`auth=${auth.type} viewer=${viewer.name} app=${viewer.app}`);
  assert.deepEqual(await strictToolHandlers(strict).whoami({}), viewer, 'whoami must return the viewer');

  step('create_issue');
  const projectId =
    process.env.LIVE_PROJECT_ID ?? (await strict.workspace.listProjects({ team })).projects[0]?.id;
  if (!projectId) throw new Error(`Team ${team} has no open project; set LIVE_PROJECT_ID`);
  const filing = {
    team,
    project_id: projectId,
    title: `[strict-mcp live test ${new Date().toISOString()}] ignore, auto-deleted`,
    sections: [
      { section: 'Observed', mode: 'replace', body: '- 2026-09-24 · scripts/live-test.mjs · created by the live test' },
      { section: 'Done when', mode: 'replace', body: '- [ ] the live test deletes this issue' },
    ],
  };
  await assert.rejects(strict.createIssue({ ...filing, project_id: undefined }), /needs a home/);
  try {
    created = await strict.createIssue(filing);
  } catch (error) {
    // The team's closest open tickets, which the filing has to account for.
    if (error?.name !== 'OverlapRefusal') throw error;
    const close = error.candidates.map((c) => c.identifier);
    console.log('overlap check named', close.join(', '));
    created = await strict.createIssue({
      ...filing,
      new_because: 'A throwaway ticket the linear-strict live test files and deletes.',
      distinct_from: close,
    });
    assert.ok(created.filed_new?.comment_url, `the reason is posted: ${JSON.stringify(created.filed_new)}`);
  }
  assert.ok(created.your_unclaimed, 'create_issue returns the unclaimed filings');
  console.log(created.identifier, created.url, 'unclaimed:', JSON.stringify(created.your_unclaimed).slice(0, 300));
  const id = created.identifier;

  if (viewer.app && process.env.LIVE_HUMAN_ID) await outOfBand(id, { assigneeId: process.env.LIVE_HUMAN_ID });

  step(`seed ${COMMENT_COUNT} comments`);
  const seeded = [];
  for (let i = 1; i <= COMMENT_COUNT; i++) {
    const data = await raw(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }`,
      { input: { issueId: created.id, body: `seed ${i}` } },
    );
    seeded.push(data.commentCreate.comment.id);
  }

  step('get_issue reads every comment oldest-first');
  let read = await strict.getIssue(id);
  assert.equal(read.comments.length, COMMENT_COUNT);
  assert.deepEqual(read.comments.slice(0, 3).map((c) => c.body), ['seed 1', 'seed 2', 'seed 3']);
  assert.equal(read.comments.at(-1).body, `seed ${COMMENT_COUNT}`);
  console.log('omitted:', JSON.stringify(read.omitted));
  console.log('findings:', JSON.stringify(read.findings));
  assert.equal(read.drift.needs_reconcile, true);

  step('set_state with reconciled_through keeps the marker');
  await assert.rejects(strict.setState(id, [], { reconciled_through: seeded.at(-1) }), /not accounted for/, 'unaccounted comments block the marker');
  const reconciled = await strict.setState(id, [], { reconciled_through: seeded.at(-1), accounts_for: [
    { comment: '*', how: 'no_state_change', reason: 'seeded test comments' },
  ] });
  console.log(JSON.stringify(reconciled.reconciled_through));
  read = await strict.getIssue(id);
  assert.equal(read.drift.reconciled_through?.through, seeded.at(-1));
  assert.equal(read.drift.needs_reconcile, false);

  step('claim');
  const claim = await strict.claim(id);
  console.log(JSON.stringify(claim));
  if (viewer.app && process.env.LIVE_HUMAN_ID) assert.equal(claim.claimed_as, 'delegate');

  step('priority-only change does not trip the Done gate');
  await outOfBand(id, { priority: 4 });
  assert.equal((await strict.checkClaim(id)).edited_since_claim, false);

  step('out-of-band description edit trips it');
  const beforeEdit = (await strict.getIssue(id)).issue;
  const current = beforeEdit.description;
  await outOfBand(id, { description: current.replace('- [ ] the live test', '- [ ] a late criterion\n- [ ] the live test') });
  const doneState = (
    await raw(`query($id: String!) { issue(id: $id) { team { states { nodes { name type } } } } }`, { id })
  ).issue.team.states.nodes.find((s) => s.type === 'completed').name;
  await assert.rejects(strict.setStatus(id, doneState), (error) => {
    console.log(error.message);
    return /a late criterion/.test(error.message);
  });

  step('a patch built from the read before that edit is refused');
  const stale = [{ section: 'Observed', mode: 'append', body: '- 2026-09-24 · scripts/live-test.mjs · stale patch' }];
  await assert.rejects(strict.setState(id, stale, { base: beforeEdit.description_sha }), /no longer the one your base[\s\S]*a late criterion/);

  step('typed comments');
  await assert.rejects(strict.comment(id, { kind: 'correction', body: 'no patch' }), /must carry a description patch/);
  const correction = await strict.comment(id, {
    kind: 'correction',
    body: 'Adding the observation the edit implied.',
    patch: [{ section: 'Observed', mode: 'append', body: '- 2026-09-24 · scripts/live-test.mjs · late criterion added out of band' }],
    author_label: 'live-test',
  });
  console.log(JSON.stringify(correction));
  const ask = await strict.comment(id, { kind: 'ask', body: 'Does the answer flip this row?', author_label: 'live-test' });
  await strict.comment(id, { kind: 'answer', body: 'It should.', answers: ask.question, author_label: 'live-test' });
  read = await strict.getIssue(id);
  assert.deepEqual(read.issue.open_questions, []);
  assert.match(read.issue.description, new RegExp(`${ask.question} · ANSWERED`));
  assert.equal(read.drift.reconciled_through?.through, seeded.at(-1), 'marker survived later writes');
  console.log('unreconciled after typed comments:', read.drift.unreconciled_comments.map((c) => c.kind).join(','));
  assert.ok(
    read.drift.unreconciled_comments.every((c) => c.kind !== 'correction' && c.kind !== 'answer' && c.kind !== 'ask'),
    'typed comments that already changed the description are not drift',
  );

  step('re-claim acknowledges, unticked items still block, then Done passes');
  await strict.claim(id);
  await assert.rejects(strict.setStatus(id, doneState), (error) => {
    console.log(error.message);
    return /2 Done when items are not ticked/.test(error.message);
  });
  await assert.rejects(
    strict.setState(id, [{ section: 'Done when', mode: 'replace', body: '- [ ] the live test deletes this issue' }], { descope_reason: 'live test', descope_risk: 'the live test stops checking its own cleanup' }),
    /cannot ask your user/,
    'dropping an unticked item without a client that can ask is refused',
  );
  await strict.setState(id, [
    { section: 'Done when', mode: 'replace', body: '- [x] a late criterion · scripts/live-test.mjs:96\n- [x] the live test deletes this issue · scripts/live-test.mjs:206' },
  ]);
  console.log(JSON.stringify(await strict.setStatus(id, doneState)));
  read = await strict.getIssue(id);

  step('closed_by sets a duplicate relation');
  other = await strict.createIssue({ team, parent: created.identifier, title: `[strict-mcp live test canonical ${new Date().toISOString()}] ignore, auto-deleted` });
  const dupe = await strict.createIssue({
    team,
    parent: created.identifier,
    title: `[strict-mcp live test duplicate ${new Date().toISOString()}] ignore, auto-deleted`,
    sections: [{ section: 'Done when', mode: 'replace', body: '- [ ] deleted by the live test' }],
  });
  try {
    await strict.comment(dupe.identifier, { kind: 'closed_by', body: 'Same thing.', closed_by: other.identifier, relation: 'duplicate', author_label: 'live-test' });
    const dupeRead = await strict.getIssue(dupe.identifier);
    console.log('duplicate state:', dupeRead.issue.state?.name, 'relations:', JSON.stringify(dupeRead.relations));
    const canonicalRead = await strict.getIssue(other.identifier);
    console.log('canonical relations:', JSON.stringify(canonicalRead.relations));
    assert.match(dupeRead.issue.description, new RegExp(`Closed by ${other.identifier} \\(duplicate\\)`));
    console.log('findings on the finished ticket:', JSON.stringify(read.findings, null, 1));
    console.log('its description:', JSON.stringify(read.issue.description));
  } finally {
    await raw(`mutation($id: String!) { issueDelete(id: $id) { success } }`, { id: dupe.id }).catch(() => {});
  }

  step('list_issues');
  const listed = await strict.listIssues({ team, open: true });
  assert.equal(listed.rows.length, listed.total);
  console.log(`listed all ${listed.total} open tickets:`, JSON.stringify(listed.by_state));
  const searched = await strict.listIssues({ query: 'strict-mcp live test', team });
  console.log(`search found ${searched.total}: ${searched.rows.map((row) => row[0]).join(', ')}`);

  step('set_fields resolves names against the real workspace');
  const teamLabels = await raw(
    `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { labels(first: 50) { nodes { name isGroup } } activeCycle { number } } } }`,
    { key: team },
  );
  const teamNode = teamLabels.teams.nodes[0];
  const label = teamNode.labels.nodes.find((l) => !l.isGroup)?.name;
  const fieldResult = await strict.setFields(id, {
    priority: 4,
    assignee: 'me',
    due_date: '2030-01-01',
    ...(label ? { add_labels: [label] } : {}),
    ...(teamNode.activeCycle ? { cycle: 'current' } : {}),
    related_to: [other.identifier],
  });
  console.log(JSON.stringify(fieldResult));
  const afterFields = await raw(
    `query($id: String!) { issue(id: $id) { priority dueDate assignee { id } cycle { number } labels { nodes { name } } relations { nodes { type relatedIssue { identifier } } } } }`,
    { id },
  );
  assert.equal(afterFields.issue.priority, 4);
  assert.equal(afterFields.issue.dueDate, '2030-01-01');
  assert.equal(afterFields.issue.assignee.id, viewer.id);
  if (label) assert.ok(afterFields.issue.labels.nodes.some((l) => l.name === label), 'label applied');
  if (teamNode.activeCycle) assert.equal(afterFields.issue.cycle?.number, teamNode.activeCycle.number);
  assert.ok(afterFields.issue.relations.nodes.some((r) => r.type === 'related' && r.relatedIssue.identifier === other.identifier));
  await assert.rejects(strict.setFields(id, { add_labels: ['strict-mcp-no-such-label'] }), /No label/);
  await assert.rejects(strict.setFields(id, { assignee: 'strict-mcp-nobody@example.invalid' }), /No active user/);

  if (process.env.LIVE_PR_URL) {
    step('set_fields link_prs links a GitHub PR and Linear records where it merged');
    const linked = await strict.setFields(id, { link_prs: [process.env.LIVE_PR_URL] });
    console.log(JSON.stringify(linked));
    let pr = linked.prs_linked[0];
    // The integration may fill in the branch after the mutation returns.
    for (let tries = 0; pr.target_branch === null && tries < 10; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const found = (await strict.getIssue(id)).pull_requests.find((p) => p.url === pr.url);
      if (found?.targetBranch) pr = { url: pr.url, target_branch: found.targetBranch, after_s: tries + 1 };
    }
    console.log('target branch:', JSON.stringify(pr));
    assert.ok(pr.target_branch, 'Linear recorded the linked PR\'s target branch');
  }

  console.log('\nLIVE TEST PASSED');
} finally {
  if (other) await raw(`mutation($id: String!) { issueDelete(id: $id) { success } }`, { id: other.id }).catch(() => {});
  if (created) {
    const deleted = await raw(`mutation($id: String!) { issueDelete(id: $id) { success } }`, { id: created.id }).catch(
      (error) => ({ error: error.message }),
    );
    console.log(`cleanup ${created.identifier}: ${JSON.stringify(deleted)}`);
  }
}
