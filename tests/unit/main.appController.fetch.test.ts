/**
 * AppController.fetch() only STARTS the check for updates in its queue; the wait for the
 * server runs outside it. What that must (and must not) change, seen from the controller:
 * writing edits is not held up, a connect and the end of the app still wait for the fetch,
 * and a failure of the fetch still reaches whoever asked for it.
 * (Added after a review found these changes untested and idle() no longer waiting.)
 *
 * shutdown() is what the app awaits when its last window has closed: it ends the waiting
 * check instead of sitting it out. (A second review found that a closed app could otherwise
 * not be opened again until git gave up on the server.) It gives a check that is simply at
 * work a moment to finish first, and it never stops waiting for anything else. (A third
 * review found that ending a healthy check by force can leave a git lock file behind, and
 * that the test of "waits for everything else" passed without the wait.)
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncStatus } from '@shared/api';
import { AppController, type Desktop, type GitLayer, type RepoHandle } from '../../src/main/appController';
import type { GitRunner } from '../../src/main/git/gitRunner';
import { LocalStore } from '../../src/main/localStore';

const STATUS: SyncStatus = { headSha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'a'.repeat(40), ahead: 0, behind: 0, incoming: [], lastFetchAt: null, fetchError: null };
const URL = 'https://example.com/team/schedule.git';

interface Rig {
  root: string;
  controller: AppController;
  log: string[];
  /** Lets the pending fetch of the pretend service finish (or fail). */
  finishFetch: (error?: Error) => void;
  connects: number;
  /** How often the pretend service was told to stop its fetch. */
  stops: number;
  /** While set, writing the working files stays open until `finishWrite()` is called. */
  holdWrites: boolean;
  finishWrite: () => void;
}

/** The moment shutdown() gives the work in flight (the app itself uses two seconds). */
const GRACE_MS = 60;

async function createRig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'team-schedule-pr-controller-'));
  const rig = { root, log: [] as string[], connects: 0, stops: 0, holdWrites: false, finishWrite: () => undefined, finishFetch: () => undefined } as unknown as Rig;
  let fetching: Promise<void> = Promise.resolve();

  const service = (dir: string, url: string, branch: string): RepoHandle => ({
    dir,
    url,
    branch,
    // Like RepoService.idle(): settles when the fetch is over, never rejects.
    idle: () => fetching.then(() => undefined, () => undefined),
    // Like RepoService.stopFetch(): the fetch that is waiting ends (with an error in its status, not a rejection).
    stopFetch: () => {
      rig.stops += 1;
      rig.log.push('stopFetch');
      rig.finishFetch();
    },
    setIdentity: async () => undefined,
    hasSchedule: async () => true,
    fetch: () => {
      rig.log.push('fetch started');
      const result = new Promise<SyncStatus>((resolve, reject) => {
        rig.finishFetch = (error) => {
          rig.log.push(error ? 'fetch failed' : 'fetch finished');
          if (error) reject(error);
          else resolve(STATUS);
        };
      });
      fetching = result.then(() => undefined);
      fetching.catch(() => undefined);
      return result;
    },
    loadSnapshot: async () => ({ status: STATUS, baseFiles: {}, workingFiles: {} }),
    loadRemote: async () => null,
    writeWorking: async () => {
      rig.log.push('writeWorking started');
      if (rig.holdWrites) await new Promise<void>((resolve) => (rig.finishWrite = resolve));
      rig.log.push('writeWorking done');
    },
    applyUpdate: async () => ({ ok: true, status: STATUS }),
    publish: async () => ({ ok: true, status: STATUS, commitSha: null }),
    createSchedule: async () => ({ ok: true, status: STATUS, commitSha: null }),
    discardLocal: async () => ({ status: STATUS, baseFiles: {}, workingFiles: {} }),
    blame: async (weekStart) => ({ weekStart, headSha: null, events: {}, title: null }),
  });
  const runner = (gitPath: string): GitRunner => ({ gitPath, run: async () => ({ code: 1, stdout: '', stderr: '', stdoutBuffer: Buffer.alloc(0) }) });
  const layer: GitLayer = {
    detectGit: async () => ({ found: true, path: 'C:\\Git\\cmd\\git.exe', version: '2.55.0' }),
    createGitRunner: runner,
    async connect(_git, params) {
      rig.connects += 1;
      rig.log.push('connect started');
      return { service: service(params.dir, params.url, params.branch ?? 'main'), remoteEmpty: false, hasSchedule: true };
    },
    open: async (_git, dir, url, branch) => service(dir, url, branch),
  };
  const desktop: Desktop = {
    appVersion: () => '1.0.1',
    systemLocale: () => 'en-US',
    documentsDir: () => join(root, 'Documents'),
    showSaveDialog: async () => null,
    showOpenDialog: async () => null,
    openPath: async () => '',
    openExternal: async () => undefined,
    notify: () => undefined,
    acknowledgeCloseRequest: () => undefined,
    closeWindow: () => undefined,
  };
  rig.controller = new AppController({ store: new LocalStore(join(root, 'userData')), desktop, git: layer, shutdownGraceMs: GRACE_MS });
  await rig.controller.boot();
  const connected = await rig.controller.connectRepo({ url: URL, branch: null, userName: 'Dana', userEmail: 'dana@example.com' });
  expect(connected.ok).toBe(true);
  rig.log.length = 0;
  return rig;
}

const settled = async (promise: Promise<unknown>, ms = 150): Promise<boolean> =>
  Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

describe('a background fetch that waits for the server, seen from the controller', () => {
  let rig: Rig;
  afterEach(async () => {
    rig.finishFetch();
    rig.finishWrite();
    await rig.controller.idle();
    await rm(rig.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('writing edits does not wait for it', async () => {
    rig = await createRig();
    const fetch = rig.controller.fetch({ interactive: false });
    const write = rig.controller.writeWorking({ 'schedule.json': '{}\n' });
    expect(await settled(write)).toBe(true);
    expect(await settled(fetch)).toBe(false);
  });

  it('a connect waits for it; a rejection of the fetch reaches the caller', async () => {
    rig = await createRig();
    const fetch = rig.controller.fetch({ interactive: false });
    const connect = rig.controller.connectRepo({ url: URL, branch: null, userName: 'Dana', userEmail: 'dana@example.com' });
    expect(await settled(connect)).toBe(false);
    expect(rig.log).toEqual(['fetch started']);
    rig.finishFetch(new Error('fetch blew up'));
    await expect(fetch).rejects.toThrow('fetch blew up');
    expect((await connect).ok).toBe(true);
    expect(rig.log).toEqual(['fetch started', 'fetch failed', 'connect started']);
  });

  it('idle(), which is awaited before the app quits, waits for it', async () => {
    rig = await createRig();
    const fetch = rig.controller.fetch({ interactive: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const idleBeforeFetchEnded = await settled(rig.controller.idle());
    rig.finishFetch();
    await fetch;
    expect(idleBeforeFetchEnded).toBe(false);
  });

  it('shutdown(), which is awaited when the last window has closed, ends it instead of waiting — after a moment', async () => {
    rig = await createRig();
    const fetch = rig.controller.fetch({ interactive: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rig.log).toEqual(['fetch started']);

    const closing = rig.controller.shutdown();
    // Not at once: a check that is simply at work would be over in this moment.
    expect(await settled(closing, GRACE_MS / 3)).toBe(false);
    expect(rig.stops).toBe(0);

    expect(await settled(closing, GRACE_MS * 5)).toBe(true);
    expect(rig.log).toEqual(['fetch started', 'stopFetch', 'fetch finished']);
    // Whoever asked for the check still gets an answer.
    expect(await settled(fetch)).toBe(true);
  });

  it('a check that finishes by itself within that moment is never stopped by force', async () => {
    rig = await createRig();
    const fetch = rig.controller.fetch({ interactive: false });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const closing = rig.controller.shutdown();
    rig.finishFetch();
    await closing;
    await fetch;
    // The moment has long passed: nothing was stopped afterwards either.
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 2));

    expect(rig.stops).toBe(0);
    expect(rig.log).toEqual(['fetch started', 'fetch finished']);
  });

  it('with nothing in flight shutdown() resolves at once, without waiting out that moment', async () => {
    rig = await createRig();
    expect(await settled(rig.controller.shutdown(), GRACE_MS / 3)).toBe(true);
    expect(rig.stops).toBe(0);
  });

  it('shutdown() waits for everything else for as long as it takes: an edit that is being written is finished first', async () => {
    rig = await createRig();
    rig.holdWrites = true;
    const write = rig.controller.writeWorking({ 'schedule.json': '{}\n' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rig.log).toEqual(['writeWorking started']);

    const closing = rig.controller.shutdown();
    // Long after the moment given to a check, the app is still not allowed to quit …
    expect(await settled(closing, GRACE_MS * 4)).toBe(false);
    expect(rig.log).toEqual(['writeWorking started', 'stopFetch']);

    // … and it is, as soon as the edit is on disk.
    rig.finishWrite();
    expect(await settled(closing)).toBe(true);
    expect(rig.log).toEqual(['writeWorking started', 'stopFetch', 'writeWorking done']);
    await write;
  });
});

describe('shutdown() before any repository is connected', () => {
  it('simply resolves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-schedule-pr-controller-'));
    try {
      const unusable = (): never => {
        throw new Error('not expected in this test');
      };
      const desktop = { appVersion: () => '1.0.2', systemLocale: () => 'en-US', documentsDir: () => root } as unknown as Desktop;
      const layer: GitLayer = {
        detectGit: async () => ({ found: false, path: null, version: null }),
        createGitRunner: unusable,
        connect: unusable,
        open: unusable,
      };
      const controller = new AppController({ store: new LocalStore(join(root, 'userData')), desktop, git: layer });
      await controller.boot();
      expect(await settled(controller.shutdown())).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
