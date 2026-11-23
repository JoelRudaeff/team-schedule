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
 * ── File contents ──────────────────────────────────────────────────────────────────────
 * A data file travels to the renderer as text. A file that is not UTF-8 (saved by another
 * program as UTF-16 or in a Windows code page) cannot be turned into text without losing
 * bytes, so it travels as its exact bytes behind RAW_BYTES_PREFIX instead (see fileTextOf).
 * Whatever is read here and written back unchanged is therefore byte for byte the same file.
 *
 * ── Concurrency ────────────────────────────────────────────────────────────────────────
 * Two promise queues. Everything that touches the working folder or the index runs through
 * the LOCAL queue, one job at a time. Everything that talks to the server (fetch, push)
 * additionally runs through the NETWORK queue, so two network commands never overlap.
 * A background fetch occupies only the network queue while it waits for the server:
 * writing edits to the working folder never has to wait for a server that does not answer.
 * (`git fetch` changes neither the working folder nor the index.) A job that needs both
 * queues always takes the network queue first.
 *
 * ── Local repository configuration (set by connect) ────────────────────────────────────
 *   user.name / user.email   the identity given by the user
 *   core.autocrlf=false, core.eol=lf, core.safecrlf=false   files are written with "\n"
 *   core.longpaths=true
 * Commit signing and hooks are left as the user configured them.
 *
 * ── Time limits ────────────────────────────────────────────────────────────────────────
 * clone 300 s; fetch / push started by the user 180 s (Git's sign-in window may be open);
 * the quiet background fetch 45 s; everything local 30 s.
 * A check for updates that is still waiting when the app is closed is not sat out: it is
 * ended on the spot (stopFetch). A save that is under way always runs to its own end.
 */
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
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
import { deepEqual } from '@shared/model';
import { isDataPath, weekPath } from '@shared/paths';
import { RAW_BYTES_PREFIX, parseWeek } from '@shared/serialize';
import { CONFIG_PATH, WEEKS_DIR, type FileMap, type IsoDate, type ScheduleEvent, type WeekData } from '@shared/types';
import { GitError, classifyGitFailure, type GitRunOptions, type GitResult, type GitRunner } from './gitRunner';

const CLONE_TIMEOUT_MS = 300_000;
/** Started by the user: Git's sign-in window may be open and somebody is typing into it. */
const INTERACTIVE_NETWORK_TIMEOUT_MS = 180_000;
/** The quiet check in the background: a server that does not answer must not be waited for long. */
const BACKGROUND_NETWORK_TIMEOUT_MS = 45_000;
const MAX_INCOMING = 50;
/** How far back "who last edited this event" looks: the newest commits that touched the week's file. */
const MAX_BLAME_COMMITS = 400;
/** The commit of the team's branch that this computer last agreed with (see statusNow). */
const SYNCED_REF = 'refs/team-schedule/synced';
/** The moment a lock file is given before it is taken for one a dead git left behind: a git that is really at work is done sooner. */
const STALE_LOCK_MS = 2_000;
/**
 * What git says when a lock file is in its way. The group is the lock file as a path inside
 * the repository's `.git` folder (`index.lock`, `refs/remotes/origin/main.lock`, …).
 */
const LOCK_REFUSAL = /Unable to create '.*[\\/]\.git[\\/]([^\r\n]+?\.lock)': File exists/g;
/** The same for the lock on the clone's configuration file, which git words differently. */
const CONFIG_LOCK_REFUSAL = /could not lock config file (?:[^\r\n]*[\\/])?\.git[\\/]config: File exists/;
const GITATTRIBUTES_PATH = '.gitattributes';
const GITATTRIBUTES_CONTENT = '*.json text eol=lf\n';

const NUL = String.fromCharCode(0);
/** Separators of the `git log` format below (ASCII "unit" and "record" separators). */
const FIELD_END = String.fromCharCode(0x1f);
const RECORD_END = String.fromCharCode(0x1e);
const LOG_FORMAT = '%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%P%x1e';

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
  /**
   * The user confirmed that `branch` is to be created although the repository has other
   * branches and not this one. Without it such a name is refused: it is far more often a
   * typing mistake than a wish, and it would quietly split this user off from the team.
   */
  createBranch?: boolean;
}

export interface ConnectOutcome {
  service: RepoService;
  /** True when the remote has no commits at all. */
  remoteEmpty: boolean;
  /** True when schedule.json exists (working folder or local branch tip) after connecting. */
  hasSchedule: boolean;
}

// ───────────────────────────── file contents ─────────────────────────────

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function asRawBytes(bytes: Uint8Array): string {
  return `${RAW_BYTES_PREFIX}${Buffer.from(bytes).toString('base64')}`;
}

/**
 * A file's content as the renderer gets it: its text when the bytes are UTF-8 (a byte order
 * mark stays part of the text), otherwise the exact bytes behind RAW_BYTES_PREFIX. Never
 * lossy: fileBytesOf() of the result gives back the very same bytes.
 */
export function fileTextOf(bytes: Uint8Array): string {
  try {
    const text = strictUtf8.decode(bytes);
    // A text that happens to begin like the marker goes the byte way too, so the two functions always undo each other.
    return text.startsWith(RAW_BYTES_PREFIX) ? asRawBytes(bytes) : text;
  } catch {
    return asRawBytes(bytes);
  }
}

/** The bytes to put on disk for a file content (the inverse of fileTextOf). */
export function fileBytesOf(text: string): Buffer {
  return text.startsWith(RAW_BYTES_PREFIX)
    ? Buffer.from(text.slice(RAW_BYTES_PREFIX.length), 'base64')
    : Buffer.from(text, 'utf8');
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

/** The file's content exactly as it is on disk (see fileTextOf); null when there is no such file. */
async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return fileTextOf(await readFile(path));
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
    await writeFile(temp, fileBytesOf(text), { flush: true });
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

/** Failures that say "git could not work here", as opposed to "this is not a repository". */
const BLOCKING_CODES: ReadonlySet<SyncError['code']> = new Set(['dubious-ownership', 'timeout', 'git-missing']);

/**
 * The `origin` address of the clone in `dir`; null when `dir` is not itself a git working
 * folder. A folder that IS a clone but that git refuses to work in (it belongs to another
 * Windows user: copied from another computer, restored from a backup) is not "no
 * repository": that failure is thrown, with the folder to trust, so the unpublished work
 * in it is never moved aside as if it were some stranger's folder.
 */
async function originOf(git: GitRunner, dir: string): Promise<string | null> {
  // Without its own .git the folder could sit inside some other repository, whose settings git would then report.
  if (!(await pathExists(join(dir, '.git')))) return null;
  try {
    const result = await git.run(['config', '--local', '--get', 'remote.origin.url'], { cwd: dir, okExitCodes: [1] });
    const url = result.stdout.trim();
    return result.code === 0 && url !== '' ? url : null;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (BLOCKING_CODES.has(error.code)) throw error;
    // `git config` only says "not inside a repository". Asking for the repository itself tells why.
    try {
      await git.run(['rev-parse', '--git-dir'], { cwd: dir });
    } catch (reason) {
      if (!(reason instanceof GitError)) throw reason;
      if (BLOCKING_CODES.has(reason.code)) throw reason;
    }
    return null;
  }
}

/** Every `*.lock` file below `folder`. Under `.git/refs` these are git's own: no branch name may end like that. */
async function lockFilesBelow(folder: string): Promise<string[]> {
  const found: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await lockFilesBelow(path)));
    else if (entry.name.endsWith('.lock')) found.push(path);
  }
  return found;
}

/** The lock files `failure` (the text of a refused git command) complains about, inside the clone's own `.git` folder. */
function locksNamedIn(dir: string, failure: string): string[] {
  const locks: string[] = [];
  for (const match of failure.matchAll(LOCK_REFUSAL)) {
    const parts = match[1].split(/[\\/]/);
    // The path is read from git's message: only a plain path inside .git is taken from it.
    if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes(':'))) continue;
    locks.push(join(dir, '.git', ...parts));
  }
  if (CONFIG_LOCK_REFUSAL.test(failure)) locks.push(join(dir, '.git', 'config.lock'));
  return locks;
}

/** The locks on the index and on HEAD: what a git leaves that dies while it moves the working copy (commit, reset, checkout). */
function workLocks(dir: string): string[] {
  return [join(dir, '.git', 'index.lock'), join(dir, '.git', 'HEAD.lock')];
}

/** What a git leaves that dies while it writes branches: one lock per branch, and the one of packed-refs. */
async function branchLocks(dir: string): Promise<string[]> {
  return [join(dir, '.git', 'packed-refs.lock'), ...(await lockFilesBelow(join(dir, '.git', 'refs')))];
}

/**
 * The lock files that the git which left `lock` can have left together with it. A git that
 * dies while it moves the working copy leaves the index, HEAD and the branch locked at once;
 * one that dies while it brings in the team's branches leaves one lock per branch — and the
 * next git names only the first lock it runs into.
 * Locks that such a git cannot have left are not looked at: they may belong to somebody who
 * is working in the folder with git by hand (an editor opened by `git commit` keeps the
 * index locked for as long as it is open).
 */
async function locksLeftWith(dir: string, lock: string): Promise<string[]> {
  if (workLocks(dir).includes(lock)) return [...workLocks(dir), ...(await branchLocks(dir))];
  if (lock === join(dir, '.git', 'packed-refs.lock') || lock.startsWith(join(dir, '.git', 'refs') + sep)) return branchLocks(dir);
  return [];
}

/** Commands that write to the working copy or move HEAD; ended by force they can leave the index, HEAD and a branch locked. */
const WORKING_COPY_COMMANDS: ReadonlySet<string> = new Set(['add', 'checkout', 'commit', 'read-tree', 'reset', 'symbolic-ref', 'update-ref']);

/**
 * The lock files a git that ran `args` (the subcommand comes first) can have left when it was
 * ended by force. A command that only reads leaves none, and for one this list does not know
 * nothing is assumed: its locks are dealt with when the next command meets them.
 */
async function locksLeftBy(dir: string, args: readonly string[]): Promise<string[]> {
  const command = args[0] ?? '';
  // Talking to the server writes nothing but branches.
  if (command === 'fetch' || command === 'push') return branchLocks(dir);
  if (command === 'config') return [join(dir, '.git', 'config.lock')];
  if (WORKING_COPY_COMMANDS.has(command)) return [...workLocks(dir), ...(await branchLocks(dir))];
  return [];
}

/** When the file was last written; null when it is not there. */
async function writtenAt(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Removes those of `locks` that a dead git left behind.
 *
 * This app runs its own git work strictly one after another, and a git that is really
 * working holds a lock for a moment only. So every lock that is there gets that moment
 * (STALE_LOCK_MS, counted from when it was written — and never more than that, whatever its
 * time says: the clock may have been set back since). A lock that is then still the very
 * same file, untouched, belongs to a git that died — a crash, a power cut, a process that
 * was ended on its time limit or because the app was closed — and is removed. A lock that
 * is gone by then, or was written anew, is somebody's git at work and is left alone.
 * Removing is best effort: where a file cannot be removed, git simply says so again.
 *
 * `pause` is the wait (tests pass their own, to decide what happens during it).
 */
export async function removeStaleLocks(locks: readonly string[], pause: (ms: number) => Promise<unknown> = sleep): Promise<void> {
  const seen = new Map<string, number>();
  for (const path of new Set(locks)) {
    const written = await writtenAt(path);
    if (written !== null) seen.set(path, written);
  }
  if (seen.size === 0) return;
  const youngest = Date.now() - Math.max(...seen.values());
  const wait = Math.min(STALE_LOCK_MS, STALE_LOCK_MS - youngest);
  if (wait > 0) await pause(wait);
  for (const [path, written] of seen) {
    if ((await writtenAt(path)) === written) await rm(path, { force: true }).catch(() => undefined);
  }
}

/**
 * `git <args>` in the clone `dir`, with the two repairs that keep a lock file from making
 * the clone unusable until somebody deletes a file deep inside the application data by hand:
 *
 *  - A command that is refused because of a lock file is run once more after that lock, and
 *    the ones a dead git can have left with it, were removed (locksLeftWith, removeStaleLocks).
 *  - A command that was ended by force (its time limit, or the app closing) may have been in
 *    the middle of writing: the locks it can have left are cleared on the spot (locksLeftBy).
 *    Otherwise the next check for updates could spend its whole time limit on them — git
 *    waits a little at each one — without ever getting far enough to say what is wrong.
 *
 * Only locks that are in the way, or that this very command can have left, are looked at;
 * and nothing outside the clone's own `.git` folder is ever touched.
 */
async function runInClone(git: GitRunner, dir: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
  try {
    return await git.run(args, { ...options, cwd: dir });
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (error.code === 'timeout') {
      await removeStaleLocks(await locksLeftBy(dir, args));
      throw error;
    }
    const named = locksNamedIn(dir, error.detail);
    if (named.length === 0) throw error;
    const leftWith = await Promise.all(named.map((lock) => locksLeftWith(dir, lock)));
    await removeStaleLocks([...named, ...leftWith.flat()]);
    return git.run(args, { ...options, cwd: dir });
  }
}

function unexpectedOutput(what: string, text: string): Error {
  return new Error(`Unexpected output of ${what}: ${text.slice(0, 200)}`);
}

/** A commit as `git log` reports it, with the commits it was made on top of. */
interface LoggedCommit {
  info: CommitInfo;
  parents: string[];
}

function parseLog(output: string): LoggedCommit[] {
  const commits: LoggedCommit[] = [];
  for (const record of output.split(RECORD_END)) {
    const [sha, authorName, authorEmail, seconds, subject, parents] = record.replace(/^\s+/, '').split(FIELD_END);
    if (!sha || seconds === undefined) continue;
    commits.push({
      info: { sha, authorName, authorEmail, time: Number(seconds) * 1000, subject: subject ?? '' },
      parents: (parents ?? '').split(' ').filter((parent) => parent !== ''),
    });
  }
  return commits;
}

function blameInfoOf(commit: CommitInfo): BlameInfo {
  return {
    sha: commit.sha,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    time: commit.time,
    summary: commit.subject,
  };
}

/** A week file's content as a week; null when there is no file or it cannot be read. */
function readableWeek(text: string | null, weekStart: IsoDate): WeekData | null {
  if (text === null) return null;
  try {
    return parseWeek(text, weekStart);
  } catch {
    return null;
  }
}

// ───────────────────────────── the service ─────────────────────────────

export class RepoService {
  readonly dir: string;
  readonly url: string;
  readonly branch: string;

  private readonly git: GitRunner;
  /** Settles when the last queued local job has finished; never rejects. */
  private tail: Promise<void> = Promise.resolve();
  /** The same for jobs that talk to the server. */
  private networkTail: Promise<void> = Promise.resolve();
  private lastFetchAt: number | null = null;
  private fetchError: SyncError | null = null;
  /** Ends the check for updates that is waiting for the server, if one is (see stopFetch). */
  private fetchStopper: AbortController | null = null;
  /** Set by stopFetch(): from then on no further check for updates asks the server. */
  private closing = false;

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
   *    When `dir` is a clone that git refuses to work in (another Windows user owns it):
   *    throw that GitError (dubious-ownership, with the folder to trust) and move nothing.
   * 2. Otherwise `git clone --origin origin -- <url> <dir>` (creating parent folders).
   * 3. Apply the local configuration listed in the file comment.
   * 4. Decide the branch: `params.branch` when given; else the branch the clone's HEAD
   *    names (the server's default — also for an empty remote) when the remote has it or is
   *    empty; else the server default, `main`, `master` or the first remote branch that exists.
   *    - given branch exists on the remote (`refs/remotes/origin/<b>`): check it out
   *      (`git checkout -B <b> origin/<b>`) unless it is already current.
   *    - given branch does not exist on the remote, which has other branches: throw GitError
   *      `branch-missing` (the detail lists the branches that exist) unless
   *      `params.createBranch` is set. A mistyped name must not fork the schedule.
   *    - with `createBranch`, or for a remote without any branch: create it from the
   *      current commit (`git checkout -B <b>`), or for an empty repository point HEAD at
   *      it (`git symbolic-ref HEAD refs/heads/<b>`).
   * 5. When the remote branch has schedule.json but neither the working folder nor the
   *    local tip has it, and the working folder holds no data files: fast-forward the
   *    local branch to the remote tip (`git reset --hard origin/<b>`).
   *
   * Throws GitError (auth, offline, not-found, dubious-ownership, timeout, branch-missing, …)
   * when the repository cannot be used; a freshly created `dir` is removed again when the
   * clone itself failed.
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
      await runInClone(git, dir, ['fetch', '--prune', 'origin'], { timeoutMs: INTERACTIVE_NETWORK_TIMEOUT_MS, interactive: true });
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

    const local = (args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> => runInClone(git, dir, args, options);
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
    // Asked of the list, not of git: on a Windows disk `rev-parse` also finds "master" when
    // "Master" is asked for, and the save would then create a second branch on the server.
    const remoteSha = remoteBranches.includes(branch) ? await revParse(remoteRef) : null;
    if (remoteSha === null && !remoteEmpty && params.createBranch !== true) {
      // The repository has branches, and this is not one of them: nearly always a slip of the
      // keyboard ("mian"). Creating it would show the whole schedule as "my changes", and the
      // first Save would start a second schedule that the team never sees.
      throw new GitError(
        {
          code: 'branch-missing',
          message: `The branch "${branch}" does not exist in this repository`,
          detail: `Branches in this repository: ${[...remoteBranches].sort().join(', ')}`,
          branches: [...remoteBranches].sort(),
        },
        null,
      );
    }
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
   * git repository or its `origin` URL differs from `url`. Throws GitError when git refuses
   * to work in the folder (dubious-ownership, …).
   */
  static async open(git: GitRunner, dir: string, url: string, branch: string): Promise<RepoService | null> {
    const origin = await originOf(git, dir);
    if (origin === null || !sameAddress(origin, url)) return null;
    return new RepoService(git, dir, url, branch);
  }

  // ───────────────────────────── public API (queued) ─────────────────────────────

  /** Resolves once nothing of this service is running or queued any more (never rejects). */
  async idle(): Promise<void> {
    let network: Promise<void>;
    let local: Promise<void>;
    do {
      network = this.networkTail;
      local = this.tail;
      await network;
      await local;
    } while (network !== this.networkTail || local !== this.tail);
  }

  /**
   * For the moment the app is closed: ends a check for updates — fetch() — that is still
   * waiting for the server, and lets no further one ask the server. Such a check then ends
   * like one that ran into its time limit (`fetchError` with code `timeout`). Without this, a
   * server that does not answer would keep the closed app alive — and impossible to open
   * again — until git gave up by itself.
   *
   * Only the check is ended. A save (publish, createSchedule) that is under way is not
   * touched: the user asked for it and confirmed it, so it runs to its own end.
   *
   * Ending git by force is never free: a git that is stopped in the very moment it writes a
   * branch leaves its lock file behind. So this is for a check that WAITS (the caller gives a
   * check that is simply at work a moment to finish, see AppController.shutdown), and a
   * lock that is left behind all the same is cleared at once, or by the next command (runInClone).
   */
  stopFetch(): void {
    this.closing = true;
    this.fetchStopper?.abort();
  }

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
   *   baseSha   = the last version both sides shared:
   *                 - HEAD itself while HEAD is a commit the team has (or had) as its tip,
   *                   see below;
   *                 - else `git merge-base HEAD origin/<branch>`;
   *                 - null when the remote branch is missing (nothing is shared yet, so
   *                   everything local counts as unpublished), when HEAD is unborn, or
   *                   without a common commit
   *   ahead / behind = `git rev-list --count` of origin/<b>..HEAD and HEAD..origin/<b>
   *                    (when HEAD is unborn: ahead 0, behind = number of remote commits;
   *                    when there is no remote branch: ahead = number of local commits)
   *   incoming  = `git log` of HEAD..origin/<b> (all remote commits when HEAD is unborn),
   *               newest first, max 50
   *   lastFetchAt / fetchError = remembered from the last fetch() of this instance
   *
   * "A commit the team had as its tip": every time HEAD and origin/<branch> are the same
   * commit, that commit is remembered in `refs/team-schedule/synced`. While HEAD still is
   * that commit, nothing local is an unpublished commit — so wherever the team's branch
   * has gone since is an update: forward (the normal case), but also BACK, after someone
   * undid a save on the server. Then ahead = 0, behind >= 1 and baseSha = HEAD: the undone
   * save is the team's change to follow, not this user's work to publish again.
   */
  status(): Promise<SyncStatus> {
    return this.enqueue(() => this.statusNow());
  }

  /**
   * `git fetch --prune origin`, then status(). Network / sign-in failures do not throw:
   * they are returned in `status.fetchError` (and remembered until the next fetch).
   * `interactive=false` must never open a sign-in window. While the server is waited for,
   * the working folder stays free (see the file comment).
   */
  fetch(interactive: boolean): Promise<SyncStatus> {
    return this.enqueueNetwork(async () => {
      await this.fetchRemote(interactive, true);
      return this.enqueue(() => this.statusNow());
    });
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
   *  5. Stage the data files that differ from that tip — and nothing else. Nothing staged
   *     and nothing unpushed → { ok:true, commitSha:null }.
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
    return this.enqueueNetwork(() =>
      this.enqueue(async (): Promise<PublishResult> => {
        const fetched = await this.fetchNow(true);
        if (fetched.fetchError) return { ok: false, reason: 'error', error: fetched.fetchError, status: fetched };
        if (fetched.remoteSha !== expectedRemoteSha) return { ok: false, reason: 'remote-changed', status: fetched };
        return this.commitAndPush(files, message, fetched, []);
      }),
    );
  }

  /**
   * First schedule in a repository that has none. Like publish(), except:
   *  - after the fetch: when the remote branch already has schedule.json → remote-changed;
   *    expectedRemoteSha is simply the current remote tip;
   *  - data files that already exist at the remote tip or in the working folder are kept
   *    (`files` is laid over them), so stray week files are never deleted;
   *  - also commits `.gitattributes` containing "*.json text eol=lf\n" when the team's
   *    branch has no .gitattributes yet (the file is written when it is not there; one that
   *    an earlier, refused attempt of this step left behind is taken as it is);
   *  - when the repository has no commits, HEAD is first pointed at the branch.
   */
  createSchedule(files: FileMap, message: string): Promise<PublishResult> {
    return this.enqueueNetwork(() =>
      this.enqueue(async (): Promise<PublishResult> => {
        const fetched = await this.fetchNow(true);
        if (fetched.fetchError) return { ok: false, reason: 'error', error: fetched.fetchError, status: fetched };
        const remote = fetched.remoteSha;
        if (remote !== null && (await this.existsAt(remote, CONFIG_PATH))) {
          return { ok: false, reason: 'remote-changed', status: fetched };
        }
        const extra: string[] = [];
        const attributesInTeam = remote !== null && (await this.existsAt(remote, GITATTRIBUTES_PATH));
        if (!attributesInTeam) {
          const attributesPath = join(this.dir, GITATTRIBUTES_PATH);
          const onDisk = await readTextIfExists(attributesPath);
          if (onDisk === null) await writeTextAtomic(attributesPath, GITATTRIBUTES_CONTENT);
          // Whether it is committed is decided by what the team has, not by what lies on disk:
          // after a refused first attempt the file is there, but still in no commit.
          if (onDisk === null || onDisk === GITATTRIBUTES_CONTENT) extra.push(GITATTRIBUTES_PATH);
        }
        if (fetched.headSha === null) await this.run(['symbolic-ref', 'HEAD', `refs/heads/${this.branch}`]);
        // "No schedule.json" does not mean "no data": week files that the team or this computer
        // already has (someone removed schedule.json by hand) must survive the new start.
        const existing: FileMap = {
          ...(remote === null ? {} : await this.readFilesAt(remote)),
          ...(await this.readWorkingFiles()),
        };
        return this.commitAndPush({ ...existing, ...files }, message, fetched, extra);
      }),
    );
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
   * Who last edited each event of the week's file at HEAD, and when ("git blame" by content).
   *
   * The commits that touched `weeks/<weekStart>.json` are read newest first (at most 400),
   * and an event belongs to the newest commit that has it as it is now while none of that
   * commit's parents had it so — the content, not the text line; each commit is compared with
   * its own parents, so a merge of two branches does not take credit for what they brought. `git blame` itself goes by lines, and in a JSON
   * list the last line has no comma: adding an event behind it rewrites that line, and blame
   * then names the person who merely added a neighbour. Comparing the events themselves is
   * also indifferent to how the file is laid out.
   * `title` is the commit that last changed the week's title. A missing file or an unborn
   * HEAD gives an empty result (not an error). An event that is older than the commits
   * looked at is left out rather than attributed to the wrong person.
   */
  blame(weekStart: IsoDate): Promise<WeekBlame> {
    return this.enqueue(async (): Promise<WeekBlame> => {
      const headSha = await this.revParse('HEAD');
      // Event ids come from files people can edit: no prototype, so no id can hit an inherited member.
      const events: WeekBlame['events'] = Object.create(null);
      const result: WeekBlame = { weekStart, headSha, events, title: null };
      const path = weekPath(weekStart);
      if (headSha === null || !isDataPath(path) || !(await this.existsAt(headSha, path))) return result;

      const commits = await this.logWithParents(headSha, { max: MAX_BLAME_COMMITS, path });
      // The file as it is at HEAD, in every commit that changed it, and in each of their parents.
      const shas = [...new Set([headSha, ...commits.flatMap((commit) => [commit.info.sha, ...commit.parents])])];
      const texts = await this.readVersions(shas, path);
      const weeks = new Map(shas.map((sha, index) => [sha, readableWeek(texts[index], weekStart)]));
      const current = weeks.get(headSha) ?? null;
      if (current === null) return result;

      const byId = new Map<string, Map<string, ScheduleEvent>>();
      const eventIn = (sha: string, id: string): ScheduleEvent | undefined => {
        let index = byId.get(sha);
        if (!index) {
          index = new Map((weeks.get(sha)?.events ?? []).map((event) => [event.id, event]));
          byId.set(sha, index);
        }
        return index.get(id);
      };
      // The newest commit that has the event as it is now while none of its parents had it so:
      // that commit made it what it is. A merge of two branches therefore names nobody new for
      // what one of the branches brought along, and a change that was made and taken back
      // belongs to whoever took it back.
      for (const event of current.events) {
        const author = commits.find(
          (commit) =>
            deepEqual(eventIn(commit.info.sha, event.id), event) &&
            commit.parents.every((parent) => !deepEqual(eventIn(parent, event.id), event)),
        );
        if (author) events[event.id] = blameInfoOf(author.info);
      }
      const titleAuthor = commits.find(
        (commit) =>
          weeks.get(commit.info.sha)?.title === current.title &&
          commit.parents.every((parent) => weeks.get(parent)?.title !== current.title),
      );
      if (titleAuthor) result.title = blameInfoOf(titleAuthor.info);
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

  /** The same for work that talks to the server. A job that also needs the local queue enters it from inside. */
  private enqueueNetwork<T>(job: () => Promise<T>): Promise<T> {
    const result = this.networkTail.then(job);
    this.networkTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Every git command of the service; a lock file that a dead git left behind does not stop it (see runInClone). */
  private run(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    return runInClone(this.git, this.dir, args, options);
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

  /** Commits of `range`, newest first. */
  private async log(range: string): Promise<CommitInfo[]> {
    return (await this.logWithParents(range, { max: MAX_INCOMING })).map((commit) => commit.info);
  }

  /** The same with each commit's parents; with `path` only the commits that changed that file. */
  private async logWithParents(range: string, options: { max: number; path?: string }): Promise<LoggedCommit[]> {
    const args = ['log', `--max-count=${options.max}`, `--format=${LOG_FORMAT}`, range];
    if (options.path !== undefined) args.push('--', options.path);
    return parseLog((await this.run(args)).stdout);
  }

  private async statusNow(): Promise<SyncStatus> {
    const headSha = await this.revParse('HEAD');
    const remoteSha = await this.revParse(this.remoteRef);
    let baseSha: string | null = null;
    let ahead = 0;
    let behind = 0;
    let incoming: CommitInfo[] = [];

    if (headSha !== null && remoteSha !== null) {
      const synced = await this.revParse(SYNCED_REF);
      if (headSha === remoteSha) {
        baseSha = headSha;
        // Remembered: this commit is the team's, whatever happens to the branch on the server later.
        if (synced !== headSha) await this.run(['update-ref', SYNCED_REF, headSha]);
      } else if (synced === headSha) {
        // HEAD is exactly what the team had when this computer last agreed with it, so there
        // is no unpublished commit here. The team's branch has gone elsewhere since — forward,
        // or back because someone undid a save on the server. Either way that is an update.
        baseSha = headSha;
        behind = Math.max(1, await this.count(`${headSha}..${remoteSha}`));
        incoming = await this.log(`${headSha}..${remoteSha}`);
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

  /**
   * `git fetch --prune origin`; a failure is remembered in `fetchError`, never thrown.
   * `stoppable`: this is a check for updates, which stopFetch() may end (the fetch that is
   * the first step of a save is not).
   */
  private async fetchRemote(interactive: boolean, stoppable = false): Promise<void> {
    if (stoppable && this.closing) {
      // The app is closing and nobody is left to hear the answer: the server is not even asked.
      this.fetchError = classifyGitFailure({ args: ['fetch'], stdout: '', stderr: '', exitCode: null, timedOut: true });
      return;
    }
    const stopper = stoppable ? new AbortController() : null;
    this.fetchStopper = stopper;
    try {
      await this.run(['fetch', '--prune', 'origin'], {
        timeoutMs: interactive ? INTERACTIVE_NETWORK_TIMEOUT_MS : BACKGROUND_NETWORK_TIMEOUT_MS,
        interactive,
        signal: stopper?.signal,
      });
      this.lastFetchAt = Date.now();
      this.fetchError = null;
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      this.fetchError = error.toSyncError();
    } finally {
      if (this.fetchStopper === stopper) this.fetchStopper = null;
    }
  }

  private async fetchNow(interactive: boolean): Promise<SyncStatus> {
    await this.fetchRemote(interactive);
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

  /**
   * What `git cat-file --batch` answers for each of `specs` (object names such as
   * `<sha>` or `<commit>:<path>`), in the same order: the bytes of a file, or null when
   * there is no such object or it is not a file.
   */
  private async readObjects(specs: readonly string[]): Promise<(Buffer | null)[]> {
    if (specs.length === 0) return [];
    const batch = await this.run(['cat-file', '--batch'], { input: `${specs.join('\n')}\n` });
    const bytes = batch.stdoutBuffer;
    const contents: (Buffer | null)[] = [];
    let offset = 0;
    for (let index = 0; index < specs.length; index++) {
      // "<object> <type> <size>\n<content>\n", or "<spec> missing\n"
      const headerEnd = bytes.indexOf(0x0a, offset);
      if (headerEnd < 0) throw unexpectedOutput('git cat-file', bytes.subarray(offset).toString('utf8'));
      const header = bytes.subarray(offset, headerEnd).toString('utf8');
      const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!match) {
        if (!/ (missing|ambiguous)$/.test(header)) throw unexpectedOutput('git cat-file', header);
        contents.push(null);
        offset = headerEnd + 1;
        continue;
      }
      const start = headerEnd + 1;
      const end = start + Number(match[2]);
      contents.push(match[1] === 'blob' ? bytes.subarray(start, end) : null);
      offset = end + 1;
    }
    return contents;
  }

  /** All data files in the tree of `commit`, read with two git processes however many files there are. */
  private async readFilesAt(commit: string): Promise<FileMap> {
    const listing = await this.run(['ls-tree', '-r', '-z', commit, '--', CONFIG_PATH, WEEKS_DIR]);
    const blobs: { object: string; path: string }[] = [];
    for (const entry of listing.stdout.split(NUL)) {
      // "<mode> <type> <object>\t<path>"
      const match = /^\d+ (\w+) ([0-9a-f]+)\s([\s\S]+)$/.exec(entry);
      if (match && match[1] === 'blob' && isDataPath(match[3])) blobs.push({ object: match[2], path: match[3] });
    }
    const files: FileMap = {};
    const contents = await this.readObjects(blobs.map((blob) => blob.object));
    blobs.forEach((blob, index) => {
      const content = contents[index];
      if (content === null) throw unexpectedOutput('git cat-file', `${blob.object} is not a file`);
      files[blob.path] = fileTextOf(content);
    });
    return files;
  }

  /** The content of `path` in each of the commits, in the same order; null where the commit has no such file. */
  private async readVersions(commits: readonly string[], path: string): Promise<(string | null)[]> {
    const contents = await this.readObjects(commits.map((sha) => `${sha}:${path}`));
    return contents.map((content) => (content === null ? null : fileTextOf(content)));
  }

  /** The data files in the working folder, with their content exactly as it is on disk. */
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

  /**
   * Stages additions, changes and deletions of data files (plus `extra` paths) — and nothing
   * else, also nothing that an earlier, failed attempt had staged.
   * Only files whose content really differs from the local tip are handed to git: a
   * file nobody touched must not become part of somebody's save merely because git would
   * store it differently today (another line-end rule, for instance).
   */
  private async stageDataFiles(extra: readonly string[]): Promise<void> {
    const headSha = await this.revParse('HEAD');
    // First the index is brought back to the tip. A save whose commit failed after `git add`
    // (a hook that refused, a signing prompt that was cancelled) leaves its files staged; left
    // there, they would go out with the NEXT save although the user has discarded them since,
    // or make that save fail on a file that is in neither place any more.
    if (headSha !== null) await this.run(['reset', '--mixed', '--quiet', headSha]);
    else await this.run(['read-tree', '--empty']);
    const committed = headSha === null ? {} : await this.readFilesAt(headSha);
    const working = await this.readWorkingFiles();
    const changed = [...new Set([...Object.keys(committed), ...Object.keys(working)])].filter(
      (path) => committed[path] !== working[path],
    );
    const paths = [...new Set([...changed, ...extra])];
    if (paths.length === 0) return;
    await this.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${paths.join(NUL)}${NUL}` });
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
      pushed = await this.run(pushArgs, { timeoutMs: INTERACTIVE_NETWORK_TIMEOUT_MS, interactive: true, okExitCodes: [1] });
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
    // git notes down what it has pushed in its own copy of the team's branch. Where it could
    // not write that (a lock file a dead git left behind), it only warns — and the save would
    // be counted as unpublished although the team has it.
    if ((await this.revParse(this.remoteRef)) !== newTip) {
      try {
        await this.run(['update-ref', this.remoteRef, newTip]);
      } catch (error) {
        // The save itself went out; the next check for updates puts the count right.
        if (!(error instanceof GitError)) throw error;
      }
    }
    this.lastFetchAt = Date.now();
    return { ok: true, status: await this.statusNow(), commitSha };
  }
}
