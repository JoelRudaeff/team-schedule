/**
 * The main-process side of the bridge with Electron and git replaced by stand-ins: what the
 * page may ask for, what is refused, and what reaches git, the disk and the desktop.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitInfo, LocalSettings, SyncStatus } from '@shared/api';
import type { AsideItem } from '@shared/merge';
import type { FileMap } from '@shared/types';
import { AppController, type Desktop, type FileDialogOptions, type GitLayer, type RepoHandle } from '../../src/main/appController';
import { GitError, type GitResult, type GitRunner } from '../../src/main/git/gitRunner';
import type { ConnectParams } from '../../src/main/git/repoService';
import { LocalStore } from '../../src/main/localStore';

const GIT_PATH = 'C:\\Program Files\\Git\\cmd\\git.exe';
const GIT: GitInfo = { found: true, path: GIT_PATH, version: '2.55.0' };
const NO_GIT: GitInfo = { found: false, path: null, version: null };
const URL = 'https://example.com/team/schedule.git';
const DANA = { userName: 'Dana Levi', userEmail: 'dana@example.com' };
const FILES: FileMap = { 'schedule.json': '{}\n' };

const STATUS: SyncStatus = {
  headSha: 'a'.repeat(40),
  remoteSha: 'a'.repeat(40),
  baseSha: 'a'.repeat(40),
  ahead: 0,
  behind: 0,
  incoming: [],
  lastFetchAt: null,
  fetchError: null,
};

function ok(stdout = ''): GitResult {
  return { code: 0, stdout, stderr: '', stdoutBuffer: Buffer.from(stdout) };
}

/** Everything the stand-ins were asked to do, in order. */
interface Rig {
  root: string;
  store: LocalStore;
  controller: AppController;
  log: string[];
  gitCalls: string[][];
  /** What the next file dialog answers; null = the user cancelled. */
  dialogAnswer: string | null;
  dialogs: FileDialogOptions[];
  opened: string[];
  links: string[];
  notifications: string[];
  /** Knobs of the pretend git layer. */
  git: {
    info: GitInfo;
    /** What detectGit answers for a custom path (default: `info`). */
    forCustomPath: GitInfo | null;
    globalIdentity: { name: string; email: string };
    connectError: GitError | null;
    hasSchedule: boolean;
    remoteEmpty: boolean;
    /** What RepoService.open finds on disk. */
    openFinds: boolean;
    connects: ConnectParams[];
  };
}

function fakeService(rig: Rig, dir: string, url: string, branch: string): RepoHandle {
  const note = (what: string): void => void rig.log.push(what);
  return {
    dir,
    url,
    branch,
    idle: async () => undefined,
    setIdentity: async (name, email) => note(`setIdentity ${name} <${email}>`),
    hasSchedule: async () => rig.git.hasSchedule,
    fetch: async (interactive) => {
      note(`fetch interactive=${interactive}`);
      return STATUS;
    },
    loadSnapshot: async () => {
      note('loadSnapshot');
      return { status: STATUS, baseFiles: FILES, workingFiles: FILES };
    },
    loadRemote: async () => ({ sha: 'a'.repeat(40), files: FILES }),
    writeWorking: async (files) => note(`writeWorking ${Object.keys(files).join(',')}`),
    applyUpdate: async (_files, sha) => {
      note(`applyUpdate ${sha}`);
      return { ok: true, status: STATUS };
    },
    publish: async (_files, message, sha) => {
      note(`publish "${message}" on ${sha}`);
      return { ok: true, status: STATUS, commitSha: 'b'.repeat(40) };
    },
    createSchedule: async (_files, message) => {
      note(`createSchedule "${message}"`);
      return { ok: true, status: STATUS, commitSha: 'b'.repeat(40) };
    },
    discardLocal: async () => {
      note('discardLocal');
      return { status: STATUS, baseFiles: FILES, workingFiles: FILES };
    },
    blame: async (weekStart) => ({ weekStart, headSha: STATUS.headSha, events: {}, title: null }),
  };
}

async function createRig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'team-schedule-controller-'));
  const store = new LocalStore(join(root, 'userData'));
  const rig = {
    root,
    store,
    log: [],
    gitCalls: [],
    dialogAnswer: null,
    dialogs: [],
    opened: [],
    links: [],
    notifications: [],
    git: {
      info: GIT,
      forCustomPath: null,
      globalIdentity: { name: 'Dana From Git', email: 'dana@git.example' },
      connectError: null,
      hasSchedule: true,
      remoteEmpty: false,
      openFinds: true,
      connects: [],
    },
  } as unknown as Rig;

  const runner = (gitPath: string): GitRunner => ({
    gitPath,
    async run(args) {
      rig.gitCalls.push([...args]);
      if (args[0] === 'config' && args[1] === '--global' && args.length === 3) {
        const value = args[2] === 'user.name' ? rig.git.globalIdentity.name : rig.git.globalIdentity.email;
        return value === '' ? { ...ok(), code: 1 } : ok(`${value}\n`);
      }
      return ok();
    },
  });

  const layer: GitLayer = {
    detectGit: async (customPath) => (customPath ? rig.git.forCustomPath ?? rig.git.info : rig.git.info),
    createGitRunner: runner,
    async connect(_git, params) {
      rig.git.connects.push(params);
      if (rig.git.connectError) throw rig.git.connectError;
      return {
        service: fakeService(rig, params.dir, params.url, params.branch ?? 'main'),
        remoteEmpty: rig.git.remoteEmpty,
        hasSchedule: rig.git.hasSchedule,
      };
    },
    open: async (_git, dir, url, branch) => (rig.git.openFinds ? fakeService(rig, dir, url, branch) : null),
  };

  const desktop: Desktop = {
    appVersion: () => '1.0.0',
    systemLocale: () => 'he-IL',
    documentsDir: () => join(root, 'Documents'),
    async showSaveDialog(options) {
      rig.dialogs.push(options);
      return rig.dialogAnswer;
    },
    async showOpenDialog(options) {
      rig.dialogs.push(options);
      return rig.dialogAnswer;
    },
    async openPath(path) {
      rig.opened.push(path);
      return '';
    },
    async openExternal(url) {
      rig.links.push(url);
    },
    notify: (title, body) => void rig.notifications.push(`${title}|${body}`),
    acknowledgeCloseRequest: () => void rig.log.push('ack'),
    closeWindow: () => void rig.log.push('close'),
  };

  rig.controller = new AppController({ store, desktop, git: layer });
  return rig;
}

let rig: Rig;

beforeEach(async () => {
  rig = await createRig();
});

afterEach(async () => {
  await rig.controller.idle();
  await rm(rig.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A started app that is connected to the team repository. */
async function connected(): Promise<void> {
  await rig.controller.boot();
  const result = await rig.controller.connectRepo({ url: URL, branch: null, ...DANA });
  expect(result.ok).toBe(true);
  rig.log.length = 0;
}

describe('start-up', () => {
  it('reports a first run without a repository, with the identity git already knows', async () => {
    const boot = await rig.controller.boot();
    expect(boot).toMatchObject({
      appVersion: '1.0.0',
      systemLocale: 'he-IL',
      firstRun: true,
      git: GIT,
      phase: 'not-configured',
      repo: null,
      suggestedIdentity: { name: 'Dana From Git', email: 'dana@git.example' },
    });
  });

  it('starts without git: nothing to suggest, nothing connected, no crash', async () => {
    rig.git.info = NO_GIT;
    const boot = await rig.controller.boot();
    expect(boot).toMatchObject({ git: NO_GIT, phase: 'not-configured', suggestedIdentity: { name: '', email: '' } });
    await expect(rig.controller.loadSnapshot()).rejects.toThrow(/No repository/);
  });

  it('opens the repository of the last session again, without the network', async () => {
    await connected();
    expect(await rig.store.getSettings()).toMatchObject({ repoUrl: URL, branch: 'main', ...DANA });

    const boot = await rig.controller.boot();
    expect(boot.phase).toBe('ready');
    expect(boot.repo).toEqual({ url: URL, branch: 'main', dir: rig.store.repoDir(URL) });
    expect(boot.firstRun).toBe(false);
    expect(rig.git.connects).toHaveLength(1); // boot itself did not connect again
  });

  it('asks to create a schedule when the repository has none, and to set up again when the folder is gone', async () => {
    await connected();
    rig.git.hasSchedule = false;
    expect((await rig.controller.boot()).phase).toBe('needs-init');
    rig.git.openFinds = false;
    expect(await rig.controller.boot()).toMatchObject({ phase: 'not-configured', repo: null });
  });
});

describe('connecting', () => {
  beforeEach(async () => {
    await rig.controller.boot();
  });

  it('connects, remembers the repository and tells whether a schedule exists', async () => {
    rig.git.hasSchedule = false;
    rig.git.remoteEmpty = true;
    const result = await rig.controller.connectRepo({ url: `  ${URL}  `, branch: '  ', userName: ' Dana\tLevi ', userEmail: ' dana@example.com ' });
    expect(result).toMatchObject({ ok: true, phase: 'needs-init', remoteEmpty: true, repo: { url: URL, branch: 'main' } });
    expect(rig.git.connects).toEqual([{ url: URL, dir: rig.store.repoDir(URL), branch: null, userName: 'Dana Levi', userEmail: 'dana@example.com' }]);
    expect(await rig.store.getSettings()).toMatchObject({ repoUrl: URL, branch: 'main', userName: 'Dana Levi', userEmail: 'dana@example.com' });
  });

  it.each([
    ['nothing', ''],
    ['an option for git', '--upload-pack=calc.exe'],
    ['a transport helper that runs a command', 'ext::sh -c "calc.exe"'],
    ['an unknown kind of address', 'ftp://example.com/x.git'],
    ['an endless address', `https://example.com/${'x'.repeat(3000)}`],
  ])('refuses %s as the address, before git is involved', async (_label, url) => {
    const result = await rig.controller.connectRepo({ url, branch: null, ...DANA });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-url' } });
    expect(rig.git.connects).toEqual([]);
    expect((await rig.store.getSettings()).repoUrl).toBeNull();
  });

  it.each([['--force'], ['a..b'], ['with space'], ['refs/heads/x.lock'], ['HEAD']])('refuses the branch name %j', async (branch) => {
    const result = await rig.controller.connectRepo({ url: URL, branch, ...DANA });
    expect(result.ok).toBe(false);
    expect(rig.git.connects).toEqual([]);
  });

  it.each([
    ['no name', { userName: '  ', userEmail: 'dana@example.com' }],
    ['a name of punctuation only', { userName: '...', userEmail: 'dana@example.com' }],
    ['no e-mail', { userName: 'Dana', userEmail: '' }],
    ['something that is not an e-mail', { userName: 'Dana', userEmail: 'dana at example' }],
  ])('refuses %s, with a reason the form can show', async (_label, identity) => {
    const result = await rig.controller.connectRepo({ url: URL, branch: null, ...identity });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail).not.toBe('');
    expect(rig.git.connects).toEqual([]);
  });

  it('says that git is missing instead of failing', async () => {
    const fresh = await createRig();
    try {
      fresh.git.info = NO_GIT;
      await fresh.controller.boot();
      const result = await fresh.controller.connectRepo({ url: URL, branch: null, ...DANA });
      expect(result).toMatchObject({ ok: false, error: { code: 'git-missing' } });
    } finally {
      await fresh.controller.idle();
      await rm(fresh.root, { recursive: true, force: true });
    }
  });

  it('finds a git that was installed after the app started', async () => {
    const fresh = await createRig();
    try {
      fresh.git.info = NO_GIT;
      await fresh.controller.boot();
      fresh.git.info = GIT;
      expect((await fresh.controller.connectRepo({ url: URL, branch: null, ...DANA })).ok).toBe(true);
    } finally {
      await fresh.controller.idle();
      await rm(fresh.root, { recursive: true, force: true });
    }
  });

  it('keeps the previous connection when a new one cannot be made', async () => {
    expect((await rig.controller.connectRepo({ url: URL, branch: null, ...DANA })).ok).toBe(true);
    rig.git.connectError = new GitError({ code: 'auth', message: 'Sign-in is needed', detail: 'HTTP 403' }, 128);
    const result = await rig.controller.connectRepo({ url: 'https://example.com/other.git', branch: null, ...DANA });
    expect(result).toEqual({ ok: false, error: { code: 'auth', message: 'Sign-in is needed', detail: 'HTTP 403', trustPath: undefined } });
    expect((await rig.store.getSettings()).repoUrl).toBe(URL);
    // The first repository still answers.
    await expect(rig.controller.loadSnapshot()).resolves.toMatchObject({ workingFiles: FILES });
  });
});

describe('schedule data and sync', () => {
  it('is refused while no repository is connected', async () => {
    await rig.controller.boot();
    await expect(rig.controller.writeWorking(FILES)).rejects.toThrow(/No repository/);
    await expect(rig.controller.publish({ files: FILES, message: 'x', expectedRemoteSha: null })).rejects.toThrow(/No repository/);
    await expect(rig.controller.fetch({ interactive: false })).rejects.toThrow(/No repository/);
    expect(await rig.controller.getAside()).toEqual([]);
    await rig.controller.setAside([{ key: 'event:2026-11-22:a' } as AsideItem]); // silently nothing
    await rig.controller.openRepoFolder();
    expect(rig.opened).toEqual([]);
  });

  it('passes every request on to the repository, one after the other', async () => {
    await connected();
    const sha = 'c'.repeat(40);
    await Promise.all([
      rig.controller.writeWorking(FILES),
      rig.controller.fetch({ interactive: true }),
      rig.controller.applyUpdate({ files: FILES, expectedRemoteSha: sha }),
      rig.controller.publish({ files: FILES, message: 'Update schedule', expectedRemoteSha: sha }),
      rig.controller.createSchedule({ files: FILES, message: 'Create schedule' }),
      rig.controller.discardLocal(),
    ]);
    expect(rig.log).toEqual([
      'writeWorking schedule.json',
      'fetch interactive=true',
      `applyUpdate ${sha}`,
      `publish "Update schedule" on ${sha}`,
      'createSchedule "Create schedule"',
      'discardLocal',
    ]);
    expect(await rig.controller.loadRemote()).toEqual({ sha: 'a'.repeat(40), files: FILES });
    expect(await rig.controller.blame('2026-11-22')).toMatchObject({ weekStart: '2026-11-22', events: {} });
  });

  it('keeps the versions kept aside per repository', async () => {
    await connected();
    const item = { key: 'event:2026-11-22:a', kind: 'event', id: 'a', weekStart: '2026-11-22', createdAt: '2026-11-22T08:00:00.000Z' } as AsideItem;
    await rig.controller.setAside([item]);
    expect(await rig.controller.getAside()).toEqual([item]);
    // Another repository has its own (empty) list.
    expect((await rig.controller.connectRepo({ url: 'https://example.com/other.git', branch: null, ...DANA })).ok).toBe(true);
    expect(await rig.controller.getAside()).toEqual([]);
  });
});

describe('local settings', () => {
  it('stores what may be changed here and nothing else', async () => {
    await connected();
    const patch = {
      language: 'he',
      pollSeconds: 120,
      notifications: false,
      repoUrl: 'https://evil.example/x.git',
      branch: 'other',
      gitPath: 'C:\\Users\\Public\\not-git.exe',
    } as Partial<LocalSettings>;
    const settings = await rig.controller.saveSettings(patch);
    expect(settings).toMatchObject({ language: 'he', pollSeconds: 120, notifications: false, repoUrl: URL, branch: 'main', gitPath: null });
  });

  it('gives a new identity to the repository first, and refuses one git could not commit with', async () => {
    await connected();
    await rig.controller.saveSettings({ userName: ' Dana L. ', userEmail: 'dl@example.com' });
    expect(rig.log).toEqual(['setIdentity Dana L. <dl@example.com>']);
    expect(await rig.store.getSettings()).toMatchObject({ userName: 'Dana L.', userEmail: 'dl@example.com' });

    await expect(rig.controller.saveSettings({ userEmail: 'not an address' })).rejects.toThrow(/e-mail/);
    expect((await rig.store.getSettings()).userEmail).toBe('dl@example.com');
  });

  it('takes a git program only from the file dialog, and only when it really is git', async () => {
    await rig.controller.boot();
    const chosen = 'D:\\Tools\\PortableGit\\cmd\\git.exe';

    rig.dialogAnswer = null;
    expect(await rig.controller.chooseGitExecutable()).toBeNull();

    // The chosen file is not git: detectGit falls back to the one it finds itself.
    rig.dialogAnswer = 'D:\\Downloads\\setup.exe';
    rig.git.forCustomPath = GIT;
    expect(await rig.controller.chooseGitExecutable()).toEqual(NO_GIT);
    expect((await rig.store.getSettings()).gitPath).toBeNull();

    rig.dialogAnswer = chosen;
    rig.git.forCustomPath = { found: true, path: chosen, version: '2.50.0' };
    expect(await rig.controller.chooseGitExecutable()).toEqual({ found: true, path: chosen, version: '2.50.0' });
    expect((await rig.store.getSettings()).gitPath).toBe(chosen);

    // "Find git automatically" is the one thing saveSettings may do about it.
    expect((await rig.controller.saveSettings({ gitPath: null })).gitPath).toBeNull();
  });

  it('marks a folder as trusted through git itself', async () => {
    await rig.controller.boot();
    await rig.controller.trustRepoPath('//server/share/schedule.git');
    expect(rig.gitCalls.at(-1)).toEqual(['config', '--global', '--add', 'safe.directory', '//server/share/schedule.git']);
  });
});

describe('files, links and notifications', () => {
  beforeEach(async () => {
    await rig.controller.boot();
  });

  it('saves a text file where the user says, as UTF-8 without a byte-order mark', async () => {
    const target = join(rig.root, 'Desktop', 'לוח.ics');
    await mkdir(dirname(target), { recursive: true });
    rig.dialogAnswer = target;
    const saved = await rig.controller.saveTextFile({
      title: 'Export',
      defaultName: '..\\..\\Windows\\System32\\con:.ics',
      filters: [{ name: 'Calendar', extensions: ['ics'] }],
      content: '﻿BEGIN:VCALENDAR\r\nSUMMARY:מבוא\r\n',
    });
    expect(saved).toEqual({ path: target });
    expect(await readFile(target, 'utf8')).toBe('BEGIN:VCALENDAR\r\nSUMMARY:מבוא\r\n');
    // The suggestion is a plain file name inside Documents, whatever the page asked for.
    expect(rig.dialogs[0].defaultPath).toBe(join(rig.root, 'Documents', '_con.ics'));

    // The next dialog starts where the user last was.
    rig.dialogAnswer = null;
    expect(await rig.controller.saveTextFile({ title: 'Export', defaultName: 'a.ics', filters: [], content: 'x' })).toBeNull();
    expect(rig.dialogs[1].defaultPath).toBe(join(dirname(target), 'a.ics'));
  });

  it('opens only files it saved itself in this session, and only calendar or week files', async () => {
    const ics = join(rig.root, 'week.ics');
    const exe = join(rig.root, 'tool.exe');
    rig.dialogAnswer = ics;
    await rig.controller.saveTextFile({ title: 't', defaultName: 'week.ics', filters: [], content: 'x' });
    rig.dialogAnswer = exe;
    await rig.controller.saveTextFile({ title: 't', defaultName: 'tool.ics', filters: [], content: 'x' });

    expect(await rig.controller.openSavedFile(ics)).toBe(true);
    expect(await rig.controller.openSavedFile(exe)).toBe(false); // saved by the app, but Windows would run it
    expect(await rig.controller.openSavedFile('C:\\Windows\\System32\\calc.exe')).toBe(false);
    expect(await rig.controller.openSavedFile(join(rig.root, 'other.ics'))).toBe(false); // never saved by the app
    expect(rig.opened).toEqual([ics]);
  });

  it('reads the file the user picked, without its byte-order mark, and refuses a huge one', async () => {
    const file = join(rig.root, 'w.week.json');
    await writeFile(file, '﻿{"type":"team-schedule-week"}', 'utf8');
    rig.dialogAnswer = file;
    expect(await rig.controller.openTextFile({ title: 'Open', filters: [] })).toEqual({
      path: file,
      name: 'w.week.json',
      content: '{"type":"team-schedule-week"}',
    });

    const huge = join(rig.root, 'video.json');
    await writeFile(huge, Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
    rig.dialogAnswer = huge;
    await expect(rig.controller.openTextFile({ title: 'Open', filters: [] })).rejects.toThrow(/5 MB/);

    rig.dialogAnswer = null;
    expect(await rig.controller.openTextFile({ title: 'Open', filters: [] })).toBeNull();
  });

  it('opens https links in the browser and nothing else', async () => {
    for (const link of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'http://example.com/', 'ms-settings:', 'not a link', '']) {
      await rig.controller.openExternal(link);
    }
    expect(rig.links).toEqual([]);
    await rig.controller.openExternal('https://git-scm.com/download/win');
    expect(rig.links).toEqual(['https://git-scm.com/download/win']);
  });

  it('shows notifications only while the user wants them', async () => {
    await rig.controller.notify({ title: 'Team Schedule', body: 'Dana updated the schedule' });
    await rig.controller.saveSettings({ notifications: false });
    await rig.controller.notify({ title: 'Team Schedule', body: 'again' });
    expect(rig.notifications).toEqual(['Team Schedule|Dana updated the schedule']);
  });

  it('opens the repository folder and hands close requests to the window', async () => {
    expect((await rig.controller.connectRepo({ url: URL, branch: null, ...DANA })).ok).toBe(true);
    await rig.controller.openRepoFolder();
    expect(rig.opened).toEqual([rig.store.repoDir(URL)]);
    await rig.controller.ackCloseRequest();
    await rig.controller.closeWindow();
    expect(rig.log.slice(-2)).toEqual(['ack', 'close']);
  });
});
