import { memoryClaimStore } from '../claims.js';
import { releaseNoteFindings, releaseNoteLabelsFromEnv } from '../release-note.js';
import type { TeamRouting } from '../route.js';
import { StrictLinear } from '../strict-linear.js';
import { type FakeState, fakeGql, fakeState } from './strict-fake-linear.helper.js';

const YES_LABEL = { id: 'l-rn', name: 'release-note', isGroup: false };
const PAIR_LABELS = [YES_LABEL, { id: 'l-rn-none', name: 'release-note-none', isGroup: false }];

function setup(overrides: Partial<FakeState> = {}, teamRouting?: TeamRouting) {
  const state = fakeState({ projects: [], ...overrides });
  state.labels.push(...PAIR_LABELS);
  const strict = new StrictLinear({
    gql: fakeGql(state),
    claims: memoryClaimStore(),
    now: () => new Date('2026-11-01T12:00:00Z'),
    teamRouting,
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

  it('refuses a value other than yes or none before any call', async () => {
    const { state, strict } = setup();
    await expect(
      strict.createIssue({
        team: 'ENG',
        title: 'Logs keep chats',
        release_note: 'maybe' as never,
      }),
    ).rejects.toThrow(/release_note must be "yes" or "none"/);
    expect(state.calls).toEqual([]);
  });
});

describe('release_note on set_fields', () => {
  it('adds the chosen label and removes the other in the same update', async () => {
    const { state, strict } = setup();
    await strict.setFields('ENG-1', { release_note: 'none' });
    expect(state.updates).toEqual([{ addedLabelIds: ['l-rn-none'], removedLabelIds: ['l-rn'] }]);
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
  it('defaults to release-note and release-note-none, and "off" turns it off', () => {
    expect(releaseNoteLabelsFromEnv({})).toEqual({
      yes: 'release-note',
      none: 'release-note-none',
    });
    expect(releaseNoteLabelsFromEnv({ LINEAR_STRICT_RELEASE_NOTE_LABELS: 'off' })).toBeNull();
    expect(releaseNoteLabelsFromEnv({ LINEAR_STRICT_RELEASE_NOTE_LABELS: 'ship, quiet' })).toEqual({
      yes: 'ship',
      none: 'quiet',
    });
  });

  it('refuses one name, three names, or the same name twice, rather than guessing', () => {
    for (const raw of ['ship', 'a,b,c', 'same,SAME']) {
      expect(() => releaseNoteLabelsFromEnv({ LINEAR_STRICT_RELEASE_NOTE_LABELS: raw })).toThrow(
        /two different labels/,
      );
    }
  });
});
