/**
 * The main-process side of the bridge: every `window.api` method the renderer can call
 * (ScheduleApi in @shared/api), on top of the git layer, the local store and the desktop.
 *
 * Electron stays behind the small `Desktop` interface and git behind `GitLayer`, so the
 * rules in this file run in unit tests (tests/unit/main.appController.test.ts).
 * Arguments have passed the checks of validate.ts when they arrive here; what a user can
 * get wrong in a form is answered with an error value, as the bridge contract asks.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type {
  ApplyUpdateRequest,
  BootState,
  ConnectRequest,
  ConnectResult,
  FileFilter,
  GitInfo,
  LocalSettings,
  OpenFileRequest,
  OpenedFile,
  PublishRequest,
  PublishResult,
  RemoteSnapshot,
  RepoInfo,
  RepoPhase,
  RepoSnapshot,
  SaveFileRequest,
  SavedFile,
  SyncErrorCode,
  SyncStatus,
  UpdateResult,
  WeekBlame,
} from '@shared/api';
import type { AsideItem } from '@shared/merge';
import { checkRepoUrl, type RepoUrlCheck } from '@shared/repoUrl';
import type { FileMap, IsoDate, Lang } from '@shared/types';
import { GitError, type GitRunner } from './git/gitRunner';
import type { ConnectParams, RepoService } from './git/repoService';
import type { ApiHandlers } from './ipc';
import type { LocalStore } from './localStore';
import { SerialQueue } from './serialQueue';
import {
  MAX_REPO_URL_LENGTH,
  cleanLine,
  describeIdentityProblem,
  isValidBranchName,
  sanitizeFileName,
  toHttpsUrl,
} from './validate';

// ───────────────────────────── what the controller is built on ─────────────────────────────

/** The part of a RepoService the controller uses (a plain shape, so tests can stand in for it). */
export type RepoHandle = Pick<
  RepoService,
  | 'dir'
  | 'url'
  | 'branch'
  | 'idle'
  | 'setIdentity'
  | 'hasSchedule'
  | 'fetch'
  | 'loadSnapshot'
  | 'loadRemote'
  | 'writeWorking'
  | 'applyUpdate'
  | 'publish'
  | 'createSchedule'
  | 'discardLocal'
  | 'blame'
>;

/** The git layer (src/main/git) as the controller sees it. */
export interface GitLayer {
  detectGit(customPath?: string | null): Promise<GitInfo>;
  createGitRunner(gitPath: string): GitRunner;
  /** RepoService.connect */
  connect(git: GitRunner, params: ConnectParams): Promise<{ service: RepoHandle; remoteEmpty: boolean; hasSchedule: boolean }>;
  /** RepoService.open */
  open(git: GitRunner, dir: string, url: string, branch: string): Promise<RepoHandle | null>;
}

export interface FileDialogOptions {
  title: string;
  /** Folder (open) or folder + suggested file name (save) the dialog starts with. */
  defaultPath: string;
  filters: FileFilter[];
}

/** Everything the controller needs from Electron and the main window. */
export interface Desktop {
  appVersion(): string;
  /** The Windows display language, e.g. "he-IL". */
  systemLocale(): string;
  /** The user's Documents folder. */
  documentsDir(): string;
  /** "Save as" dialog on the main window; null = cancelled. */
  showSaveDialog(options: FileDialogOptions): Promise<string | null>;
  /** "Open" dialog for one file on the main window; null = cancelled. */
  showOpenDialog(options: FileDialogOptions): Promise<string | null>;
  /** Opens a file or folder with its default program; resolves to '' on success, otherwise to the reason. */
  openPath(path: string): Promise<string>;
  /** Opens a link in the default browser. */
  openExternal(url: string): Promise<void>;
  /** Windows notification + taskbar flash. Does nothing while the window has the focus. */
  notify(title: string, body: string): void;
  acknowledgeCloseRequest(): void;
  /** Closes the window without asking the renderer again. */
  closeWindow(): void;
}

export interface AppControllerOptions {
  store: LocalStore;
  desktop: Desktop;
  git: GitLayer;
}

// ───────────────────────────── helpers ─────────────────────────────

const MAX_OPEN_FILE_BYTES = 5 * 1024 * 1024;

/**
 * What openSavedFile hands to Windows. A saved file is opened with whatever program is
 * registered for its type, so only types that are shown — a calendar entry, a week file —
 * qualify; a name the user changed to something Windows would *run* is never opened.
 */
const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.ics', '.json']);

/** The only text the main process shows by itself (the dialog has no renderer to translate it). */
const GIT_DIALOG_TITLE: Record<Lang, string> = { en: 'Select git.exe', he: 'בחירת git.exe' };

const REPO_URL_PROBLEMS: Record<Extract<RepoUrlCheck, { ok: false }>['reason'], string> = {
  empty: 'The repository address is empty',
  unsupported: 'The repository address is not one of the supported kinds',
  unsafe: 'The repository address is not allowed: git could take it for an option or a command',
};

const NOT_CONFIGURED: { phase: RepoPhase; repo: RepoInfo | null } = { phase: 'not-configured', repo: null };

function refusal(code: SyncErrorCode, message: string): { ok: false; error: { code: SyncErrorCode; message: string; detail: string } } {
  // The UI has its own text for every code except `unknown`; there the details box is the only place for the reason.
  return { ok: false, error: { code, message, detail: code === 'unknown' ? message : '' } };
}

function repoInfoOf(service: RepoHandle): RepoInfo {
  return { url: service.url, branch: service.branch, dir: service.dir };
}

/** Windows file names ignore case, and the same file can be written with either kind of slash. */
function isSameFile(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function withoutBom(text: string): string {
  return text.startsWith('﻿') ? text.slice(1) : text;
}

// ───────────────────────────── the controller ─────────────────────────────

export class AppController implements ApiHandlers {
  private readonly store: LocalStore;
  private readonly desktop: Desktop;
  private readonly git: GitLayer;
  /**
   * One git job at a time in the repository folder. A RepoService queues its own methods,
   * but connecting and (re-)opening happen outside any service, and a new service must
   * never start while the one it replaces is still at work in the same folder.
   */
  private readonly repoQueue = new SerialQueue();
  /** null while git has not been found. */
  private runner: GitRunner | null = null;
  /** The connected repository; null until boot / connectRepo found one. */
  private service: RepoHandle | null = null;
  /** Paths written by saveTextFile in this session: the only ones openSavedFile accepts. */
  private readonly savedFiles = new Set<string>();
  /** Where the user last saved or opened a file; the next file dialog starts there. */
  private lastFolder: string | null = null;

  constructor(options: AppControllerOptions) {
    this.store = options.store;
    this.desktop = options.desktop;
    this.git = options.git;
  }

  /** Resolves when no git or settings work is in flight (never rejects). Awaited before the app quits. */
  async idle(): Promise<void> {
    await this.repoQueue.idle();
    await this.store.idle();
  }

  // ── start-up and local settings ──

  async boot(): Promise<BootState> {
    const { settings, firstRun } = await this.store.load();
    const git = await this.git.detectGit(settings.gitPath);
    this.useGit(git);
    const [suggestedIdentity, { phase, repo }] = await Promise.all([
      this.readGlobalIdentity(),
      this.repoQueue.run(() => this.openStoredRepo()),
    ]);
    return {
      appVersion: this.desktop.appVersion(),
      systemLocale: this.desktop.systemLocale(),
      firstRun,
      settings,
      git,
      suggestedIdentity,
      phase,
      repo,
    };
  }

  async saveSettings(patch: Partial<LocalSettings>): Promise<LocalSettings> {
    const before = await this.store.getSettings();
    // Field by field: repoUrl and branch belong to connectRepo, and a git program is only ever
    // taken from the file dialog of chooseGitExecutable — here it can just be reset to "find it".
    const change: Partial<LocalSettings> = {};
    if (patch.language !== undefined) change.language = patch.language;
    if (patch.userName !== undefined) change.userName = cleanLine(patch.userName);
    if (patch.userEmail !== undefined) change.userEmail = cleanLine(patch.userEmail);
    if (patch.pollSeconds !== undefined) change.pollSeconds = patch.pollSeconds;
    if (patch.notifications !== undefined) change.notifications = patch.notifications;
    if (patch.gitPath === null) change.gitPath = null;

    const userName = change.userName ?? before.userName;
    const userEmail = change.userEmail ?? before.userEmail;
    if (this.service && (userName !== before.userName || userEmail !== before.userEmail)) {
      // The repository must never be left with an identity git refuses to commit under.
      const problem = describeIdentityProblem(userName, userEmail);
      if (problem !== null) throw new Error(problem);
      // Before the settings are stored: should git fail, the two still agree.
      await this.repoQueue.run(() => this.service?.setIdentity(userName, userEmail));
    }
    const settings = await this.store.updateSettings(change);
    if (change.gitPath === null && before.gitPath !== null) await this.refreshGit();
    return settings;
  }

  async detectGit(): Promise<GitInfo> {
    return this.refreshGit();
  }

  async chooseGitExecutable(): Promise<GitInfo | null> {
    const { language } = await this.store.getSettings();
    const chosen = await this.desktop.showOpenDialog({
      title: GIT_DIALOG_TITLE[language],
      defaultPath: this.lastFolder ?? '',
      filters: [{ name: 'git.exe', extensions: ['exe'] }],
    });
    if (chosen === null) return null;
    const info = await this.git.detectGit(chosen);
    // detectGit falls back to a git it finds by itself, so `found` alone does not say that the chosen file is git.
    if (!info.found || info.path === null || !isSameFile(info.path, chosen)) return { found: false, path: null, version: null };
    await this.store.updateSettings({ gitPath: info.path });
    if (this.useGit(info)) await this.repoQueue.run(() => this.openStoredRepo());
    return info;
  }

  // ── repository connection ──

  async connectRepo(req: ConnectRequest): Promise<ConnectResult> {
    if (req.url.length > MAX_REPO_URL_LENGTH) return refusal('invalid-url', 'The repository address is too long');
    const address = checkRepoUrl(req.url);
    if (!address.ok) return refusal('invalid-url', REPO_URL_PROBLEMS[address.reason]);
    const branch = req.branch === null || req.branch.trim() === '' ? null : req.branch.trim();
    if (branch !== null && !isValidBranchName(branch)) return refusal('unknown', 'The branch name is not valid');
    const userName = cleanLine(req.userName);
    const userEmail = cleanLine(req.userEmail);
    const identityProblem = describeIdentityProblem(userName, userEmail);
    if (identityProblem !== null) return refusal('unknown', identityProblem);
    // git may have been installed a moment ago, without anyone asking to look for it again.
    if (!this.runner) await this.refreshGit();

    return this.repoQueue.run(async (): Promise<ConnectResult> => {
      const runner = this.runner;
      if (!runner) return refusal('git-missing', 'Git was not found on this computer');
      const dir = this.store.repoDir(address.url);
      // A check for updates that is still waiting for the server works in the same folder: let it finish first.
      await this.service?.idle();
      let outcome: Awaited<ReturnType<GitLayer['connect']>>;
      try {
        outcome = await this.git.connect(runner, {
          url: address.url,
          dir,
          branch,
          userName,
          userEmail,
          ...(req.createBranch === true ? { createBranch: true } : {}),
        });
      } catch (error) {
        // Unreachable, sign-in refused, no such repository …: the previous connection (if any) stays in use.
        if (error instanceof GitError) return { ok: false, error: error.toSyncError() };
        throw error;
      }
      const { service } = outcome;
      const settings = await this.store.updateSettings({ repoUrl: address.url, branch: service.branch, userName, userEmail });
      this.service = service;
      return {
        ok: true,
        phase: outcome.hasSchedule ? 'ready' : 'needs-init',
        repo: repoInfoOf(service),
        settings,
        remoteEmpty: outcome.remoteEmpty,
      };
    });
  }

  async trustRepoPath(path: string): Promise<void> {
    if (!this.runner) throw new Error('Git was not found on this computer');
    await this.runner.run(['config', '--global', '--add', 'safe.directory', path]);
  }

  async createSchedule(req: { files: FileMap; message: string }): Promise<PublishResult> {
    return this.withRepo((service) => service.createSchedule(req.files, req.message));
  }

  // ── data ──

  async loadSnapshot(): Promise<RepoSnapshot> {
    return this.withRepo((service) => service.loadSnapshot());
  }

  async loadRemote(): Promise<RemoteSnapshot | null> {
    return this.withRepo((service) => service.loadRemote());
  }

  async writeWorking(files: FileMap): Promise<void> {
    return this.withRepo((service) => service.writeWorking(files));
  }

  // ── sync ──

  async fetch(opts: { interactive: boolean }): Promise<SyncStatus> {
    // Only STARTED in its turn. The wait for the server happens outside the queue, so that
    // nothing else — above all writing edits to the working folder — is held up by a server
    // that does not answer. The service itself keeps its network commands apart.
    const started = await this.withRepo(async (service) => ({ status: service.fetch(opts.interactive) }));
    return started.status;
  }

  async applyUpdate(req: ApplyUpdateRequest): Promise<UpdateResult> {
    return this.withRepo((service) => service.applyUpdate(req.files, req.expectedRemoteSha));
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    return this.withRepo((service) => service.publish(req.files, req.message, req.expectedRemoteSha));
  }

  async discardLocal(): Promise<RepoSnapshot> {
    return this.withRepo((service) => service.discardLocal());
  }

  async blame(weekStart: IsoDate): Promise<WeekBlame> {
    return this.withRepo((service) => service.blame(weekStart));
  }

  // ── versions kept aside ──

  async getAside(): Promise<AsideItem[]> {
    return this.service ? this.store.readAside(this.service.url) : [];
  }

  async setAside(items: AsideItem[]): Promise<void> {
    if (this.service) await this.store.writeAside(this.service.url, items);
  }

  // ── files and shell ──

  async saveTextFile(req: SaveFileRequest): Promise<SavedFile | null> {
    const path = await this.desktop.showSaveDialog({
      title: req.title,
      defaultPath: join(this.dialogFolder(), sanitizeFileName(req.defaultName, 'schedule')),
      filters: req.filters,
    });
    if (path === null) return null;
    // UTF-8 without a byte-order mark is promised, whatever the text starts with.
    await writeFile(path, withoutBom(req.content), 'utf8');
    this.lastFolder = dirname(path);
    this.savedFiles.add(path);
    return { path };
  }

  async openTextFile(req: OpenFileRequest): Promise<OpenedFile | null> {
    const path = await this.desktop.showOpenDialog({ title: req.title, defaultPath: this.dialogFolder(), filters: req.filters });
    if (path === null) return null;
    this.lastFolder = dirname(path);
    // Checked before reading: the user may have picked a video by mistake.
    if ((await stat(path)).size > MAX_OPEN_FILE_BYTES) throw new Error('The file is larger than 5 MB');
    const text = (await readFile(path)).toString('utf8');
    return { path, name: basename(path), content: withoutBom(text) };
  }

  async openSavedFile(path: string): Promise<boolean> {
    if (!this.savedFiles.has(path) || !OPENABLE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
    return (await this.desktop.openPath(path)) === '';
  }

  async openRepoFolder(): Promise<void> {
    if (!this.service) return;
    const problem = await this.desktop.openPath(this.service.dir);
    if (problem !== '') throw new Error(`The repository folder could not be opened: ${problem}`);
  }

  async openExternal(url: string): Promise<void> {
    const link = toHttpsUrl(url);
    if (link !== null) await this.desktop.openExternal(link);
  }

  async notify(req: { title: string; body: string }): Promise<void> {
    const { notifications } = await this.store.getSettings();
    if (notifications) this.desktop.notify(req.title, req.body);
  }

  // ── window lifecycle ──

  async ackCloseRequest(): Promise<void> {
    this.desktop.acknowledgeCloseRequest();
  }

  async closeWindow(): Promise<void> {
    this.desktop.closeWindow();
  }

  // ── internals ──

  /** Runs one job of the connected repository, in turn. Rejects when there is none. */
  private withRepo<T>(job: (service: RepoHandle) => Promise<T>): Promise<T> {
    return this.repoQueue.run(() => {
      // Looked up when the job's turn comes: a connect queued before it may have replaced the service.
      if (!this.service) throw new Error('No repository is connected');
      return job(this.service);
    });
  }

  /** Remembers which git to run. True when that is a different program than before (or git appeared / vanished). */
  private useGit(info: GitInfo): boolean {
    const gitPath = info.found ? info.path : null;
    if (gitPath === (this.runner?.gitPath ?? null)) return false;
    this.runner = gitPath === null ? null : this.git.createGitRunner(gitPath);
    return true;
  }

  /** Looks for git again; a different git than before also means a new service for the repository. */
  private async refreshGit(): Promise<GitInfo> {
    const { gitPath } = await this.store.getSettings();
    const info = await this.git.detectGit(gitPath);
    if (this.useGit(info)) await this.repoQueue.run(() => this.openStoredRepo());
    return info;
  }

  /**
   * Opens the repository named in the settings with the current git (no network) and
   * makes it the current one — or leaves none. Only to be called as a job of `repoQueue`.
   */
  private async openStoredRepo(): Promise<{ phase: RepoPhase; repo: RepoInfo | null }> {
    // The service being replaced may still be waiting for the server in the very same folder.
    await this.service?.idle();
    this.service = null;
    const { repoUrl, branch } = await this.store.getSettings();
    if (!this.runner || repoUrl === null || branch === null) return NOT_CONFIGURED;
    try {
      const service = await this.git.open(this.runner, this.store.repoDir(repoUrl), repoUrl, branch);
      if (service === null) return NOT_CONFIGURED;
      const hasSchedule = await service.hasSchedule();
      this.service = service;
      return { phase: hasSchedule ? 'ready' : 'needs-init', repo: repoInfoOf(service) };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      // git refuses the folder or cannot read it. The set-up screen is the way out: connecting
      // again re-uses the folder and reports such a problem with its remedy.
      console.error('The local repository folder could not be opened:', error);
      return NOT_CONFIGURED;
    }
  }

  /** user.name / user.email of the user's global git configuration, '' for whatever is not set. */
  private async readGlobalIdentity(): Promise<{ name: string; email: string }> {
    const runner = this.runner;
    if (!runner) return { name: '', email: '' };
    const read = async (key: string): Promise<string> => {
      try {
        // Exit code 1 is git's way of saying "not set".
        const result = await runner.run(['config', '--global', key], { okExitCodes: [1] });
        return result.code === 0 ? cleanLine(result.stdout) : '';
      } catch (error) {
        // Only a suggestion for the set-up form: a broken global configuration must not stop the app from starting.
        console.error(`git config --global ${key} failed:`, error);
        return '';
      }
    };
    const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
    return { name, email };
  }

  private dialogFolder(): string {
    return this.lastFolder ?? this.desktop.documentsDir();
  }
}
