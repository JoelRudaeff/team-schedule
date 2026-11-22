/**
 * What the store does when the window is asked to close. This part only runs with a real
 * window (`background: true`), so the few things it needs from one are stood in for here.
 * (Added after a review found this logic covered by one end-to-end test only.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertEvent } from '@shared/model';
import { buildFileMap } from '@shared/serialize';
import type { Dataset, ScheduleConfig, ScheduleEvent } from '@shared/types';
import { createAppStore, type AppStoreHandle } from '@renderer/store/createStore';
import type { DialogState } from '@renderer/store/types';
import { FakeBackend } from './fakeApi';

const W = '2026-11-22';

const CONFIG: ScheduleConfig = {
  course: { name: 'DevOps', startDate: null, endDate: null },
  timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
  subjects: [],
  locations: [],
  teachers: [],
  classes: [],
};

const A: ScheduleEvent = { id: 'a', day: 0, start: 540, end: 600, title: 'Intro', subjectId: null, locationId: null, teacherIds: [], classIds: [], notes: '' };
const BASE: Dataset = upsertEvent({ config: CONFIG, weeks: {} }, W, A);

/** As much of an element as the store looks at: it can lose and take the focus. */
class FakeElement {
  log: string[] = [];
  onBlur: (() => void) | null = null;
  blur(): void {
    this.log.push('blur');
    this.onBlur?.();
  }
  focus(): void {
    this.log.push('focus');
  }
}

interface FakeDocument {
  documentElement: { lang: string; dir: string };
  title: string;
  body: FakeElement;
  activeElement: FakeElement | null;
}

let page: FakeDocument;

beforeEach(() => {
  // The store starts its periodic check with setInterval; nothing here should keep ticking.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const body = new FakeElement();
  page = { documentElement: { lang: '', dir: '' }, title: '', body, activeElement: body };
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('document', page);
  vi.stubGlobal('window', { addEventListener: () => undefined });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function start(): Promise<{ api: FakeBackend; store: AppStoreHandle }> {
  const api = new FakeBackend();
  api.seed(buildFileMap(BASE, {}));
  const store = createAppStore(api, { background: true, persistDelayMs: 0, now: () => new Date(2026, 10, 24, 10, 0, 0) });
  await store.actions.init();
  await store.whenIdle();
  return { api, store };
}

/** Lets the store's reaction to a close request run to its end. */
async function settle(api: FakeBackend, store: AppStoreHandle): Promise<void> {
  const acks = (): number => api.calls.filter((call) => call === 'ackCloseRequest').length;
  const before = acks();
  api.requestClose();
  for (let turn = 0; turn < 200 && acks() === before; turn++) await new Promise((resolve) => setTimeout(resolve, 1));
  // After the acknowledgement: the flush and whatever the store decided.
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 1));
  await store.whenIdle();
}

describe('the window is asked to close', () => {
  it('with nothing unpublished and nothing half-written it simply closes', async () => {
    const { api, store } = await start();
    await settle(api, store);
    expect(api.closed).toBe(true);
    expect(store.getState().dialog).toBeNull();
  });

  it('with unpublished changes it asks, and stays open', async () => {
    const { api, store } = await start();
    store.actions.saveEvent(W, { ...A, title: 'Edited' });
    await settle(api, store);
    expect(api.closed).toBe(false);
    expect(store.getState().dialog).toEqual({ type: 'close-guard', covered: null, draft: false });
  });

  it('over a half-written event it asks even when nothing is unpublished, and "stay" gives the event dialog back', async () => {
    const { api, store } = await start();
    const editing: DialogState = { type: 'event', weekStart: W, eventId: null };
    store.actions.openDialog(editing);
    store.actions.setDraftDirty(true);

    await settle(api, store);

    expect(api.closed).toBe(false);
    const asked = store.getState().dialog;
    if (asked?.type !== 'close-guard') throw new Error('expected the close question');
    expect(asked.covered).toBe(editing);
    expect(asked.draft).toBe(true);

    store.actions.closeDialog();
    expect(store.getState().dialog).toBe(editing);
  });

  it('an event dialog that was not changed does not hold the window', async () => {
    const { api, store } = await start();
    store.actions.openDialog({ type: 'event', weekStart: W, eventId: 'a' });
    store.actions.setDraftDirty(false);
    await settle(api, store);
    expect(api.closed).toBe(true);
  });

  it('a second request while the question is open is not an answer: nothing changes', async () => {
    const { api, store } = await start();
    store.actions.saveEvent(W, { ...A, title: 'Edited' });
    await settle(api, store);
    const asked = store.getState().dialog;

    await settle(api, store);

    expect(store.getState().dialog).toBe(asked);
    expect(api.closed).toBe(false);
  });

  it('another dialog that is open is covered, not replaced', async () => {
    const { api, store } = await start();
    store.actions.saveEvent(W, { ...A, title: 'Edited' });
    const settings: DialogState = { type: 'settings', tab: 'course' };
    store.actions.openDialog(settings);

    await settle(api, store);

    const asked = store.getState().dialog;
    if (asked?.type !== 'close-guard') throw new Error('expected the close question');
    expect(asked.covered).toBe(settings);
    expect(asked.draft).toBe(false);
  });

  it('a box that is still being typed in hands its text over first, and gets the keyboard back', async () => {
    const { api, store } = await start();
    // The week-name box commits when it loses the focus.
    const box = new FakeElement();
    box.onBlur = () => store.actions.setWeekTitle(W, 'Typed, not yet committed');
    page.activeElement = box;

    await settle(api, store);

    expect(box.log).toEqual(['blur', 'focus']);
    // The typed name counts as an unpublished change now, so the window asks instead of closing over it.
    expect(store.getState().working.weeks[W].title).toBe('Typed, not yet committed');
    expect(api.closed).toBe(false);
    expect(store.getState().dialog?.type).toBe('close-guard');
  });
});
