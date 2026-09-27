import { type Elicitor, ROW_WIDTH, elicitSignOff, signOffRows, wrap } from '../sign-off.js';

const REQUEST = {
  identifier: 'ENG-1',
  title: 'A ticket whose title is long enough to fill a terminal line',
  dropped: ['a check'],
  added: [],
  reason: 'moved elsewhere',
  risk: 'nobody runs it',
  description: '',
};

function elicitor(
  capable: boolean,
  answer: () => Promise<Awaited<ReturnType<Elicitor['elicitInput']>>>,
) {
  const seen: Parameters<Elicitor['elicitInput']>[0][] = [];
  const server: Elicitor = {
    getClientCapabilities: () => (capable ? { elicitation: {} } : {}),
    elicitInput: (params) => {
      seen.push(params);
      return answer();
    },
  };
  return { server, seen };
}

describe('the rows shown for sign-off', () => {
  it('shows the ticket, each check in full with what replaces it, then why and what approving gives up', () => {
    const rows = signOffRows({
      title: 'Sign-in drops the session',
      dropped: ['the test fails against develop', 'the build log shows it'],
      added: ['the test fails with the fix removed · Observed 6 (already ticked)'],
      reason: 'develop cannot reach this defect',
      risk: 'nobody runs it against develop',
    });
    expect(rows).toEqual([
      { title: 'Ticket', text: 'Sign-in drops the session' },
      { title: 'Check today 1', text: 'the test fails against develop' },
      {
        title: 'Becomes',
        text: 'the test fails with the fix removed · Observed 6 (already ticked)',
      },
      { title: 'Check today 2', text: 'the build log shows it' },
      { title: 'Becomes', text: 'nothing: this check is removed' },
      { title: 'Why the agent wants it', text: 'develop cannot reach this defect' },
      { title: 'If you accept', text: 'nobody runs it against develop' },
      { title: 'Your note (optional)', text: expect.stringContaining('press Decline') as string },
    ]);
    // Titles are fixed labels, short enough to survive the client's cut at about fifty columns.
    expect(Math.max(...rows.map((row) => row.title.length))).toBeLessThan(30);
  });

  it('continues a long check on the next rows instead of letting the client cut it', () => {
    const becomes =
      'the same test fails against a preview built with the fix removed (#1425), proving it goes red for this defect · Observed 4 (already ticked)';
    const rows = signOffRows({ ...REQUEST, dropped: ['a check'], added: [becomes] });
    const at = rows.findIndex((row) => row.title === 'Becomes');
    expect(rows[at + 1]?.title).toBe('↳');
    expect(
      rows
        .slice(at, at + 2)
        .map((row) => row.text)
        .join(' '),
    ).toBe(becomes);
    expect(Math.max(...rows.map((row) => row.text.length))).toBeLessThanOrEqual(ROW_WIDTH);
  });
});

describe('wrapping a row', () => {
  it('breaks at spaces, and gives a word longer than the width a line of its own', () => {
    expect(wrap('one two three', 7)).toEqual(['one two', 'three']);
    expect(wrap('aaaa bbbb cccc dddd e', 19)).toEqual(['aaaa bbbb', 'cccc dddd e']);
    expect(wrap('a verylongword b', 5)).toEqual(['a', 'verylongword', 'b']);
    expect(wrap('')).toEqual(['']);
  });
});

describe('elicitation sign-off', () => {
  it('says what is asked on the one visible line, puts the substance in the rows, and approves on Accept', async () => {
    const { server, seen } = elicitor(true, () =>
      Promise.resolve({ action: 'accept', content: {} }),
    );
    await expect(elicitSignOff(() => server)(REQUEST)).resolves.toEqual({
      outcome: 'approved',
      signer: 'person',
    });
    expect(seen[0]?.message).toBe(
      'ENG-1: the agent wants to change a Done when check. Read each row (↓), then Accept or Decline.',
    );
    expect(seen[0]?.requestedSchema.properties['row_1']).toMatchObject({
      type: 'string',
      title: 'Ticket',
      description: REQUEST.title,
    });
    expect(seen[0]?.requestedSchema.properties['row_2']).toMatchObject({
      type: 'string',
      title: 'Check today',
      description: 'a check',
    });
    expect(seen[0]?.requestedSchema.properties['row_5']).toMatchObject({
      title: 'If you accept',
      description: 'nobody runs it',
    });
    expect(seen[0]?.requestedSchema.required).toBeUndefined();
  });

  it('approves when the client sends the fields back empty, and keeps anything written', async () => {
    const run = (content: Record<string, string>) =>
      elicitSignOff(
        () => elicitor(true, () => Promise.resolve({ action: 'accept', content })).server,
      )(REQUEST);
    await expect(run({ row_1: '' })).resolves.toEqual({ outcome: 'approved', signer: 'person' });
    await expect(run({ row_6: ' fine, keep the other one ' })).resolves.toEqual({
      outcome: 'approved',
      signer: 'person',
      note: 'fine, keep the other one',
    });
  });

  it('returns what the client sent on anything but approval', async () => {
    const run = (answer: Parameters<typeof elicitor>[1]) =>
      elicitSignOff(() => elicitor(true, answer).server)(REQUEST);
    await expect(
      run(() => Promise.resolve({ action: 'decline', content: { row_5: 'keep it broad' } })),
    ).resolves.toEqual({
      outcome: 'declined',
      note: 'keep it broad',
      returned: 'action=decline, content {row_5: string}',
    });
    await expect(run(() => Promise.resolve({ action: 'cancel' }))).resolves.toEqual({
      outcome: 'unanswered',
      returned: 'action=cancel, no content',
    });
    await expect(run(() => Promise.reject(new Error('Request timed out')))).resolves.toEqual({
      outcome: 'unanswered',
      returned: 'error: Request timed out',
    });
  });

  it('does not ask a client that never declared elicitation, or before the server is up', async () => {
    const { server, seen } = elicitor(false, () =>
      Promise.resolve({ action: 'accept', content: {} }),
    );
    await expect(elicitSignOff(() => server)(REQUEST)).resolves.toEqual({ outcome: 'unavailable' });
    await expect(elicitSignOff(() => undefined)(REQUEST)).resolves.toEqual({
      outcome: 'unavailable',
    });
    expect(seen).toEqual([]);
  });
});
