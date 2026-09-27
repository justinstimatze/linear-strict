import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MCPToolDefinition } from './tools.js';

/**
 * MCP requires outputSchema and structuredContent to be objects at the top
 * level, so an array result is advertised and returned inside `{ items }`.
 */
function convertOutputSchema(
  outputSchema: MCPToolDefinition['output_schema'],
): Tool['outputSchema'] {
  if (outputSchema.type === 'array') {
    return { type: 'object', properties: { items: outputSchema }, required: ['items'] };
  }
  return { ...outputSchema, type: 'object' } as Tool['outputSchema'];
}

export function convertToolDefinition(toolDef: MCPToolDefinition): Tool {
  return {
    name: toolDef.name,
    description: toolDef.description,
    inputSchema: {
      ...toolDef.input_schema,
      type: 'object',
      // Unknown arguments are refused at call time; saying so in the schema lets a client know up front.
      additionalProperties: false,
    } as Tool['inputSchema'],
    outputSchema: convertOutputSchema(toolDef.output_schema),
    annotations: toolDef.annotations,
    ...(toolDef.meta ? { _meta: toolDef.meta } : {}),
  };
}

/** The structuredContent for a result, shaped like the outputSchema convertToolDefinition advertised. */
export function buildStructuredContent(
  toolDef: MCPToolDefinition,
  result: unknown,
): Record<string, unknown> | undefined {
  if (toolDef.output_schema.type === 'array')
    return Array.isArray(result) ? { items: result } : undefined;
  if (result !== null && typeof result === 'object' && !Array.isArray(result))
    return result as Record<string, unknown>;
  return undefined;
}
