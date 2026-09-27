import type { Finding } from './sections.js';

/**
 * Facts derived from what Linear already stores about a ticket, never from
 * its prose: which pull requests are linked and where they merged, and
 * whether a comment was written by a person or an agent.
 */

export interface AttachmentNode {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
  createdAt: string;
  sourceType: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  /** GitHub's state as Linear last synced it: open, merged or closed (draft is separate). */
  status: string;
  draft: boolean;
  targetBranch: string | null;
  mergedAt: string | null;
  /** How the PR names the ticket, e.g. "closes" or "contributes". */
  linkKind: string | null;
}

function field<T>(metadata: Record<string, unknown>, key: string, guard: (value: unknown) => value is T): T | null {
  const value = metadata[key];
  return guard(value) ? value : null;
}
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';

/** Linked GitHub pull requests, read from Linear's attachment metadata. */
export function pullRequests(attachments: AttachmentNode[]): PullRequest[] {
  const prs: PullRequest[] = [];
  for (const attachment of attachments) {
    const metadata = attachment.metadata;
    if (attachment.sourceType !== 'github' || !metadata) continue;
    const number = field(metadata, 'number', isNumber);
    if (number === null || !/\/pull\/\d+/.test(attachment.url)) continue;
    prs.push({
      number,
      title: attachment.title,
      url: attachment.url,
      status: field(metadata, 'status', isString) ?? 'unknown',
      draft: metadata['draft'] === true,
      targetBranch: field(metadata, 'targetBranch', isString),
      mergedAt: field(metadata, 'mergedAt', isString),
      linkKind: field(metadata, 'linkKind', isString),
    });
  }
  return prs.sort((a, b) => a.number - b.number);
}

export interface ReleaseNode {
  name: string;
  version: string | null;
  url: string;
  completedAt: string | null;
  stage: { name: string; type: string } | null;
}

/** What else Linear knows about whether the work reached people, beyond linked PRs. */
export interface ShipEvidence {
  labels: string[];
  releases: ReleaseNode[];
  /** Description and comment bodies, searched for PRs named but never linked. */
  text: string[];
  /** Environment whose `posthog-<env>:<state>` label says whether a flag is on for users. */
  productionEnv: string;
}

const PR_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
const PR_SHORT = /(?<![\w/.-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;

/** PRs named in prose, as owner/repo#N, from full URLs and the short form. */
export function mentionedPullRequests(text: string[]): string[] {
  const found = new Set<string>();
  for (const body of text) {
    for (const pattern of [PR_URL, PR_SHORT]) {
      for (const match of body.matchAll(pattern)) {
        const [, owner, repo, number] = match;
        if (owner && repo && number) found.add(`${owner}/${repo}#${number}`.toLowerCase());
      }
    }
  }
  return [...found].sort();
}

function prKey(pr: PullRequest): string | null {
  const match = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(pr.url);
  return match ? `${match[1] ?? ''}/${match[2] ?? ''}#${match[3] ?? ''}`.toLowerCase() : null;
}

/** A state that claims the work has landed: a completed-type state, or one named like "Merged". */
function claimsShipped(state: { name: string; type: string } | null): boolean {
  if (!state) return false;
  return state.type === 'completed' || /merged/i.test(state.name);
}

/**
 * Findings about a ticket whose state says the work landed. Advisory: some
 * tickets close with no code at all, and Linear's view of a PR is a synced
 * copy. Main ancestry is not checked here; a PR merged into the main branch
 * is the evidence this can see.
 */
export function shippedStateFindings(
  state: { name: string; type: string } | null,
  prs: PullRequest[],
  mainBranch: string,
  evidence?: ShipEvidence,
): Finding[] {
  if (!state || !claimsShipped(state)) return [];
  const findings = [...prFindings(state, prs, mainBranch, evidence?.releases ?? [])];
  if (evidence && state.type === 'completed') findings.push(...flagFindings(state, evidence));
  if (evidence) {
    const linked = new Set(prs.map(prKey).filter((key): key is string => key !== null));
    const unlinked = mentionedPullRequests(evidence.text).filter((key) => !linked.has(key));
    if (unlinked.length > 0) {
      findings.push({
        code: 'pr_mentioned_not_linked',
        detail: `State is "${state.name}" and the ticket names ${unlinked.join(', ')}, which ${unlinked.length === 1 ? 'is' : 'are'} not linked. Link the PR so its merge state is visible, or say with a closed_by comment that the work landed elsewhere.`,
      });
    }
  }
  return findings;
}

function flagFindings(state: { name: string }, evidence: ShipEvidence): Finding[] {
  if (!evidence.labels.includes('posthog-flag')) return [];
  const prefix = `posthog-${evidence.productionEnv}:`;
  const production = evidence.labels.find((label) => label.startsWith(prefix));
  if (!production) {
    return [
      {
        code: 'flag_unverified',
        detail: `State is "${state.name}" and the work ships behind a flag, but no ${prefix}<dark|custom|live> label says whether it is on in ${evidence.productionEnv}.`,
      },
    ];
  }
  if (production.endsWith(':dark')) {
    return [
      {
        code: 'flag_dark',
        detail: `State is "${state.name}" but the flag is dark in ${evidence.productionEnv} (${production}): nobody there sees this yet.`,
      },
    ];
  }
  return [];
}

function prFindings(
  state: { name: string; type: string },
  prs: PullRequest[],
  mainBranch: string,
  releases: ReleaseNode[],
): Finding[] {
  // A release is stronger evidence than a branch: teams that merge to develop and ship by release
  // would otherwise all read as not on main.
  if (state.type === 'completed' && releases.length > 0) {
    if (releases.some((release) => release.stage?.type === 'completed')) return [];
    return [
      {
        code: 'not_released',
        detail: `State is "${state.name}" but none of its releases has completed (${releases.map((release) => `${release.version ?? release.name}: ${release.stage?.name ?? 'no stage'}`).join(', ')}).`,
      },
    ];
  }
  const merged = prs.filter((pr) => pr.status === 'merged');

  if (prs.length === 0) {
    return [
      {
        code: 'no_linked_pr',
        detail: `State is "${state.name}" but no pull request is linked. If the fix shipped under another ticket's PR, say so with a closed_by comment, or link the PR.`,
      },
    ];
  }
  if (merged.length === 0) {
    return [
      {
        code: 'no_merged_pr',
        detail: `State is "${state.name}" but none of the ${prs.length} linked PRs is merged (${prs.map((pr) => `#${pr.number} ${pr.status}`).join(', ')}).`,
      },
    ];
  }
  if (state.type === 'completed' && !merged.some((pr) => pr.targetBranch === mainBranch)) {
    const targets = [...new Set(merged.map((pr) => pr.targetBranch ?? 'unknown branch'))].join(', ');
    return [
      {
        code: 'not_on_main',
        detail: `State is "${state.name}" but the linked PRs merged into ${targets}, not ${mainBranch}. Done means on ${mainBranch}; link the promotion PR, or check ancestry before closing.`,
      },
    ];
  }
  return [];
}

export type AuthorKind = 'agent' | 'person' | 'unknown';

/**
 * Who wrote a comment, as far as Linear's records show. An app user, an
 * integration bot, or a body opening with 🤖 is an agent. A person account
 * with no such marker is reported as a person, with the caveat spelled out,
 * because an agent driving a personal API key through another client looks
 * exactly like this.
 */
export function commentAuthorKind(comment: {
  body: string;
  user: { app?: boolean | null } | null;
  botActor: unknown;
  externalUser: unknown;
}): { kind: AuthorKind; basis: string } {
  if (comment.user?.app) return { kind: 'agent', basis: 'posted by an agent (app) identity' };
  if (comment.botActor) return { kind: 'agent', basis: 'posted by an integration' };
  if (comment.body.trimStart().startsWith('🤖')) return { kind: 'agent', basis: 'body opens with 🤖' };
  if (comment.externalUser) return { kind: 'person', basis: 'external user (e.g. via Slack or a support integration)' };
  if (comment.user) {
    return {
      kind: 'person',
      basis: 'person account with no agent marker; an agent using that person\'s API key through another client looks the same',
    };
  }
  return { kind: 'unknown', basis: 'Linear returned no author' };
}
