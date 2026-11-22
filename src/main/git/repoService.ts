/**
 * All git work for one connected repository.
 *
 * ── Model ──────────────────────────────────────────────────────────────────────────────
 * `dir` is a normal clone with remote `origin`. The schedule lives on one branch.
 * Invariant kept by every method: the local branch never keeps commits the team does not
 * have. Unpublished work = plain modifications of the data files in the working folder.
 * Only data files (`isDataPath` from @shared/paths: schedule.json, weeks/YYYY-MM-DD.json)
 * are ever read, written, staged or committed; other files in the repository are left alone.
 * git never merges text: the renderer merges datasets and hands over complete file sets.
 *
 * ── Concurrency ────────────────────────────────────────────────────────────────────────
 * Every public method runs through one internal promise queue, so two git commands never
 * run at the same time on the repository (a background fetch can never interleave with a
 * publish).
 *
 * ── Local repository configuration (set by connect) ────────────────────────────────────
 *   user.name / user.email   the identity given by the user
 *   core.autocrlf=false, core.eol=lf, core.safecrlf=false   files are written with "\n"
 *   core.longpaths=true
 * Commit signing and hooks are left as the user configured them.
 *
 * ── Time limits ────────────────────────────────────────────────────────────────────────
 * clone 300 s, fetch / push 120 s, everything local 30 s.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  BlameInfo,
  CommitInfo,
  PublishResult,
  RemoteSnapshot,
  RepoSnapshot,
  SyncError,
  SyncStatus,
  UpdateResult,
  WeekBlame,
} from '@shared/api';
import { eventIdOfLine, isDataPath, isTitleLine, weekPath } from '@shared/paths';
import { CONFIG_PATH, WEEKS_DIR, type FileMap, type IsoDate } from '@shared/types';
import { GitError, classifyGitFailure, type GitRunOptions, type GitResult, type GitRunner } from './gitRunner';

const CLONE_TIMEOUT_MS = 300_000;
const NETWORK_TIMEOUT_MS = 120_000;
const MAX_INCOMING = 50;
const GITATTRIBUTES_PATH = '.gitattributes';
const GITATTRIBUTES_CONTENT = '*.json text eol=lf\n';

/** Applied to the clone itself, so even the very first checkout writes "\n" files on Windows. */
const LOCAL_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.autocrlf', 'false'],
  ['core.eol', 'lf'],
  ['core.safecrlf', 'false'],
  ['core.longpaths', 'true'],
];

export interface ConnectParams {
  /** Already validated with checkRepoUrl(). */
  url: string;
  /** Folder for the clone (may or may not exist yet). */
  dir: string;
  /** null = the remote's default branch, or `main` when the remote is empty. */
  branch: string | null;
  userName: string;
  userEmail: string;
}

export interface ConnectOutcome {
  service: RepoService;
  /** True when the remote has no commits at all. */
  remoteEmpty: boolean;
  /** True when schedule.json exists (working folder or local branch tip) after connecting. */
  hasSchedule: boolean;
}

// ───────────────────────────── small helpers ─────────────────────────────

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The file's text exactly as it is on disk; null when there is no such file. */
async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw error;
  }
}

/** Windows answers like this while an antivirus or indexer has the file open for a moment. */
const SHARING_ERRORS: ReadonlySet<string | undefined> = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function retryWhileInUse<T>(action: () => Promise<T>): Promise<T> {
  for (const delay of [20, 50, 100, 200, 400]) {
    try {
      return await action();
    } catch (error) {
      if (!SHARING_ERRORS.has(errorCode(error))) throw error;
      await sleep(delay);
    }
  }
  return action();
}

/** A crash in the middle must never leave half a schedule file: write beside it, then swap. */
async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, text, { encoding: 'utf8', flush: true });
    await retryWhileInUse(() => rename(temp, path));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function diskPath(dir: string, repoPath: string): string {
  return join(dir, ...repoPath.split('/'));
}

/** Two spellings of one address: git stores what it was given, but slashes and case may differ on Windows. */
function sameAddress(a: string, b: string): boolean {
  const normalize = (url: string): string => url.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

function timestampForFolder(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** The `origin` address of the clone in `dir`; null when `dir` is not itself a git working folder. */
async function originOf(git: GitRunner, dir: string): Promise<string | null> {
  // Without its own .git the folder could sit inside some other repository, whose settings git would then report.
  if (!(await pathExists(join(dir, '.git')))) return null;
  try {
    const result = await git.run(['config', '--local', '--get', 'remote.origin.url'], { cwd: dir, okExitCodes: [1] });
    const url = result.stdout.trim();
    return result.code === 0 && url !== '' ? url : null;
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

function unexpectedOutput(what: string, text: string): Error {
  return new Error(`Unexpected output of ${what}: ${text.slice(0, 200)}`);
}

/** Parses `git blame --line-porcelain`: one record per line of the file. */
function parseBlame(output: string): { info: BlameInfo; line: string }[] {
  const records: { info: BlameInfo; line: string }[] = [];
  let current: BlameInfo | null = null;
  for (const raw of output.split('\n')) {
    if (raw.startsWith('\t')) {
      if (current) records.push({ info: current, line: raw.slice(1) });
      current = null;
      continue;
    }
    const header = /^([0-9a-f]{40,64}) \d+ \d+(?: \d+)?$/.exec(raw);
    if (header) {
      current = { sha: header[1], authorName: '', authorEmail: '', time: 0, summary: '' };
      continue;
    }
    if (!current) continue;
    const space = raw.indexOf(' ');
    const key = space < 0 ? raw : raw.slice(0, space);
    const value = space < 0 ? '' : raw.slice(space + 1);
    if (key === 'author') current.authorName = value;
    else if (key === 'author-mail') current.authorEmail = value.replace(/^<|>$/g, '');
    else if (key === 'author-time') current.time = Number(value) * 1000;
    else if (key === 'summary') current.summary = value;
  }
  return records;
}

// ───────────────────────────── the service ─────────────────────────────

export class RepoService {
  readonly dir: string;
  readonly url: string;
  readonly branch: string;

  private readonly git: GitRunner;
  /** Settles when the last queued job has finished; never rejects. */
  private tail: Promise<void> = Promise.resolve();
  private lastFetchAt: number | null = null;
  private fetchError: SyncError | null = null;

  /** Use `RepoService.connect` / `RepoService.open`; the constructor does no I/O. */
  constructor(git: GitRunner, dir: string, url: string, branch: string) {
    this.git = git;
    this.dir = dir;
    this.url = url;
    this.branch = branch;
  }

  /**
   * Connects to the team repository. May open a sign-in window (interactive).
   *
   * 1. When `dir` is already a git repository whose `origin` URL equals `url`: re-use it
   *    (unpublished work in the working folder is kept) and `git fetch --prune origin`.
   *    When `dir` exists but is anything else: rename it to `<dir>.old-<timestamp>` first.
   * 2. Otherwise `git clone --origin origin -- <url> <dir>` (creating parent folders).
   * 3. Apply the local configuration listed in the file comment.
   * 4. Decide the branch: `params.branch` when given; else the branch the clone's HEAD
   *    names (the server's default — also for an empty remote) when the remote has it or is
   *    empty; else the server default, `main`, `master` or the first remote branch that exists.
   *    - given branch exists on the remote (`refs/remotes/origin/<b>`): check it out
   *      (`git checkout -B <b> origin/<b>`) unless it is already current.
   *    - given branch does not exist on the remote: create it from the current commit
   *      (`git checkout -B <b>`), or for an empty repository point HEAD at it
   *      (`git symbolic-ref HEAD refs/heads/<b>`).
   * 5. When the remote branch has schedule.json but neither the working folder nor the
   *    local tip has it, and the working folder holds no data files: fast-forward the
   *    local branch to the remote tip (`git reset --hard origin/<b>`).
   *
   * Throws GitError (auth, offline, not-found, dubious-ownership, timeout, …) when the
   * repository cannot be reached; in that case a freshly created `dir` is removed again.
   */
  static async connect(git: GitRunner, params: ConnectParams): Promise<ConnectOutcome> {
    const { url, dir } = params;
    const configFlags = LOCAL_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]);

    let reused = false;
    if (await pathExists(dir)) {
      const origin = await originOf(git, dir);
      if (origin !== null && sameAddress(origin, url)) reused = true;
      else await retryWhileInUse(() => rename(dir, `${dir}.old-${timestampForFolder(new Date())}`));
    }

    if (reused) {
      await git.run(['fetch', '--prune', 'origin'], { cwd: dir, timeoutMs: NETWORK_TIMEOUT_MS, interactive: true });
    } else {
      await mkdir(dirname(dir), { recursive: true });
      try {
        await git.run(['clone', ...configFlags, '--origin', 'origin', '--', url, dir], {
          timeoutMs: CLONE_TIMEOUT_MS,
          interactive: true,
        });
      } catch (error) {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
        throw error;
      }
    }

    const local = (args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> =>
      git.run(args, { ...options, cwd: dir });
    for (const [key, value] of LOCAL_CONFIG) await local(['config', key, value]);
    await local(['config', 'user.name', params.userName]);
    await local(['config', 'user.email', params.userEmail]);

    const revParse = async (ref: string): Promise<string | null> => {
      const result = await local(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { okExitCodes: [1] });
      const sha = result.stdout.trim();
      return result.code === 0 && sha !== '' ? sha : null;
    };
    const currentBranch = async (): Promise<string> =>
      (await local(['symbolic-ref', '--quiet', '--short', 'HEAD'], { okExitCodes: [1] })).stdout.trim();

    const remoteBranches = (await local(['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin'])).stdout
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => name !== '' && name !== 'HEAD');
    const remoteEmpty = remoteBranches.length === 0;

    let branch = params.branch;
    if (branch === null) {
      // After a clone the local HEAD names the server's default branch — also for an empty
      // repository, so the first schedule lands on the branch the server expects.
      const current = await currentBranch();
      if (remoteEmpty) {
        branch = current || 'main';
      } else if (current !== '' && remoteBranches.includes(current)) {
        branch = current;
      } else {
        // The server's default branch does not exist (a bare repository made with another
        // default name than the one the schedule was pushed to): use the branch that does.
        const head = await local(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { okExitCodes: [1] });
        const serverDefault = head.stdout.trim().replace(/^origin\//, '');
        branch =
          [serverDefault, 'main', 'master'].find((name) => name !== '' && remoteBranches.includes(name)) ??
          [...remoteBranches].sort()[0];
      }
    }
    // The last gate before the name becomes part of a ref.
    await local(['check-ref-format', '--branch', branch]);

    const remoteRef = `refs/remotes/origin/${branch}`;
    const remoteSha = await revParse(remoteRef);
    if ((await currentBranch()) !== branch) {
      if (remoteSha !== null) await local(['checkout', '--quiet', '-B', branch, remoteRef]);
      else if ((await revParse('HEAD')) !== null) await local(['checkout', '--quiet', '-B', branch]);
      else await local(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    }

    const service = new RepoService(git, dir, url, branch);
    if (remoteSha !== null && !(await service.hasScheduleNow())) {
      const teamHasSchedule = await service.existsAt(remoteSha, CONFIG_PATH);
      const noLocalData = Object.keys(await service.readWorkingFiles()).length === 0;
      if (teamHasSchedule && noLocalData) await local(['reset', '--hard', '--quiet', remoteSha]);
    }
    service.lastFetchAt = Date.now();
    return { service, remoteEmpty, hasSchedule: await service.hasScheduleNow() };
  }

  /**
   * Opens an existing clone without any network access. Returns null when `dir` is not a
   * git repository or its `origin` URL differs from `url`.
   */
  static async open(git: GitRunner, dir: string, url: string, branch: string): Promise<RepoService | null> {
    const origin = await originOf(git, dir);
    if (origin === null || !sameAddress(origin, url)) return null;
    return new RepoService(git, dir, url, branch);
  }

  // ───────────────────────────── public API (queued) ─────────────────────────────

  /** Stores user.name / user.email in the repository's local git config. */
  setIdentity(userName: string, userEmail: string): Promise<void> {
    return this.enqueue(async () => {
      await this.run(['config', 'user.name', userName]);
      await this.run(['config', 'user.email', userEmail]);
    });
  }

  /** True when schedule.json exists in the working folder or at the local branch tip. */
  hasSchedule(): Promise<boolean> {
    return this.enqueue(() => this.hasScheduleNow());
  }

  /**
   * Status from local information only (no network):
   *   headSha   = `git rev-parse --verify --quiet HEAD` (null when unborn)
   *   remoteSha = `refs/remotes/origin/<branch>` (null when missing)
   *   baseSha   = `git merge-base HEAD origin/<branch>` when both exist; null when the
   *               remote branch is missing (nothing is shared yet, so everything local
   *               counts as unpublished), when HEAD is unborn, or without a common commit
   *   ahead / behind = `git rev-list --count` of origin/<b>..HEAD and HEAD..origin/<b>
   *                    (when HEAD is unborn: ahead 0, behind = number of remote commits;
   *                    when there is no remote branch: ahead = number of local commits)
   *   incoming  = `git log` of HEAD..origin/<b> (all remote commits when HEAD is unborn),
   *               newest first, max 50
   *   lastFetchAt / fetchError = remembered from the last fetch() of this instance
   */
  status(): Promise<SyncStatus> {
    return this.enqueue(() => this.statusNow());
  }

  /**
   * `git fetch --prune origin`, then status(). Network / sign-in failures do not throw:
   * they are returned in `status.fetchError` (and remembered until the next fetch).
   * `interactive=false` must never open a sign-in window.
   */
  fetch(interactive: boolean): Promise<SyncStatus> {
    return this.enqueue(() => this.fetchNow(interactive));
  }

  /** status() + data files at baseSha + data files in the working folder. */
  loadSnapshot(): Promise<RepoSnapshot> {
    return this.enqueue(() => this.snapshotNow());
  }

  /** Data files at `origin/<branch>`; null when that ref does not exist. */
  loadRemote(): Promise<RemoteSnapshot | null> {
    return this.enqueue(async () => {
      const sha = await this.revParse(this.remoteRef);
      return sha === null ? null : { sha, files: await this.readFilesAt(sha) };
    });
  }

  /**
   * Makes the working folder's data files exactly `files`:
   *  - every key must satisfy isDataPath() (otherwise throw — nothing may be written
   *    outside schedule.json and weeks/);
   *  - write each file whose current content differs (UTF-8, no BOM, atomically: write a
   *    temp file in the same folder, then rename);
   *  - delete data files on disk that are not in `files`.
   */
  writeWorking(files: FileMap): Promise<void> {
    return this.enqueue(() => this.writeWorkingFiles(files));
  }

  /**
   * Brings the local branch to the team's tip, keeping `files` as the working content.
   * No network.
   *  1. origin/<branch> must exist and equal `expectedRemoteSha`, else → remote-changed.
   *  2. writeWorking(files)                (first, so a crash never loses local edits)
   *  3. `git reset --mixed <expectedRemoteSha>` (moves the branch and index, keeps files)
   *  4. best effort, errors ignored: bring tracked NON-data files in line with the new tip.
   * Result: files that differ from the team tip show up as unpublished changes.
   */
  applyUpdate(files: FileMap, expectedRemoteSha: string): Promise<UpdateResult> {
    return this.enqueue(async (): Promise<UpdateResult> => {
      const remote = await this.revParse(this.remoteRef);
      if (remote === null || remote !== expectedRemoteSha) {
        return { ok: false, reason: 'remote-changed', status: await this.statusNow() };
      }
      try {
        await this.writeWorkingFiles(files);
        await this.moveBranchTo(remote);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        return { ok: false, reason: 'error', error: error.toSyncError(), status: await this.statusNow() };
      }
      return { ok: true, status: await this.statusNow() };
    });
  }

  /**
   * Publishes `files` as one commit on top of the team's tip.
   *  1. fetch (interactive). Failure → { ok:false, reason:'error' }.
   *  2. The remote tip must equal `expectedRemoteSha` (both null = remote branch absent),
   *     else → { ok:false, reason:'remote-changed' } with the fresh status. Nothing written.
   *  3. writeWorking(files).
   *  4. When a remote tip exists and HEAD differs from it: `git reset --mixed <remoteSha>`.
   *  5. Stage data files only. Nothing staged and nothing unpushed → { ok:true, commitSha:null }.
   *  6. `git commit` with the message (identity from the local config).
   *  7. `git push --porcelain origin HEAD:refs/heads/<branch>`.
   *     Refused → undo the commit (`git reset --mixed <previous tip>`; when there was no
   *       previous commit: `git update-ref -d HEAD`) and fetch again: when the team's tip
   *       has moved, a teammate published first → remote-changed; otherwise reason 'error'.
   *     Could not be sent at all (network, sign-in) → undo the commit, reason 'error'.
   *  8. Success → { ok:true, commitSha, status } with ahead = behind = 0.
   * After any failure the working folder still contains `files`.
   */
  publish(files: FileMap, message: string, expectedRemoteSha: string | null): Promise<PublishResult> {
    return this.enqueue(async (): Promise<PublishResult> => {
      const fetched = await this.fetchNow(true);
      if (fetched.fetchError) return { ok: false, reason: 'error', error: fetched.fetchError, status: fetched };
      if (fetched.remoteSha !== expectedRemoteSha) return { ok: false, reason: 'remote-changed', status: fetched };
      return this.commitAndPush(files, message, fetched, []);
    });
  }

  /**
   * First schedule in a repository that has none. Like publish(), except:
   *  - after the fetch: when the remote branch already has schedule.json → remote-changed;
   *    expectedRemoteSha is simply the current remote tip;
   *  - data files that already exist at the remote tip or in the working folder are kept
   *    (`files` is laid over them), so stray week files are never deleted;
   *  - also writes and stages `.gitattributes` containing "*.json text eol=lf\n" when the
   *    repository has no .gitattributes yet;
   *  - when the repository has no commits, HEAD is first pointed at the branch.
   */
  createSchedule(files: FileMap, message: string): Promise<PublishResult> {
    return this.enqueue(async (): Promise<PublishResult> => {
      const fetched = await this.fetchNow(true);
      if (fetched.fetchError) return { ok: false, reason: 'error', error: fetched.fetchError, status: fetched };
      const remote = fetched.remoteSha;
      if (remote !== null && (await this.existsAt(remote, CONFIG_PATH))) {
        return { ok: false, reason: 'remote-changed', status: fetched };
      }
      const extra: string[] = [];
      const attributesOnDisk = await pathExists(join(this.dir, GITATTRIBUTES_PATH));
      const attributesInTeam = remote !== null && (await this.existsAt(remote, GITATTRIBUTES_PATH));
      if (!attributesOnDisk && !attributesInTeam) {
        await writeTextAtomic(join(this.dir, GITATTRIBUTES_PATH), GITATTRIBUTES_CONTENT);
        extra.push(GITATTRIBUTES_PATH);
      }
      if (fetched.headSha === null) await this.run(['symbolic-ref', 'HEAD', `refs/heads/${this.branch}`]);
      // "No schedule.json" does not mean "no data": week files that the team or this computer
      // already has (someone removed schedule.json by hand) must survive the new start.
      const existing: FileMap = {
        ...(remote === null ? {} : await this.readFilesAt(remote)),
        ...(await this.readWorkingFiles()),
      };
      return this.commitAndPush({ ...existing, ...files }, message, fetched, extra);
    });
  }

  /**
   * Restores the working folder's data files to the last shared version (status().baseSha),
   * then loadSnapshot(). When nothing is shared (the team's branch is missing on the server)
   * the local branch tip is restored instead: "discard" must never mean "delete everything".
   */
  discardLocal(): Promise<RepoSnapshot> {
    return this.enqueue(async () => {
      const status = await this.statusNow();
      const restoreFrom = status.baseSha ?? status.headSha;
      // Without any commit there is nothing to go back to: the working files are left alone.
      if (restoreFrom !== null) await this.writeWorkingFiles(await this.readFilesAt(restoreFrom));
      return this.snapshotNow();
    });
  }

  /**
   * `git blame -M --line-porcelain HEAD -- weeks/<weekStart>.json`, mapped with
   * eventIdOfLine() / isTitleLine() from @shared/paths. A missing file or an unborn
   * HEAD gives an empty result (not an error). Author time is converted to milliseconds.
   */
  blame(weekStart: IsoDate): Promise<WeekBlame> {
    return this.enqueue(async (): Promise<WeekBlame> => {
      const headSha = await this.revParse('HEAD');
      const result: WeekBlame = { weekStart, headSha, events: {}, title: null };
      const path = weekPath(weekStart);
      if (headSha === null || !isDataPath(path) || !(await this.existsAt(headSha, path))) return result;
      const output = await this.run(['blame', '-M', '--line-porcelain', headSha, '--', path]);
      for (const { info, line } of parseBlame(output.stdout)) {
        const eventId = eventIdOfLine(line);
        if (eventId !== null) result.events[eventId] = info;
        else if (isTitleLine(line)) result.title = info;
      }
      return result;
    });
  }

  // ───────────────────────────── internals (never queued) ─────────────────────────────

  private get remoteRef(): string {
    return `refs/remotes/origin/${this.branch}`;
  }

  /** Runs `job` after everything queued before it; a failing job does not block the ones behind it. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private run(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    return this.git.run(args, { ...options, cwd: this.dir });
  }

  private async revParse(ref: string): Promise<string | null> {
    const result = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { okExitCodes: [1] });
    const sha = result.stdout.trim();
    return result.code === 0 && sha !== '' ? sha : null;
  }

  private async count(range: string): Promise<number> {
    const result = await this.run(['rev-list', '--count', range]);
    return Number(result.stdout.trim()) || 0;
  }

  private async log(range: string): Promise<CommitInfo[]> {
    const format = '%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1e';
    const result = await this.run(['log', `--max-count=${MAX_INCOMING}`, `--format=${format}`, range]);
    const commits: CommitInfo[] = [];
    for (const record of result.stdout.split('\x1e')) {
      const [sha, authorName, authorEmail, seconds, subject] = record.replace(/^\s+/, '').split('\x1f');
      if (!sha || seconds === undefined) continue;
      commits.push({ sha, authorName, authorEmail, time: Number(seconds) * 1000, subject: subject ?? '' });
    }
    return commits;
  }

  private async statusNow(): Promise<SyncStatus> {
    const headSha = await this.revParse('HEAD');
    const remoteSha = await this.revParse(this.remoteRef);
    let baseSha: string | null = null;
    let ahead = 0;
    let behind = 0;
    let incoming: CommitInfo[] = [];

    if (headSha !== null && remoteSha !== null) {
      if (headSha === remoteSha) {
        baseSha = headSha;
      } else {
        const mergeBase = await this.run(['merge-base', headSha, remoteSha], { okExitCodes: [1] });
        baseSha = mergeBase.stdout.trim() || null;
        ahead = await this.count(`${remoteSha}..${headSha}`);
        behind = await this.count(`${headSha}..${remoteSha}`);
        if (behind > 0) incoming = await this.log(`${headSha}..${remoteSha}`);
      }
    } else if (headSha !== null) {
      ahead = await this.count(headSha);
    } else if (remoteSha !== null) {
      behind = await this.count(remoteSha);
      incoming = await this.log(remoteSha);
    }

    return {
      headSha,
      remoteSha,
      baseSha,
      ahead,
      behind,
      incoming,
      lastFetchAt: this.lastFetchAt,
      fetchError: this.fetchError,
    };
  }

  private async fetchNow(interactive: boolean): Promise<SyncStatus> {
    try {
      await this.run(['fetch', '--prune', 'origin'], { timeoutMs: NETWORK_TIMEOUT_MS, interactive });
      this.lastFetchAt = Date.now();
      this.fetchError = null;
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      this.fetchError = error.toSyncError();
    }
    return this.statusNow();
  }

  private async snapshotNow(): Promise<RepoSnapshot> {
    const status = await this.statusNow();
    const baseFiles = status.baseSha === null ? {} : await this.readFilesAt(status.baseSha);
    return { status, baseFiles, workingFiles: await this.readWorkingFiles() };
  }

  /** True when `path` is a file in the tree of `commit`. */
  private async existsAt(commit: string, path: string): Promise<boolean> {
    const result = await this.run(['ls-tree', '--name-only', commit, '--', path]);
    return result.stdout.trim() !== '';
  }

  private async hasScheduleNow(): Promise<boolean> {
    if (await pathExists(join(this.dir, CONFIG_PATH))) return true;
    const headSha = await this.revParse('HEAD');
    return headSha !== null && (await this.existsAt(headSha, CONFIG_PATH));
  }

  /** All data files in the tree of `commit`, read with two git processes however many files there are. */
  private async readFilesAt(commit: string): Promise<FileMap> {
    const listing = await this.run(['ls-tree', '-r', '-z', commit, '--', CONFIG_PATH, WEEKS_DIR]);
    const blobs: { object: string; path: string }[] = [];
    for (const entry of listing.stdout.split('\0')) {
      // "<mode> <type> <object>\t<path>"
      const match = /^\d+ (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
      if (match && match[1] === 'blob' && isDataPath(match[3])) blobs.push({ object: match[2], path: match[3] });
    }
    const files: FileMap = {};
    if (blobs.length === 0) return files;

    const batch = await this.run(['cat-file', '--batch'], { input: `${blobs.map((b) => b.object).join('\n')}\n` });
    const bytes = batch.stdoutBuffer;
    let offset = 0;
    for (const blob of blobs) {
      // "<object> blob <size>\n<content>\n"
      const headerEnd = bytes.indexOf(0x0a, offset);
      if (headerEnd < 0) throw unexpectedOutput('git cat-file', bytes.subarray(offset).toString('utf8'));
      const header = bytes.subarray(offset, headerEnd).toString('utf8');
      const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
      if (!match) throw unexpectedOutput('git cat-file', header);
      const start = headerEnd + 1;
      const end = start + Number(match[1]);
      files[blob.path] = bytes.subarray(start, end).toString('utf8');
      offset = end + 1;
    }
    return files;
  }

  /** The data files in the working folder, with their text exactly as it is on disk. */
  private async readWorkingFiles(): Promise<FileMap> {
    const files: FileMap = {};
    const config = await readTextIfExists(join(this.dir, CONFIG_PATH));
    if (config !== null) files[CONFIG_PATH] = config;
    let names: string[];
    try {
      names = await readdir(join(this.dir, WEEKS_DIR));
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return files;
      throw error;
    }
    for (const name of names.sort()) {
      const path = `${WEEKS_DIR}/${name}`;
      if (!isDataPath(path)) continue;
      const text = await readTextIfExists(diskPath(this.dir, path));
      if (text !== null) files[path] = text;
    }
    return files;
  }

  private async writeWorkingFiles(files: FileMap): Promise<void> {
    // Everything is checked before anything is written: a bad request must change nothing.
    for (const [path, content] of Object.entries(files)) {
      if (!isDataPath(path)) throw new Error(`Refusing to write "${path}": it is not a schedule data file`);
      if (typeof content !== 'string') throw new Error(`Refusing to write "${path}": its content is not text`);
    }
    const current = await this.readWorkingFiles();
    for (const [path, content] of Object.entries(files)) {
      if (current[path] !== content) await writeTextAtomic(diskPath(this.dir, path), content);
    }
    for (const path of Object.keys(current)) {
      if (!Object.hasOwn(files, path)) await retryWhileInUse(() => rm(diskPath(this.dir, path), { force: true }));
    }
  }

  /** Moves the branch and the index to `commit` without touching the data files in the working folder. */
  private async moveBranchTo(commit: string): Promise<void> {
    await this.run(['reset', '--mixed', '--quiet', commit]);
    try {
      // Files the app does not manage (a README …) should simply follow the team's version.
      await this.run(['checkout', '--quiet', '--', '.', `:(exclude)${CONFIG_PATH}`, `:(exclude)${WEEKS_DIR}`]);
    } catch (error) {
      // Best effort only: such files never take part in a commit made by the app.
      if (!(error instanceof GitError)) throw error;
    }
  }

  /** Stages additions, changes and deletions of data files (plus `extra` paths) — and nothing else. */
  private async stageDataFiles(extra: readonly string[]): Promise<void> {
    const tracked = (await this.run(['ls-files', '-z', '--', CONFIG_PATH, WEEKS_DIR])).stdout
      .split('\0')
      .filter((path) => path !== '' && isDataPath(path));
    const onDisk = Object.keys(await this.readWorkingFiles());
    const paths = [...new Set([...tracked, ...onDisk, ...extra])];
    if (paths.length === 0) return;
    await this.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${paths.join('\0')}\0` });
  }

  /** Takes back the commit made by a publish that did not reach the team; the files stay as they are. */
  private async undoCommit(previousTip: string | null): Promise<void> {
    if (previousTip !== null) await this.run(['reset', '--mixed', '--quiet', previousTip]);
    else await this.run(['update-ref', '-d', 'HEAD']);
  }

  /** Steps 3–8 of publish(); `fetched` is the status right after a successful fetch. */
  private async commitAndPush(
    files: FileMap,
    message: string,
    fetched: SyncStatus,
    extraPaths: readonly string[],
  ): Promise<PublishResult> {
    const remote = fetched.remoteSha;
    let tip = fetched.headSha;
    let commitSha: string | null = null;
    const failure = async (error: unknown): Promise<PublishResult> => {
      if (!(error instanceof GitError)) throw error;
      return { ok: false, reason: 'error', error: error.toSyncError(), status: await this.statusNow() };
    };

    try {
      await this.writeWorkingFiles(files);
      if (remote !== null && tip !== remote) {
        await this.moveBranchTo(remote);
        tip = remote;
      }
      await this.stageDataFiles(extraPaths);
      const staged = await this.run(['diff', '--cached', '--quiet'], { okExitCodes: [1] });
      if (staged.code === 1) {
        // The message goes through stdin: no length limit and no argument-encoding surprises with Hebrew.
        await this.run(['commit', '--quiet', '--file=-'], { input: message });
        commitSha = await this.revParse('HEAD');
      }
    } catch (error) {
      return failure(error);
    }

    const newTip = commitSha ?? tip;
    if (newTip === null || newTip === remote) {
      return { ok: true, status: await this.statusNow(), commitSha: null };
    }

    const pushArgs = ['push', '--porcelain', 'origin', `HEAD:refs/heads/${this.branch}`];
    let pushed: GitResult;
    try {
      // Exit code 1 = "some refs were not updated": the porcelain lines on stdout say why.
      pushed = await this.run(pushArgs, { timeoutMs: NETWORK_TIMEOUT_MS, interactive: true, okExitCodes: [1] });
    } catch (error) {
      if (commitSha !== null) await this.undoCommit(tip);
      return failure(error);
    }
    if (pushed.code !== 0) {
      if (commitSha !== null) await this.undoCommit(tip);
      // Why it was refused is decided by looking, not by parsing git's wording: when the
      // team's tip is no longer the one this commit was built on, a teammate got there first
      // ("fetch first", or "failed to update ref" when it happened during the push itself).
      const after = await this.fetchNow(true);
      if (after.remoteSha !== remote) return { ok: false, reason: 'remote-changed', status: after };
      const error = classifyGitFailure({
        args: pushArgs,
        stdout: pushed.stdout,
        stderr: pushed.stderr,
        exitCode: pushed.code,
        timedOut: false,
      });
      return { ok: false, reason: 'error', error, status: after };
    }
    this.lastFetchAt = Date.now();
    return { ok: true, status: await this.statusNow(), commitSha };
  }
}
