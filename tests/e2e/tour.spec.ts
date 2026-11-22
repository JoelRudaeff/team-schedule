/**
 * A guided tour through the whole app with two teammates sharing one repository.
 * It checks the main flows end to end and leaves screenshots in test-results/screens.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { addEvent, connect, createTeam, launch, quit, removeTeam, shot, type Team } from './helpers';

let team: Team;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  team = createTeam();
});

test.afterAll(async () => {
  await removeTeam(team);
});

const eventCard = (page: Page, title: string) => page.locator('.wg-event', { hasText: title });
const syncState = (page: Page) => page.getByTestId('sync-status');

test('Dana sets up the team schedule and publishes the first week', async () => {
  const dana = await launch(team, 'dana', { lang: 'en' });
  const { page } = dana;
  try {
    await expect(page.getByTestId('setup-wizard')).toBeVisible();
    await shot(page, '01-setup');

    await connect(page, team, 'Dana Levi', 'dana@example.com');
    await page.getByTestId('setup-course-name').fill('DevOps 2026');
    await shot(page, '02-create-schedule');
    await page.getByTestId('setup-create').click();
    await expect(page.getByTestId('app-ready')).toBeVisible({ timeout: 60_000 });
    await expect(syncState(page)).toHaveAttribute('data-state', 'clean');

    await addEvent(page, { title: 'Docker basics', day: 0, start: '09:00', end: '10:30', subject: 'Lecture', location: 'Room 101' });
    await addEvent(page, { title: 'Hands-on lab', day: 0, start: '11:00', end: '13:00', subject: 'Lab', location: 'Lab A' });
    await addEvent(page, { title: 'מבוא לרשתות', day: 2, start: '09:00', end: '10:30', subject: 'Workshop' });
    await addEvent(page, { title: 'Exam prep', day: 4, start: '14:00', end: '15:00', subject: 'Exam' });
    await page.getByTestId('week-title-input').fill('Containers week');
    await page.getByTestId('week-title-input').press('Enter');
    await expect(syncState(page)).toHaveAttribute('data-state', 'dirty');
    await expect(syncState(page)).toHaveAttribute('data-unpublished', '7');
    await shot(page, '03-week-unpublished');

    await eventCard(page, 'Docker basics').click();
    await expect(page.getByTestId('event-popover')).toBeVisible();
    await expect(page.getByTestId('event-unpublished')).toBeVisible();
    await shot(page, '04-event-popover');
    await page.keyboard.press('Escape');

    // Saving asks first and says what it means.
    await page.getByTestId('sync-publish').click();
    await expect(page.getByTestId('publish-dialog')).toBeVisible();
    await expect(page.getByTestId('publish-changes').locator('li')).toHaveCount(7);
    await page.getByTestId('publish-note').fill('First week');
    await shot(page, '05-publish-dialog');
    await page.getByTestId('publish-confirm').click();
    await expect(page.getByTestId('publish-dialog')).toBeHidden({ timeout: 60_000 });
    await expect(syncState(page)).toHaveAttribute('data-state', 'clean');
    await shot(page, '06-published');
  } finally {
    await quit(dana);
  }
});

test('Yossi connects in Hebrew, sees who edited what, changes things and publishes', async () => {
  const yossi = await launch(team, 'yossi', { lang: 'he' });
  const { page } = yossi;
  try {
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await shot(page, '07-setup-hebrew');
    await connect(page, team, 'יוסי כהן', 'yossi@example.com');
    await expect(page.getByTestId('app-ready')).toBeVisible();
    await expect(eventCard(page, 'Docker basics')).toBeVisible();
    await expect(page.getByTestId('week-title-input')).toHaveValue('Containers week');

    await eventCard(page, 'Docker basics').click();
    await expect(page.getByTestId('blame-line')).toContainText('Dana Levi');
    await shot(page, '08-blame-hebrew');

    // Move the lecture one hour later and add a lesson.
    await page.getByTestId('event-edit').click();
    await page.getByTestId('event-start').selectOption({ label: '10:00' });
    await shot(page, '09-event-dialog-hebrew');
    await page.getByTestId('event-save').click();
    await addEvent(page, { title: 'תרגול Kubernetes', day: 3, start: '10:00', end: '12:00' });
    await expect(syncState(page)).toHaveAttribute('data-state', 'dirty');

    await page.getByTestId('sync-publish').click();
    await page.getByTestId('publish-confirm').click();
    await expect(page.getByTestId('publish-dialog')).toBeHidden({ timeout: 60_000 });
    await expect(syncState(page)).toHaveAttribute('data-state', 'clean');
  } finally {
    await quit(yossi);
  }
});

test('Dana is told about the update, collides with it, and keeps her version aside', async () => {
  const dana = await launch(team, 'dana');
  const { page } = dana;
  try {
    await expect(page.getByTestId('app-ready')).toBeVisible();
    // The background check notices Yossi's commit.
    await expect(syncState(page)).toHaveAttribute('data-state', 'behind', { timeout: 60_000 });
    await expect(syncState(page)).toHaveAttribute('data-behind', '1');
    await shot(page, '10-update-available');

    // Dana still sees the old time and changes the same lecture, plus something unrelated.
    await eventCard(page, 'Docker basics').click();
    await page.getByTestId('event-edit').click();
    await page.getByTestId('event-start').selectOption({ label: '08:00' });
    await page.getByTestId('event-save').click();
    await addEvent(page, { title: 'Guest talk', day: 5, start: '09:00', end: '10:00', subject: 'Meeting' });
    await expect(syncState(page)).toHaveAttribute('data-state', 'diverged');

    await page.getByTestId('sync-publish').click();
    await page.getByTestId('publish-confirm').click();
    await expect(page.getByTestId('merge-dialog')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('conflict-card')).toHaveCount(1);
    await expect(page.getByTestId('merge-graph')).toBeVisible();
    await shot(page, '11-merge-dialog');

    // Cancelling changes nothing; the same overview comes back, this time in Hebrew.
    await page.getByTestId('merge-cancel').click();
    await expect(syncState(page)).toHaveAttribute('data-state', 'diverged');
    await page.getByTestId('lang-he').click();
    await page.getByTestId('sync-publish').click();
    await page.getByTestId('publish-confirm').click();
    await expect(page.getByTestId('merge-dialog')).toBeVisible({ timeout: 60_000 });
    await shot(page, '11b-merge-dialog-hebrew');
    await page.getByTestId('merge-option-custom').click();
    await page.getByTestId('conflict-card').scrollIntoViewIfNeeded();
    await shot(page, '12-merge-decide-one-by-one');

    // "Update and keep mine aside"
    await page.getByTestId('merge-option-aside').click();
    await page.getByTestId('merge-apply').click();
    await expect(page.getByTestId('merge-dialog')).toBeHidden({ timeout: 60_000 });

    // The team's time is in the schedule, mine is a ghost, the unrelated event is still unpublished.
    await expect(eventCard(page, 'Docker basics')).toHaveAttribute('data-start', '600');
    await expect(page.locator('.wg-ghost')).toHaveCount(1);
    await expect(page.getByTestId('aside-badge')).toBeVisible();
    await expect(syncState(page)).toHaveAttribute('data-state', 'dirty');
    await expect(syncState(page)).toHaveAttribute('data-unpublished', '1');
    await expect(eventCard(page, 'תרגול Kubernetes')).toBeVisible();
    await shot(page, '13-kept-aside-ghost');

    await page.locator('.wg-ghost').click();
    await expect(page.getByTestId('aside-popover')).toBeVisible();
    await shot(page, '14-aside-popover');
    await page.keyboard.press('Escape');

    await page.getByTestId('aside-badge').click();
    await expect(page.getByTestId('aside-dialog')).toBeVisible();
    await shot(page, '15-aside-dialog');
    await page.getByTestId('aside-use').click();
    await page.getByTestId('aside-close').click();
    await expect(eventCard(page, 'Docker basics')).toHaveAttribute('data-start', '480');
    await expect(page.locator('.wg-ghost')).toHaveCount(0);

    // Now a normal save: nothing new on the team's side, so no merge dialog.
    await page.getByTestId('sync-publish').click();
    await page.getByTestId('publish-confirm').click();
    await expect(page.getByTestId('publish-dialog')).toBeHidden({ timeout: 60_000 });
    await expect(syncState(page)).toHaveAttribute('data-state', 'clean');
  } finally {
    await quit(dana);
  }
});

test('settings, filters, week navigation and the Outlook export', async () => {
  const yossi = await launch(team, 'yossi');
  const { page, app } = yossi;
  try {
    await expect(page.getByTestId('app-ready')).toBeVisible();
    await expect(syncState(page)).toHaveAttribute('data-state', 'behind', { timeout: 60_000 });
    await page.getByTestId('sync-update').click();
    await expect(syncState(page)).toHaveAttribute('data-state', 'clean', { timeout: 60_000 });
    await expect(eventCard(page, 'Guest talk')).toBeVisible();
    await shot(page, '16-updated-hebrew');

    // Settings: course dates, time grid, subjects with RGB colours.
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-tab-course').click();
    await page.getByTestId('settings-course-start').fill('2026-11-01');
    await page.getByTestId('settings-course-end').fill('2027-01-30');
    await page.getByTestId('settings-slot').selectOption('45');
    await expect(page.getByTestId('settings-course-weeks')).toBeVisible();
    await shot(page, '17-settings-course-hebrew');
    await page.getByTestId('settings-slot').selectOption('30');
    await page.getByTestId('settings-tab-subjects').click();
    await page.getByTestId('entity-new-name').fill('סיור');
    await page.getByTestId('entity-new-color').click();
    await page.getByTestId('entity-new-color-picker-r').fill('200');
    await page.getByTestId('entity-new-color-picker-g').fill('30');
    await page.getByTestId('entity-new-color-picker-b').fill('120');
    await shot(page, '18-settings-subjects-color');
    await page.keyboard.press('Escape');
    await page.getByTestId('entity-add').click();
    await expect(page.getByTestId('entity-list-subject').locator('li')).toHaveCount(7);
    await page.getByTestId('settings-tab-teachers').click();
    await page.getByTestId('entity-new-name').fill('דנה');
    await page.getByTestId('entity-add').click();
    await page.getByTestId('settings-tab-classes').click();
    await page.getByTestId('entity-new-name').fill('כיתה 1');
    await page.getByTestId('entity-add').click();
    await page.getByTestId('entity-new-name').fill('כיתה 2');
    await page.getByTestId('entity-add').click();
    await shot(page, '19-settings-classes');
    await page.getByTestId('settings-close').click();

    // The course now starts on 1 Nov, so this is course week 4 and weeks can be reached by number.
    await expect(page.getByTestId('week-label')).toContainText('4');
    await page.getByTestId('week-number-input').fill('6');
    await page.getByTestId('week-number-input').press('Enter');
    await expect(page.getByTestId('week-grid')).toHaveAttribute('data-week', '2026-12-06');
    await page.getByTestId('week-prev').click();
    await expect(page.getByTestId('week-grid')).toHaveAttribute('data-week', '2026-11-29');
    await page.getByTestId('week-number-input').fill('99');
    await page.getByTestId('week-number-input').press('Enter');
    await expect(page.getByTestId('week-number-error')).toBeVisible();
    await page.getByTestId('week-today').click();
    await expect(page.getByTestId('week-grid')).toHaveAttribute('data-week', '2026-11-22');

    // Filter by location: the whole week, only that room.
    await page.getByTestId('filter-location').click();
    await page.getByTestId('filter-location-panel').getByText('Room 101').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.wg-event')).toHaveCount(1);
    await shot(page, '20-filtered-by-location');
    await page.getByTestId('filters-clear').click();
    await expect(page.locator('.wg-event')).toHaveCount(6);

    // Outlook export, with the save dialog answered by the test and nothing really opened.
    const icsPath = join(team.root, 'export.ics');
    await app.evaluate(({ dialog, shell }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
      shell.openPath = async () => '';
    }, icsPath);
    await page.getByTestId('main-menu').click();
    await page.getByTestId('main-menu-export-ics').click();
    await expect(page.getByTestId('export-ics-dialog')).toBeVisible();
    await shot(page, '21-export-outlook');
    await page.getByTestId('export-ics-confirm').click();
    await expect(page.getByTestId('export-ics-dialog')).toBeHidden();
    expect(existsSync(icsPath)).toBe(true);
    const ics = readFileSync(icsPath, 'utf8');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(6);
    expect(ics).toContain('SUMMARY:Docker basics');
    expect(ics).toContain('LOCATION:Room 101');

    // Repeat the week into the next one.
    await page.getByTestId('main-menu').click();
    await page.getByTestId('main-menu-repeat-week').click();
    await expect(page.getByTestId('repeat-week-dialog')).toBeVisible();
    await shot(page, '22-repeat-week');
    await page.getByTestId('repeat-week-confirm').click();
    await page.getByTestId('week-next').click();
    await expect(page.locator('.wg-event')).toHaveCount(6);

    // Closing with unpublished changes asks first (the same path as the window's X button).
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect(page.getByTestId('close-guard-dialog')).toBeVisible();
    await shot(page, '23-close-guard');
    await page.getByTestId('close-guard-cancel').click();
  } finally {
    await quit(yossi);
  }
});
