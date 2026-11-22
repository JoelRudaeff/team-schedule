/**
 * Two behaviours that only show in the running app (both found by the second review of pull
 * request #1, neither of which could be seen without a window):
 *
 *  - closed while a check for updates is waiting for a server that does not answer, the app
 *    ends within seconds (it gives the check a moment, then ends it) — so it can be started
 *    again straight away instead of doing nothing until git gives up;
 *  - the Save question that comes back after an out-of-date overview still holds the note
 *    that was typed for that save.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { addEvent, connect, createTeam, launch, quit, removeTeam, type AppHandle, type Team } from './helpers';

let team: Team;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  team = createTeam();
});

test.afterAll(async () => {
  await removeTeam(team);
});

/** Plain git, with the same private configuration the app instances of this team use. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: team.gitConfig } });
}

/** The app's own clone of the team repository: the one folder under `repos`. */
function cloneOf(handle: AppHandle): string {
  const repos = join(handle.userData, 'repos');
  return join(repos, readdirSync(repos)[0]);
}

const syncState = (page: Page) => page.getByTestId('sync-status');

/**
 * Ends an app process together with whatever it started. Needed where a test makes git wait
 * on purpose: should the app not end by itself (the test fails), a plain exit would leave
 * that git and its helpers behind, sleeping inside the folder the test wants to remove.
 * (The process id is taken while the app runs: afterwards Playwright no longer has it.)
 */
function endWithChildren(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone: that is what the test expects.
  }
}

test('closed while a check for updates waits for a server that does not answer, the app ends within seconds and starts again', async () => {
  let dana = await launch(team, 'dana', { lang: 'en' });
  await connect(dana.page, team, 'Dana Levi', 'dana@example.com');
  await dana.page.getByTestId('setup-create').click();
  await expect(dana.page.getByTestId('app-ready')).toBeVisible({ timeout: 60_000 });
  const clone = cloneOf(dana);
  await quit(dana);

  // From now on the "server" takes every request of this clone and never answers it.
  const marker = join(team.root, 'check-is-waiting').replace(/\\/g, '/');
  git(clone, 'config', 'remote.origin.uploadpack', `touch '${marker}'; sleep 120 #`);

  dana = await launch(team, 'dana');
  const pid = dana.app.process().pid;
  try {
    await expect(dana.page.getByTestId('app-ready')).toBeVisible({ timeout: 60_000 });
    // The quiet check that follows the start is under way and waiting.
    await expect.poll(() => existsSync(marker), { timeout: 30_000 }).toBe(true);

    const ended = dana.app.waitForEvent('close', { timeout: 20_000 });
    const closedAt = Date.now();
    // The same path as the window's X button.
    await dana.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await ended;
    // Left to itself, the waiting check would have kept the closed app alive for 45 seconds.
    expect(Date.now() - closedAt).toBeLessThan(20_000);
  } finally {
    endWithChildren(pid);
  }

  // Nothing is left that holds the app's single-instance lock: it starts again.
  git(clone, 'config', '--unset', 'remote.origin.uploadpack');
  dana = await launch(team, 'dana');
  try {
    await expect(dana.page.getByTestId('app-ready')).toBeVisible({ timeout: 60_000 });
    await expect(syncState(dana.page)).toHaveAttribute('data-state', 'clean', { timeout: 60_000 });
  } finally {
    await quit(dana);
  }
});

test('the Save question that comes back after an out-of-date overview still holds the note', async () => {
  // A quiet check every 15 seconds instead of every minute, so the test does not sit waiting.
  const settingsFile = join(team.root, 'users', 'dana', 'settings.json');
  const settings: Record<string, unknown> = JSON.parse(readFileSync(settingsFile, 'utf8'));
  writeFileSync(settingsFile, JSON.stringify({ ...settings, pollSeconds: 15 }));

  const dana = await launch(team, 'dana');
  const { page } = dana;
  try {
    await expect(page.getByTestId('app-ready')).toBeVisible({ timeout: 60_000 });
    await addEvent(page, { title: 'My lesson', day: 1, start: '09:00', end: '10:00' });

    // A teammate renames the course and saves.
    const mate = join(team.root, 'mate');
    git(team.root, 'clone', '--quiet', team.remote, mate);
    const configFile = join(mate, 'schedule.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as { course: { name: string } };
    config.course.name = 'Renamed by a teammate';
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    git(mate, '-c', 'user.name=Yossi Cohen', '-c', 'user.email=yossi@example.com', 'commit', '--quiet', '-am', 'Rename the course');
    git(mate, 'push', '--quiet', 'origin', 'HEAD');

    // Save, with a note. The team has something new, so the overview comes first.
    await page.getByTestId('sync-publish').click();
    await page.getByTestId('publish-note').fill('my note');
    await page.getByTestId('publish-confirm').click();
    await expect(page.getByTestId('merge-dialog')).toBeVisible({ timeout: 60_000 });
    await expect(syncState(page)).toHaveAttribute('data-behind', '1');

    // While the overview is on screen, something outside the app brings the local copy up to
    // the team's version and keeps my lesson (what "stash, pull, stash pop" does).
    const clone = cloneOf(dana);
    const branch = git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    git(clone, 'stash', 'push', '--quiet', '--include-untracked');
    git(clone, 'merge', '--quiet', '--ff-only', `origin/${branch}`);
    git(clone, 'stash', 'pop', '--quiet');

    // The next quiet check sees it: nothing of the team's is left to bring in.
    await expect(syncState(page)).toHaveAttribute('data-behind', '0', { timeout: 60_000 });

    // Deciding on the old overview does not send anything: the question is asked again …
    await page.getByTestId('merge-combine-save').click();
    await expect(page.getByTestId('publish-dialog')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('merge-dialog')).toBeHidden();
    expect(git(team.remote, 'log', '-1', '--format=%s').trim()).toBe('Rename the course');
    // … and it is the same save, so the note is still in the box.
    await expect(page.getByTestId('publish-note')).toHaveValue('my note');

    await page.getByTestId('publish-confirm').click();
    await expect(page.getByTestId('publish-dialog')).toBeHidden({ timeout: 60_000 });
    await expect(syncState(page)).toHaveAttribute('data-state', 'clean', { timeout: 60_000 });
    expect(git(team.remote, 'log', '-1', '--format=%s').trim()).toBe('my note');
  } finally {
    await quit(dana);
  }
});
