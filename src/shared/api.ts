/**
 * The bridge between the user interface (renderer) and the main process, which owns git
 * and the file system.
 *
 * CONTRACT FILE — do not change without updating main, preload and renderer together.
 *
 * The renderer calls `window.api.<method>(…)`; the preload script forwards each call as
 * `ipcRenderer.invoke('ts:<method>', …args)` and the main process answers with
 * `ipcMain.handle`. Expected failures (no network, sign-in needed, the team's copy changed)
 * are returned as values, never thrown; a rejected promise always means a bug or an
 * unexpected local failure (disk full, git crashed).
 */
import type { AsideItem } from './merge';
import type { FileMap, IsoDate, Lang } from './types';

// ───────────────────────────── local (per computer) settings ─────────────────────────────

export interface GitInfo {
  found: boolean;
  /** Full path of git.exe, null when not found. */
  path: string | null;
  /** e.g. "2.55.0.windows.5", null when not found. */
  version: string | null;
}

/** Stored on this computer only (never in the repository). */
export interface LocalSettings {
  language: Lang;
  /** Address of the team's git repository; null until the first set-up. */
  repoUrl: string | null;
  /** Branch that holds the schedule; null until connected. */
  branch: string | null;
  /** Name and e-mail recorded with every change this user publishes (git author). */
  userName: string;
  userEmail: string;
  /** Custom path to git.exe; null = find it automatically. */
  gitPath: string | null;
  /** How often to look for team updates in the background, seconds (15 … 3600). */
  pollSeconds: number;
  /** Show a Windows notification when a teammate publishes an update. */
  notifications: boolean;
}

export const DEFAULT_POLL_SECONDS = 60;
export const MIN_POLL_SECONDS = 15;
export const MAX_POLL_SECONDS = 3600;

export interface RepoInfo {
  url: string;
  branch: string;
  /** The local working folder (a normal git clone inside the app's data folder). */
  dir: string;
}

/**
 * - `not-configured`: no repository yet (or its local folder is gone) → show the set-up screen.
 * - `needs-init`: connected, but the repository holds no schedule yet → offer to create one.
 * - `ready`: connected and a schedule exists.
 */
export type RepoPhase = 'not-configured' | 'needs-init' | 'ready';

/** Everything the UI needs to start. Produced without any network access. */
export interface BootState {
  appVersion: string;
  /** Windows display language, e.g. "he-IL" — used to pick the language on first start. */
  systemLocale: string;
  /** True when no settings file existed yet (first start on this computer). */
  firstRun: boolean;
  settings: LocalSettings;
  git: GitInfo;
  /** user.name / user.email from the user's global git config ('' when unset). */
  suggestedIdentity: { name: string; email: string };
  phase: RepoPhase;
  repo: RepoInfo | null;
}

// ───────────────────────────── sync state ─────────────────────────────

export type SyncErrorCode =
  /** git.exe is not installed / not found. */
  | 'git-missing'
  /** The repository address was rejected before git was even started. */
  | 'invalid-url'
  /** No network, DNS failure, server unreachable, shared folder not reachable. */
  | 'offline'
  /** Sign-in needed or refused, or no permission to read / write the repository. */
  | 'auth'
  /** The server answered but there is no such repository / path. */
  | 'not-found'
  /** git refuses a folder owned by another Windows user (typical for shared folders). */
  | 'dubious-ownership'
  /**
   * The branch named in the connect request does not exist in the repository, which has
   * other branches (`detail` lists them). Nothing was changed; connecting again with
   * `createBranch` creates it.
   */
  | 'branch-missing'
  /** git did not finish in time and was stopped. */
  | 'timeout'
  | 'unknown';

export interface SyncError {
  code: SyncErrorCode;
  /** Short English summary for logs; the UI shows its own localized text per code. */
  message: string;
  /** git's own output (credentials masked), shown in a collapsible "details" box. */
  detail: string;
  /** For `dubious-ownership`: the folder git asks to be trusted (pass to `trustRepoPath`). */
  trustPath?: string;
  /** For `branch-missing`: the branches the repository does have. */
  branches?: string[];
}

export interface CommitInfo {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** Milliseconds since the Unix epoch. */
  time: number;
  /** First line of the commit message. */
  subject: string;
}

/**
 * Where the local copy stands relative to the team's copy (`origin/<branch>`).
 *
 * The app keeps one invariant: the local branch never holds commits that the team does
 * not have, except transiently inside `publish`. Unpublished work lives in the working
 * folder as plain file changes. `ahead > 0` therefore only appears after a crash or
 * outside interference and heals itself on the next update or publish.
 */
export interface SyncStatus {
  /** Local branch tip; null when the repository has no commits yet. */
  headSha: string | null;
  /** The team's tip as of the last successful fetch; null when the remote branch does not exist. */
  remoteSha: string | null;
  /**
   * Commit that `RepoSnapshot.baseFiles` comes from: the newest commit shared by local and
   * team history (equals headSha in the normal case). null when there is none.
   */
  baseSha: string | null;
  /** Local commits the team does not have (normally 0). */
  ahead: number;
  /** Team commits not yet applied locally — "update available" when > 0. */
  behind: number;
  /** Those team commits, newest first, at most 50. */
  incoming: CommitInfo[];
  /** When the team's copy was last reached successfully (ms since epoch), null = never. */
  lastFetchAt: number | null;
  /** Why the most recent fetch failed; null when it succeeded (or none was tried yet). */
  fetchError: SyncError | null;
}

export interface RepoSnapshot {
  status: SyncStatus;
  /** Data files at `status.baseSha` ({} when baseSha is null). */
  baseFiles: FileMap;
  /** Data files currently in the working folder (base + this user's unpublished edits). */
  workingFiles: FileMap;
}

export interface RemoteSnapshot {
  /** The team's tip (`origin/<branch>`). */
  sha: string;
  /** Data files at that commit. */
  files: FileMap;
}

// ───────────────────────────── requests and results ─────────────────────────────

export interface ConnectRequest {
  url: string;
  /** null = use the repository's default branch (or `main` when it is empty). */
  branch: string | null;
  userName: string;
  userEmail: string;
  /**
   * Create `branch` when the repository has other branches but not this one. Without it
   * such a request fails with `branch-missing`: a mistyped name must never quietly start a
   * second schedule next to the team's.
   */
  createBranch?: boolean;
}

export type ConnectResult =
  | {
      ok: true;
      phase: 'ready' | 'needs-init';
      repo: RepoInfo;
      /** Settings after the connection was stored (repoUrl, branch, userName, userEmail). */
      settings: LocalSettings;
      /** True when the repository has no commits at all. */
      remoteEmpty: boolean;
    }
  | { ok: false; error: SyncError };

export interface PublishRequest {
  /**
   * The COMPLETE desired content of all data files (schedule.json + weeks/*.json).
   * Data files in the working folder that are not listed here are deleted.
   */
  files: FileMap;
  /** Commit message (may be multi-line). */
  message: string;
  /**
   * The team tip (`SyncStatus.remoteSha`) that `files` was prepared against; null when the
   * remote branch did not exist. Publishing only proceeds while this is still the tip.
   */
  expectedRemoteSha: string | null;
}

export type PublishResult =
  | {
      ok: true;
      status: SyncStatus;
      /** The new commit; null when the files already matched the team's copy (nothing to publish). */
      commitSha: string | null;
    }
  /** Someone published in the meantime. Nothing was sent; local work is untouched. */
  | { ok: false; reason: 'remote-changed'; status: SyncStatus }
  /** Could not reach the repository / was refused. Nothing was sent; local work is untouched. */
  | { ok: false; reason: 'error'; error: SyncError; status: SyncStatus };

export interface ApplyUpdateRequest {
  /** The COMPLETE desired content of all data files after the update (team changes + kept local edits). */
  files: FileMap;
  /** The team tip the files were merged against; must still equal `origin/<branch>`. */
  expectedRemoteSha: string;
}

export type UpdateResult =
  | { ok: true; status: SyncStatus }
  | { ok: false; reason: 'remote-changed'; status: SyncStatus }
  | { ok: false; reason: 'error'; error: SyncError; status: SyncStatus };

/** Who last changed something, from `git blame`. */
export interface BlameInfo {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** Milliseconds since the Unix epoch. */
  time: number;
  /** First line of that commit's message. */
  summary: string;
}

/** `git blame` of one week file as published (local unpublished edits are not included). */
export interface WeekBlame {
  weekStart: IsoDate;
  /** The commit that was blamed (local branch tip); null when there are no commits. */
  headSha: string | null;
  /** Event id → last editor. Events that are not in the published file are absent. */
  events: Record<string, BlameInfo>;
  /** Last editor of the week title; null when unknown. */
  title: BlameInfo | null;
}

export interface FileFilter {
  name: string;
  /** Without the dot, e.g. ['ics']. */
  extensions: string[];
}

export interface SaveFileRequest {
  /** Dialog title. */
  title: string;
  defaultName: string;
  filters: FileFilter[];
  /** Text to write (UTF-8, no BOM). */
  content: string;
}

export interface SavedFile {
  path: string;
}

export interface OpenFileRequest {
  title: string;
  filters: FileFilter[];
}

export interface OpenedFile {
  path: string;
  /** File name without folders. */
  name: string;
  content: string;
}

// ───────────────────────────── the API ─────────────────────────────

export interface ScheduleApi {
  // ── start-up and local settings ──

  /** Reads settings, finds git and inspects the local working folder. No network. */
  boot(): Promise<BootState>;
  /**
   * Stores a partial update and returns the complete settings. Changing userName /
   * userEmail also updates the git identity of the connected repository. `repoUrl` and
   * `branch` cannot be changed here (use `connectRepo`). pollSeconds is clamped.
   */
  saveSettings(patch: Partial<LocalSettings>): Promise<LocalSettings>;
  /** Looks for git again (after the user installed it). */
  detectGit(): Promise<GitInfo>;
  /** Lets the user pick git.exe; stores it as `gitPath` when it really is git. null = cancelled. */
  chooseGitExecutable(): Promise<GitInfo | null>;

  // ── repository connection ──

  /**
   * Connects this computer to the team repository: clones it into the app's data folder
   * (or re-uses the existing local folder for the same address, keeping unpublished work),
   * stores the git identity and remembers the address. May show the Windows sign-in window.
   * When the team already has a schedule and the local folder has none, the local folder
   * is brought up to date as part of connecting.
   */
  connectRepo(req: ConnectRequest): Promise<ConnectResult>;
  /**
   * After a `dubious-ownership` error and the user's explicit consent: marks the folder as
   * trusted in the user's global git settings (`git config --global --add safe.directory`).
   */
  trustRepoPath(path: string): Promise<void>;
  /**
   * Creates the first schedule in a repository that has none: writes the files, commits
   * and publishes them. Answers `remote-changed` when a teammate created a schedule in the
   * meantime (connect again to pick it up).
   */
  createSchedule(req: { files: FileMap; message: string }): Promise<PublishResult>;

  // ── data ──

  /** Current status (no network) plus the base and working versions of all data files. */
  loadSnapshot(): Promise<RepoSnapshot>;
  /** The team's newest fetched version of all data files; null when the remote branch does not exist. */
  loadRemote(): Promise<RemoteSnapshot | null>;
  /**
   * Makes the working folder's data files exactly equal to `files` (writes changed files,
   * deletes data files that are not listed). This is how unpublished edits are kept on disk.
   */
  writeWorking(files: FileMap): Promise<void>;

  // ── sync ──

  /**
   * Asks the server for the team's newest version and returns the new status. Never rejects
   * for network or sign-in problems: those are reported in `fetchError`.
   * `interactive: false` (background checks) must never open a sign-in window.
   */
  fetch(opts: { interactive: boolean }): Promise<SyncStatus>;
  /**
   * Moves the local copy to the team's tip and leaves `files` in the working folder, so
   * local edits that were merged in stay as unpublished changes. No network.
   */
  applyUpdate(req: ApplyUpdateRequest): Promise<UpdateResult>;
  /**
   * Publishes: fetches, verifies the team tip is still `expectedRemoteSha`, writes `files`,
   * commits on top of the team tip with the user's identity and pushes. On any failure the
   * commit is undone, so the files stay in the working folder as unpublished changes.
   */
  publish(req: PublishRequest): Promise<PublishResult>;
  /** Throws away all unpublished edits: the working folder's data files become the base version again. */
  discardLocal(): Promise<RepoSnapshot>;
  /** Last editor of every event of one week (see WeekBlame). */
  blame(weekStart: IsoDate): Promise<WeekBlame>;

  // ── versions kept aside (local only, per repository) ──

  getAside(): Promise<AsideItem[]>;
  setAside(items: AsideItem[]): Promise<void>;

  // ── files and shell ──

  /** "Save as" dialog + write. null = cancelled. */
  saveTextFile(req: SaveFileRequest): Promise<SavedFile | null>;
  /** "Open" dialog + read as UTF-8. null = cancelled. */
  openTextFile(req: OpenFileRequest): Promise<OpenedFile | null>;
  /**
   * Opens a file with its default Windows program (e.g. an .ics file in Outlook). Only
   * paths returned by `saveTextFile` during this session are accepted. false = refused / failed.
   */
  openSavedFile(path: string): Promise<boolean>;
  /** Shows the local working folder in Explorer. */
  openRepoFolder(): Promise<void>;
  /** Opens an https:// link in the default browser (anything else is ignored). */
  openExternal(url: string): Promise<void>;
  /** Windows notification + taskbar flash (only while the window is not focused). */
  notify(req: { title: string; body: string }): Promise<void>;

  // ── window lifecycle ──

  /**
   * The user asked to close the window. The renderer must call `ackCloseRequest()` at once
   * (otherwise the window closes by itself after a few seconds), save pending work, and
   * then either call `closeWindow()` or keep the window open. Returns an unsubscribe function.
   */
  onCloseRequested(listener: () => void): () => void;
  ackCloseRequest(): Promise<void>;
  closeWindow(): Promise<void>;
}

/** Methods forwarded 1:1 over IPC (everything except the event subscription). */
export const API_INVOKE_METHODS = [
  'boot',
  'saveSettings',
  'detectGit',
  'chooseGitExecutable',
  'connectRepo',
  'trustRepoPath',
  'createSchedule',
  'loadSnapshot',
  'loadRemote',
  'writeWorking',
  'fetch',
  'applyUpdate',
  'publish',
  'discardLocal',
  'blame',
  'getAside',
  'setAside',
  'saveTextFile',
  'openTextFile',
  'openSavedFile',
  'openRepoFolder',
  'openExternal',
  'notify',
  'ackCloseRequest',
  'closeWindow',
] as const satisfies readonly (keyof ScheduleApi)[];

export type ApiInvokeMethod = (typeof API_INVOKE_METHODS)[number];

/** IPC channel for an invoke method. */
export function ipcChannel(method: ApiInvokeMethod): string {
  return `ts:${method}`;
}

/** Main → renderer event: the user asked to close the window. */
export const CLOSE_REQUESTED_CHANNEL = 'ts:close-requested';
