import { memoryClaimStore } from '../claims.js';
import {
  parseReleaseNoteLine,
  releaseNoteFindings,
  releaseNoteGateFromEnv,
  releaseNoteLabelsFromEnv,
} from '../release-note.js';
import type { TeamRouting } from '../route.js';
import { StrictLinear } from '../strict-linear.js';
import { type FakeState, fakeGql, fakeState } from './strict-fake-linear.helper.js';

const YES_LABEL = { id: 'l-rn', name: 'release-note', isGroup: false };
const PAIR_LABELS = [YES_LABEL, { id: 'l-rn-none', name: 'release-note-none', isGroup: false }];
const SELFHOST_LABEL = { id: 'l-rn-selfhost', name: 'release-note-selfhost', isGroup: false };

function setup(
  overrides: Partial<FakeState> = {},
  teamRouting?: TeamRouting,
  releaseNoteGate: 'warn' | 'block' = 'block',
) {
  const state = fakeState({ projects: [], ...overrides });
  state.labels.push(...PAIR_LABELS);
  const strict = new StrictLinear({
    gql: fakeGql(state),
    claims: memoryClaimStore(),
    now: () => new Date('2026-11-01T12:00:00Z'),
    teamRouting,
    releaseNoteGate,
  });
  return { state, strict };
}

describe('release_note on create_issue', () => {
  it('refuses a filing that does not say whether a visitor will notice it, quoting the rubric', async () => {
    const { state, strict } = setup();
    await expect(strict.createIssue({ team: 'ENG', title: 'Logs keep chats' })).rejects.toThrow(
      /release_note is required on ENG[\s\S]*none: nothing a visitor sees changes/,
    );
    expect(state.created).toEqual([]);
  });

  it('files the label the author chose', async () => {
    const { state, strict } = setup();
    const result = await strict.createIssue({
      team: 'ENG',
      title: 'Logs keep chats',
      release_note: 'yes',
    });
    expect(state.created).toEqual([
      { teamId: 't-1', title: 'Logs keep chats', labelIds: ['l-rn'] },
    ]);
    expect(result).toMatchObject({ release_note: 'yes' });
  });

  it("defaults to none on the agents' own team, where nothing a visitor sees is filed", async () => {
    const { state, strict } = setup({}, { productTeams: ['CUR'], fleetTeam: 'ENG' });
    await strict.createIssue({ team: 'ENG', title: 'Gate reruns a flaky shard' });
    expect(state.created).toEqual([
      { teamId: 't-1', title: 'Gate reruns a flaky shard', labelIds: ['l-rn-none'] },
    ]);
  });

  it('stays off, filing without a label, in a workspace that has not created both labels', async () => {
    const state = fakeState({ projects: [] });
    state.labels.push(YES_LABEL);
    const strict = new StrictLinear({ gql: fakeGql(state), claims: memoryClaimStore() });
    const result = await strict.createIssue({
      team: 'ENG',
      title: 'Logs keep chats',
      release_note: 'yes',
    });
    expect(state.created).toEqual([{ teamId: 't-1', title: 'Logs keep chats' }]);
    expect((result as { release_note_unset?: string }).release_note_unset).toMatch(
      /no release-note labels/,
    );
  });

  it('refuses a value other than yes, none or selfhost before any call', async () => {
    const { state, strict } = setup();
    await expect(
      strict.createIssue({
        team: 'ENG',
        title: 'Logs keep chats',
        release_note: 'maybe' as never,
      }),
    ).rejects.toThrow(/release_note must be "yes", "none" or "selfhost"/);
    expect(state.calls).toEqual([]);
  });
});

describe('release_note on set_fields', () => {
  it('adds the chosen label and removes the other in the same update', async () => {
    const { state, strict } = setup();
    state.issue.labels = ['release-note'];
    await strict.setFields('ENG-1', { release_note: 'none' });
    expect(state.updates).toEqual([{ addedLabelIds: ['l-rn-none'], removedLabelIds: ['l-rn'] }]);
  });

  it('removes nothing the ticket lacks, since Linear refuses that, and adds nothing it has', async () => {
    const { state, strict } = setup();
    await strict.setFields('ENG-1', { release_note: 'yes' });
    expect(state.updates).toEqual([{ addedLabelIds: ['l-rn'] }]);
  });

  it('refuses, naming both labels, where the workspace lacks them', async () => {
    const state = fakeState();
    const strict = new StrictLinear({ gql: fakeGql(state), claims: memoryClaimStore() });
    await expect(strict.setFields('ENG-1', { release_note: 'yes' })).rejects.toThrow(
      /"release-note" and "release-note-none"/,
    );
    expect(state.updates).toEqual([]);
  });
});

describe('release_note on get_issue', () => {
  it('asks for the label on a ticket that carries neither', async () => {
    const { strict } = setup();
    const read = await strict.getIssue('ENG-1');
    expect(read.findings.map((f: { code: string }) => f.code)).toContain('release_note_unset');
  });

  it('says nothing once the ticket carries one', async () => {
    const { state, strict } = setup();
    state.issue.labels = ['release-note-none'];
    const read = await strict.getIssue('ENG-1');
    expect(read.findings.map((f: { code: string }) => f.code)).not.toContain('release_note_unset');
  });

  it('never asks about a canceled ticket, which ships nothing', () => {
    const pair = { yes: 'release-note', none: 'release-note-none' };
    expect(releaseNoteFindings({ type: 'canceled' }, [], pair)).toEqual([]);
    expect(
      releaseNoteFindings({ type: 'started' }, ['release-note', 'release-note-none'], pair),
    ).toEqual([{ code: 'release_note_unset', detail: expect.any(String) as string }]);
    expect(
      releaseNoteFindings({ type: 'started' }, ['release-note', 'release-note-none'], pair)[0]
        ?.detail,
    ).toMatch(/^Both/);
  });
});

describe('LINEAR_STRICT_RELEASE_NOTE_LABELS', () => {
  it('defaults to release-note, release-note-none and release-note-selfhost, and "off" turns it off', () => {
    expect(releaseNoteLabelsFromEnv({})).toEqual({
      yes: 'release-note',
      none: 'release-note-none',
      selfhost: 'release-note-selfhost',
    });
    expect(releaseNoteLabelsFromEnv({ LINEAR_STRICT_RELEASE_NOTE_LABELS: 'off' })).toBeNull();
    expect(releaseNoteLabelsFromEnv({ LINEAR_STRICT_RELEASE_NOTE_LABELS: 'ship, quiet' })).toEqual({
      yes: 'ship',
      none: 'quiet',
    });
    expect(
      releaseNoteLabelsFromEnv({ LINEAR_STRICT_RELEASE_NOTE_LABELS: 'ship,quiet,own' }),
    ).toEqual({ yes: 'ship', none: 'quiet', selfhost: 'own' });
  });

  it('refuses one name, four names, an empty third, or the same name twice, rather than guessing', () => {
    for (const raw of ['ship', 'a,b,c,d', 'a,b,', 'same,SAME', 'a,b,A']) {
      expect(() => releaseNoteLabelsFromEnv({ LINEAR_STRICT_RELEASE_NOTE_LABELS: raw })).toThrow(
        /two or three different labels/,
      );
    }
  });
});

const LINE =
  'Fixed · Alpha · If your connection drops partway through an answer, it keeps streaming from where it stopped. · flag: none';

describe('parseReleaseNoteLine', () => {
  it('reads kind, area, sentence and flag from a well-formed line, and NONE as none', () => {
    expect(parseReleaseNoteLine(LINE)).toEqual({
      line: {
        kind: 'Fixed',
        area: 'Alpha',
        sentence:
          'If your connection drops partway through an answer, it keeps streaming from where it stopped.',
        flag: null,
      },
    });
    expect(
      parseReleaseNoteLine(
        'Added · Self-host · You can sign in with your own OIDC provider. · flag: self-host-oidc',
      ),
    ).toMatchObject({ line: { area: 'Self-host', flag: 'self-host-oidc' } });
    expect(parseReleaseNoteLine('NONE')).toEqual({ none: true });
  });

  it('names every reason a line is not one, rather than guessing what was meant', () => {
    const bad = (text: string) => {
      const parsed = parseReleaseNoteLine(text);
      return 'errors' in parsed ? parsed.errors.join(' | ') : '';
    };
    expect(bad('Fixed · Alpha · Streams resume after a dropped connection.')).toMatch(
      /has 3 parts/,
    );
    expect(
      bad('Improved · Chat · Streams resume after a dropped connection. · flag: none'),
    ).toMatch(/kind "Improved"[\s\S]*area "Chat"/);
    expect(bad('Fixed · Alpha · Fixes CUR-123 for everyone here. · flag: none')).toMatch(
      /ticket id/,
    );
    expect(bad('Fixed · Alpha · Streams resume after a drop. · no flag')).toMatch(/flag: <key>/);
    expect(bad('none')).toMatch(/has 1 part/);
  });
});

describe('the Release note section on set_state', () => {
  it('writes NONE and moves the label to release-note-none in the same update', async () => {
    const { state, strict } = setup();
    state.issue.labels = ['release-note'];
    const result = await strict.setState('ENG-1', [
      { section: 'Release note', mode: 'replace', body: 'NONE' },
    ]);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      addedLabelIds: ['l-rn-none'],
      removedLabelIds: ['l-release-note'],
    });
    expect(state.issue.description).toContain('## Release note\n\nNONE');
    expect(result).toMatchObject({
      release_note: expect.stringMatching(/release-note-none/) as string,
    });
  });

  it('writes a line on a release-note ticket without touching its labels', async () => {
    const { state, strict } = setup();
    state.issue.labels = ['release-note'];
    await strict.setState('ENG-1', [{ section: 'Release note', mode: 'replace', body: LINE }]);
    expect(state.updates).toEqual([{ description: expect.stringContaining(LINE) as string }]);
  });

  it('moves a release-note-none ticket to release-note when a line is written, so label and line agree', async () => {
    const { state, strict } = setup();
    state.issue.labels = ['release-note-none'];
    await strict.setState('ENG-1', [{ section: 'Release note', mode: 'replace', body: LINE }]);
    expect(state.updates[0]).toMatchObject({
      addedLabelIds: ['l-rn'],
      removedLabelIds: ['l-release-note-none'],
    });
  });

  it('refuses a malformed line, two lines, or append mode, and writes nothing', async () => {
    const { state, strict } = setup();
    for (const [mode, body] of [
      ['replace', 'Fixed · Alpha · Streams resume.'],
      ['replace', `${LINE}\n${LINE}`],
      ['append', LINE],
    ] as const) {
      await expect(
        strict.setState('ENG-1', [{ section: 'Release note', mode, body }]),
      ).rejects.toThrow(/Release note:/);
    }
    expect(state.updates).toEqual([]);
  });

  it('is not written through a comment, which would leave the label behind', async () => {
    const { state, strict } = setup();
    await expect(
      strict.comment('ENG-1', {
        kind: 'correction',
        body: 'The note line',
        patch: [{ section: 'Release note', mode: 'replace', body: 'NONE' }],
      }),
    ).rejects.toThrow(/"Release note" cannot be patched here/);
    expect(state.updates).toEqual([]);
  });
});

describe('set_status with LINEAR_STRICT_RELEASE_NOTE_GATE=block refuses to ship a release-note ticket without its line', () => {
  const shipStates = [
    { id: 's-todo', name: 'Todo', type: 'unstarted' },
    { id: 's-progress', name: 'In Progress', type: 'started' },
    { id: 's-merged', name: 'Merged', type: 'started' },
    { id: 's-verify', name: 'Verify', type: 'started' },
    { id: 's-done', name: 'Done', type: 'completed' },
  ];

  it.each(['Merged', 'Verify', 'Done'])(
    'refuses %s with no Release note section',
    async (target) => {
      const { state, strict } = setup({ states: shipStates });
      state.issue.labels = ['release-note'];
      await strict.claim('ENG-1');
      await expect(strict.setStatus('ENG-1', target)).rejects.toThrow(
        new RegExp(
          `Refusing to move ENG-1 to ${target}: it is labelled "release-note" and has no ## Release note section`,
        ),
      );
      expect(state.issue.stateId).toBe('s-todo');
    },
  );

  it('refuses a release-note-selfhost ticket whose line does not parse, quoting why', async () => {
    const { state, strict } = setup({ states: shipStates });
    state.labels.push(SELFHOST_LABEL);
    state.issue.labels = ['release-note-selfhost'];
    state.issue.description = `${state.issue.description}\n\n## Release note\n\nAdded · Alpha · New. · flag: none`;
    await expect(strict.setStatus('ENG-1', 'Merged')).rejects.toThrow(
      /labelled "release-note-selfhost" and has a ## Release note line that does not parse \(Release note: the sentence is missing or too short/,
    );
  });

  it('moves a release-note ticket once its line is well formed', async () => {
    const { state, strict } = setup({ states: shipStates });
    state.issue.labels = ['release-note'];
    state.issue.description = `${state.issue.description}\n\n## Release note\n\n${LINE}`;
    await expect(strict.setStatus('ENG-1', 'Verify')).resolves.toMatchObject({ state: 'Verify' });
  });

  it('lets a release-note-none ticket and a move to In Progress through without a line', async () => {
    const { state, strict } = setup({ states: shipStates });
    state.issue.labels = ['release-note'];
    await expect(strict.setStatus('ENG-1', 'In Progress')).resolves.toMatchObject({
      state: 'In Progress',
    });
    state.issue.labels = ['release-note-none'];
    await expect(strict.setStatus('ENG-1', 'Merged')).resolves.toMatchObject({ state: 'Merged' });
  });

  it('by default warns instead: the move lands and the result names the missing line', async () => {
    const { state, strict } = setup({ states: shipStates }, undefined, 'warn');
    state.issue.labels = ['release-note'];
    const result = await strict.setStatus('ENG-1', 'Verify');
    expect(state.issue.stateId).toBe('s-verify');
    expect(result).toMatchObject({
      state: 'Verify',
      release_note_missing: expect.stringMatching(
        /^ENG-1 moved to Verify, but it is labelled "release-note" and has no ## Release note section[\s\S]*set_state/,
      ) as string,
    });
  });

  it('reads the mode from LINEAR_STRICT_RELEASE_NOTE_GATE, warn unless it says block', () => {
    expect(releaseNoteGateFromEnv({})).toBe('warn');
    expect(releaseNoteGateFromEnv({ LINEAR_STRICT_RELEASE_NOTE_GATE: 'Block' })).toBe('block');
    expect(() => releaseNoteGateFromEnv({ LINEAR_STRICT_RELEASE_NOTE_GATE: 'on' })).toThrow(
      /"warn" or "block"/,
    );
  });

  it('flags a malformed line on get_issue', async () => {
    const { state, strict } = setup();
    state.issue.labels = ['release-note'];
    state.issue.description = `${state.issue.description}\n\n## Release note\n\nFixed · it works`;
    const read = await strict.getIssue('ENG-1');
    expect(read.findings.map((f: { code: string }) => f.code)).toContain(
      'release_note_line_invalid',
    );
  });
});

describe('release_note selfhost and the section on create_issue', () => {
  it('files release-note-selfhost where the workspace has it', async () => {
    const { state, strict } = setup();
    state.labels.push(SELFHOST_LABEL);
    await strict.createIssue({
      team: 'ENG',
      title: 'OIDC for self-hosters',
      release_note: 'selfhost',
    });
    expect(state.created).toEqual([
      { teamId: 't-1', title: 'OIDC for self-hosters', labelIds: ['l-rn-selfhost'] },
    ]);
  });

  it('refuses selfhost where the label does not exist, saying labels are not created here', async () => {
    const { state, strict } = setup();
    await expect(
      strict.createIssue({ team: 'ENG', title: 'OIDC for self-hosters', release_note: 'selfhost' }),
    ).rejects.toThrow(/"release-note-selfhost"[\s\S]*Labels are not created here/);
    expect(state.created).toEqual([]);
  });

  it('takes the label from a NONE section and refuses a release_note that contradicts it', async () => {
    const { state, strict } = setup();
    await strict.createIssue({
      team: 'ENG',
      title: 'Quarantine a red test',
      sections: [{ section: 'Release note', mode: 'replace', body: 'NONE' }],
    });
    expect(state.created[0]).toMatchObject({ labelIds: ['l-rn-none'] });
    await expect(
      strict.createIssue({
        team: 'ENG',
        title: 'Quarantine another red test',
        release_note: 'yes',
        sections: [{ section: 'Release note', mode: 'replace', body: 'NONE' }],
      }),
    ).rejects.toThrow(/contradicts the Release note section/);
  });
});
