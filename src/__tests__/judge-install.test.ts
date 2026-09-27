import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hookRunner, mergeHooks, signOffHookHealth, signOffHooks } from '../install.js';
import { judgeSignOff } from '../judge.js';
import { resolveJudgeKey } from '../judge-key.js';
import type { SignOffRequest } from '../strict-linear.js';

const REQUEST: SignOffRequest = {
  identifier: 'ENG-1',
  title: 'Sign-in drops the session',
  dropped: ['it fails on develop'],
  added: [],
  reason: 'develop is gone',
  risk: 'nothing checks it',
  description: '## Observed\n\n- develop was retired',
};

function reply(status: number, body: unknown) {
  const sent: RequestInit[] = [];
  const fake = ((_url: string, init: RequestInit) => {
    sent.push(init);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return { fake, sent };
}

describe('the sign-off judge', () => {
  it('asks for the verdict as schema-enforced output, caches its brief, and records the model', async () => {
    const { fake, sent } = reply(200, {
      content: [
        { type: 'thinking', thinking: '' },
        {
          type: 'text',
          text: JSON.stringify({ approve: true, reason: 'Observed says develop was retired.' }),
        },
      ],
    });
    await expect(judgeSignOff({ apiKey: 'k', fetch: fake })(REQUEST)).resolves.toEqual({
      outcome: 'approved',
      note: 'Observed says develop was retired.',
      signer: 'judge',
      model: 'claude-opus-5-5',
    });
    const body = JSON.parse(sent[0]?.body as string) as Record<string, unknown>;
    expect(body['output_config']).toMatchObject({ format: { type: 'json_schema' } });
    expect(body['tool_choice']).toBeUndefined();
    expect(body['system']).toEqual([
      expect.objectContaining({ cache_control: { type: 'ephemeral' } }),
    ]);
    expect(JSON.stringify(body['messages'])).toContain('develop was retired');
  });

  it('declines when the judge says no, and reports no verdict on an API error', async () => {
    const no = reply(200, {
      content: [
        { type: 'text', text: JSON.stringify({ approve: false, reason: 'Nothing shows it.' }) },
      ],
    });
    await expect(judgeSignOff({ apiKey: 'k', fetch: no.fake })(REQUEST)).resolves.toMatchObject({
      outcome: 'declined',
      note: 'Nothing shows it.',
    });
    const down = reply(529, { error: { message: 'Overloaded' } });
    await expect(judgeSignOff({ apiKey: 'k', fetch: down.fake })(REQUEST)).resolves.toMatchObject({
      outcome: 'unanswered',
      returned: 'judge error: 529 Overloaded',
    });
  });
});

describe('installing the sign-off hooks', () => {
  const hooks = signOffHooks(
    hookRunner('/opt/linear-strict/dist/index.js', '0.1.0', '/usr/bin/node'),
    '/state/linear-strict/sign-offs',
  );

  it('adds its hooks beside the ones already there, replaces its own on a rerun, and removes only its own', () => {
    const existing = {
      model: 'opus',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'weir check' }] }],
      },
    };
    const once = mergeHooks(existing, hooks);
    expect(once.hooks?.['PreToolUse']?.map((entry) => entry.matcher)).toEqual([
      'Bash',
      'AskUserQuestion',
      'Bash|Write|Edit|MultiEdit|NotebookEdit',
    ]);
    expect(once.hooks?.['PostToolUse']?.[0]?.hooks[0]?.command).toMatch(
      /^'\/usr\/bin\/node' '\/opt\/linear-strict\/dist\/index.js' hook ask-post /,
    );
    expect(mergeHooks(once, hooks)).toEqual(once);
    expect(mergeHooks(once, {})).toEqual(existing);
  });

  it('runs a checkout directly, and an npx copy through npx at the same version, since npm prunes its cache', () => {
    expect(hookRunner('/opt/linear-strict/dist/index.js', '0.1.0', '/usr/bin/node')).toBe(
      "'/usr/bin/node' '/opt/linear-strict/dist/index.js'",
    );
    expect(
      hookRunner(
        '/home/a/.npm/_npx/9f2c/node_modules/linear-strict/dist/index.js',
        '0.1.0',
        '/nowhere/bin/node',
      ),
    ).toBe('npx -y linear-strict@0.1.0');
    const npxHooks = signOffHooks('npx -y linear-strict@0.1.0', '/state');
    expect(npxHooks['PostToolUse']?.[0]?.hooks[0]).toMatchObject({
      command: expect.stringMatching(/^npx -y linear-strict@0\.1\.0 hook ask-post /) as string,
      timeout: 120,
    });
  });

  it('reports hooks whose program is gone, or pinned to another version, as unable to run', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-health-'));
    const saved = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = dir;
    try {
      const project = path.join(dir, 'project');
      const write = (runner: string) => {
        writeFileSync(
          path.join(dir, 'settings.json'),
          JSON.stringify(mergeHooks({}, signOffHooks(runner, '/state'))),
        );
      };
      expect(signOffHookHealth(project)).toEqual({ files: [], problems: [] });

      write(hookRunner(process.argv[1] ?? '', '0.1.0'));
      expect(signOffHookHealth(project, '0.1.0').problems).toEqual([]);

      write(hookRunner(path.join(dir, 'gone', 'index.js'), '0.1.0'));
      expect(signOffHookHealth(project, '0.1.0').problems).toEqual([
        expect.stringMatching(/gone\/index\.js, which no longer exists/) as string,
      ]);

      write('npx -y linear-strict@0.1.0');
      expect(signOffHookHealth(project, '0.1.0').problems).toEqual([]);
      expect(signOffHookHealth(project, '0.2.0').problems).toEqual([
        expect.stringMatching(/linear-strict@0\.1\.0 .* this server is 0\.2\.0/) as string,
      ]);
    } finally {
      if (saved === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
      else process.env['CLAUDE_CONFIG_DIR'] = saved;
    }
  });

  it('refuses a tool call that touches the sign-off records, and nothing else', () => {
    const guard = hooks['PreToolUse']?.[1]?.hooks[0]?.command ?? '';
    const run = (payload: unknown) =>
      spawnSync('sh', ['-c', guard], { input: JSON.stringify(payload), encoding: 'utf8' });
    const touching = run({
      tool_name: 'Write',
      tool_input: { file_path: '/state/linear-strict/sign-offs/0123456789ab.answer.json' },
    });
    expect(touching.status).toBe(2);
    expect(touching.stderr).toMatch(/recorded by its hook/);
    expect(run({ tool_name: 'Bash', tool_input: { command: 'npm test' } }).status).toBe(0);
  });
});

describe('the judge key', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'judge-key-'));
  const file = path.join(dir, 'anthropic-api-key');
  const saved = process.env['ANTHROPIC_API_KEY'];
  afterAll(() => {
    if (saved === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = saved;
  });

  it('prefers the environment, then reads a private file, and refuses one others can read', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    expect(resolveJudgeKey(file)).toBeNull();
    writeFileSync(file, 'sk-ant-test-1234\n', { mode: 0o600 });
    expect(resolveJudgeKey(file)).toEqual({ key: 'sk-ant-test-1234', source: file });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-5678';
    expect(resolveJudgeKey(file)?.source).toBe('ANTHROPIC_API_KEY');
    delete process.env['ANTHROPIC_API_KEY'];
    chmodSync(file, 0o644);
    expect(() => resolveJudgeKey(file)).toThrow(/readable by other users/);
  });
});
