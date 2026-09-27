import { readFileSync } from 'node:fs';

const read = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

describe('published metadata', () => {
  it('names one version and one registry name everywhere a release has to change them', () => {
    const pkg = read('package.json');
    const server = read('server.json') as {
      name: string;
      version: string;
      packages: { identifier: string; version: string }[];
    };
    expect(server.name).toBe(pkg['mcpName']);
    expect(server.version).toBe(pkg['version']);
    expect(server.packages.map((entry) => [entry.identifier, entry.version])).toEqual([
      [pkg['name'], pkg['version']],
    ]);
  });
});
