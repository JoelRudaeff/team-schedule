/**
 * End-to-end helpers: a temporary "team" (a bare git repository on disk) and app instances
 * that each run on their own data folder, so several teammates can be played at once.
 * Run `npm run build` first: the tests drive the built app in `out/`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';

export interface Team {
  root: string;
  /** Windows path of the bare repository that plays the server. */
  remote: string;
  /** A private global git config, so the developer's own settings are never read or changed. */
  gitConfig: string;
}

export function createTeam(): Team {
  const root = mkdtempSync(join(tmpdir(), 'team-schedule-e2e-'));
  const gitConfig = join(root, 'global.gitconfig');
  writeFileSync(gitConfig, '');
  const remote = join(root, 'team.git');
  execFileSync('git', ['init', '--bare', '--quiet', remote], { env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig } });
  return { root, remote, gitConfig };
}

/** Best effort: Windows may keep the folder locked for a moment after the app has exited. */
export async function removeTeam(team: Team): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(team.root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.warn(`Could not remove the temporary folder ${team.root}`);
}

export interface AppHandle {
  app: ElectronApplication;
  page: Page;
  userData: string;
}

/** Starts the app for one (pretend) teammate. The same `user` gets the same data folder again. */
export async function launch(team: Team, user: string, options: { lang?: 'en' | 'he' } = {}): Promise<AppHandle> {
  const userData = join(team.root, 'users', user);
  mkdirSync(userData, { recursive: true });
  const settingsFile = join(userData, 'settings.json');
  if (options.lang && !existsSync(settingsFile)) writeFileSync(settingsFile, JSON.stringify({ language: options.lang }));
  // TEAM_SCHEDULE_EXE=dist\win-unpacked\Team Schedule.exe runs the same tests against the packaged app.
  const packagedExe = process.env.TEAM_SCHEDULE_EXE;
  const app = await electron.launch({
    executablePath: packagedExe || undefined,
    // A fixed scale keeps screenshots the same size on every display.
    args: packagedExe ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'],
    env: { ...process.env, TEAM_SCHEDULE_USER_DATA: userData, GIT_CONFIG_GLOBAL: team.gitConfig } as Record<string, string>,
  });
  const page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[${user}] console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => console.log(`[${user}] page error: ${error.message}`));
  return { app, page, userData };
}

/** Fills the set-up form and connects. Ends on the schedule or on the "create schedule" step. */
export async function connect(page: Page, team: Team, name: string, email: string): Promise<void> {
  await expect(page.getByTestId('setup-wizard')).toBeVisible();
  await page.getByTestId('setup-repo-url').fill(team.remote);
  await page.getByTestId('setup-user-name').fill(name);
  await page.getByTestId('setup-user-email').fill(email);
  await page.getByTestId('setup-connect').click();
  await expect(page.getByTestId('setup-create').or(page.getByTestId('app-ready'))).toBeVisible({ timeout: 60_000 });
}

/** Adds an event through the dialog. `day` is 0 (Sunday) … 6; times are "HH:MM". */
export async function addEvent(
  page: Page,
  event: { title: string; day: number; start: string; end: string; subject?: string; location?: string },
): Promise<void> {
  await page.getByTestId('new-event').click();
  await expect(page.getByTestId('event-dialog')).toBeVisible();
  await page.getByTestId('event-title').fill(event.title);
  await page.getByTestId('event-day').selectOption(String(event.day));
  await page.getByTestId('event-start').selectOption({ label: event.start });
  await page.getByTestId('event-end').selectOption({ label: event.end });
  if (event.subject) await page.getByTestId('event-subject').getByRole('radio', { name: event.subject }).click();
  if (event.location) {
    await page.getByTestId('event-location-add').click();
    await page.getByTestId('event-location-new-name').fill(event.location);
    await page.getByTestId('event-location-new-add').click();
  }
  await page.getByTestId('event-save').click();
  await expect(page.getByTestId('event-dialog')).toBeHidden();
}

/**
 * Ends an app instance at once. A normal window close would (rightly) stop and ask about
 * unpublished changes, which a test that is finished has no use for.
 */
export async function quit(handle: AppHandle): Promise<void> {
  await handle.app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
}

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync('test-results/screens', { recursive: true });
  // Fade-in animations are finished instantly, so a dialog is never caught half transparent.
  await page.screenshot({ path: `test-results/screens/${name}.png`, animations: 'disabled' });
}
