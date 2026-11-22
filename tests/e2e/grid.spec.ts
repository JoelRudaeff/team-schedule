/**
 * Mouse work on the week grid: click and drag to create, drag to move, drag the lower edge
 * to resize — in both reading directions, since the day columns are mirrored in Hebrew.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { connect, createTeam, launch, quit, removeTeam, shot, type AppHandle, type Team } from './helpers';

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

const column = (day: number): Locator => page.getByTestId(`day-column-${day}`);
const card = (title: string): Locator => page.locator('.wg-event', { hasText: title });

/** Screen position of a time of day inside a day column (the grid starts at 08:00 with 30-minute rows of 28px). */
async function pointAt(day: number, minutes: number): Promise<{ x: number; y: number }> {
  const box = await column(day).boundingBox();
  if (!box) throw new Error('column not visible');
  return { x: box.x + box.width / 2, y: box.y + ((minutes - 480) / 30) * 28 + 2 };
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

test('clicking a slot opens a new event at that time', async () => {
  const at = await pointAt(1, 600);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('event-dialog')).toBeVisible();
  await expect(page.getByTestId('event-day')).toHaveValue('1');
  await expect(page.getByTestId('event-start')).toHaveValue('600');
  await expect(page.getByTestId('event-end')).toHaveValue('660');
  await page.getByTestId('event-title').fill('Clicked');
  await page.getByTestId('event-title').press('Enter');
  await expect(card('Clicked')).toHaveAttribute('data-start', '600');
});

test('dragging across slots creates an event of that length', async () => {
  await drag(await pointAt(3, 540), await pointAt(3, 690));
  await expect(page.getByTestId('event-dialog')).toBeVisible();
  await expect(page.getByTestId('event-day')).toHaveValue('3');
  await expect(page.getByTestId('event-start')).toHaveValue('540');
  await expect(page.getByTestId('event-end')).toHaveValue('690');
  await page.getByTestId('event-title').fill('Dragged');
  await page.getByTestId('event-save').click();
  await expect(card('Dragged')).toHaveAttribute('data-end', '690');
});

test('dragging an event moves it to another day and time, keeping its length', async () => {
  const box = await card('Dragged').boundingBox();
  if (!box) throw new Error('event not visible');
  // Grab it 10px below its top edge and drop it on Friday so that its start lands on 11:00.
  const target = await pointAt(5, 660);
  await drag({ x: box.x + box.width / 2, y: box.y + 10 }, { x: target.x, y: target.y + 8 });
  await expect(card('Dragged')).toHaveAttribute('data-day', '5');
  await expect(card('Dragged')).toHaveAttribute('data-start', '660');
  await expect(card('Dragged')).toHaveAttribute('data-end', '810');
});

test('dragging the lower edge changes the end time', async () => {
  const box = await card('Clicked').boundingBox();
  if (!box) throw new Error('event not visible');
  const target = await pointAt(1, 750);
  await drag({ x: box.x + box.width / 2, y: box.y + box.height - 2 }, target);
  await expect(card('Clicked')).toHaveAttribute('data-start', '600');
  await expect(card('Clicked')).toHaveAttribute('data-end', '750');
});

test('a double click opens the editor; undo and redo work from the keyboard', async () => {
  await card('Clicked').dblclick();
  await expect(page.getByTestId('event-dialog')).toBeVisible();
  await page.getByTestId('event-cancel').click();

  await page.getByTestId('week-grid').focus().catch(() => undefined);
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+z');
  await expect(card('Clicked')).toHaveAttribute('data-end', '660');
  await page.keyboard.press('Control+y');
  await expect(card('Clicked')).toHaveAttribute('data-end', '750');
});

test('the same gestures work mirrored in Hebrew', async () => {
  await page.getByTestId('lang-he').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  // Sunday is now the right-most column: the column test ids still mean the same days.
  const sunday = await column(0).boundingBox();
  const saturday = await column(6).boundingBox();
  if (!sunday || !saturday) throw new Error('columns not visible');
  expect(sunday.x).toBeGreaterThan(saturday.x);

  await drag(await pointAt(0, 480), await pointAt(0, 570));
  await expect(page.getByTestId('event-dialog')).toBeVisible();
  await expect(page.getByTestId('event-day')).toHaveValue('0');
  await expect(page.getByTestId('event-start')).toHaveValue('480');
  await expect(page.getByTestId('event-end')).toHaveValue('570');
  await page.getByTestId('event-title').fill('ראשון בבוקר');
  await page.getByTestId('event-save').click();

  const box = await card('ראשון בבוקר').boundingBox();
  if (!box) throw new Error('event not visible');
  const target = await pointAt(2, 480);
  await drag({ x: box.x + box.width / 2, y: box.y + 10 }, { x: target.x, y: target.y + 8 });
  await expect(card('ראשון בבוקר')).toHaveAttribute('data-day', '2');
  await expect(card('ראשון בבוקר')).toHaveAttribute('data-start', '480');
  await shot(page, '30-grid-hebrew-after-drag');
});
