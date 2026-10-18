import { authorName, nameOf } from '../issue-core.js';

describe('nameOf', () => {
  it('names an app identity by its full name, keeping the @ its handle drops', () => {
    expect(nameOf({ id: 'a', name: 'mayor@justin', displayName: 'mayorjustin', app: true })).toBe(
      'mayor@justin',
    );
  });

  it('names a person by their handle', () => {
    expect(nameOf({ id: 'p', name: 'Justin Stimatze', displayName: 'justin', app: false })).toBe(
      'justin',
    );
  });

  it('names a comment written by an app identity by its full name', () => {
    expect(
      authorName({
        user: { id: 'a', name: 'venus@justin', displayName: 'venusjustin', app: true },
        botActor: null,
        externalUser: null,
      }),
    ).toBe('venus@justin');
  });
});
