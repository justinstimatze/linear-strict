import {
  type AttachmentNode,
  type ReleaseNode,
  type ShipEvidence,
  commentAuthorKind,
  mentionedPullRequests,
  pullRequests,
  shippedStateFindings,
} from '../facts.js';

function pr(number: number, status: string, targetBranch: string): AttachmentNode {
  const url = `https://github.com/o/r/pull/${number}`;
  return {
    id: `a-${number}`,
    title: `PR ${number}`,
    subtitle: null,
    url,
    createdAt: '2026-09-01T00:00:00.000Z',
    sourceType: 'github',
    metadata: { number, status, targetBranch, url, draft: false, mergedAt: status === 'merged' ? '2026-09-02T00:00:00.000Z' : null, linkKind: 'closes' },
  };
}

const DONE = { name: 'Done', type: 'completed' };
const MERGED = { name: 'Merged', type: 'started' };

describe('pullRequests', () => {
  it('reads GitHub PRs from attachment metadata and skips everything else', () => {
    const slack: AttachmentNode = { ...pr(1, 'merged', 'main'), sourceType: 'slack', url: 'https://slack.com/x' };
    const issueLink: AttachmentNode = { ...pr(2, 'open', 'main'), url: 'https://github.com/o/r/issues/2' };
    expect(pullRequests([pr(9, 'merged', 'main'), slack, issueLink, pr(3, 'open', 'develop')]).map((p) => [p.number, p.status, p.targetBranch])).toEqual([
      [3, 'open', 'develop'],
      [9, 'merged', 'main'],
    ]);
  });
});

describe('shippedStateFindings', () => {
  it('flags a Done or Merged ticket with no linked PR', () => {
    expect(shippedStateFindings(DONE, [], 'main').map((f) => f.code)).toEqual(['no_linked_pr']);
    expect(shippedStateFindings(MERGED, [], 'main').map((f) => f.code)).toEqual(['no_linked_pr']);
  });

  it('flags linked PRs that never merged', () => {
    expect(shippedStateFindings(DONE, pullRequests([pr(4, 'open', 'develop')]), 'main').map((f) => f.code)).toEqual(['no_merged_pr']);
  });

  it('flags Done when the only merges went to develop, and stays quiet for Merged', () => {
    const develop = pullRequests([pr(5, 'merged', 'develop')]);
    expect(shippedStateFindings(DONE, develop, 'main').map((f) => f.code)).toEqual(['not_on_main']);
    expect(shippedStateFindings(MERGED, develop, 'main')).toEqual([]);
  });

  it('is quiet once a PR merged into main is linked, and for states that claim nothing', () => {
    const promoted = pullRequests([pr(5, 'merged', 'develop'), pr(6, 'merged', 'main')]);
    expect(shippedStateFindings(DONE, promoted, 'main')).toEqual([]);
    expect(shippedStateFindings({ name: 'In Progress', type: 'started' }, [], 'main')).toEqual([]);
  });
});

describe('commentAuthorKind', () => {
  it('separates agents from people and says what it is based on', () => {
    const base = { body: 'text', user: null, botActor: null, externalUser: null };
    expect(commentAuthorKind({ ...base, user: { app: true } }).kind).toBe('agent');
    expect(commentAuthorKind({ ...base, botActor: { name: 'GitHub' } }).kind).toBe('agent');
    expect(commentAuthorKind({ ...base, user: { app: false }, body: '🤖 claude · 2026-09-24 · evidence' }).kind).toBe('agent');
    const person = commentAuthorKind({ ...base, user: { app: false } });
    expect(person.kind).toBe('person');
    expect(person.basis).toMatch(/looks the same/);
  });
});

describe('shipped-state evidence beyond PRs', () => {
  const evidence = (overrides: Partial<ShipEvidence> = {}): ShipEvidence => ({
    labels: [],
    releases: [],
    text: [],
    productionEnv: 'production',
    ...overrides,
  });
  const release = (stageType: string): ReleaseNode => ({
    name: 'Web',
    version: '1.4.0',
    url: 'https://l/r',
    completedAt: null,
    stage: { name: stageType === 'completed' ? 'Released' : 'In QA', type: stageType },
  });
  const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

  it('uses a completed release in place of the main-branch check', () => {
    const develop = pullRequests([pr(5, 'merged', 'develop')]);
    expect(codes(shippedStateFindings(DONE, develop, 'main', evidence({ releases: [release('completed')] })))).toEqual([]);
    expect(codes(shippedStateFindings(DONE, develop, 'main', evidence({ releases: [release('started')] })))).toEqual([
      'not_released',
    ]);
  });

  it('flags a Done ticket whose flag is dark in production, or has no production label', () => {
    const shipped = pullRequests([pr(6, 'merged', 'main')]);
    expect(
      codes(shippedStateFindings(DONE, shipped, 'main', evidence({ labels: ['posthog-flag', 'posthog-production:dark', 'posthog-preview:live'] }))),
    ).toEqual(['flag_dark']);
    expect(codes(shippedStateFindings(DONE, shipped, 'main', evidence({ labels: ['posthog-flag', 'posthog-preview:live'] })))).toEqual([
      'flag_unverified',
    ]);
    expect(codes(shippedStateFindings(DONE, shipped, 'main', evidence({ labels: ['posthog-flag', 'posthog-production:live'] })))).toEqual(
      [],
    );
    expect(codes(shippedStateFindings(MERGED, shipped, 'main', evidence({ labels: ['posthog-flag'] })))).toEqual([]);
  });

  it('flags PRs named in the thread but never linked', () => {
    const linked = pullRequests([pr(6, 'merged', 'main')]);
    const text = ['Shipped in https://github.com/o/r/pull/6 and o/r#7.', 'see path/to/o/r#8 (not a PR)', 'also O/R#7'];
    const findings = shippedStateFindings(DONE, linked, 'main', evidence({ text }));
    expect(codes(findings)).toEqual(['pr_mentioned_not_linked']);
    expect(findings[0]?.detail).toContain('o/r#7');
    expect(findings[0]?.detail).not.toContain('o/r#6');
    expect(mentionedPullRequests(text)).toEqual(['o/r#6', 'o/r#7']);
  });
});
