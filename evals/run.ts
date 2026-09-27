import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { CASES } from './cases.js';
import { type EvalCase, emptyUsage, runCase } from './harness.js';

const root = path.resolve(import.meta.dirname, '..');

const { values } = parseArgs({
  options: {
    model: { type: 'string', multiple: true, default: ['claude-opus-5-5'] },
    samples: { type: 'string', default: '3' },
    case: { type: 'string', multiple: true },
    concurrency: { type: 'string', default: '4' },
    'no-cache': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
});

if (values.list) {
  for (const evalCase of CASES) console.log(`${evalCase.name}\n  ${evalCase.about}`);
  process.exit(0);
}

loadDotEnv(path.join(root, '.env'));
if (!process.env['ANTHROPIC_API_KEY']) {
  console.error('ANTHROPIC_API_KEY is not set, in the environment or in .env at the repo root.');
  process.exit(2);
}

const samples = Number(values.samples);
const concurrency = Number(values.concurrency);
const filters = values.case ?? [];
const cases = CASES.filter((evalCase) => filters.length === 0 || filters.some((filter) => evalCase.name.includes(filter)));
if (cases.length === 0) {
  console.error(`No case matches ${filters.join(', ')}. --list shows them.`);
  process.exit(2);
}

const client = new Anthropic({ maxRetries: 4 });
const usage = emptyUsage();
const cacheDir = values['no-cache'] ? null : path.join(root, 'evals/.cache');
const resultsDir = path.join(root, 'evals/results');
mkdirSync(resultsDir, { recursive: true });
const resultsFile = path.join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

interface Job {
  evalCase: EvalCase;
  model: string;
  sample: number;
}
interface Outcome extends Job {
  pass: boolean;
  failed: string[];
  error: string | null;
}

const jobs: Job[] = values.model.flatMap((model) =>
  cases.flatMap((evalCase) => Array.from({ length: samples }, (_, sample) => ({ evalCase, model, sample }))),
);

async function runJob(job: Job): Promise<Outcome> {
  try {
    const run = await runCase(job.evalCase, { client, model: job.model, sample: job.sample, cacheDir, usage });
    const checks = job.evalCase.grade(run);
    const failed = checks.filter((result) => !result.ok);
    appendFileSync(
      resultsFile,
      `${JSON.stringify({
        case: job.evalCase.name,
        model: job.model,
        sample: job.sample,
        pass: failed.length === 0,
        checks,
        turns: run.turns,
        stop_reason: run.stopReason,
        tool_calls: run.toolCalls,
        sign_off_asked: run.signOffAsked,
        final_text: run.finalText,
        final_description: run.state.issue.description,
        final_state: run.state.issue.stateId,
      })}\n`,
    );
    return { ...job, pass: failed.length === 0, failed: failed.map((result) => result.detail ?? result.name), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendFileSync(resultsFile, `${JSON.stringify({ case: job.evalCase.name, model: job.model, sample: job.sample, error: message })}\n`);
    return { ...job, pass: false, failed: [], error: message };
  }
}

const outcomes: Outcome[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      if (!job) break;
      const outcome = await runJob(job);
      outcomes.push(outcome);
      console.error(`${outcome.pass ? 'pass' : 'FAIL'}  ${job.model}  ${job.evalCase.name} #${String(job.sample)}${outcome.error ? `  error: ${outcome.error}` : ''}`);
    }
  }),
);

console.log('');
for (const model of values.model) {
  console.log(model);
  for (const evalCase of cases) {
    const mine = outcomes.filter((outcome) => outcome.model === model && outcome.evalCase === evalCase);
    const passed = mine.filter((outcome) => outcome.pass).length;
    console.log(`  ${String(passed)}/${String(mine.length)}  ${evalCase.name}`);
    const reasons = new Map<string, number>();
    for (const outcome of mine) {
      for (const reason of outcome.error ? [`error: ${outcome.error}`] : outcome.failed) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of reasons) console.log(`        ${String(count)}× ${reason}`);
  }
}
console.log(
  `\nAPI calls ${String(usage.calls)} (disk cache served ${String(usage.diskHits)}) · input ${String(usage.input)} · cache read ${String(usage.cacheRead)} · cache write ${String(usage.cacheWrite)} · output ${String(usage.output)}`,
);
console.log(`results: ${path.relative(root, resultsFile)}`);
process.exit(outcomes.every((outcome) => outcome.pass) ? 0 : 1);

/** Reads KEY=value lines from a gitignored .env, without overriding the environment. */
function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    process.env[match[1]] ??= match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
