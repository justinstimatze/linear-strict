import { memoryClaimStore } from '../claims.js';
import { StrictLinear } from '../strict-linear.js';
import { unknownArguments } from '../server.js';
import { strictToolDefinitions, strictToolHandlers } from '../tools.js';
import { fakeGql, fakeState } from './strict-fake-linear.helper.js';

function handlers() {
  const state = fakeState();
  const strict = new StrictLinear({ gql: fakeGql(state), claims: memoryClaimStore() });
  return strictToolHandlers(strict);
}

describe('strict tools', () => {
  it('has exactly one handler for every advertised tool', () => {
    expect(Object.keys(handlers()).sort()).toEqual(
      strictToolDefinitions.map((tool) => tool.name).sort(),
    );
  });

  it('refuses a description patch that does not name its base', async () => {
    const patch = [
      { section: 'Observed', mode: 'append', body: '- 2026-09-24 · `curl /health` · 200' },
    ];
    await expect(
      Promise.resolve().then(() => handlers()['set_state']?.({ issue: 'ENG-1', patch })),
    ).rejects.toThrow(/base is required/);
    await expect(
      Promise.resolve().then(() =>
        handlers()['comment']?.({ issue: 'ENG-1', kind: 'evidence', body: 'Seen.', patch }),
      ),
    ).rejects.toThrow(/base is required/);
  });

  it('posts a comment without a patch with no base', async () => {
    await expect(
      handlers()['comment']?.({ issue: 'ENG-1', kind: 'evidence', body: 'Seen.' }),
    ).resolves.toMatchObject({ kind: 'evidence' });
  });

  it('whoami returns the identity behind the token', async () => {
    await expect(handlers()['whoami']?.({})).resolves.toEqual({
      id: 'u-agent',
      name: 'agent-a',
      displayName: 'agent-a',
      app: true,
    });
  });
});

describe('unknown arguments', () => {
  const byName = new Map(strictToolDefinitions.map((tool) => [tool.name, tool]));
  const tool = (name: string) => {
    const found = byName.get(name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };

  it('names what the tool takes', () => {
    expect(unknownArguments(tool('get_issue'), ['id'], tool('set_fields'))).toBe(
      'Unknown argument(s) for get_issue: id. It takes: issue.',
    );
  });

  it('points a field on create_issue at set_fields', () => {
    expect(unknownArguments(tool('create_issue'), ['assignee'], tool('set_fields'))).toContain(
      'Set assignee with set_fields after this call.',
    );
  });
});
