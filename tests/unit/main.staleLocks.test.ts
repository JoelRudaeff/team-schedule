/**
 * The rule by which a lock file counts as "left behind by a dead git" and is removed
 * (removeStaleLocks in src/main/git/repoService.ts) — with the wait in the hands of the
 * test, so that nothing here depends on how fast or how punctual the computer is.
 *
 * Two reviews of pull request #1 found this rule wrong in ways that only showed by chance:
 * measured against the clock a second time, a lock survived whenever the timer returned a
 * hair early; and a lock dated in the future was waited for as long as the clock was off.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeStaleLocks } from '../../src/main/git/repoService';

/** The moment a lock is given (STALE_LOCK_MS). */
const MOMENT_MS = 2_000;

let dir = '';
/** Every wait that was asked for, in milliseconds. */
let waits: number[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'team-schedule-locks-'));
  waits = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A lock file that was written `ageMs` ago (a negative age lies in the future). */
async function lock(name: string, ageMs: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, '');
  const written = new Date(Date.now() - ageMs);
  await utimes(path, written, written);
  return path;
}

/** A wait that is over at once — what a timer that returns early looks like, taken to the extreme. */
const atOnce = async (ms: number): Promise<void> => {
  waits.push(ms);
};

/** A wait during which something happens to the locks. */
const during =
  (event: () => Promise<void>) =>
  async (ms: number): Promise<void> => {
    waits.push(ms);
    await event();
  };

const left = async (): Promise<string[]> => (await readdir(dir)).sort();

describe('removing the lock files a dead git left behind', () => {
  it('a lock that has been lying there for a while goes at once, without any wait', async () => {
    const old = await lock('index.lock', 60_000);
    await removeStaleLocks([old], atOnce);
    expect(await left()).toEqual([]);
    expect(waits).toEqual([]);
  });

  it('a lock that was only just written is given its moment — and goes afterwards, even when the wait returns early', async () => {
    const young = await lock('index.lock', 0);
    await removeStaleLocks([young], atOnce);

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(MOMENT_MS - 500);
    expect(waits[0]).toBeLessThanOrEqual(MOMENT_MS);
    // Not measured against the clock again: it is the same untouched file, so it goes.
    expect(await left()).toEqual([]);
  });

  it('the wait is counted from the youngest lock, and the old ones go with it', async () => {
    const old = await lock('HEAD.lock', 60_000);
    const young = await lock('index.lock', 500);
    await removeStaleLocks([old, young], atOnce);

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(MOMENT_MS - 1_000);
    expect(waits[0]).toBeLessThanOrEqual(MOMENT_MS - 500);
    expect(await left()).toEqual([]);
  });

  it('a lock dated in the future (the clock was set back since) is given the usual moment, never more', async () => {
    const future = await lock('index.lock', -3_600_000);
    await removeStaleLocks([future], atOnce);

    expect(waits).toEqual([MOMENT_MS]);
    expect(await left()).toEqual([]);
  });

  it('a lock that is written again during the wait belongs to a git at work: it is left alone', async () => {
    const held = await lock('index.lock', 0);
    const stale = await lock('HEAD.lock', 0);
    await removeStaleLocks(
      [held, stale],
      during(async () => {
        const again = new Date(Date.now() + 1_000);
        await utimes(held, again, again);
      }),
    );
    expect(await left()).toEqual(['index.lock']);
  });

  it('a lock that was replaced by a new one during the wait is left alone as well', async () => {
    const replaced = await lock('index.lock', 0);
    await removeStaleLocks(
      [replaced],
      during(async () => {
        await rm(replaced);
        await lock('index.lock', -1_000);
      }),
    );
    expect(await left()).toEqual(['index.lock']);
  });

  it('a lock that is gone after the wait: nothing happens', async () => {
    const gone = await lock('index.lock', 0);
    const stale = await lock('HEAD.lock', 0);
    await removeStaleLocks([gone, stale], during(() => rm(gone)));
    expect(await left()).toEqual([]);
  });

  it('a lock that is not there, and one that cannot be removed, do not keep the others from going', async () => {
    const stale = await lock('HEAD.lock', 60_000);
    // Something that cannot be removed like a file: a folder with something in it.
    const stuck = join(dir, 'index.lock');
    await mkdir(stuck);
    await writeFile(join(stuck, 'inside'), '');
    const old = new Date(Date.now() - 60_000);
    await utimes(stuck, old, old);

    await expect(removeStaleLocks([join(dir, 'missing.lock'), stuck, stale, stale], atOnce)).resolves.toBeUndefined();

    expect(await left()).toEqual(['index.lock']);
    expect(waits).toEqual([]);
  });

  it('with nothing to look at, nothing is waited for', async () => {
    await removeStaleLocks([], atOnce);
    await removeStaleLocks([join(dir, 'missing.lock')], atOnce);
    expect(waits).toEqual([]);
  });
});
