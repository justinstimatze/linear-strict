import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildStructuredContent, convertToolDefinition } from './tool-schema.js';
import type { Elicitor } from './sign-off.js';
import type { MCPToolDefinition } from './tools.js';

export interface ServerConfig {
  name: string;
  version: string;
  instructions: string;
  tools: MCPToolDefinition[];
  call: (name: string, args: unknown) => Promise<unknown>;
}

/**
 * An MCP server with tools only. A failed call comes back as an in-band error
 * result the model can read, never as a protocol error. Built on the low-level
 * Server because McpServer.registerTool takes zod schemas, and these tools are
 * plain JSON Schema; the SDK deprecates Server for high-level use only.
 */
export async function runServer(config: ServerConfig, transport: Transport): Promise<Elicitor & { close(): Promise<void> }> {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: config.name, version: config.version },
    { instructions: config.instructions, capabilities: { tools: {} } },
  );
  const byName = new Map(config.tools.map((tool) => [tool.name, tool]));
  const listed = config.tools.map(convertToolDefinition);

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const tool = byName.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const unknown = Object.keys(args ?? {}).filter((key) => !(key in tool.input_schema.properties));
      if (unknown.length > 0) throw new Error(unknownArguments(tool, unknown, byName.get('set_fields')));
      const result = await config.call(name, args ?? {});
      const structuredContent = buildStructuredContent(tool, result);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        ...(structuredContent !== undefined ? { structuredContent } : {}),
        isError: false,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });

  await server.connect(transport);
  return server;
}

/**
 * Names what the tool does take, so the next call can be right. A field that
 * set_fields changes (an assignee on create_issue, say) is pointed there.
 */
export function unknownArguments(tool: MCPToolDefinition, unknown: string[], setFields?: MCPToolDefinition): string {
  const accepted = Object.keys(tool.input_schema.properties);
  const viaFields =
    setFields && tool.name !== setFields.name
      ? unknown.filter((key) => key in setFields.input_schema.properties && key !== 'issue')
      : [];
  return [
    `Unknown argument(s) for ${tool.name}: ${unknown.join(', ')}.`,
    accepted.length > 0 ? `It takes: ${accepted.join(', ')}.` : 'It takes no arguments.',
    ...(viaFields.length > 0 ? [`Set ${viaFields.join(', ')} with set_fields after this call.`] : []),
  ].join(' ');
}
