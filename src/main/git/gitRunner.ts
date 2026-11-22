/**
 * Runs the user's installed git.exe as a child process.
 *
 * CONTRACT FILE — exported names and signatures are fixed; the bodies are implemented by
 * the "git service" build task.
 *
 * Rules for the implementation:
 *  - Always `child_process.spawn(gitPath, args, { shell: false, windowsHide: true })` — never
 *    a shell, never string concatenation of commands. stdin is 'ignore' unless `input` is
 *    given (then it is written and closed).
 *  - Every call is prefixed with `-c core.quotepath=false -c protocol.ext.allow=never`.
 *  - Environment = process.env plus: GIT_TERMINAL_PROMPT=0 (never wait for console input),
 *    LC_ALL=C and LANG=C (stable English messages for error classification),
 *    GIT_OPTIONAL_LOCKS=0, and GCM_INTERACTIVE=never when `interactive` is false
 *    (background checks must not pop up a sign-in window; interactive calls leave
 *    GCM_INTERACTIVE untouched so Git Credential Manager can ask).
 *  - stdout and stderr are collected as Buffers and decoded as UTF-8.
 *  - `timeoutMs` (default 30 000): on expiry the process tree is killed and the call fails
 *    with code `timeout`. The same happens when `signal` is aborted.
 *  - Exit code 0 (or one listed in `okExitCodes`) resolves; anything else rejects with a
 *    GitError built by classifyGitFailure().
 *
 * Made precise by the implementation:
 *  - Two groups of variables are taken OUT of the inherited environment, because they would
 *    silently break what the caller asked for: the ones that point git at another repository
 *    (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, … — set whenever the app or its tests are
 *    started from inside a git hook) and the ones that replace the commit identity
 *    (GIT_AUTHOR_*, GIT_COMMITTER_*), which must come from the repository's own config.
 *  - When `interactive` is false, GIT_ASKPASS is emptied and SSH_ASKPASS_REQUIRE=never is
 *    set as well: an "askpass" program is the second way (besides Git Credential Manager)
 *    in which git or ssh can open a password window.
 *  - A call that cannot even start git rejects with code `git-missing` — or with `unknown`
 *    when the reason is that `cwd` does not exist (Windows reports both the same way).
 *  - A timed-out call rejects once the killed processes are gone, so the next command never
 *    races a dying one for the repository's lock files.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { GitInfo, SyncError, SyncErrorCode } from '@shared/api';
import { maskRepoUrl } from '@shared/repoUrl';

export interface GitRunOptions {
  /** Working directory (the repository folder). */
  cwd?: string;
  /** Default 30 000. Network operations pass larger values. */
  timeoutMs?: number;
  /** May git show a sign-in window? Default false. */
  interactive?: boolean;
  /** Written to stdin. */
  input?: string | Buffer;
  /** Extra exit codes that are not errors (e.g. [1] for `git diff --quiet`). */
  okExitCodes?: number[];
  /**
   * Ends the command when it is aborted: the process tree is stopped and the call fails with
   * code `timeout`, exactly as when the time limit runs out.
   */
  signal?: AbortSignal;
}

export interface GitResult {
  code: number;
  /** UTF-8 decoded. */
  stdout: string;
  stderr: string;
  /** Raw bytes of stdout (for `git cat-file --batch`). */
  stdoutBuffer: Buffer;
}

export class GitError extends Error {
  readonly code: SyncErrorCode;
  /** git's stderr (or stdout when stderr is empty), credentials masked, at most ~4000 chars. */
  readonly detail: string;
  readonly exitCode: number | null;
  readonly trustPath?: string;
  readonly branches?: string[];

  constructor(error: SyncError, exitCode: number | null) {
    super(error.message);
    this.name = 'GitError';
    this.code = error.code;
    this.detail = error.detail;
    this.exitCode = exitCode;
    this.trustPath = error.trustPath;
    this.branches = error.branches;
  }

  toSyncError(): SyncError {
    return { code: this.code, message: this.message, detail: this.detail, trustPath: this.trustPath, branches: this.branches };
  }
}

export interface GitRunner {
  readonly gitPath: string;
  run(args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
}

// ───────────────────────────── child processes ─────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
/** `git --version` answers at once; anything slower is not a usable git. */
const DETECT_TIMEOUT_MS = 10_000;
/** How long a killed process tree gets to release its output pipes before the call gives up on them. */
const KILL_GRACE_MS = 5_000;

interface ProcessRequest {
  file: string;
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface ProcessOutcome {
  /** null when the process was killed or never started. */
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  /** Why the process could not be started; null when it ran. */
  startError: Error | null;
}

function systemTool(name: string): string {
  return join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', name);
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return;
  }
  // cmd\git.exe is only a launcher: the work happens in its children (the real git, ssh,
  // hooks). They would survive if the launcher alone were terminated, and taskkill can only
  // find them while the launcher is still alive — so it must not be killed first.
  const killer = spawn(systemTool('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  killer.on('error', () => child.kill());
  killer.on('exit', (code) => {
    if (code !== 0) child.kill();
  });
}

/** Runs one program to its end. Never rejects: every way of failing is part of the outcome. */
function execute(request: ProcessRequest): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let limitTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null, startError: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(limitTimer);
      clearTimeout(graceTimer);
      request.signal?.removeEventListener('abort', stop);
      resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut, startError });
    };

    /** The time limit ran out, or the caller gave up: the whole process tree is ended. */
    function stop(): void {
      if (settled || timedOut) return;
      timedOut = true;
      killProcessTree(child);
      graceTimer = setTimeout(() => {
        // A process that escaped the kill could hold the pipes open forever.
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, null);
      }, KILL_GRACE_MS);
    }

    let child: ChildProcess;
    try {
      child = spawn(request.file, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        windowsHide: true,
        stdio: [request.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // spawn throws at once for arguments it cannot pass on, such as a NUL character.
      finish(null, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    limitTimer = setTimeout(stop, request.timeoutMs);
    if (request.signal?.aborted) stop();
    else request.signal?.addEventListener('abort', stop, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      // Without a process id nothing was started, and no 'close' event will follow.
      if (child.pid === undefined) finish(null, error);
    });
    child.on('close', (code) => finish(code, null));

    if (request.input !== undefined && child.stdin) {
      // git may exit before it has read everything (EPIPE); its exit code tells that story.
      child.stdin.on('error', () => undefined);
      child.stdin.end(request.input);
    }
  });
}

// ───────────────────────────── environment ─────────────────────────────

/**
 * Inherited variables that must not reach git: with them it would work on another
 * repository, or record another author, than the one the caller asked for.
 */
const REMOVED_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
];

function gitEnvironment(interactive: boolean): NodeJS.ProcessEnv {
  const fixed: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    LANG: 'C',
    GIT_OPTIONAL_LOCKS: '0',
  };
  if (!interactive) {
    fixed.GCM_INTERACTIVE = 'never';
    // An empty GIT_ASKPASS switches off every askpass program git knows of (core.askPass and
    // SSH_ASKPASS included); ssh needs to be told separately.
    fixed.GIT_ASKPASS = '';
    fixed.SSH_ASKPASS_REQUIRE = 'never';
  }
  const replaced = new Set([...Object.keys(fixed), ...REMOVED_VARIABLES]);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    // Windows compares names without regard to case, so "Lang" must not survive next to "LANG".
    if (!replaced.has(name.toUpperCase())) env[name] = value;
  }
  return Object.assign(env, fixed);
}

// ───────────────────────────── finding git ─────────────────────────────

const NOT_FOUND: GitInfo = { found: false, path: null, version: null };

/** The version when `path` really is git, else null. */
async function gitVersionOf(path: string): Promise<string | null> {
  const outcome = await execute({
    file: path,
    args: ['--version'],
    env: gitEnvironment(false),
    timeoutMs: DETECT_TIMEOUT_MS,
  });
  if (outcome.exitCode !== 0) return null;
  const match = /^git version (\S.*)$/m.exec(outcome.stdout.toString('utf8'));
  return match === null ? null : match[1].trim();
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Every `git` in the folders of PATH, in PATH order.
 *
 * The folders are walked here instead of asking `where.exe`, because that tool looks into
 * the CURRENT folder first — and the app must never run, let alone adopt for all its work,
 * a git.exe that merely lies in the folder it was started from (Downloads, some project).
 * For the same reason PATH entries that are not full paths are skipped: an empty entry or
 * "." means "the current folder".
 */
async function gitOnPath(): Promise<string[]> {
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  const found: string[] = [];
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const folder = entry.trim().replace(/^"(.*)"$/, '$1');
    if (folder === '' || !isAbsolute(folder)) continue;
    const candidate = join(folder, name);
    if (await isFile(candidate)) found.push(candidate);
  }
  return found;
}

function usualInstallPaths(): string[] {
  if (process.platform !== 'win32') return [];
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData === undefined ? undefined : join(process.env.LocalAppData, 'Programs'),
  ];
  return roots
    .filter((root): root is string => root !== undefined && root !== '')
    .map((root) => join(root, 'Git', 'cmd', 'git.exe'));
}

/** Candidates in the order of the contract; later sources are only looked up when earlier ones fail. */
async function* gitCandidates(customPath: string | null): AsyncGenerator<string> {
  const custom = customPath?.trim() ?? '';
  // A bare name such as "git.exe" would be looked up in the current folder first; only a
  // full path says which program the user means.
  if (custom !== '' && isAbsolute(custom)) yield custom;
  yield* await gitOnPath();
  yield* usualInstallPaths();
}

/**
 * Finds git: `customPath` when given and valid, else `git` in the folders of PATH (never in
 * the current folder),
 * else the usual install folders (%ProgramFiles%\Git\cmd\git.exe,
 * %ProgramFiles(x86)%\Git\cmd\git.exe, %LocalAppData%\Programs\Git\cmd\git.exe).
 * A candidate is valid when `<path> --version` prints "git version X"; the version is the
 * text after "git version ". Never throws.
 */
export async function detectGit(customPath?: string | null): Promise<GitInfo> {
  try {
    const tried = new Set<string>();
    for await (const candidate of gitCandidates(customPath ?? null)) {
      const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (tried.has(key)) continue;
      tried.add(key);
      const version = await gitVersionOf(candidate);
      if (version !== null) return { found: true, path: candidate, version };
    }
  } catch {
    // "Never throws": whatever went wrong while looking, the answer is that git was not found.
  }
  return NOT_FOUND;
}

// ───────────────────────────── running git ─────────────────────────────

const FIXED_OPTIONS = ['-c', 'core.quotepath=false', '-c', 'protocol.ext.allow=never'];

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function describeStartFailure(gitPath: string, cwd: string | undefined, error: Error): Promise<SyncError> {
  // Windows answers "file not found" for a missing working folder exactly as for a missing program.
  if (cwd !== undefined && !(await isDirectory(cwd))) {
    return { code: 'unknown', message: 'The working folder does not exist', detail: cwd };
  }
  return { code: 'git-missing', message: 'git could not be started', detail: `${gitPath}: ${error.message}` };
}

export function createGitRunner(gitPath: string): GitRunner {
  return {
    gitPath,
    async run(args, options = {}) {
      const outcome = await execute({
        file: gitPath,
        args: [...FIXED_OPTIONS, ...args],
        cwd: options.cwd,
        env: gitEnvironment(options.interactive === true),
        input: options.input,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
      });
      if (outcome.startError !== null) {
        throw new GitError(await describeStartFailure(gitPath, options.cwd, outcome.startError), null);
      }
      const stdout = outcome.stdout.toString('utf8');
      const stderr = outcome.stderr.toString('utf8');
      const { exitCode } = outcome;
      if (!outcome.timedOut && exitCode !== null && (exitCode === 0 || options.okExitCodes?.includes(exitCode))) {
        return { code: exitCode, stdout, stderr, stdoutBuffer: outcome.stdout };
      }
      throw new GitError(
        classifyGitFailure({ args, stdout, stderr, exitCode, timedOut: outcome.timedOut }),
        exitCode,
      );
    },
  };
}

// ───────────────────────────── classifying failures ─────────────────────────────

const MAX_DETAIL_LENGTH = 4000;
/** Of an over-long output the end matters most: that is where git prints its "fatal:" line. */
const DETAIL_HEAD_LENGTH = 1000;

const AUTH_PATTERNS = [
  /authentication failed/i,
  /could not read username/i,
  /could not read password/i,
  /terminal prompts disabled/i,
  /permission denied \(publickey/i,
  /http 401/i,
  /http 403/i,
  /returned error: 401/i,
  /returned error: 403/i,
  /invalid username or/i,
  /access denied/i,
  /not authorized/i,
  /user interaction is not allowed/i,
];

const NOT_FOUND_PATTERNS = [
  /does not appear to be a git repository/i,
  // Covers GitHub's "remote: Repository not found." and git's "repository '<url>' not found".
  /repository.*not found/i,
  /returned error: 404/i,
  // What `git clone` says about a shared folder (\\server\share\repo.git) that is not there.
  /repository '.*' does not exist/i,
];

const OFFLINE_PATTERNS = [
  /could not resolve host/i,
  /failed to connect/i,
  /connection timed out/i,
  /connection refused/i,
  /connection reset/i,
  /network is unreachable/i,
  /unable to access/i,
  /could not read from remote repository/i,
  /early eof/i,
  /the remote end hung up/i,
];

/** Commands that talk to the remote: only for them does a missing path mean "not reachable". */
const REMOTE_COMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);
/** Options in front of the subcommand that take their value as the next argument. */
const OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree']);

const SUMMARIES: Record<Exclude<SyncErrorCode, 'unknown'>, string> = {
  'git-missing': 'git could not be started',
  'invalid-url': 'The repository address is not valid',
  offline: 'The repository could not be reached',
  auth: 'Sign-in is needed, or access to the repository was refused',
  'not-found': 'The repository was not found',
  'dubious-ownership': 'git does not trust the folder because another user owns it',
  'branch-missing': 'The repository has no branch with that name',
  timeout: 'git did not finish in time and was stopped',
};

function subcommandOf(args: readonly string[]): string {
  for (let index = 0; index < args.length; index++) {
    if (OPTIONS_WITH_VALUE.has(args[index])) index++;
    else if (!args[index].startsWith('-')) return args[index];
  }
  return '';
}

function maskCredentials(text: string): string {
  return text.replace(/https?:\/\/[^\s'"<>]+/gi, (url) => maskRepoUrl(url));
}

function shorten(text: string): string {
  if (text.length <= MAX_DETAIL_LENGTH) return text;
  return `${text.slice(0, DETAIL_HEAD_LENGTH)}\n…\n${text.slice(DETAIL_HEAD_LENGTH - MAX_DETAIL_LENGTH)}`;
}

/** The folder inside git's "git config --global --add safe.directory <path>" advice, unquoted. */
function trustPathIn(output: string): string | undefined {
  const match = /git config --global --add safe\.directory (.+)/i.exec(output);
  if (match === null) return undefined;
  const quoted = match[1].trim();
  // git quotes for a POSIX shell: '…' with every inner quote written as '\'' and every ! as '\!'.
  if (quoted.length >= 2 && quoted.startsWith("'") && quoted.endsWith("'")) {
    return quoted.slice(1, -1).replace(/'\\(['!])'/g, '$1');
  }
  return quoted.replace(/^"(.*)"$/, '$1');
}

/**
 * Maps a failed git invocation to a SyncError. Checked in this order (case-insensitive):
 *  1. timedOut → `timeout`
 *  2. "detected dubious ownership" → `dubious-ownership`; trustPath = the path inside
 *     "git config --global --add safe.directory <path>" (quotes removed) when present
 *  3. authentication: "Authentication failed", "could not read Username", "could not read
 *     Password", "terminal prompts disabled", "Permission denied (publickey", "HTTP 401",
 *     "HTTP 403", "returned error: 401", "returned error: 403", "Invalid username or",
 *     "access denied", "not authorized", "user interaction is not allowed" (GCM when
 *     interaction is disabled) → `auth`
 *  4. "Repository not found", "does not appear to be a git repository", "not found" after
 *     "repository" on the same line, "returned error: 404", "repository '<path>' does not
 *     exist" (a shared folder that is not there) → `not-found`
 *  5. "Could not resolve host", "Failed to connect", "Connection timed out", "Connection
 *     refused", "Connection reset", "Network is unreachable", "unable to access",
 *     "Could not read from remote repository", "No such file or directory" for a remote
 *     path (= while cloning, fetching or pushing), "early EOF", "The remote end hung up"
 *     → `offline`
 *  6. otherwise → `unknown`
 * The patterns are looked for in stderr and stdout together. `detail` is the output (stderr,
 * or stdout when stderr is empty) with credentials in URLs masked (maskRepoUrl), trimmed
 * and cut to about 4000 characters.
 */
export function classifyGitFailure(input: {
  args: readonly string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}): SyncError {
  const output = `${input.stderr}\n${input.stdout}`;
  const detail = shorten(maskCredentials(input.stderr.trim() !== '' ? input.stderr : input.stdout).trim());
  const subcommand = subcommandOf(input.args);
  const matches = (patterns: readonly RegExp[]): boolean => patterns.some((pattern) => pattern.test(output));
  const known = (code: Exclude<SyncErrorCode, 'unknown'>): SyncError => ({ code, message: SUMMARIES[code], detail });

  if (input.timedOut) return known('timeout');
  if (/detected dubious ownership/i.test(output)) return { ...known('dubious-ownership'), trustPath: trustPathIn(output) };
  if (matches(AUTH_PATTERNS)) return known('auth');
  if (matches(NOT_FOUND_PATTERNS)) return known('not-found');
  if (matches(OFFLINE_PATTERNS)) return known('offline');
  if (REMOTE_COMMANDS.has(subcommand) && /no such file or directory/i.test(output)) return known('offline');

  const what = subcommand === '' ? 'git' : `git ${subcommand}`;
  const how = input.exitCode === null ? 'was stopped' : `failed with exit code ${input.exitCode}`;
  return { code: 'unknown', message: `${what} ${how}`, detail };
}
