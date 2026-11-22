/**
 * An in-memory stand-in for the main process (ScheduleApi) with the same rules as the real
 * git layer: a linear team history, a local copy that never keeps commits the team lacks,
 * and unpublished work living in the working files. Tests use it to drive the store through
 * whole sync scenarios, including a teammate publishing at the worst possible moment.
 */
import type {
  ApplyUpdateRequest,
  BootState,
  ConnectRequest,
  ConnectResult,
  GitInfo,
  LocalSettings,
  OpenedFile,
  PublishRequest,
  PublishResult,
  RemoteSnapshot,
  RepoInfo,
  RepoPhase,
  RepoSnapshot,
  SaveFileRequest,
  SavedFile,
  ScheduleApi,
  SyncError,
  SyncStatus,
  UpdateResult,
  WeekBlame,
} from '@shared/api';
import type { AsideItem } from '@shared/merge';
import { deepEqual } from '@shared/model';
import type { FileMap, IsoDate } from '@shared/types';

export interface FakeCommit {
  sha: string;
  files: FileMap;
  authorName: string;
  authorEmail: string;
  time: number;
  message: string;
}

const GIT: GitInfo = { found: true, path: 'C:\\Program Files\\Git\\cmd\\git.exe', version: '2.55.0' };
const REPO: RepoInfo = { url: 'https://example.com/team/schedule.git', branch: 'main', dir: 'C:\\data\\repos\\schedule' };

export class FakeBackend implements ScheduleApi {
  /** The team's history, oldest first. */
  team: FakeCommit[] = [];
  /** Index of the local branch tip in `team` (-1 = no commits). */
  head = -1;
  /** Index of the team tip as of the last fetch (-1 = remote branch unknown). */
  seen = -1;
  working: FileMap = {};
  aside: AsideItem[] = [];
  settings: LocalSettings = {
    language: 'en',
    repoUrl: REPO.url,
    branch: REPO.branch,
    userName: 'Me',
    userEmail: 'me@example.com',
    gitPath: null,
    pollSeconds: 60,
    notifications: true,
  };
  phase: RepoPhase = 'ready';
  firstRun = false;
  systemLocale = 'en-US';
  clock = Date.UTC(2026, 10, 24, 8, 0, 0);

  // ── knobs ──
  fetchError: SyncError | null = null;
  /** The team's branch was deleted or renamed on the server: a fetch finds no remote version. */
  remoteGone = false;
  /** Makes the next push fail (after the commit was prepared) with this error. */
  pushError: SyncError | null = null;
  /** Runs after publish wrote the files and moved the local copy, right before the "push". */
  beforePush: (() => void) | null = null;
  /** When set, every bridge call with this name throws. */
  throwOn: string | null = null;
  connectAnswer: ConnectResult | null = null;
  saveAnswers: (string | null)[] = [];
  openAnswers: (OpenedFile | null)[] = [];

  // ── recordings ──
  calls: string[] = [];
  saved: { path: string; request: SaveFileRequest }[] = [];
  opened: string[] = [];
  notifications: { title: string; body: string }[] = [];
  closed = false;
  private closeListener: (() => void) | null = null;
  private shaCounter = 0;

  // ── test helpers ──

  /** Adds a commit to the team's history without the local copy knowing (a teammate published). */
  teammatePublishes(files: FileMap, authorName = 'Dana', message = 'Team change'): FakeCommit {
    this.clock += 60_000;
    const commit: FakeCommit = {
      sha: `sha${String(++this.shaCounter).padStart(4, '0')}`,
      files: { ...files },
      authorName,
      authorEmail: `${authorName.toLowerCase()}@example.com`,
      time: this.clock,
      message,
    };
    this.team.push(commit);
    return commit;
  }

  /** A repository whose team history starts with `files`, fully in sync locally. */
  seed(files: FileMap): void {
    this.teammatePublishes(files, 'Dana', 'Create schedule');
    this.head = this.seen = this.team.length - 1;
    this.working = { ...files };
  }

  get tip(): FakeCommit {
    return this.team[this.team.length - 1];
  }

  requestClose(): void {
    this.closeListener?.();
  }

  private record(name: string): void {
    this.calls.push(name);
    if (this.throwOn === name) throw new Error(`fake bridge failure in ${name}`);
  }

  private statusNow(): SyncStatus {
    const incoming = this.team
      .slice(this.head + 1, this.seen + 1)
      .reverse()
      .map((c) => ({
        sha: c.sha,
        authorName: c.authorName,
        authorEmail: c.authorEmail,
        time: c.time,
        subject: c.message.split('\n')[0],
      }));
    const headSha = this.head >= 0 ? this.team[this.head].sha : null;
    return {
      headSha,
      remoteSha: this.seen >= 0 ? this.team[this.seen].sha : null,
      baseSha: this.seen >= 0 ? headSha : null,
      ahead: 0,
      behind: Math.max(0, this.seen - this.head),
      incoming,
      lastFetchAt: this.clock,
      fetchError: this.fetchError,
    };
  }

  private doFetch(): SyncStatus {
    if (!this.fetchError) this.seen = this.remoteGone ? -1 : this.team.length - 1;
    return this.statusNow();
  }

  // ── ScheduleApi ──

  async boot(): Promise<BootState> {
    this.record('boot');
    return {
      appVersion: '1.0.0',
      systemLocale: this.systemLocale,
      firstRun: this.firstRun,
      settings: { ...this.settings },
      git: GIT,
      suggestedIdentity: { name: 'Me', email: 'me@example.com' },
      phase: this.phase,
      repo: this.phase === 'not-configured' ? null : REPO,
    };
  }

  async saveSettings(patch: Partial<LocalSettings>): Promise<LocalSettings> {
    this.record('saveSettings');
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }

  async detectGit(): Promise<GitInfo> {
    this.record('detectGit');
    return GIT;
  }

  async chooseGitExecutable(): Promise<GitInfo | null> {
    this.record('chooseGitExecutable');
    return GIT;
  }

  async connectRepo(req: ConnectRequest): Promise<ConnectResult> {
    this.record('connectRepo');
    if (this.connectAnswer) return this.connectAnswer;
    this.settings = { ...this.settings, repoUrl: req.url, userName: req.userName, userEmail: req.userEmail };
    // Connecting fetches, and brings a local copy without a schedule up to the team's.
    this.seen = this.team.length - 1;
    const teamHasSchedule = this.seen >= 0 && 'schedule.json' in this.team[this.seen].files;
    if (teamHasSchedule && !('schedule.json' in this.working)) {
      this.head = this.seen;
      this.working = { ...this.team[this.seen].files };
    }
    const ready = 'schedule.json' in this.working;
    this.phase = ready ? 'ready' : 'needs-init';
    return { ok: true, phase: ready ? 'ready' : 'needs-init', repo: REPO, settings: { ...this.settings }, remoteEmpty: this.team.length === 0 };
  }

  async trustRepoPath(): Promise<void> {
    this.record('trustRepoPath');
  }

  async createSchedule(req: { files: FileMap; message: string }): Promise<PublishResult> {
    this.record('createSchedule');
    const status = this.doFetch();
    if (status.fetchError) return { ok: false, reason: 'error', error: status.fetchError, status };
    if (this.seen >= 0 && 'schedule.json' in this.team[this.seen].files) return { ok: false, reason: 'remote-changed', status };
    this.working = { ...req.files };
    const commit = this.teammatePublishes(req.files, this.settings.userName, req.message);
    this.head = this.seen = this.team.length - 1;
    this.phase = 'ready';
    return { ok: true, status: this.statusNow(), commitSha: commit.sha };
  }

  async loadSnapshot(): Promise<RepoSnapshot> {
    this.record('loadSnapshot');
    const status = this.statusNow();
    return {
      status,
      baseFiles: status.baseSha !== null && this.head >= 0 ? { ...this.team[this.head].files } : {},
      workingFiles: { ...this.working },
    };
  }

  async loadRemote(): Promise<RemoteSnapshot | null> {
    this.record('loadRemote');
    return this.seen < 0 ? null : { sha: this.team[this.seen].sha, files: { ...this.team[this.seen].files } };
  }

  async writeWorking(files: FileMap): Promise<void> {
    this.record('writeWorking');
    this.working = { ...files };
  }

  async fetch(): Promise<SyncStatus> {
    this.record('fetch');
    return this.doFetch();
  }

  async applyUpdate(req: ApplyUpdateRequest): Promise<UpdateResult> {
    this.record('applyUpdate');
    if (this.seen < 0 || this.team[this.seen].sha !== req.expectedRemoteSha) {
      return { ok: false, reason: 'remote-changed', status: this.statusNow() };
    }
    this.working = { ...req.files };
    this.head = this.seen;
    return { ok: true, status: this.statusNow() };
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    this.record('publish');
    const fetched = this.doFetch();
    if (fetched.fetchError) return { ok: false, reason: 'error', error: fetched.fetchError, status: fetched };
    if (fetched.remoteSha !== req.expectedRemoteSha) return { ok: false, reason: 'remote-changed', status: fetched };

    // From here on the real service has written the files and moved the local copy to the team's tip.
    this.working = { ...req.files };
    this.head = this.seen;
    if (this.seen >= 0 && deepEqual(req.files, this.team[this.seen].files)) {
      return { ok: true, status: this.statusNow(), commitSha: null };
    }
    const before = this.team.length;
    this.beforePush?.();
    this.beforePush = null;
    if (this.team.length !== before) {
      this.seen = this.team.length - 1;
      return { ok: false, reason: 'remote-changed', status: this.statusNow() };
    }
    if (this.pushError) {
      const error = this.pushError;
      this.pushError = null;
      return { ok: false, reason: 'error', error, status: this.statusNow() };
    }
    const commit = this.teammatePublishes(req.files, this.settings.userName, req.message);
    this.head = this.seen = this.team.length - 1;
    return { ok: true, status: this.statusNow(), commitSha: commit.sha };
  }

  async discardLocal(): Promise<RepoSnapshot> {
    this.record('discardLocal');
    this.working = this.head >= 0 ? { ...this.team[this.head].files } : {};
    return this.loadSnapshot();
  }

  async blame(weekStart: IsoDate): Promise<WeekBlame> {
    this.record('blame');
    const headSha = this.head >= 0 ? this.team[this.head].sha : null;
    return { weekStart, headSha, events: {}, title: null };
  }

  async getAside(): Promise<AsideItem[]> {
    this.record('getAside');
    return [...this.aside];
  }

  async setAside(items: AsideItem[]): Promise<void> {
    this.record('setAside');
    this.aside = [...items];
  }

  async saveTextFile(req: SaveFileRequest): Promise<SavedFile | null> {
    this.record('saveTextFile');
    const path = this.saveAnswers.length > 0 ? this.saveAnswers.shift() ?? null : `C:\\out\\${req.defaultName}`;
    if (path === null) return null;
    this.saved.push({ path, request: req });
    return { path };
  }

  async openTextFile(): Promise<OpenedFile | null> {
    this.record('openTextFile');
    return this.openAnswers.shift() ?? null;
  }

  async openSavedFile(path: string): Promise<boolean> {
    this.record('openSavedFile');
    this.opened.push(path);
    return true;
  }

  async openRepoFolder(): Promise<void> {
    this.record('openRepoFolder');
  }

  async openExternal(): Promise<void> {
    this.record('openExternal');
  }

  async notify(req: { title: string; body: string }): Promise<void> {
    this.record('notify');
    this.notifications.push(req);
  }

  onCloseRequested(listener: () => void): () => void {
    this.closeListener = listener;
    return () => {
      this.closeListener = null;
    };
  }

  async ackCloseRequest(): Promise<void> {
    this.record('ackCloseRequest');
  }

  async closeWindow(): Promise<void> {
    this.record('closeWindow');
    this.closed = true;
  }
}
