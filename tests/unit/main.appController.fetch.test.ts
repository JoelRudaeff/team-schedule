/**
 * AppController.fetch() only STARTS the check for updates in its queue; the wait for the
 * server runs outside it. What that must (and must not) change, seen from the controller:
 * writing edits is not held up, a connect and the end of the app still wait for the fetch,
 * and a failure of the fetch still reaches whoever asked for it.
 * (Added after a review found these changes untested and idle() no longer waiting.)
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
}

async function createRig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'team-schedule-pr-controller-'));
  const rig = { root, log: [] as string[], connects: 0, finishFetch: () => undefined } as unknown as Rig;
  let fetching: Promise<void> = Promise.resolve();

  const service = (dir: string, url: string, branch: string): RepoHandle => ({
    dir,
    url,
    branch,
    // Like RepoService.idle(): settles when the fetch is over, never rejects.
    idle: () => fetching.then(() => undefined, () => undefined),
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
    writeWorking: async () => void rig.log.push('writeWorking done'),
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
  rig.controller = new AppController({ store: new LocalStore(join(root, 'userData')), desktop, git: layer });
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
});
