#!/usr/bin/env node
/**
 * Every sign-off route, end to end through the built server over stdio, the
 * way a client reaches it. Only Linear is faked (scripts/e2e/fake-apis.ts).
 *
 * - person, in Claude Code with the hooks: `install` writes the hooks into a
 *   scratch CLAUDE_CONFIG_DIR, the server issues an AskUserQuestion, the
 *   installed hook commands run as Claude Code would run them, and the retry
 *   is approved from the recorded answer.
 * - person, with hooks that can no longer run: the server falls back to the
 *   elicitation form rather than wait for an answer nothing records.
 * - judge: a canned verdict, or the real API with --live-judge (needs a key
 *   from ANTHROPIC_API_KEY or `auth judge-key set`; one call, a few cents).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = path.join(root, 'dist/index.js');
const fake = path.join(root, 'scripts/e2e/fake-apis.ts');
const liveJudge = process.argv.includes('--live-judge');

const DESCRIPTION = [
  '## Observed',
  '',
  '- 2026-09-20 · `gh api repos/x/y/environments` · develop environment deleted; previews replace it',
  '',
  '## Done when',
  '',
  '- [ ] the sign-in test fails against develop with the fix reverted',
].join('\n');
const REPLACEMENT = '- [ ] the sign-in test fails against a PR preview with the fix reverted';

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'linear-strict-e2e-'));
  return {
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    LINEAR_STRICT_STATE_DIR: path.join(dir, 'state'),
    LINEAR_STRICT_CONFIG_DIR: path.join(dir, 'config'),
  };
}

async function connect(env, { elicit } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', '--import', fake, server],
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LINEAR_API_TOKEN: 'lin_api_e2e', E2E_DESCRIPTION: DESCRIPTION, ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => (stderr += chunk));
  const client = new Client({ name: 'claude-code', version: 'e2e' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.map((part) => part.text ?? '').join('');
    return { error: result.isError === true, text, json: result.isError ? undefined : JSON.parse(text) };
  };
  return { call, close: () => client.close(), stderr: () => stderr };
}

async function descope(session, signOff) {
  const read = await session.call('get_issue', { issue: 'ENG-1' });
  assert.equal(read.error, false, read.text);
  return session.call('set_state', {
    issue: 'ENG-1',
    base: read.json.issue.description_sha,
    patch: [{ section: 'Done when', mode: 'replace', body: REPLACEMENT }],
    descope_reason: 'develop was deleted; PR previews replaced it (Observed 1)',
    descope_risk: 'nothing; the same test runs against a preview instead',
    ...(signOff ? { sign_off: signOff } : {}),
  });
}

/** Runs the installed hook for this event and tool the way Claude Code does: sh -c, payload on stdin. */
function runHook(env, event, payload) {
  const settings = JSON.parse(readFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  const entry = settings.hooks[event].find((candidate) => new RegExp(`^(${candidate.matcher})$`).test(payload.tool_name));
  const result = spawnSync('sh', ['-c', entry.hooks[0].command], {
    input: JSON.stringify({ hook_event_name: event, ...payload }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function personWithHooks() {
  const env = scratch();
  execFileSync(process.execPath, [server, 'install'], { env: { ...process.env, ...env } });
  const session = await connect(env);
  try {
    const first = await descope(session);
    assert.equal(first.error, true, 'a descope with no sign-off is refused until someone answers');
    const ask = JSON.parse(/\{"questions":.*\}/.exec(first.text)?.[0] ?? 'null');
    assert.ok(ask, `the refusal hands over an AskUserQuestion: ${first.text}`);
    const question = ask.questions[0];
    const token = /sign-off ([0-9a-f]{12})/.exec(question.question)?.[1];
    assert.ok(token);

    const softened = { ...question, options: question.options.map((option) => ({ ...option, preview: 'A small wording fix.' })) };
    const refused = runHook(env, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [softened] } });
    assert.match(refused.stdout, /"permissionDecision":"deny"/, 'a reworded question is refused');
    const shown = runHook(env, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [question] } });
    assert.equal(shown.code, 0, shown.stderr);
    assert.doesNotMatch(shown.stdout, /deny/);

    const byHand = runHook(env, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(env.LINEAR_STRICT_STATE_DIR, 'sign-offs', `${token}.answer.json`) } });
    assert.equal(byHand.code, 2, 'an answer written by hand is refused');

    const accept = question.options.find((option) => option.label === 'Accept');
    const answer = { questions: [question], answers: { [question.question]: 'Accept' }, annotations: { [question.question]: { preview: accept.preview, notes: 'fine by me' } } };
    const recorded = runHook(env, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_input: answer, tool_response: answer });
    assert.equal(recorded.code, 0, recorded.stderr);

    const retry = await descope(session, token);
    assert.equal(retry.error, false, retry.text);
    const after = await session.call('get_issue', { issue: 'ENG-1' });
    assert.match(after.json.issue.description, /PR preview with the fix reverted/);
    const note = after.json.comments.map((comment) => comment.body).join('\n');
    assert.match(note, /sign-off from the person/);
    assert.match(note, /fine by me/);
    console.log('ok  person, AskUserQuestion with hooks: refused a reworded question and a hand-written answer, approved from the recorded Accept');
  } finally {
    await session.close();
  }
}

async function personWithBrokenHooks() {
  const env = scratch();
  execFileSync(process.execPath, [server, 'install'], { env: { ...process.env, ...env } });
  const file = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll(server, path.join(root, 'gone/index.js')));
  let asked = false;
  const session = await connect(env, {
    elicit: () => {
      asked = true;
      return { action: 'accept', content: {} };
    },
  });
  try {
    const result = await descope(session);
    assert.equal(result.error, false, result.text);
    assert.ok(asked, 'the form was used');
    assert.match(session.stderr(), /hooks can't run, asking through the form/);
    console.log('ok  person, hooks that can no longer run: fell back to the elicitation form and was approved there');
  } finally {
    await session.close();
  }
}

async function judge() {
  const env = { ...scratch(), LINEAR_STRICT_SIGN_OFF: 'judge' };
  if (liveJudge) {
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    else env.LINEAR_STRICT_CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config'), 'linear-strict');
  } else {
    Object.assign(env, { ANTHROPIC_API_KEY: 'sk-ant-e2e', E2E_JUDGE: 'fake' });
  }
  const session = await connect(env);
  try {
    const result = await descope(session);
    const after = await session.call('get_issue', { issue: 'ENG-1' });
    const note = after.json.comments.map((comment) => comment.body).join('\n');
    if (result.error) {
      assert.match(result.text, /sign-off judge declined/, result.text);
      console.log(`ok  judge${liveJudge ? ' (live)' : ''}: declined, with its reason: ${result.text}`);
    } else {
      assert.match(note, /approved by a model judge \(claude-opus-5-5\)/);
      console.log(`ok  judge${liveJudge ? ' (live)' : ''}: approved, and the descope comment names the model and its reason`);
    }
  } finally {
    await session.close();
  }
}

await personWithHooks();
await personWithBrokenHooks();
await judge();
