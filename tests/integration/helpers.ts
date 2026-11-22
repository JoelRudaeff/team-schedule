/**
 * A throw-away "team" for the git integration tests: one bare repository that plays the
 * server, and any number of clones made through RepoService.connect — all in a temp folder,
 * all with a private git configuration so the developer's own settings are never read or
 * changed.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner, detectGit, type GitResult, type GitRunner } from '../../src/main/git/gitRunner';
import { RepoService, type ConnectOutcome } from '../../src/main/git/repoService';

export interface Identity {
  name: string;
  email: string;
}

export const DANA: Identity = { name: 'דנה לוי', email: 'dana@example.com' };
export const YOSSI: Identity = { name: 'Yossi Cohen', email: 'yossi@example.com' };
export const NOA: Identity = { name: 'Noa', email: 'noa@example.com' };

export const CONFIG_TEXT =
  '{\n' +
  '"formatVersion": 1,\n' +
  '"course": {"name":"קורס DevOps","startDate":null,"endDate":null},\n' +
  '"timeGrid": {"dayStart":"08:00","dayEnd":"20:00","slotMinutes":30},\n' +
  '"subjects": [],\n' +
  '"locations": [],\n' +
  '"teachers": [],\n' +
  '"classes": []\n' +
  '}\n';

export const WEEK = '2026-11-22';
export const WEEK_FILE = `weeks/${WEEK}.json`;

/** One event line in the canonical week-file layout. */
export function eventLine(id: string, day: number, start: string, end: string, title: string): string {
  return (
    `{"id":"${id}","day":${day},"start":"${start}","end":"${end}","title":${JSON.stringify(title)},` +
    '"subject":null,"location":null,"teachers":[],"classes":[],"notes":""}'
  );
}

/** A week file in the canonical layout (one event per line). */
export function weekText(title: string, eventLines: readonly string[], weekStart: string = WEEK): string {
  const events = eventLines.length === 0 ? '"events": []\n' : `"events": [\n${eventLines.join(',\n')}\n]\n`;
  return `{\n"formatVersion": 1,\n"weekStart": "${weekStart}",\n"title": ${JSON.stringify(title)},\n${events}}\n`;
}

export interface Sandbox {
  root: string;
  git: GitRunner;
  /** Windows path of the bare repository that plays the team's server. */
  remote: string;
  /** Connects a new user (a fresh clone folder named after `folder`). */
  connect(folder: string, who: Identity, branch?: string | null): Promise<ConnectOutcome>;
  /** Folder that `connect(folder, …)` uses. */
  dirOf(folder: string): string;
  /** Plain git in any folder, for arranging and inspecting state. */
  raw(cwd: string, ...args: string[]): Promise<GitResult>;
  /** Installs a hook script (POSIX sh, run by Git for Windows) in a repository. */
  installHook(gitDir: string, name: string, script: string): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * @param globalConfig extra lines for the private global git config (e.g. core.autocrlf=true
 *                     to imitate a default Git for Windows installation)
 */
export async function createSandbox(globalConfig = ''): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'team-schedule-git-'));
  const configFile = join(root, 'global.gitconfig');
  await writeFile(configFile, globalConfig, 'utf8');
  process.env.GIT_CONFIG_GLOBAL = configFile;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  const info = await detectGit();
  if (!info.found || info.path === null) throw new Error('git is required for the integration tests');
  const git = createGitRunner(info.path);

  const remote = join(root, 'team.git');
  await git.run(['init', '--bare', '--quiet', remote]);

  const dirOf = (folder: string): string => join(root, 'clones', folder);
  return {
    root,
    git,
    remote,
    dirOf,
    connect: (folder, who, branch = null) =>
      RepoService.connect(git, { url: remote, dir: dirOf(folder), branch, userName: who.name, userEmail: who.email }),
    raw: (cwd, ...args) => git.run(args, { cwd }),
    async installHook(gitDir, name, script) {
      const file = join(gitDir, 'hooks', name);
      await mkdir(join(gitDir, 'hooks'), { recursive: true });
      await writeFile(file, script.replace(/\r\n/g, '\n'), 'utf8');
      await chmod(file, 0o755);
    },
    async cleanup() {
      // Windows may hold a handle on a pack file for a moment after git exits.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** Forward slashes, so a Windows path can be written into a POSIX shell script. */
export function shPath(path: string): string {
  return path.replace(/\\/g, '/');
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
