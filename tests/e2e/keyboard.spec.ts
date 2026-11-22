/**
 * What a person does with the keyboard, or by a slip of the hand, in the real app — in
 * English and in Hebrew. Every test pins a behaviour that an independent review of version
 * 1.0.0 found broken (unreachable settings pages and lists, work thrown away without a
 * question, clicks and drags that landed somewhere unintended, a mistyped branch).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addEvent, connect, createTeam, launch, quit, removeTeam, shot, type AppHandle, type Team } from './helpers';

let team: Team;
let handle: AppHandle;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  team = createTeam();
  handle = await launch(team, 'dana', { lang: 'en' });
  page = handle.page;
  await connect(page, team, 'Dana Levi', 'dana@example.com');
  await page.getByTestId('setup-create').click();
  await expect(page.getByTestId('app-ready')).toBeVisible({ timeout: 60_000 });
});

test.afterAll(async () => {
  await quit(handle);
  await removeTeam(team);
});

const card = (title: string): Locator => page.locator('.wg-event', { hasText: title });
// These run inside the window, so they are handed over as text (the test code itself is compiled without the browser's types).
const focusedTestId = (): Promise<string | null> => page.evaluate<string | null>("document.activeElement?.getAttribute('data-testid') ?? null");
const focusInside = (selector: string): Promise<boolean> =>
  page.evaluate<boolean>(`document.activeElement !== null && document.activeElement.closest(${JSON.stringify(selector)}) !== null`);
/** Computed direction and bidi handling of the first element matching the selector. */
const directionOf = (selector: string): Promise<string[]> =>
  page.evaluate<string[]>(
    `(() => { const style = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return [style.direction, style.unicodeBidi]; })()`,
  );

test('Settings: every page is reached with the arrow keys, across both groups', async () => {
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  const order = ['general', 'repository', 'course', 'subjects', 'locations', 'teachers', 'classes'];

  await page.getByTestId('settings-tab-general').focus();
  for (const next of [...order.slice(1), order[0]]) {
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId(`settings-tab-${next}`)).toHaveAttribute('aria-selected', 'true');
    expect(await focusedTestId()).toBe(`settings-tab-${next}`);
  }
  // Exactly one tab stop in the whole list.
  expect(await page.locator('[data-testid="settings-tab"] [role="tab"][tabindex="0"]').count()).toBe(1);

  // On the teachers page two teachers are added with the keyboard alone.
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('settings-tab-teachers')).toHaveAttribute('aria-selected', 'true');
  for (const name of ['Dana T', 'Uri T']) {
    await page.getByTestId('entity-new-name').fill(name);
    await page.getByTestId('entity-new-name').press('Enter');
  }
  await expect(page.locator('[data-testid^="entity-row-"]')).toHaveCount(2);
  await page.getByTestId('settings-close').click();
});

test('event dialog: teachers are chosen with the keyboard, and the focus comes back', async () => {
  await page.getByTestId('new-event').click();
  await page.getByTestId('event-title').fill('Keyboard lesson');

  const field = page.getByTestId('event-teachers');
  await field.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('event-teachers-panel')).toBeVisible();
  // The list has the focus now: Space ticks, the arrows walk, Tab stays inside.
  await expect.poll(() => focusInside('[data-testid="event-teachers-panel"]')).toBe(true);
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await focusInside('[data-testid="event-teachers-panel"]')).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('event-teachers-panel')).toBeHidden();
  await expect(field).toBeFocused();
  await expect(field).toContainText('Dana T');
  await expect(field).toContainText('Uri T');

  // Escape closed the list only: the dialog and what was typed are still there.
  await expect(page.getByTestId('event-title')).toHaveValue('Keyboard lesson');
  await page.getByTestId('event-save').click();
  await expect(card('Keyboard lesson')).toBeVisible();
});

test('Escape on a changed event asks before throwing it away; an untouched one just closes', async () => {
  await page.getByTestId('new-event').click();
  await expect(page.getByTestId('event-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('event-dialog')).toBeHidden();

  await page.getByTestId('new-event').click();
  await page.getByTestId('event-title').fill('Half written');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('event-discard-ask')).toBeVisible();
  await expect(page.getByTestId('event-keep-editing')).toBeFocused();
  // A second Escape is not "yes, discard": it goes back to editing, with the keyboard
  // in the field it came from, so typing simply continues.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('event-discard-ask')).toBeHidden();
  await expect(page.getByTestId('event-title')).toHaveValue('Half written');
  await expect(page.getByTestId('event-title')).toBeFocused();
  await page.keyboard.type(' and on');
  await expect(page.getByTestId('event-title')).toHaveValue('Half written and on');

  await page.keyboard.press('Escape');
  await page.getByTestId('event-discard').click();
  await expect(page.getByTestId('event-dialog')).toBeHidden();
  await expect(card('Half written')).toHaveCount(0);
});

test('closing the window over a half-written event asks, and "go back" returns to it as it was', async () => {
  await page.getByTestId('new-event').click();
  await page.getByTestId('event-title').fill('Typed before the X');
  await page.getByTestId('event-notes').fill('do not lose me');

  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect(page.getByTestId('close-guard-dialog')).toBeVisible();
  await expect(page.getByTestId('close-guard-draft')).toBeVisible();
  // Saving to the team from here would replace the dialog underneath, so it is not offered.
  await expect(page.getByTestId('close-guard-save')).toHaveCount(0);
  await shot(page, '30-close-over-draft');

  await page.getByTestId('close-guard-cancel').click();
  await expect(page.getByTestId('close-guard-dialog')).toBeHidden();
  await expect(page.getByTestId('event-title')).toHaveValue('Typed before the X');
  await expect(page.getByTestId('event-notes')).toHaveValue('do not lose me');
  await page.getByTestId('event-day').selectOption('4');
  await page.getByTestId('event-save').click();
  await expect(card('Typed before the X')).toBeVisible();
});

test('a double click on "Add event" adds one event and opens nothing else', async () => {
  await page.getByTestId('new-event').click();
  await page.getByTestId('event-title').fill('Double saved');
  await page.getByTestId('event-day').selectOption('5');
  await page.getByTestId('event-start').selectOption({ label: '16:00' });
  await page.getByTestId('event-end').selectOption({ label: '17:00' });
  await page.getByTestId('event-save').dblclick();
  await expect(card('Double saved')).toHaveCount(1);
  // The second click must not have landed on the grid behind the button.
  await page.waitForTimeout(600);
  await expect(page.getByTestId('event-dialog')).toHaveCount(0);
});

test('an event let go outside the week stays where it was', async () => {
  const moved = card('Double saved');
  const before = [await moved.getAttribute('data-day'), await moved.getAttribute('data-start')];
  const box = await moved.boundingBox();
  if (!box) throw new Error('event not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y - 100, { steps: 5 });
  // Released over the toolbar: a slip, not a wish to hold the lesson at dawn on Sunday.
  await page.mouse.move(40, 20, { steps: 5 });
  await page.mouse.up();
  expect([await moved.getAttribute('data-day'), await moved.getAttribute('data-start')]).toEqual(before);
  await expect(page.getByTestId('event-popover')).toHaveCount(0);
});

test('the Delete key keeps the keyboard in the week, and "Undo" brings back that very event', async () => {
  await addEvent(page, { title: 'To be deleted', day: 2, start: '09:00', end: '10:00' });
  await card('To be deleted').focus();
  await page.keyboard.press('Delete');
  await expect(card('To be deleted')).toHaveCount(0);
  expect(await focusInside('.wg')).toBe(true);

  const toast = page.getByTestId('toast-info').filter({ hasText: 'Event deleted' });
  await expect(toast).toBeVisible();
  // Another change makes that offer meaningless, so it goes away …
  await addEvent(page, { title: 'Something else', day: 3, start: '11:00', end: '12:00' });
  await expect(toast).toHaveCount(0);
  // … while a deletion that is still the last thing done can be taken back from the message.
  await card('Something else').focus();
  await page.keyboard.press('Delete');
  await page.getByTestId('toast-info').filter({ hasText: 'Event deleted' }).getByRole('button', { name: 'Undo' }).click();
  await expect(card('Something else')).toBeVisible();
});

test('a Delete key that is held down deletes one event, not the whole week', async () => {
  const before = await page.locator('.wg-event').count();
  expect(before).toBeGreaterThan(2);
  await card('Something else').focus();
  // The second and third "down" are what a held key sends: repeats.
  await page.keyboard.down('Delete');
  await page.keyboard.down('Delete');
  await page.keyboard.down('Delete');
  await page.keyboard.up('Delete');
  await expect(page.locator('.wg-event')).toHaveCount(before - 1);
  await expect(card('Something else')).toHaveCount(0);
  // The same from the details of an event, which hold the keyboard after a click.
  await card('Double saved').click();
  await expect(page.getByTestId('event-popover')).toBeVisible();
  await page.keyboard.down('Delete');
  await page.keyboard.down('Delete');
  await page.keyboard.up('Delete');
  await expect(page.locator('.wg-event')).toHaveCount(before - 2);
  // Both come back with two Undos.
  await page.keyboard.press('Escape');
  await page.locator('body').press('Control+z');
  await page.locator('body').press('Control+z');
  await expect(page.locator('.wg-event')).toHaveCount(before);
});

test('the week-number box keeps what was typed and says why it leads nowhere', async () => {
  const box = page.getByTestId('week-number-input');
  const label = await page.getByTestId('week-label').textContent();
  for (const typed of ['0', '1e1']) {
    await box.click();
    await box.pressSequentially(typed);
    await box.press('Enter');
    await expect(page.getByTestId('week-number-error')).toContainText(`There is no week`);
    await expect(page.getByTestId('week-number-error')).toContainText(typed);
    await expect(box).toHaveValue(typed);
    expect(await page.getByTestId('week-label').textContent()).toBe(label);
    await box.press('Control+a');
    await box.press('Delete');
  }

  // Week numbers can be typed one after another: after a jump the box is empty and still has the keyboard.
  await box.click();
  await box.pressSequentially('10');
  await box.press('Enter');
  await expect(page.getByTestId('week-label')).toContainText('Week 10');
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
  await page.keyboard.type('11');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('week-label')).toContainText('Week 11');
  await page.getByTestId('week-today').click();
  expect(await page.getByTestId('week-label').textContent()).toBe(label);
});

test('a mistyped branch is refused with the branches that exist; the right name connects', async () => {
  // Publish, so the team's repository has a branch at all.
  await page.getByTestId('sync-publish').click();
  await page.getByTestId('publish-confirm').click();
  await expect(page.getByTestId('publish-dialog')).toBeHidden({ timeout: 60_000 });

  const yossi = await launch(team, 'yossi', { lang: 'en' });
  try {
    const second = yossi.page;
    await expect(second.getByTestId('setup-wizard')).toBeVisible();
    await second.getByTestId('setup-repo-url').fill(team.remote);
    await second.getByTestId('setup-user-name').fill('Yossi Cohen');
    await second.getByTestId('setup-user-email').fill('yossi@example.com');
    await second.locator('.setup__advanced summary').click();
    await second.getByTestId('setup-branch').fill('no-such-branch');
    await second.getByTestId('setup-connect').click();

    await expect(second.getByTestId('branch-missing')).toBeVisible({ timeout: 60_000 });
    await expect(second.getByTestId('branch-missing')).toContainText(/Branches in this repository: \S+/);
    await expect(second.getByTestId('create-branch')).toBeVisible();
    await expect(second.getByTestId('app-ready')).toHaveCount(0);
    await shot(second, '31-branch-missing');

    await second.getByTestId('setup-branch').fill('');
    await second.getByTestId('setup-connect').click();
    await expect(second.getByTestId('app-ready')).toBeVisible({ timeout: 60_000 });
    await expect(second.getByTestId('sync-status')).toHaveAttribute('data-state', 'clean', { timeout: 60_000 });
    await expect(second.locator('.wg-event', { hasText: 'Keyboard lesson' })).toBeVisible();
  } finally {
    await quit(yossi);
  }
});

test('Hebrew: sentences keep their direction around English names, and an empty box starts on the right', async () => {
  await page.getByTestId('lang-he').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // Two lessons in "Room A" at the same time: the double-booking sentence starts with the Latin name.
  await addEvent(page, { title: 'Overlap 1', day: 1, start: '13:00', end: '14:00', location: 'Room A' });
  await page.getByTestId('new-event').click();
  await page.getByTestId('event-title').fill('Overlap 2');
  await page.getByTestId('event-day').selectOption('1');
  await page.getByTestId('event-start').selectOption({ label: '13:00' });
  await page.getByTestId('event-end').selectOption({ label: '14:00' });
  await page.getByTestId('event-location').selectOption({ label: 'Room A' });
  const clash = '[data-testid="event-clash-warning"] .ui-callout__text span';
  await expect(page.locator(clash).first()).toBeVisible();
  expect(await directionOf(clash)).toEqual(['rtl', 'normal']);
  // The notes box is still empty: caret and placeholder belong on the right.
  expect((await directionOf('[data-testid="event-notes"]'))[0]).toBe('rtl');
  // The title holds English text, so that box reads left to right.
  expect((await directionOf('[data-testid="event-title"]'))[0]).toBe('ltr');
  await shot(page, '32-hebrew-clash-sentence');
  await page.getByTestId('event-save').click();

  // "No such week": the range reads 1–N, left to right.
  const box = page.getByTestId('week-number-input');
  await box.click();
  await box.pressSequentially('999');
  await box.press('Enter');
  await expect(page.getByTestId('week-number-error')).toBeVisible();
  await shot(page, '33-hebrew-no-such-week');
  await box.press('Control+a');
  await box.press('Delete');

  // The list of changes in the save dialog: old value, arrow, new value in reading direction.
  await page.getByTestId('week-title-input').fill('שבוע מבחנים');
  await page.getByTestId('week-title-input').press('Enter');
  await page.getByTestId('sync-publish').click();
  await expect(page.getByTestId('publish-dialog')).toBeVisible();
  await expect(page.getByTestId('publish-dialog')).toContainText('←');
  // Measured on screen, not read off the text: the old value stands on the right, the arrow
  // points left to the new one; and the hours of a lesson read 13:00 then 14:00.
  const xOf =(lineIndex: number, text: string): Promise<number> =>
    page.evaluate<number>(
      `(() => {
        const line = [...document.querySelectorAll('.sy-change__detail')][${lineIndex}];
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent.indexOf(${JSON.stringify(text)});
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + ${text.length});
          return range.getBoundingClientRect().left;
        }
        return -1;
      })()`,
    );
  const details = await page.locator('.sy-change__detail').allTextContents();
  const titleLine = details.findIndex((text) => text.includes('←'));
  const eventLineIndex = details.findIndex((text) => text.includes('13:00'));
  expect(titleLine).toBeGreaterThanOrEqual(0);
  expect(eventLineIndex).toBeGreaterThanOrEqual(0);
  const [oldX, arrowX, newX] = [await xOf(titleLine, '(ריק)'), await xOf(titleLine, '←'), await xOf(titleLine, 'שבוע מבחנים')];
  expect(oldX).toBeGreaterThan(arrowX);
  expect(arrowX).toBeGreaterThan(newX);
  expect(await xOf(eventLineIndex, '13:00')).toBeLessThan(await xOf(eventLineIndex, '14:00'));
  await shot(page, '34-hebrew-save-dialog');
  await page.keyboard.press('Escape');
  await page.getByTestId('lang-en').click();
});
