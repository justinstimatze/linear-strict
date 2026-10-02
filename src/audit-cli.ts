/**
 * `linear-strict audit export` writes a team's tickets to a JSONL file;
 * `linear-strict audit check` reads it with a git checkout and reports
 * citations that no longer show what they cited.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { type ExportedIssue, exportTeam } from './audit-export.js';
import { checkIssue, type Finding, gitRepo, report } from './audit-check.js';
import { resolveLinearAuth } from './auth/resolve.js';
import { linearGql } from './linear.js';

const USAGE = `Usage:
  linear-strict audit export --team <KEY> --out <file.jsonl> [--max-fetch 500] [--pace 20]
      Writes every ticket on the team, open ones first, with its description
      versions and comments: about three API calls per ticket, one ticket every
      --pace seconds (20 keeps a run near a fifth of a key's hourly quota),
      saved every 25. Rerun with the same --out to fetch only tickets updated
      since, and to carry on after --max-fetch or a rate limit stopped a run.
  linear-strict audit check --export <file.jsonl> --repo <git checkout>
                            [--ref origin/main] [--main origin/main]
                            [--issue <ID>]... [--json]
      Checks every path:line and commit hash the tickets cite against the
      repo. Offline; fetch the repo first if its refs should be current.`;

function flags(args: string[]) {
  const values = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"\n\n${USAGE}`);
    const name = arg.slice(2);
    if (name === 'json') {
      values.set(name, ['true']);
      continue;
    }
    const value = args[++i];
    if (value === undefined) throw new Error(`--${name} needs a value\n\n${USAGE}`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return {
    one: (name: string) => values.get(name)?.[0],
    all: (name: string) => values.get(name) ?? [],
    need: (name: string) => {
      const value = values.get(name)?.[0];
      if (!value) throw new Error(`--${name} is required\n\n${USAGE}`);
      return value;
    },
  };
}

export function readExport(file: string): ExportedIssue[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ExportedIssue);
}

async function runExport(args: string[]) {
  const f = flags(args);
  const team = f.need('team');
  const out = f.need('out');
  const auth = resolveLinearAuth();
  if (!auth)
    throw new Error(
      'Linear credentials not found. Set LINEAR_API_TOKEN, or run `linear-strict auth login`.',
    );
  const config = await auth.getConfig();
  const gql = linearGql({ token: config.token, kind: config.type });
  const previous = new Map(
    existsSync(out) ? readExport(out).map((issue) => [issue.identifier, issue]) : [],
  );
  const count = (name: string, fallback: number) => {
    const value = Number(f.one(name) ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a number`);
    return value;
  };
  const maxFetch = count('max-fetch', 500);
  // Written whole and then moved into place, so an interrupted run leaves the last save intact.
  const save = (list: ExportedIssue[]) => {
    writeFileSync(`${out}.partial`, list.map((issue) => JSON.stringify(issue)).join('\n') + '\n');
    renameSync(`${out}.partial`, out);
  };
  const { issues, fetched, pending, stopped, omitted } = await exportTeam(gql, team, previous, {
    maxFetch,
    paceMs: count('pace', 20) * 1000,
    checkpoint: save,
    progress: (done, total) => {
      if (done % 50 === 0 || done === total)
        process.stderr.write(`linear-strict audit: ${String(done)}/${String(total)} tickets\n`);
    },
  });
  save(issues);
  const gaps = issues.filter((issue) => issue.omitted.length > 0).length;
  process.stdout.write(
    `Wrote ${String(issues.length)} tickets to ${out} (${String(fetched)} fetched, the rest unchanged since the last export).${pending > 0 ? ` ${String(pending)} still to fetch${stopped ? ` (stopped at ${stopped})` : ` (--max-fetch ${String(maxFetch)} reached)`}; rerun the same command to continue.` : ''}${gaps > 0 ? ` ${String(gaps)} have a part missing; see each record's omitted.` : ''}${omitted.length > 0 ? ` The ticket list itself was cut short: ${omitted.map((o) => o.reason).join('; ')}` : ''}\n`,
  );
  return 0;
}

function runCheck(args: string[]) {
  const f = flags(args);
  const wanted = new Set(f.all('issue').map((id) => id.toUpperCase()));
  const issues = readExport(f.need('export')).filter(
    (issue) => wanted.size === 0 || wanted.has(issue.identifier),
  );
  const repo = gitRepo(f.need('repo'));
  const options = { ref: f.one('ref') ?? 'origin/main', main: f.one('main') ?? 'origin/main' };
  if (!repo.commit(options.ref))
    throw new Error(`${options.ref} is not a ref in ${f.need('repo')}. Pass --ref.`);
  const findings: Finding[] = issues.flatMap((issue) => checkIssue(repo, issue, options));
  process.stdout.write(
    f.one('json') ? `${JSON.stringify(findings, null, 1)}\n` : `${report(findings)}\n`,
  );
  return 0;
}

export async function runAuditCli(args: string[]): Promise<number> {
  if (args[0] === 'export') return runExport(args.slice(1));
  if (args[0] === 'check') return runCheck(args.slice(1));
  process.stderr.write(`${USAGE}\n`);
  return args[0] === undefined || args[0] === '--help' ? 0 : 1;
}
