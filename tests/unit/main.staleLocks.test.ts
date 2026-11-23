/**
 * The rule by which a lock file counts as "left behind by a dead git" and is removed
 * (removeStaleLocks in src/main/git/repoService.ts) — with the wait in the hands of the
 * test, so that nothing here depends on how fast or how punctual the computer is.
 *
 * Two reviews of pull request #1 found this rule wrong in ways that only showed by chance:
 * measured against the clock a second time, a lock survived whenever the timer returned a
 * hair early; and a lock dated in the future was waited for as long as the clock was off.
 *
 * The second half pins WHICH locks are looked at (locksLeftWith, locksLeftBy), row by row:
 * the review of pull request #2 found that most rows had no test, and that the rule took a
 * lock or two more than the command in question can have left.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locksLeftBy, locksLeftWith, removeStaleLocks } from '../../src/main/git/repoService';

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

describe('which lock files are looked at', () => {
  /** A clone as far as its lock files go: every kind git knows, and a few things that are none of the app's business. */
  const IN_GIT = [
    'index.lock',
    'HEAD.lock',
    'config.lock',
    'packed-refs.lock',
    'ORIG_HEAD.lock',
    'refs/heads/main.lock',
    'refs/heads/feature/x.lock',
    'refs/remotes/origin/main.lock',
    'refs/remotes/origin/other.lock',
    'refs/team-schedule/synced.lock',
  ];
  const BRANCHES = ['packed-refs.lock', 'refs/heads/feature/x.lock', 'refs/heads/main.lock', 'refs/remotes/origin/main.lock', 'refs/remotes/origin/other.lock', 'refs/team-schedule/synced.lock'];
  const sorted = (names: string[]): string[] => [...names].sort();

  beforeEach(async () => {
    for (const name of IN_GIT) {
      const path = join(dir, '.git', ...name.split('/'));
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, '');
    }
    // Files that are no locks, and a "lock" that is not git's.
    await writeFile(join(dir, '.git', 'refs', 'heads', 'main'), 'abc\n');
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(join(dir, 'weeks'));
    await writeFile(join(dir, 'weeks', 'notes.lock'), '');
  });

  /** As paths inside .git with forward slashes, sorted and without doubles. */
  const inGit = (paths: string[]): string[] => {
    const gitDir = join(dir, '.git');
    return sorted([...new Set(paths)].map((path) => (path.startsWith(gitDir) ? path.slice(gitDir.length + 1).replace(/\\/g, '/') : `OUTSIDE:${path}`)));
  };
  const at = (name: string): string => join(dir, '.git', ...name.split('/'));

  describe('together with a lock that is in the way (locksLeftWith)', () => {
    it.each([
      ['the index', 'index.lock'],
      ['HEAD', 'HEAD.lock'],
      ['the local branch', 'refs/heads/main.lock'],
      ['a local branch in a folder', 'refs/heads/feature/x.lock'],
    ])('%s: HEAD and the branches may be in the way next', async (_what, name) => {
      expect(inGit(await locksLeftWith(dir, at(name)))).toEqual(sorted(['HEAD.lock', ...BRANCHES]));
    });

    it.each([
      ['the team\'s branch', 'refs/remotes/origin/main.lock'],
      ['the mark of what was agreed with the team', 'refs/team-schedule/synced.lock'],
      ['packed-refs', 'packed-refs.lock'],
    ])('%s: the branches, and neither the index nor HEAD', async (_what, name) => {
      expect(inGit(await locksLeftWith(dir, at(name)))).toEqual(sorted(BRANCHES));
    });

    it.each([
      ['the configuration', 'config.lock'],
      ['a lock the app knows nothing about', 'ORIG_HEAD.lock'],
    ])('%s: nothing more', async (_what, name) => {
      expect(await locksLeftWith(dir, at(name))).toEqual([]);
    });

    it('a path outside the clone\'s .git folder: nothing', async () => {
      expect(await locksLeftWith(dir, join(dir, 'weeks', 'notes.lock'))).toEqual([]);
      expect(await locksLeftWith(dir, join(dir, 'refs', 'heads', 'main.lock'))).toEqual([]);
    });
  });

  describe('after a command that was ended by force (locksLeftBy)', () => {
    const ALL = sorted(['index.lock', 'HEAD.lock', ...BRANCHES]);

    it.each([
      ['fetch', ['fetch', '--prune', 'origin']],
      ['push', ['push', '--porcelain', 'origin', 'HEAD:refs/heads/main']],
    ])('%s talks to the server and writes nothing but branches', async (_command, args) => {
      expect(inGit(await locksLeftBy(dir, args))).toEqual(sorted(BRANCHES));
    });

    it.each([
      ['commit', ['commit', '--quiet', '--file=-']],
      ['reset --mixed', ['reset', '--mixed', '--quiet', 'abc123']],
      ['reset --hard', ['reset', '--hard', '--quiet', 'abc123']],
      ['checkout of a branch', ['checkout', '--quiet', '-B', 'main', 'refs/remotes/origin/main']],
      ['checkout of a new branch', ['checkout', '--quiet', '-B', 'other']],
    ])('%s moves the working copy: the index, HEAD and the branches', async (_command, args) => {
      expect(inGit(await locksLeftBy(dir, args))).toEqual(ALL);
    });

    it.each([
      ['add', ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul']],
      ['read-tree', ['read-tree', '--empty']],
      ['checkout of files', ['checkout', '--quiet', '--', '.', ':(exclude)schedule.json', ':(exclude)weeks']],
    ])('%s writes the index and nothing else', async (_command, args) => {
      expect(inGit(await locksLeftBy(dir, args))).toEqual(['index.lock']);
    });

    it.each([
      ['update-ref of the agreed mark', ['update-ref', 'refs/team-schedule/synced', 'abc123']],
      ['update-ref of the team\'s branch', ['update-ref', 'refs/remotes/origin/main', 'abc123']],
      ['update-ref -d HEAD', ['update-ref', '-d', 'HEAD']],
    ])('%s writes HEAD and branches, never the index', async (_command, args) => {
      expect(inGit(await locksLeftBy(dir, args))).toEqual(sorted(['HEAD.lock', ...BRANCHES]));
    });

    it('symbolic-ref that points HEAD at a branch writes HEAD only', async () => {
      expect(inGit(await locksLeftBy(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']))).toEqual(['HEAD.lock']);
    });

    it.each([
      ['the current branch', ['symbolic-ref', '--quiet', '--short', 'HEAD']],
      ['the server\'s default branch', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']],
    ])('symbolic-ref that only reads %s leaves nothing', async (_what, args) => {
      expect(await locksLeftBy(dir, args)).toEqual([]);
    });

    it('config writes the configuration and nothing else', async () => {
      expect(inGit(await locksLeftBy(dir, ['config', 'user.name', 'Dana']))).toEqual(['config.lock']);
    });

    it.each([
      ['rev-parse', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']],
      ['rev-list', ['rev-list', '--count', 'abc..def']],
      ['log', ['log', '--max-count=50', '--format=%H', 'abc..def']],
      ['ls-tree', ['ls-tree', '-r', '-z', 'abc', '--', 'schedule.json', 'weeks']],
      ['cat-file', ['cat-file', '--batch']],
      ['diff', ['diff', '--cached', '--quiet']],
      ['merge-base', ['merge-base', 'abc', 'def']],
      ['for-each-ref', ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin']],
      ['check-ref-format', ['check-ref-format', '--branch', 'main']],
      ['a command this table does not know', ['gc', '--auto']],
      ['no command at all', []],
    ])('%s only reads (or is unknown): nothing is assumed', async (_command, args) => {
      expect(await locksLeftBy(dir, args)).toEqual([]);
    });

    it('never names a lock the app knows nothing about, or anything outside .git', async () => {
      for (const args of [['fetch'], ['commit'], ['reset', '--mixed', 'abc'], ['update-ref', '-d', 'HEAD'], ['config', 'a', 'b']]) {
        const names = inGit(await locksLeftBy(dir, args));
        expect(names).not.toContain('ORIG_HEAD.lock');
        expect(names.filter((name) => name.startsWith('OUTSIDE:'))).toEqual([]);
      }
    });
  });
});
