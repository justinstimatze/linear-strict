import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logUsage } from '../usage-log.js';

describe('logUsage', () => {
  it('appends one row per call with the cache counts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'usage-'));
    process.env['LINEAR_STRICT_STATE_DIR'] = dir;
    logUsage('overlap', 'm', { cache_creation_input_tokens: 5, cache_read_input_tokens: 7 });
    logUsage('overlap', 'm', undefined);
    const rows = readFileSync(path.join(dir, 'usage.jsonl'), 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0] ?? '{}')).toMatchObject({
      call: 'overlap',
      cacheWrite: 5,
      cacheRead: 7,
    });
    delete process.env['LINEAR_STRICT_STATE_DIR'];
  });
});
