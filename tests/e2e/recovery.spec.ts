/**
 * A schedule file that got damaged on this computer must not cost anything: the app starts,
 * shows the week as the team has it, and repairs the file from the team's version on request.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { addEvent, connect, createTeam, launch, quit, removeTeam, shot } from './helpers';

test('a week file damaged on this computer is shown as the team has it and repaired with one button', async () => {
  const team = createTeam();
  try {
    // Dana publishes a week …
    let dana = await launch(team, 'dana', { lang: 'en' });
    let weekFile = '';
    let published = '';
    try {
      const { page } = dana;
      await connect(page, team, 'Dana Levi', 'dana@example.com');
      await page.getByTestId('setup-create').click();
      await expect(page.getByTestId('app-ready')).toBeVisible({ timeout: 60_000 });
      await addEvent(page, { title: 'Docker basics', day: 0, start: '09:00', end: '10:30' });
      await page.getByTestId('sync-publish').click();
      await page.getByTestId('publish-confirm').click();
      await expect(page.getByTestId('publish-dialog')).toBeHidden({ timeout: 60_000 });
      await expect(page.getByTestId('sync-status')).toHaveAttribute('data-state', 'clean');

      const repos = join(dana.userData, 'repos');
      const weeks = join(repos, readdirSync(repos)[0], 'weeks');
      weekFile = join(weeks, readdirSync(weeks)[0]);
      published = readFileSync(weekFile, 'utf8');
    } finally {
      await quit(dana);
    }

    // … and then something on her computer ruins the file.
    writeFileSync(weekFile, published.slice(0, Math.floor(published.length / 2)));

    dana = await launch(team, 'dana');
    try {
      const { page } = dana;
      await expect(page.getByTestId('app-ready')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('problem-banner')).toBeVisible();
      // The lesson is still on screen (the team's version), and nothing counts as "changed by me".
      await expect(page.locator('.wg-event', { hasText: 'Docker basics' })).toBeVisible();
      await expect(page.getByTestId('week-read-only')).toBeVisible();
      await expect(page.getByTestId('new-event')).toBeDisabled();
      await expect(page.getByTestId('sync-status')).toHaveAttribute('data-state', 'clean');
      await shot(page, '40-damaged-file-banner');

      await page.getByTestId('problem-restore').click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.getByTestId('confirm-ok').click();
      await expect(page.getByTestId('problem-banner')).toBeHidden({ timeout: 30_000 });
      await expect(page.getByTestId('week-read-only')).toBeHidden();
      await expect(page.locator('.wg-event', { hasText: 'Docker basics' })).toBeVisible();
      await expect(page.getByTestId('new-event')).toBeEnabled();
      expect(readFileSync(weekFile, 'utf8')).toBe(published);
    } finally {
      await quit(dana);
    }
  } finally {
    await removeTeam(team);
  }
});
