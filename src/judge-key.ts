import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './auth/credential-store.js';

/**
 * The judge's Anthropic key, stored where `auth login` keeps Linear
 * credentials rather than in an MCP config that may sit in a project
 * directory. ANTHROPIC_API_KEY in the server's environment still wins.
 */
export function judgeKeyPath(): string {
  return path.join(getConfigDir(), 'anthropic-api-key');
}

export function resolveJudgeKey(file = judgeKeyPath()): { key: string; source: string } | null {
  const fromEnv = process.env['ANTHROPIC_API_KEY']?.trim();
  if (fromEnv) return { key: fromEnv, source: 'ANTHROPIC_API_KEY' };
  try {
    const mode = statSync(file).mode & 0o077;
    if (mode !== 0) throw new Error(`${file} is readable by other users; run chmod 600 on it, or set it again with \`linear-strict auth judge-key set\`.`);
    const key = readFileSync(file, 'utf8').trim();
    return key ? { key, source: file } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Reads a line from the terminal without echoing it, or from piped stdin. */
async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let text = '';
    const done = (value: string | null) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      if (value === null) reject(new Error('cancelled'));
      else resolve(value.trim());
    };
    const onData = (data: Buffer) => {
      for (const char of data.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          done(text);
          return;
        }
        if (char === '\u0003') {
          done(null);
          return;
        }
        if (char === '\u007f') text = text.slice(0, -1);
        else text += char;
      }
    };
    input.on('data', onData);
  });
}

/** `linear-strict auth judge-key <set|status|remove>`. Never prints the key. */
export async function runJudgeKeyCli(args: string[], print: (message: string) => void): Promise<number> {
  const file = judgeKeyPath();
  switch (args[0] ?? '') {
    case 'set': {
      const key = await readSecret('Anthropic API key for the sign-off judge (input hidden): ');
      if (!key.startsWith('sk-ant-')) {
        print('That does not look like an Anthropic API key (sk-ant-…); nothing was saved.');
        return 1;
      }
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${key}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      print(`Saved to ${file} (mode 600), ending …${key.slice(-4)}.`);
      return 0;
    }
    case 'status': {
      const found = resolveJudgeKey(file);
      print(found ? `Judge key from ${found.source}, ending …${found.key.slice(-4)}.` : `No judge key: set ANTHROPIC_API_KEY or run \`linear-strict auth judge-key set\` (${file}).`);
      return found ? 0 : 1;
    }
    case 'remove':
      rmSync(file, { force: true });
      print(`Removed ${file}.`);
      return 0;
    default:
      print('Usage: linear-strict auth judge-key <set|status|remove>\n  set reads the key from a hidden prompt, or from stdin when piped.');
      return 1;
  }
}
