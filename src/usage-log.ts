import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { defaultStateDir } from './sign-off-store.js';

/** What a Messages reply reports about tokens and the prompt cache. */
export interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Appends one line per model call to usage.jsonl in the state directory, so
 * the gap between calls that share a cached prefix can be read off and the
 * cache TTL chosen from it. Never throws: a log that can't be written must
 * not fail the call it describes.
 */
export function logUsage(call: string, model: string, usage: ApiUsage | undefined): void {
  if (!usage) return;
  try {
    const dir = defaultStateDir();
    mkdirSync(dir, { recursive: true });
    const row = {
      at: new Date().toISOString(),
      call,
      model,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
    };
    appendFileSync(path.join(dir, 'usage.jsonl'), `${JSON.stringify(row)}\n`);
  } catch {
    // Best effort.
  }
}
