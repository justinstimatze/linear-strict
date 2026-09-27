import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { guardInstance } from '../single-instance.js';

describe('one server per client connection', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'instances-'));
  const identity = ['/opt/linear-strict/dist/index.js', '/work', 'LINEAR_API_TOKEN=x'];

  function server(pid: number, clock: { now: number }, lastCallAt = () => 0, ppid = () => 100) {
    return guardInstance({
      dir,
      identity,
      pid,
      ppid: 100,
      now: () => clock.now,
      isAlive: (other) => other === 1 || other === 2,
      currentPpid: ppid,
      graceMs: 60_000,
      intervalMs: 60_000,
      lastCallAt,
      exit: () => undefined,
    });
  }

  it('lets the older server go once a newer one runs for the same client and the older one sits idle', () => {
    const clock = { now: Date.now() };
    const older = server(1, clock);
    const newer = server(2, clock);
    expect(newer.check()).toBeNull();
    expect(older.check()).toBeNull();
    clock.now += 61_000;
    expect(older.check()).toMatch(/newer server \(pid 2\)/);
    expect(newer.check()).toBeNull();
    older.stop();
    newer.stop();
  });

  it('keeps an older server the client is still calling', () => {
    const clock = { now: Date.now() };
    let lastCall = 0;
    const older = server(1, clock, () => lastCall);
    const newer = server(2, clock);
    clock.now += 61_000;
    lastCall = clock.now;
    expect(older.check()).toBeNull();
    older.stop();
    newer.stop();
  });

  it('goes when its parent does', () => {
    const clock = { now: Date.now() };
    const orphan = server(1, clock, () => 0, () => 1);
    expect(orphan.check()).toMatch(/parent \(pid 100\) exited/);
    orphan.stop();
  });
});
