import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const disallowedTopLevelKeys = ['oneOf', 'anyOf', 'allOf', 'enum', 'not'];
const strictToolNames = [
  'get_issue',
  'description_history',
  'list_issues',
  'claim',
  'check_claim',
  'set_state',
  'comment',
  'set_status',
  'create_issue',
  'list_teams',
  'list_cycles',
  'list_projects',
  'list_initiatives',
  'notifications',
  'get_principal_notifications',
  'mark_principal_notifications_read',
  'mark_notifications_read',
  'set_fields',
  'whoami',
];

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, '..');
const serverEntryPath = path.join(repoRoot, 'dist/index.js');

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntryPath, '--token', 'mcp-smoke-test-token'],
    cwd: repoRoot,
    env: {
      ...process.env,
      LINEAR_API_TOKEN: 'mcp-smoke-test-token',
    },
    stderr: 'inherit',
  });
  const client = new Client({
    name: 'linear-strict-smoke-test',
    version: '1.0.0',
  });

  try {
    await client.connect(transport);

    const serverVersion = client.getServerVersion();
    assert.equal(serverVersion?.name, 'linear-strict', 'Server must identify itself as "linear-strict".');
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /omitted[\s\S]*set_state/, 'Server must return its instructions from initialize.');
    // Claude Code truncates server instructions past 2,048 characters.
    assert.ok(instructions.length < 2048, `Instructions are ${instructions.length} characters; the client cap is 2,048.`);
    assert.match(
      serverVersion?.version ?? '',
      /^\d+\.\d+\.\d+/,
      'Server must report a semver version during initialization.',
    );

    const serverCapabilities = client.getServerCapabilities();
    assert.ok(serverCapabilities?.tools, 'Server must declare the tools capability.');
    assert.equal(serverCapabilities?.resources, undefined, 'The server offers tools only.');
    assert.equal(serverCapabilities?.prompts, undefined, 'The server offers tools only.');

    const { tools } = await client.listTools();
    const actualToolNames = tools.map((tool) => tool.name).sort();
    assert.deepEqual(actualToolNames, [...strictToolNames].sort(), 'The server must advertise exactly the strict tools.');
    assert.equal(
      new Set(actualToolNames).size,
      actualToolNames.length,
      'MCP server advertised duplicate tool names.',
    );

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(
      byName.get('get_issue')?._meta?.['anthropic/maxResultSizeChars'],
      200_000,
      'get_issue must raise the client result-size limit so a whole ticket stays in context.',
    );
    for (const name of ['set_state', 'set_status', 'claim', 'comment']) {
      assert.equal(byName.get(name)?.annotations?.destructiveHint, true, `${name} can overwrite, so destructiveHint must be true.`);
    }
    assert.equal(byName.get('create_issue')?.annotations?.destructiveHint, false, 'create_issue only adds.');
    assert.ok(byName.get('get_issue')?.outputSchema?.properties?.omitted, 'get_issue must describe its result fields.');

    for (const tool of tools) {
      assert.equal(
        tool.inputSchema.type,
        'object',
        `Tool ${tool.name} must expose a top-level object input schema.`,
      );
      assert.equal(
        tool.inputSchema.additionalProperties,
        false,
        `Tool ${tool.name} must declare that unknown arguments are refused.`,
      );

      for (const key of disallowedTopLevelKeys) {
        assert.ok(
          !(key in tool.inputSchema),
          `Tool ${tool.name} exposes disallowed top-level schema key ${key}.`,
        );
      }

      assert.ok(tool.annotations, `Tool ${tool.name} must advertise annotations.`);
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(
          typeof tool.annotations[hint],
          'boolean',
          `Tool ${tool.name} must advertise an explicit boolean ${hint}.`,
        );
      }

      assert.ok(tool.outputSchema, `Tool ${tool.name} must advertise an outputSchema.`);
      assert.equal(
        tool.outputSchema.type,
        'object',
        `Tool ${tool.name} must expose a top-level object output schema.`,
      );
    }

    const openWorldToolNames = tools
      .filter((tool) => tool.annotations.openWorldHint)
      .map((tool) => tool.name);
    assert.deepEqual(
      openWorldToolNames,
      [],
      'Every tool talks only to the configured Linear workspace, so none may advertise openWorldHint.',
    );

    const rejectedArguments = await client.callTool({ name: 'whoami', arguments: { unexpectedArgument: true } });
    assert.equal(rejectedArguments.isError, true, 'Unknown arguments must come back as an in-band error result.');
    assert.equal(rejectedArguments.content[0].type, 'text', 'Error results must be text content items.');
    assert.ok(rejectedArguments.content[0].text.includes('Unknown argument(s) for whoami: unexpectedArgument'));
    assert.equal(rejectedArguments.structuredContent, undefined, 'Error results carry no structuredContent.');

    const unknownToolResult = await client.callTool({
      name: 'linear_toolThatDoesNotExist',
      arguments: {},
    });
    assert.equal(
      unknownToolResult.isError,
      true,
      'Unknown tools must surface an in-band error result rather than a protocol error.',
    );
    assert.ok(
      unknownToolResult.content[0].text.includes('Unknown tool: linear_toolThatDoesNotExist'),
    );

    console.log(`MCP smoke test passed: ${actualToolNames.length} tools advertised.`);
  } finally {
    await transport.close().catch(() => {});
  }
}

// Hard timeout so a stuck child process can never hang CI for hours.
const SMOKE_TEST_TIMEOUT_MS = 60_000;
const watchdog = setTimeout(() => {
  console.error(`MCP smoke test timed out after ${SMOKE_TEST_TIMEOUT_MS}ms`);
  process.exit(2);
}, SMOKE_TEST_TIMEOUT_MS);
watchdog.unref();

main()
  .then(() => {
    clearTimeout(watchdog);
    process.exit(0);
  })
  .catch((error) => {
    clearTimeout(watchdog);
    console.error('MCP smoke test failed:', error);
    process.exit(1);
  });
