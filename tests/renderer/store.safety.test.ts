/**
 * The store's promises that an independent review of version 1.0.0 found broken:
 *  - what the user confirmed is exactly what runs (also while a background check is waiting
 *    for a slow server), and a decision made on an old picture is never applied to a new one;
 *  - a filter never keeps a list entry that is gone;
 *  - "Undo" on the "event deleted" message undoes that deletion and nothing else;
 *  - a week file always holds the whole week;
 *  - "use my version" never leaves an event pointing at nothing, and never claims success
 *    when nothing could be used.
 */
import { describe, expect, it } from 'vitest';
import type { SyncStatus } from '@shared/api';
import { countEntityUsage, findEntity, findEvent, getWeek, hasActiveFilters, upsertEvent } from '@shared/model';
import { buildFileMap, filesToDataset } from '@shared/serialize';
import type { Dataset, FileMap, ScheduleConfig, ScheduleEvent } from '@shared/types';
import { parseWeekTemplate } from '@shared/weekTemplate';
import { translatorFor, withoutIsolates } from '@renderer/i18n';
import { prefillFromFilters } from '@renderer/lib/commitText';
import { createAppStore, type AppStoreHandle } from '@renderer/store/createStore';
import { FakeBackend } from './fakeApi';

const W = '2026-11-22';
const en = translatorFor('en');

const CONFIG: ScheduleConfig = {
  course: { name: 'DevOps', startDate: '2026-11-01', endDate: '2026-12-31' },
  timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
  subjects: [{ id: 's1', name: 'Lab', color: '#16A34A' }],
  locations: [
    { id: 'l1', name: 'Room 1' },
    { id: 'l2', name: 'Room 2' },
  ],
  teachers: [{ id: 't1', name: 'Dana' }],
  classes: [{ id: 'c1', name: 'Class 1' }],
};

function ev(id: string, patch: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return { id, day: 0, start: 540, end: 600, title: `Event ${id}`, subjectId: null, locationId: null, teacherIds: [], classIds: [], notes: '', ...patch };
}

function dataset(events: ScheduleEvent[], config: ScheduleConfig = CONFIG): Dataset {
  let ds: Dataset = { config, weeks: {} };
  for (const event of events) ds = upsertEvent(ds, W, event);
  return ds;
}

const files = (ds: Dataset): FileMap => buildFileMap(ds, {});
const parse = (map: FileMap): Dataset => filesToDataset(map).dataset;

const A = ev('a', { title: 'Intro' });
const B = ev('b', { title: 'Lab', day: 2, start: 780, end: 840 });
const BASE = dataset([A, B]);

/** A backend whose fetch can be held open, like a server that does not answer. */
class GatedBackend extends FakeBackend {
  private release: (() => void) | null = null;
  private gate: Promise<void> | null = null;

  holdFetch(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  releaseFetch(): void {
    this.release?.();
    this.gate = null;
    this.release = null;
  }

  override async fetch(): Promise<SyncStatus> {
    if (this.gate) await this.gate;
    return super.fetch();
  }
}

async function start(initial: Dataset = BASE): Promise<{ api: GatedBackend; store: AppStoreHandle }> {
  const api = new GatedBackend();
  api.seed(files(initial));
  let n = 0;
  const store = createAppStore(api, {
    background: false,
    persistDelayMs: 0,
    now: () => new Date(2026, 10, 24, 10, 0, 0),
    newId: () => `new${++n}`,
  });
  await store.actions.init();
  await store.whenIdle();
  return { api, store };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const messages = (store: AppStoreHandle): string[] => store.getState().toasts.map((toast) => withoutIsolates(toast.message));

describe('a save or merge that was confirmed while a background check is still waiting for the server', () => {
  it('Save: the window is busy at once, the dialog cannot be closed any more, and exactly what was confirmed goes out', async () => {
    const { api, store } = await start();
    store.actions.saveEvent(W, { ...A, title: 'Intro (edited)' });
    await store.whenIdle();

    api.holdFetch();
    const check = store.actions.checkForUpdates({ interactive: false, silent: true });
    await tick();
    expect(store.getState().busy).toBe('checking');

    store.actions.requestPublish();
    const publishing = store.actions.confirmPublish('my note');
    await tick();

    // From this moment the busy overlay is up and the dialog's buttons are locked …
    expect(store.getState().busy).toBe('publishing');
    // … and "Cancel", Escape or the corner X no longer call off what is already running.
    store.actions.closeDialog();
    expect(store.getState().dialog?.type).toBe('publish');
    expect(api.calls).not.toContain('publish');

    api.releaseFetch();
    await check;
    await publishing;

    expect(api.calls).toContain('publish');
    expect(findEvent(parse(api.team[api.team.length - 1].files), W, 'a')?.title).toBe('Intro (edited)');
    expect(store.getState().dialog).toBeNull();
    expect(store.getState().busy).toBeNull();
    expect(store.getState().diff).toEqual([]);
  });

  it('merge overview: the decision locks the dialog at once', async () => {
    const { api, store } = await start();
    store.actions.saveEvent(W, { ...A, title: 'Mine' });
    await store.whenIdle();
    api.teammatePublishes(files(dataset([{ ...A, title: 'Theirs' }, B])));
    await store.actions.requestUpdate();
    expect(store.getState().dialog?.type).toBe('merge');

    api.holdFetch();
    const check = store.actions.checkForUpdates({ interactive: false, silent: true });
    await tick();
    const resolving = store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'keep-local' });
    await tick();

    expect(store.getState().busy).toBe('updating');
    store.actions.closeDialog();
    expect(store.getState().dialog?.type).toBe('merge');

    api.releaseFetch();
    await check;
    await resolving;
    expect(store.getState().dialog).toBeNull();
    expect(findEvent(store.getState().working, W, 'a')?.title).toBe('Theirs');
    expect(store.getState().aside.map((item) => item.key)).toEqual([`event:${W}:a`]);
  });

  it('a dialog whose operation is not running closes as always', async () => {
    const { store } = await start();
    store.actions.saveEvent(W, { ...A, title: 'Edited' });
    store.actions.requestPublish();
    store.actions.closeDialog();
    expect(store.getState().dialog).toBeNull();
  });
});

describe('a merge decision made on an old picture', () => {
  it('is not applied when the schedule changed after the overview was drawn: the overview is built again and nothing is lost', async () => {
    const { api, store } = await start();
    store.actions.saveEvent(W, { ...A, title: 'Mine' });
    await store.whenIdle();
    api.teammatePublishes(files(dataset([{ ...A, title: 'Theirs' }, B])));
    await store.actions.requestUpdate();
    const first = store.getState().dialog;
    expect(first?.type).toBe('merge');

    // Something changes the working copy while the overview is on screen.
    store.actions.saveEvent(W, ev('fresh', { title: 'Added afterwards', day: 4 }));
    await store.whenIdle();

    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'theirs', then: 'keep-local' });

    const state = store.getState();
    // Nothing was merged with the old decision …
    expect(findEvent(state.working, W, 'a')?.title).toBe('Mine');
    // … what was added afterwards is still there, on screen and on disk …
    expect(findEvent(state.working, W, 'fresh')?.title).toBe('Added afterwards');
    expect(findEvent(parse(api.working), W, 'fresh')?.title).toBe('Added afterwards');
    // … and the user is shown a fresh overview, computed from the schedule as it is now.
    expect(state.dialog?.type).toBe('merge');
    if (state.dialog?.type !== 'merge' || first?.type !== 'merge') throw new Error('expected merge dialogs');
    expect(state.dialog.session).not.toBe(first.session);
    expect(state.dialog.session.mine).toBe(state.working);
    expect(messages(store)).toContain(en.t('store.mergeOutdated'));
    expect(state.busy).toBeNull();

    // Deciding on the new overview works.
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'theirs', then: 'keep-local' });
    expect(findEvent(store.getState().working, W, 'a')?.title).toBe('Theirs');
    expect(findEvent(store.getState().working, W, 'fresh')?.title).toBe('Added afterwards');
    expect(store.getState().dialog).toBeNull();
  });
});

describe('a filter never keeps a list entry that is gone', () => {
  it('removing the entry here takes it out of the filter, so nothing is hidden behind an invisible filter', async () => {
    const { store } = await start(dataset([{ ...A, locationId: 'l1' }, { ...B, locationId: 'l2' }]));
    store.actions.setFilters({ locationIds: ['l1'], teacherIds: ['t1'] });
    store.actions.removeEntity('location', 'l1');

    const state = store.getState();
    expect(state.filters.locationIds).toEqual([]);
    // Other filters are untouched.
    expect(state.filters.teacherIds).toEqual(['t1']);
    expect(prefillFromFilters(state.filters)).toEqual({ teacherIds: ['t1'] });
  });

  it('an update in which a teammate removed the entry does the same', async () => {
    const { api, store } = await start(dataset([{ ...A, classIds: ['c1'] }, B]));
    store.actions.setFilters({ classIds: ['c1'] });
    api.teammatePublishes(files(dataset([{ ...A, classIds: [] }, B], { ...CONFIG, classes: [] })));

    await store.actions.requestUpdate();

    const state = store.getState();
    expect(state.working.config.classes).toEqual([]);
    expect(state.filters.classIds).toEqual([]);
    expect(hasActiveFilters(state.filters)).toBe(false);
    // A new event made now is not pre-filled with the class that no longer exists.
    expect(prefillFromFilters(state.filters)).toEqual({});
  });

  it('a filter on entries that still exist is left exactly as it is (the same object)', async () => {
    const { store } = await start();
    store.actions.setFilters({ locationIds: ['l2'] });
    const before = store.getState().filters;
    store.actions.saveEvent(W, { ...A, title: 'Edited' });
    store.actions.removeEntity('location', 'l1');
    expect(store.getState().filters).toBe(before);
  });
});

describe('the "Event deleted · Undo" message', () => {
  it('brings back exactly the event that was deleted', async () => {
    const { store } = await start();
    store.actions.deleteEvent(W, 'a');
    const toast = store.getState().toasts.find((entry) => entry.action);
    expect(withoutIsolates(toast?.message ?? '')).toBe(en.t('grid.deleted'));
    toast?.action?.run();
    expect(getWeek(store.getState().working, W).events.map((event) => event.id)).toEqual(['a', 'b']);
  });

  it('disappears with the next change, and its button can no longer undo that other change', async () => {
    const { store } = await start();
    store.actions.deleteEvent(W, 'a');
    const toast = store.getState().toasts.find((entry) => entry.action);
    expect(toast).toBeDefined();

    store.actions.saveEvent(W, { ...B, start: 600, end: 660 });
    expect(store.getState().toasts.some((entry) => entry.id === toast?.id)).toBe(false);

    // A click that was already on its way must not undo the move of the other event.
    toast?.action?.run();
    expect(getWeek(store.getState().working, W).events.map((event) => event.id)).toEqual(['b']);
    expect(findEvent(store.getState().working, W, 'b')?.start).toBe(600);
  });

  it('disappears when the deletion was undone another way (Ctrl+Z)', async () => {
    const { store } = await start();
    store.actions.saveEvent(W, { ...B, title: 'Lab (older edit)' });
    store.actions.deleteEvent(W, 'a');
    const toast = store.getState().toasts.find((entry) => entry.action);
    store.actions.undo();
    expect(store.getState().toasts.some((entry) => entry.id === toast?.id)).toBe(false);
    // Its button would otherwise have undone the older, unrelated edit.
    toast?.action?.run();
    expect(findEvent(store.getState().working, W, 'b')?.title).toBe('Lab (older edit)');
  });

  it('says nothing when nothing was deleted', async () => {
    const { store } = await start();
    store.actions.deleteEvent(W, 'no-such-event');
    expect(store.getState().toasts).toEqual([]);
    expect(store.getState().canUndo).toBe(false);
  });
});

describe('a week file', () => {
  it('holds the whole week also while a filter is on, and says how many events it holds', async () => {
    const { api, store } = await start(dataset([{ ...A, locationId: 'l1' }, { ...B, locationId: 'l2' }]));
    store.actions.setFilters({ locationIds: ['l1'] });
    api.saveAnswers = ['C:\\exports\\week.week.json'];

    await store.actions.exportWeekFile(W, { filteredOnly: false });

    const template = parseWeekTemplate(api.saved[0].request.content);
    expect(template.events.map((event) => event.title)).toEqual(['Intro', 'Lab']);
    expect(messages(store)).toContain(en.tn('store.exportWeekDone', 2));
  });
});

describe('"use my version" of something that was kept aside', () => {
  it('a version that no longer fits stays in the list, and the message says so instead of "it is back"', async () => {
    const { api, store } = await start(dataset([A]));
    // I end the day at 10:00; the team moves the day to 12:00–19:00.
    store.actions.updateTimeGrid({ dayEnd: 600 });
    await store.whenIdle();
    api.teammatePublishes(files(dataset([A], { ...CONFIG, timeGrid: { dayStart: 720, dayEnd: 1140, slotMinutes: 30 } })));
    await store.actions.requestUpdate();
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'keep-local' });
    expect(store.getState().aside.map((item) => item.key)).toEqual(['timeGrid.dayEnd']);
    const toastsBefore = store.getState().toasts.length;

    store.actions.applyAside('timeGrid.dayEnd');

    const state = store.getState();
    expect(state.working.config.timeGrid).toEqual({ dayStart: 720, dayEnd: 1140, slotMinutes: 30 });
    expect(state.aside.map((item) => item.key)).toEqual(['timeGrid.dayEnd']);
    expect(state.canUndo).toBe(false);
    const fresh = state.toasts.slice(toastsBefore);
    expect(fresh.map((toast) => toast.kind)).toEqual(['warning']);
    expect(withoutIsolates(fresh[0].message)).toBe(en.t('store.asideCannotApply'));
  });

  it('my deletion of a room that events use asks first, then takes the room out of those events too', async () => {
    const { api, store } = await start(dataset([{ ...A, locationId: 'l1' }]));
    store.actions.removeEntity('location', 'l1');
    await store.whenIdle();
    // Meanwhile the team renames the room and books a new lesson in it.
    const teamConfig: ScheduleConfig = { ...CONFIG, locations: [{ id: 'l1', name: 'Room 1 (lab)' }, { id: 'l2', name: 'Room 2' }] };
    const T = ev('t', { title: 'Team lesson', day: 3, locationId: 'l1' });
    api.teammatePublishes(files(dataset([{ ...A, locationId: 'l1' }, T], teamConfig)));
    await store.actions.requestUpdate();
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'keep-local' });
    expect(store.getState().aside.map((item) => item.key)).toEqual(['location:l1']);
    // My deletion did not happen, so the team's events — and mine — still use the room.
    expect(countEntityUsage(store.getState().working, 'location', 'l1')).toBe(2);

    store.actions.openDialog({ type: 'aside' });
    store.actions.applyAside('location:l1');

    // Nothing has changed yet: the user is told how many events use the room.
    const asked = store.getState().dialog;
    if (asked?.type !== 'confirm') throw new Error('expected a confirmation');
    expect(withoutIsolates(asked.message)).toBe(en.tn('settings.removeText', 2));
    expect(findEntity(store.getState().working.config, 'location', 'l1')).toBeDefined();

    await asked.onConfirm();

    const state = store.getState();
    expect(state.working.config.locations.map((location) => location.id)).toEqual(['l2']);
    expect(countEntityUsage(state.working, 'location', 'l1')).toBe(0);
    expect(findEvent(state.working, W, 't')?.locationId).toBeNull();
    expect(state.aside).toEqual([]);
    // One undo step brings back the room, its use, and the kept-aside entry.
    store.actions.undo();
    expect(countEntityUsage(store.getState().working, 'location', 'l1')).toBe(2);
    expect(store.getState().aside.map((item) => item.key)).toEqual(['location:l1']);
  });

  it('my version of an event comes back whole: a teacher who was removed meanwhile comes back with it, and the user is told', async () => {
    const { api, store } = await start(dataset([{ ...A, teacherIds: ['t1'] }]));
    store.actions.saveEvent(W, { ...A, teacherIds: ['t1'], title: 'Mine' });
    await store.whenIdle();
    // The team removes the teacher (which takes her off the event) and renames the event.
    api.teammatePublishes(files(dataset([{ ...A, teacherIds: [], title: 'Theirs' }], { ...CONFIG, teachers: [] })));
    await store.actions.requestUpdate();
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'keep-local' });
    expect(store.getState().working.config.teachers).toEqual([]);
    const toastsBefore = store.getState().toasts.length;

    store.actions.applyAside(`event:${W}:a`);

    const state = store.getState();
    expect(findEvent(state.working, W, 'a')).toMatchObject({ title: 'Mine', teacherIds: ['t1'] });
    expect(state.working.config.teachers).toEqual([{ id: 't1', name: 'Dana' }]);
    const said = state.toasts.slice(toastsBefore).map((toast) => withoutIsolates(toast.message));
    expect(said).toContain(en.t('store.asideApplied'));
    expect(said).toContain(withoutIsolates(en.t('store.noteRestored', { kind: en.t('store.kindTeacher'), name: 'Dana' })));
  });
});

describe('the question "close the window?"', () => {
  it('answering "stay" brings back the dialog it was laid over', async () => {
    const { store } = await start();
    const covered = { type: 'event', weekStart: W, eventId: 'a' } as const;
    store.actions.openDialog({ type: 'close-guard', covered, draft: true });
    store.actions.closeDialog();
    expect(store.getState().dialog).toBe(covered);
  });

  it('with nothing underneath it simply closes', async () => {
    const { store } = await start();
    store.actions.openDialog({ type: 'close-guard', covered: null, draft: false });
    store.actions.closeDialog();
    expect(store.getState().dialog).toBeNull();
  });
});
