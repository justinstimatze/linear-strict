import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { fakeGql, type FakeState } from '../src/__tests__/strict-fake-linear.helper.js';
import { memoryClaimStore } from '../src/claims.js';
import { STRICT_INSTRUCTIONS } from '../src/instructions.js';
import { type SignOffOutcome, type SignOffRequest, StrictLinear } from '../src/strict-linear.js';
import { strictToolDefinitions, strictToolHandlers } from '../src/tools.js';

/**
 * One scenario: a ticket in the fake Linear, what the user asks, and checks
 * on the ticket's final state. Grading reads state, never the model's own
 * account of what it did.
 */
export interface EvalCase {
  name: string;
  /** What the case measures, in one line. */
  about: string;
  prompt: string;
  fixture: () => FakeState;
  /** How the person at the client answers a sign-off form. Omitted: the client cannot show one. */
  signOff?: SignOffOutcome;
  grade: (run: Run) => Check[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ToolCall {
  name: string;
  input: unknown;
  error: string | null;
}

export interface Run {
  state: FakeState;
  toolCalls: ToolCall[];
  signOffAsked: SignOffRequest[];
  finalText: string;
  turns: number;
  stopReason: string | null;
}

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Responses served from the disk cache, which cost nothing. */
  diskHits: number;
  calls: number;
}

const MAX_TURNS = 16;
const MAX_TOKENS = 4096;
const NOW = new Date('2026-09-24T12:00:00Z');

// Claude Code puts a server's initialize instructions into the system prompt
// under this heading, so the model sees them the way a real session does.
const SYSTEM = `You are an agent working on a team's Linear tickets for the user. Use the tools to do what they ask, then reply to them with what you did and anything that is left.

# MCP Server Instructions

## linear-strict
${STRICT_INSTRUCTIONS}`;

const TOOLS: Anthropic.Messages.Tool[] = strictToolDefinitions.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.input_schema as Anthropic.Messages.Tool.InputSchema,
}));

export function emptyUsage(): Usage {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, diskHits: 0, calls: 0 };
}

/**
 * Responses are cached on disk by a hash of the whole request plus the
 * sample number. The fake Linear is deterministic, so an unchanged case
 * replays for free, and any change to a tool description, the instructions
 * or a fixture changes the hash and pays for a fresh answer.
 */
class DiskCache {
  private readonly dir: string | null;

  constructor(dir: string | null) {
    this.dir = dir;
    if (dir) mkdirSync(dir, { recursive: true });
  }

  key(body: unknown, sample: number) {
    return createHash('sha256').update(JSON.stringify({ body, sample })).digest('hex');
  }

  get(key: string): Anthropic.Messages.Message | null {
    if (!this.dir) return null;
    try {
      return JSON.parse(
        readFileSync(path.join(this.dir, `${key}.json`), 'utf8'),
      ) as Anthropic.Messages.Message;
    } catch {
      return null;
    }
  }

  put(key: string, message: Anthropic.Messages.Message) {
    if (this.dir) writeFileSync(path.join(this.dir, `${key}.json`), JSON.stringify(message));
  }
}

export interface RunOptions {
  client: Anthropic;
  model: string;
  sample: number;
  cacheDir: string | null;
  usage: Usage;
}

/** Drives one sample of one case to the end of the model's turn. */
export async function runCase(evalCase: EvalCase, options: RunOptions): Promise<Run> {
  const state = evalCase.fixture();
  const signOffAsked: SignOffRequest[] = [];
  const answer = evalCase.signOff;
  const strict = new StrictLinear({
    gql: fakeGql(state),
    claims: memoryClaimStore(),
    now: () => NOW,
    ...(answer
      ? {
          signOff: (request: SignOffRequest) => {
            signOffAsked.push(request);
            return Promise.resolve(answer);
          },
        }
      : {}),
  });
  const handlers = strictToolHandlers(strict);
  const cache = new DiskCache(options.cacheDir);

  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: evalCase.prompt }];
  const toolCalls: ToolCall[] = [];
  let finalText = '';
  let stopReason: string | null = null;
  let turns = 0;

  while (turns < MAX_TURNS) {
    turns += 1;
    const body: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: options.model,
      max_tokens: MAX_TOKENS,
      // The breakpoint on the system block caches the tool schemas and the
      // system prompt together (tools come first in the prefix); the one on
      // the newest message caches the conversation so far for the next turn.
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages: withTrailingBreakpoint(messages),
    };
    const key = cache.key(body, options.sample);
    let response = cache.get(key);
    if (response) {
      options.usage.diskHits += 1;
    } else {
      response = await options.client.messages.create(body);
      cache.put(key, response);
      options.usage.calls += 1;
      options.usage.input += response.usage.input_tokens;
      options.usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
      options.usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
      options.usage.output += response.usage.output_tokens;
    }

    stopReason = response.stop_reason;
    messages.push({ role: 'assistant', content: response.content });
    finalText = response.content
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const uses = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use',
    );
    if (response.stop_reason !== 'tool_use' || uses.length === 0) break;

    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const use of uses) {
      const handler = handlers[use.name];
      let content: string;
      let error: string | null = null;
      try {
        if (!handler) throw new Error(`Unknown tool: ${use.name}`);
        content = JSON.stringify(await handler(use.input));
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        content = `Error: ${error}`;
      }
      toolCalls.push({ name: use.name, input: use.input, error });
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content,
        ...(error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return { state, toolCalls, signOffAsked, finalText, turns, stopReason };
}

/** A copy of the conversation with a cache breakpoint on the last block. */
function withTrailingBreakpoint(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  const last = messages.at(-1);
  if (!last) return messages;
  const blocks: Anthropic.Messages.ContentBlockParam[] =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
  const tail = blocks.at(-1);
  if (tail && (tail.type === 'text' || tail.type === 'tool_result')) {
    blocks[blocks.length - 1] = { ...tail, cache_control: { type: 'ephemeral' } };
  }
  return [...messages.slice(0, -1), { role: last.role, content: blocks }];
}
