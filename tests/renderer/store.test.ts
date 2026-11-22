/**
 * The application store driven through a fake main process: whole user scenarios, with the
 * emphasis on the rule that matters most — nobody's work is lost unless the user chose so.
 */
import { describe, expect, it } from 'vitest';
import { eventKey } from '@shared/merge';
import { findEvent, getWeek, upsertEvent } from '@shared/model';
import { buildFileMap, filesToDataset } from '@shared/serialize';
import type { Dataset, FileMap, ScheduleConfig, ScheduleEvent } from '@shared/types';
import { serializeWeekTemplate, exportWeekTemplate } from '@shared/weekTemplate';
import { createAppStore, type AppStoreHandle } from '@renderer/store/createStore';
import type { DialogState, MergeSession } from '@renderer/store/types';
import { FakeBackend } from './fakeApi';

const W = '2026-11-22';
const W2 = '2026-11-29';

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
  return {
    id,
    day: 0,
    start: 540,
    end: 600,
    title: `Event ${id}`,
    subjectId: null,
    locationId: null,
    teacherIds: [],
    classIds: [],
    notes: '',
    ...patch,
  };
}

function dataset(events: ScheduleEvent[], title = ''): Dataset {
  let ds: Dataset = { config: CONFIG, weeks: title === '' ? {} : { [W]: { weekStart: W, title, events: [] } } };
  for (const event of events) ds = upsertEvent(ds, W, event);
  return ds;
}

const files = (ds: Dataset): FileMap => buildFileMap(ds, {});
const parse = (map: FileMap): Dataset => filesToDataset(map).dataset;

const A = ev('a', { title: 'Intro', start: 540, end: 600 });
const B = ev('b', { title: 'Lab', day: 2, start: 780, end: 840 });
const BASE = dataset([A, B]);

interface Rig {
  api: FakeBackend;
  store: AppStoreHandle;
}

/** A started app whose local copy is in sync with a team repository containing `initial`. */
async function start(initial: Dataset = BASE, prepare?: (api: FakeBackend) => void): Promise<Rig> {
  const api = new FakeBackend();
  api.seed(files(initial));
  prepare?.(api);
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

function mergeSession(store: AppStoreHandle): MergeSession {
  const dialog = store.getState().dialog;
  if (dialog?.type !== 'merge') throw new Error(`expected the merge dialog, got ${dialog?.type ?? 'none'}`);
  return dialog.session;
}

const lastToast = (store: AppStoreHandle) => store.getState().toasts.at(-1);

describe('start-up', () => {
  it('loads the schedule and shows the current week', async () => {
    const { store } = await start();
    const state = store.getState();
    expect(state.phase).toBe('ready');
    expect(state.weekStart).toBe(W);
    expect(getWeek(state.working, W).events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(state.diff).toEqual([]);
    expect(state.sync).toMatchObject({ ahead: 0, behind: 0 });
  });

  it('goes to the set-up screen without a repository, and to "create" for an empty one', async () => {
    const setup = await start(BASE, (api) => (api.phase = 'not-configured'));
    expect(setup.store.getState().phase).toBe('setup');
    const init = await start(BASE, (api) => (api.phase = 'needs-init'));
    expect(init.store.getState().phase).toBe('needs-init');
  });

  it('picks Hebrew on the first start of a Hebrew Windows and remembers it', async () => {
    const { store, api } = await start(BASE, (fake) => {
      fake.firstRun = true;
      fake.systemLocale = 'he-IL';
    });
    expect(store.getState().lang).toBe('he');
    expect(api.settings.language).toBe('he');
  });

  it('reports a failed start instead of hanging', async () => {
    const { store } = await start(BASE, (api) => (api.throwOn = 'boot'));
    expect(store.getState().phase).toBe('fatal');
    expect(store.getState().fatalError?.detail).toContain('fake bridge failure');
  });

  it('refuses to work on a schedule saved by a newer app version', async () => {
    const { store } = await start(BASE, (api) => {
      api.working['schedule.json'] = api.working['schedule.json'].replace('"formatVersion": 1', '"formatVersion": 99');
    });
    expect(store.getState().phase).toBe('fatal');
  });

  it('treats a vanished local schedule.json as "use the team\'s settings", not as "everything deleted"', async () => {
    const { store, api } = await start(BASE, (fake) => {
      delete fake.working['schedule.json'];
    });
    expect(store.getState().phase).toBe('ready');
    expect(store.getState().working.config).toEqual(CONFIG);
    expect(store.getState().diff).toEqual([]);
    expect(api.working['schedule.json']).toBe(files(BASE)['schedule.json']);
  });
});

describe('editing', () => {
  it('keeps edits on disk as unpublished changes and counts them', async () => {
    const { store, api } = await start();
    store.actions.saveEvent(W, ev('c', { title: 'New', day: 3 }));
    store.actions.setWeekTitle(W, 'Docker week');
    await store.whenIdle();
    const state = store.getState();
    expect(state.diff.map((d) => d.key).sort()).toEqual([eventKey(W, 'c'), `weekTitle:${W}`].sort());
    expect(state.diffByKey.get(eventKey(W, 'c'))?.change).toBe('added');
    expect(parse(api.working).weeks[W]).toMatchObject({ title: 'Docker week' });
    expect(findEvent(parse(api.working), W, 'c')?.title).toBe('New');
    // Nothing reached the team.
    expect(api.team).toHaveLength(1);
  });

  it('undoes and redoes step by step', async () => {
    const { store, api } = await start();
    store.actions.saveEvent(W, { ...A, title: 'Changed' });
    store.actions.deleteEvent(W, 'b');
    expect(store.getState().canUndo).toBe(true);
    store.actions.undo();
    expect(findEvent(store.getState().working, W, 'b')).toBeDefined();
    store.actions.undo();
    expect(store.getState().diff).toEqual([]);
    expect(store.getState().canUndo).toBe(false);
    store.actions.redo();
    expect(findEvent(store.getState().working, W, 'a')?.title).toBe('Changed');
    await store.whenIdle();
    expect(findEvent(parse(api.working), W, 'a')?.title).toBe('Changed');
  });

  it('duplicates an event and manages list entries', async () => {
    const { store } = await start();
    const copyId = store.actions.duplicateEvent(W, 'a');
    expect(copyId).toBe('new1');
    expect(findEvent(store.getState().working, W, 'new1')).toMatchObject({ title: 'Intro', start: 540 });

    const roomId = store.actions.addEntity('location', '  Lab B ');
    expect(store.actions.addEntity('location', 'lab b')).toBe(roomId);
    expect(store.actions.addEntity('location', '   ')).toBe('');
    const subjectId = store.actions.addEntity('subject', 'Exam');
    expect(store.getState().working.config.subjects.find((s) => s.id === subjectId)?.color).toMatch(/^#[0-9A-F]{6}$/);

    store.actions.saveEvent(W, { ...A, locationId: roomId });
    store.actions.removeEntity('location', roomId);
    expect(findEvent(store.getState().working, W, 'a')?.locationId).toBeNull();
    expect(store.getState().working.config.locations.some((l) => l.id === roomId)).toBe(false);
  });

  it('never rewrites a week file it cannot read, and blocks editing that week', async () => {
    const broken = '{ this is not json';
    const { store, api } = await start(BASE, (fake) => {
      fake.working[`weeks/${W2}.json`] = broken;
    });
    expect(store.getState().readOnlyWeeks).toEqual([W2]);
    expect(store.getState().problems).toHaveLength(1);
    store.actions.saveEvent(W2, ev('x'));
    expect(lastToast(store)?.kind).toBe('warning');
    store.actions.saveEvent(W, ev('c'));
    await store.whenIdle();
    expect(api.working[`weeks/${W2}.json`]).toBe(broken);
    expect(findEvent(parse(api.working), W, 'c')).toBeDefined();
  });

  it('navigates by week number (course weeks) and by date', async () => {
    const { store } = await start();
    expect(store.actions.goToWeekNumber(1)).toBe(true);
    expect(store.getState().weekStart).toBe('2026-11-01');
    expect(store.actions.goToWeekNumber(99)).toBe(false);
    expect(store.getState().weekStart).toBe('2026-11-01');
    store.actions.goToWeek('2026-12-09');
    expect(store.getState().weekStart).toBe('2026-12-06');
    store.actions.goToRelativeWeek(-1);
    expect(store.getState().weekStart).toBe('2026-11-29');
    store.actions.goToToday();
    expect(store.getState().weekStart).toBe(W);
  });
});

describe('saving to the team', () => {
  it('asks first, then commits and pushes with a readable message', async () => {
    const { store, api } = await start();
    store.actions.requestPublish();
    expect(lastToast(store)?.kind).toBe('info'); // nothing to publish yet
    expect(store.getState().dialog).toBeNull();

    store.actions.saveEvent(W, ev('c', { title: 'New lesson', day: 3 }));
    store.actions.requestPublish();
    expect(store.getState().dialog).toEqual({ type: 'publish' });
    await store.actions.confirmPublish('  adding Wednesday ');

    expect(api.team).toHaveLength(2);
    expect(api.tip.authorName).toBe('Me');
    expect(api.tip.message.split('\n')[0]).toBe('adding Wednesday');
    expect(api.tip.message).toContain('Update schedule: events +1');
    expect(api.tip.message).toContain('"New lesson"');
    expect(findEvent(parse(api.tip.files), W, 'c')).toBeDefined();
    const state = store.getState();
    expect(state.diff).toEqual([]);
    expect(state.dialog).toBeNull();
    expect(state.busy).toBeNull();
    expect(lastToast(store)?.kind).toBe('success');
  });

  it('shows the merge overview when the team changed, even without collisions, and then publishes both', async () => {
    const { store, api } = await start();
    api.teammatePublishes(files(dataset([A, B, ev('t', { title: 'Team lesson', day: 4 })])));
    store.actions.saveEvent(W, ev('m', { title: 'My lesson', day: 5 }));
    await store.actions.confirmPublish('');

    const session = mergeSession(store);
    expect(session).toMatchObject({ mode: 'publish', changedAgain: false });
    expect(session.result.conflictCount).toBe(0);
    expect(session.incoming.map((c) => c.authorName)).toEqual(['Dana']);
    expect(api.team).toHaveLength(2); // nothing went out yet

    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'publish' });
    const published = parse(api.tip.files);
    expect(findEvent(published, W, 't')).toBeDefined();
    expect(findEvent(published, W, 'm')).toBeDefined();
    expect(store.getState().diff).toEqual([]);
    expect(store.getState().dialog).toBeNull();
    expect(store.getState().aside).toEqual([]);
  });

  /** Both sides changed event `a`; the team also added `t`, I also added `m`. */
  async function collision(): Promise<Rig & { key: string }> {
    const rig = await start();
    rig.api.teammatePublishes(
      files(dataset([{ ...A, start: 600, end: 660 }, B, ev('t', { title: 'Team lesson', day: 4 })])),
    );
    rig.store.actions.saveEvent(W, { ...A, start: 480, end: 540 });
    rig.store.actions.saveEvent(W, ev('m', { title: 'My lesson', day: 5 }));
    await rig.store.actions.confirmPublish('my note');
    const session = mergeSession(rig.store);
    expect(session.result.conflictCount).toBe(1);
    return { ...rig, key: eventKey(W, 'a') };
  }

  it('"just push": my version wins the collision, the team\'s other changes are kept', async () => {
    const { store, api } = await collision();
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'mine', then: 'publish' });
    const published = parse(api.tip.files);
    expect(findEvent(published, W, 'a')).toMatchObject({ start: 480, end: 540 });
    expect(findEvent(published, W, 't')).toBeDefined();
    expect(findEvent(published, W, 'm')).toBeDefined();
    expect(api.tip.message.split('\n')[0]).toBe('my note');
    expect(store.getState().aside).toEqual([]);
    expect(store.getState().diff).toEqual([]);
  });

  it('"just update": the team\'s version wins, my other changes stay unpublished, nothing is sent', async () => {
    const { store, api, key } = await collision();
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'theirs', then: 'keep-local' });
    expect(api.team).toHaveLength(2);
    const state = store.getState();
    expect(findEvent(state.working, W, 'a')).toMatchObject({ start: 600, end: 660 });
    expect(findEvent(state.working, W, 't')).toBeDefined();
    expect(state.diff.map((d) => d.key)).toEqual([eventKey(W, 'm')]);
    expect(state.diffByKey.has(key)).toBe(false);
    expect(state.aside).toEqual([]);
    expect(state.sync).toMatchObject({ behind: 0 });
    expect(state.dialog).toBeNull();
    expect(state.canUndo).toBe(false);
  });

  it('"update and keep mine aside": the team\'s version is shown, mine waits for a decision', async () => {
    const { store, api, key } = await collision();
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'keep-local' });
    expect(api.team).toHaveLength(2);
    let state = store.getState();
    expect(findEvent(state.working, W, 'a')).toMatchObject({ start: 600 });
    expect(state.aside).toHaveLength(1);
    expect(state.aside[0]).toMatchObject({ key, kind: 'event', weekStart: W });
    expect(state.aside[0].mine).toMatchObject({ start: 480, end: 540 });
    expect(state.aside[0].theirs).toMatchObject({ start: 600, end: 660 });
    expect(api.aside).toHaveLength(1); // stored on this computer

    // Deciding later: my version comes back as a normal unpublished edit.
    store.actions.applyAside(key);
    state = store.getState();
    expect(state.aside).toEqual([]);
    expect(api.aside).toEqual([]);
    expect(findEvent(state.working, W, 'a')).toMatchObject({ start: 480, end: 540 });
    expect(state.diffByKey.get(key)?.change).toBe('modified');
  });

  it('lets each collision be decided separately', async () => {
    const { store, api, key } = await collision();
    await store.actions.resolveMerge({ resolutions: { [key]: 'aside' }, defaultResolution: 'mine', then: 'publish' });
    const published = parse(api.tip.files);
    expect(findEvent(published, W, 'a')).toMatchObject({ start: 600 });
    expect(findEvent(published, W, 'm')).toBeDefined();
    expect(store.getState().aside.map((item) => item.key)).toEqual([key]);
    store.actions.discardAside(key);
    expect(store.getState().aside).toEqual([]);
  });

  it('survives a teammate publishing during the push: nothing is lost, the overview comes back', async () => {
    const { store, api, key } = await collision();
    const beforeRace = parse(api.tip.files);
    api.beforePush = () => {
      api.teammatePublishes(files(upsertEvent(beforeRace, W, ev('late', { title: 'Late addition', day: 6 }))), 'Noa');
    };
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'publish' });

    // My colliding version must not have evaporated with the failed push.
    expect(store.getState().aside.map((item) => item.key)).toEqual([key]);
    const session = mergeSession(store);
    expect(session).toMatchObject({ mode: 'publish', changedAgain: true, note: 'my note' });
    expect(session.result.conflictCount).toBe(0);
    expect(session.incoming.map((c) => c.authorName)).toEqual(['Noa']);

    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'publish' });
    const published = parse(api.tip.files);
    expect(findEvent(published, W, 'a')).toMatchObject({ start: 600 }); // the team's
    expect(findEvent(published, W, 't')).toBeDefined();
    expect(findEvent(published, W, 'late')).toBeDefined();
    expect(findEvent(published, W, 'm')).toBeDefined(); // mine
    expect(store.getState().diff).toEqual([]);
  });

  it('notices when my changes are already in the team\'s copy', async () => {
    const { store, api } = await start();
    const same = ev('c', { title: 'Same idea', day: 3 });
    api.teammatePublishes(files(dataset([A, B, same])));
    store.actions.saveEvent(W, same);
    await store.actions.confirmPublish('');
    expect(store.getState().dialog).toBeNull();
    expect(api.team).toHaveLength(2);
    expect(store.getState().diff).toEqual([]);
    expect(store.getState().sync).toMatchObject({ behind: 0 });
  });

  it('keeps my work and explains when the repository cannot be reached', async () => {
    const { store, api } = await start();
    store.actions.saveEvent(W, ev('c'));
    api.fetchError = { code: 'offline', message: 'offline', detail: 'Could not resolve host' };
    store.actions.requestPublish();
    await store.actions.confirmPublish('');
    const dialog = store.getState().dialog as Extract<DialogState, { type: 'error' }>;
    expect(dialog.type).toBe('error');
    expect(dialog.detail).toContain('Could not resolve host');
    expect(api.team).toHaveLength(1);
    expect(store.getState().diff).toHaveLength(1);
    expect(store.getState().busy).toBeNull();
  });

  it('offers to sign in when the server refuses the push', async () => {
    const { store, api } = await start();
    store.actions.saveEvent(W, ev('c'));
    api.pushError = { code: 'auth', message: 'auth', detail: 'Authentication failed' };
    await store.actions.confirmPublish('');
    const dialog = store.getState().dialog as Extract<DialogState, { type: 'error' }>;
    expect(dialog.type).toBe('error');
    expect(dialog.actions).toHaveLength(1);
    expect(store.getState().diff).toHaveLength(1);
    // A second attempt goes through.
    await store.actions.confirmPublish('');
    expect(api.team).toHaveLength(2);
    expect(store.getState().diff).toEqual([]);
  });

  it('ignores a second click while a save is running', async () => {
    const { store, api } = await start();
    store.actions.saveEvent(W, ev('c'));
    await Promise.all([store.actions.confirmPublish('one'), store.actions.confirmPublish('two')]);
    expect(api.team).toHaveLength(2);
  });

  it('stores my colliding version on this computer before the files are replaced', async () => {
    for (const then of ['keep-local', 'publish'] as const) {
      const { store, api } = await collision();
      api.calls.length = 0;
      await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then });
      const stored = api.calls.indexOf('setAside');
      const replaced = api.calls.indexOf(then === 'publish' ? 'publish' : 'applyUpdate');
      expect(stored).toBeGreaterThanOrEqual(0);
      expect(replaced).toBeGreaterThan(stored);
    }
  });

  it('keeps my colliding version when replacing the files fails', async () => {
    const { store, api, key } = await collision();
    api.throwOn = 'applyUpdate';
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'keep-local' });
    api.throwOn = null;
    // Nothing was replaced, so my version is still simply the unpublished edit it was.
    expect(findEvent(store.getState().working, W, 'a')).toMatchObject({ start: 480, end: 540 });
    expect(findEvent(parse(api.working), W, 'a')).toMatchObject({ start: 480, end: 540 });
    expect(store.getState().diffByKey.get(key)?.change).toBe('modified');
    expect(store.getState().busy).toBeNull();
  });

  it('undoing "use my version" brings back the team\'s version together with the kept-aside entry', async () => {
    const { store, api, key } = await collision();
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'keep-local' });
    store.actions.applyAside(key);
    expect(store.getState().aside).toEqual([]);

    store.actions.undo();
    expect(findEvent(store.getState().working, W, 'a')).toMatchObject({ start: 600, end: 660 });
    expect(store.getState().aside.map((item) => item.key)).toEqual([key]);
    expect(api.aside.map((item) => item.key)).toEqual([key]);

    store.actions.redo();
    expect(findEvent(store.getState().working, W, 'a')).toMatchObject({ start: 480, end: 540 });
    expect(store.getState().aside).toEqual([]);
    expect(api.aside).toEqual([]);
  });

  it('does not bring a discarded kept-aside version back through undo or redo', async () => {
    const { store, api, key } = await collision();
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'keep-local' });
    store.actions.applyAside(key);
    store.actions.undo();
    store.actions.discardAside(key);
    expect(store.getState().aside).toEqual([]);
    store.actions.redo();
    store.actions.undo();
    expect(store.getState().aside).toEqual([]);
    expect(api.aside).toEqual([]);
    expect(findEvent(store.getState().working, W, 'a')).toMatchObject({ start: 600, end: 660 });
  });
});

describe('files this version cannot read', () => {
  const DAMAGED = '{ damaged on this computer';
  const weekFile = (week: string): string => `weeks/${week}.json`;
  /** The team's week file, saved by a newer app version than this one. */
  const fromNewerApp = (text: string): string => text.replace('"formatVersion": 1', '"formatVersion": 99');

  it('shows a damaged local week as the team has it, never as "all its lessons deleted"', async () => {
    const { store, api } = await start(BASE, (fake) => {
      fake.working[weekFile(W)] = DAMAGED;
    });
    const state = store.getState();
    expect(state.readOnlyWeeks).toEqual([W]);
    expect(getWeek(state.working, W).events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(state.diff).toEqual([]);
    expect(state.problems.map((p) => p.path)).toEqual([weekFile(W)]);

    // Editing elsewhere writes the other files and leaves the damaged one exactly as it is.
    store.actions.saveEvent(W2, ev('x'));
    await store.whenIdle();
    expect(api.working[weekFile(W)]).toBe(DAMAGED);
    expect(findEvent(parse(api.working), W2, 'x')).toBeDefined();
  });

  it('repairs a damaged local file by going back to the team\'s version', async () => {
    const { store, api } = await start(BASE, (fake) => {
      fake.working[weekFile(W)] = DAMAGED;
    });
    expect(store.getState().damagedFiles).toEqual([weekFile(W)]);
    await store.actions.discardLocalChanges();
    const state = store.getState();
    expect(state.damagedFiles).toEqual([]);
    expect(state.readOnlyWeeks).toEqual([]);
    expect(state.problems).toEqual([]);
    expect(api.working).toEqual(files(BASE));
    // "The files were restored", not "your changes were discarded": there were none.
    expect(lastToast(store)?.message).toContain('team');
    // The repaired week can be edited again.
    store.actions.saveEvent(W, ev('c'));
    expect(findEvent(store.getState().working, W, 'c')).toBeDefined();
  });

  it('does not call a file "damaged here" when the team itself holds it in that form', async () => {
    const teamFiles = { ...files(BASE), [weekFile(W2)]: fromNewerApp(files(upsertEvent(BASE, W2, ev('n')))[weekFile(W2)]) };
    const api = new FakeBackend();
    api.seed(teamFiles);
    const store = createAppStore(api, { background: false, persistDelayMs: 0, now: () => new Date(2026, 10, 24, 10, 0, 0) });
    await store.actions.init();
    await store.whenIdle();
    expect(store.getState().readOnlyWeeks).toEqual([W2]);
    expect(store.getState().damagedFiles).toEqual([]);
  });

  it('refuses to publish while a file is damaged on this computer, and names the file', async () => {
    const { store, api } = await start(BASE, (fake) => {
      fake.working[weekFile(W)] = DAMAGED;
    });
    store.actions.saveEvent(W2, ev('x'));
    await store.actions.confirmPublish('');
    const dialog = store.getState().dialog as Extract<DialogState, { type: 'error' }>;
    expect(dialog.type).toBe('error');
    expect(dialog.detail).toBe(weekFile(W));
    expect(api.team).toHaveLength(1);
    expect(api.calls).not.toContain('publish');
    expect(store.getState().diff).toHaveLength(1);
  });

  it('publishes normally when the unreadable file is simply the team\'s own version', async () => {
    const teamFiles = { ...files(BASE), [weekFile(W2)]: fromNewerApp(files(upsertEvent(BASE, W2, ev('n')))[weekFile(W2)]) };
    const api = new FakeBackend();
    api.seed(teamFiles);
    const store = createAppStore(api, { background: false, persistDelayMs: 0, now: () => new Date(2026, 10, 24, 10, 0, 0) });
    await store.actions.init();
    await store.whenIdle();
    expect(store.getState().readOnlyWeeks).toEqual([W2]);

    store.actions.saveEvent(W, ev('c'));
    await store.actions.confirmPublish('');
    expect(api.team).toHaveLength(2);
    expect(findEvent(parse(api.tip.files), W, 'c')).toBeDefined();
    // The newer app's file went through untouched.
    expect(api.tip.files[weekFile(W2)]).toBe(teamFiles[weekFile(W2)]);
  });

  it('an update keeps an unreadable local file that the team did not touch', async () => {
    const { store, api } = await start(BASE, (fake) => {
      fake.working[weekFile(W2)] = DAMAGED;
    });
    api.teammatePublishes(files(dataset([A, B, ev('t')])));
    await store.actions.requestUpdate();
    expect(findEvent(store.getState().working, W, 't')).toBeDefined();
    expect(api.working[weekFile(W2)]).toBe(DAMAGED);
    expect(store.getState().readOnlyWeeks).toEqual([W2]);
  });

  it('an update replaces a damaged local file once the team has a newer version of it', async () => {
    const { store, api } = await start(BASE, (fake) => {
      fake.working[weekFile(W)] = DAMAGED;
    });
    api.teammatePublishes(files(dataset([A, B, ev('t')])));
    await store.actions.requestUpdate();
    expect(api.working[weekFile(W)]).toBe(api.tip.files[weekFile(W)]);
    expect(store.getState().readOnlyWeeks).toEqual([]);
    expect(getWeek(store.getState().working, W).events.map((e) => e.id).sort()).toEqual(['a', 'b', 't']);
    expect(store.getState().diff).toEqual([]);
  });

  it('keeps my changes aside when the team\'s copy of that week became unreadable', async () => {
    const { store, api } = await start();
    const unreadable = fromNewerApp(files(dataset([A, B, ev('t')]))[weekFile(W)]);
    api.teammatePublishes({ ...files(BASE), [weekFile(W)]: unreadable });
    store.actions.saveEvent(W, ev('m', { title: 'My lesson', day: 5 }));
    store.actions.saveEvent(W2, ev('n', { title: 'Next week', day: 1 }));
    await store.actions.confirmPublish('');
    mergeSession(store);
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'aside', then: 'publish' });

    // The team's file is untouched, my lesson in the other week went out …
    expect(api.tip.files[weekFile(W)]).toBe(unreadable);
    expect(findEvent(parse(api.tip.files), W2, 'n')).toBeDefined();
    // … and my lesson in the unreadable week waits on this computer instead of vanishing.
    const state = store.getState();
    expect(state.aside.map((item) => item.key)).toEqual([eventKey(W, 'm')]);
    expect(state.aside[0].mine).toMatchObject({ title: 'My lesson' });
    expect(api.aside.map((item) => item.key)).toEqual([eventKey(W, 'm')]);
    expect(state.readOnlyWeeks).toEqual([W]);
    expect(state.toasts.some((toast) => toast.kind === 'warning' && toast.sticky)).toBe(true);
    expect(state.dialog).toBeNull();
  });
});

describe('updating from the team', () => {
  it('announces a teammate\'s update once, with who made it', async () => {
    const { store, api } = await start();
    api.teammatePublishes(files(dataset([A])), 'Dana');
    api.teammatePublishes(files(dataset([A, ev('t')])), 'Yossi');
    await store.actions.checkForUpdates({ interactive: false, silent: true });
    expect(store.getState().sync).toMatchObject({ behind: 2 });
    expect(api.notifications).toHaveLength(1);
    expect(api.notifications[0].body).toContain('Dana');
    expect(api.notifications[0].body).toContain('Yossi');
    expect(lastToast(store)?.action).toBeDefined();
    // The schedule on screen has not changed by itself.
    expect(findEvent(store.getState().working, W, 'b')).toBeDefined();

    await store.actions.checkForUpdates({ interactive: false, silent: true });
    expect(api.notifications).toHaveLength(1);
  });

  it('updates in one step when there are no local changes', async () => {
    const { store, api } = await start();
    api.teammatePublishes(files(dataset([A, B, ev('t')])));
    await store.actions.requestUpdate();
    expect(findEvent(store.getState().working, W, 't')).toBeDefined();
    expect(store.getState().diff).toEqual([]);
    expect(store.getState().sync).toMatchObject({ behind: 0 });
    expect(parse(api.working)).toEqual(parse(api.tip.files));
    expect(lastToast(store)?.kind).toBe('success');
  });

  it('merges silently when my edits do not collide, and keeps them unpublished', async () => {
    const { store, api } = await start();
    api.teammatePublishes(files(dataset([A, B, ev('t')])));
    store.actions.saveEvent(W, ev('m'));
    await store.actions.requestUpdate();
    const state = store.getState();
    expect(state.dialog).toBeNull();
    expect(findEvent(state.working, W, 't')).toBeDefined();
    expect(state.diff.map((d) => d.key)).toEqual([eventKey(W, 'm')]);
    expect(api.team).toHaveLength(2);
    expect(findEvent(parse(api.working), W, 'm')).toBeDefined();
  });

  it('asks when my edits collide; "mine" keeps my version as an unpublished change', async () => {
    const { store, api } = await start();
    api.teammatePublishes(files(dataset([{ ...A, title: 'Team title' }, B])));
    store.actions.saveEvent(W, { ...A, title: 'My title' });
    await store.actions.requestUpdate();
    const session = mergeSession(store);
    expect(session.mode).toBe('update');
    // "publish" is not a choice in an update: it is treated as keep-local.
    await store.actions.resolveMerge({ resolutions: {}, defaultResolution: 'mine', then: 'publish' });
    expect(api.team).toHaveLength(2);
    expect(findEvent(store.getState().working, W, 'a')?.title).toBe('My title');
    expect(store.getState().diff).toHaveLength(1);
    expect(store.getState().sync).toMatchObject({ behind: 0 });
  });

  it('says so when there is nothing new, and reports connection problems', async () => {
    const { store, api } = await start();
    await store.actions.requestUpdate();
    expect(lastToast(store)?.kind).toBe('info');
    api.fetchError = { code: 'auth', message: 'auth', detail: 'denied' };
    await store.actions.checkForUpdates({ interactive: true });
    expect(lastToast(store)).toMatchObject({ kind: 'error', detail: 'denied' });
    expect(lastToast(store)?.action).toBeDefined();
    expect(store.getState().sync?.fetchError?.code).toBe('auth');
  });

  it('will not merge with a team copy it cannot read', async () => {
    const { store, api } = await start();
    api.teammatePublishes({ ...files(BASE), 'schedule.json': '{"formatVersion": 99}' });
    store.actions.saveEvent(W, ev('m'));
    await store.actions.requestUpdate();
    expect(store.getState().dialog?.type).toBe('error');
    expect(findEvent(store.getState().working, W, 'm')).toBeDefined();
  });

  it('says that the team\'s branch is gone instead of claiming to be up to date', async () => {
    const { store, api } = await start();
    api.remoteGone = true;
    await store.actions.requestUpdate();
    expect(lastToast(store)?.kind).toBe('warning');
    expect(api.calls).not.toContain('applyUpdate');
    // The schedule on this computer is untouched.
    expect(getWeek(store.getState().working, W).events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('discards unpublished changes on request', async () => {
    const { store, api } = await start();
    store.actions.saveEvent(W, ev('m'));
    await store.actions.discardLocalChanges();
    expect(store.getState().diff).toEqual([]);
    expect(findEvent(parse(api.working), W, 'm')).toBeUndefined();
    expect(store.getState().canUndo).toBe(false);
  });
});

describe('set-up', () => {
  it('connects to a repository that already has a schedule', async () => {
    const { store } = await start(BASE, (api) => {
      api.phase = 'not-configured';
      api.working = {};
      api.head = -1;
    });
    expect(store.getState().phase).toBe('setup');
    const result = await store.actions.connectRepo({ url: 'https://example.com/x.git', branch: null, userName: 'Me', userEmail: 'me@example.com' });
    expect(result.ok).toBe(true);
    expect(store.getState().phase).toBe('ready');
    expect(getWeek(store.getState().working, W).events).toHaveLength(2);
  });

  it('hands a failed connection back to the set-up screen', async () => {
    const { store, api } = await start(BASE, (fake) => (fake.phase = 'not-configured'));
    api.connectAnswer = { ok: false, error: { code: 'not-found', message: 'nope', detail: 'Repository not found' } };
    const result = await store.actions.connectRepo({ url: 'https://example.com/x.git', branch: null, userName: 'Me', userEmail: 'me@example.com' });
    expect(result).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(store.getState().phase).toBe('setup');
    expect(store.getState().busy).toBeNull();
  });

  it('creates the first schedule in an empty repository', async () => {
    const api = new FakeBackend();
    api.phase = 'needs-init';
    const store = createAppStore(api, { background: false, persistDelayMs: 0 });
    await store.actions.init();
    expect(store.getState().phase).toBe('needs-init');
    const ok = await store.actions.createSchedule({ courseName: ' DevOps 2027 ', startDate: '2027-01-03', endDate: null });
    expect(ok).toBe(true);
    expect(store.getState().phase).toBe('ready');
    expect(api.team).toHaveLength(1);
    const created = parse(api.tip.files);
    expect(created.config.course).toEqual({ name: 'DevOps 2027', startDate: '2027-01-03', endDate: null });
    expect(created.config.subjects).toHaveLength(6);
    expect(store.getState().diff).toEqual([]);
  });

  it('never writes a date that is not a real calendar day into a new schedule', async () => {
    const api = new FakeBackend();
    api.phase = 'needs-init';
    const store = createAppStore(api, { background: false, persistDelayMs: 0 });
    await store.actions.init();
    const ok = await store.actions.createSchedule({ courseName: 'X', startDate: '20261-01-03', endDate: '2027-02-30' });
    expect(ok).toBe(true);
    expect(parse(api.tip.files).config.course).toEqual({ name: 'X', startDate: null, endDate: null });
    expect(filesToDataset(api.tip.files).problems).toEqual([]);
  });

  it('loads the teammate\'s schedule when they created it first', async () => {
    const api = new FakeBackend();
    api.phase = 'needs-init';
    const store = createAppStore(api, { background: false, persistDelayMs: 0 });
    await store.actions.init();
    api.teammatePublishes(files(BASE), 'Dana', 'Create schedule');
    const ok = await store.actions.createSchedule({ courseName: 'Mine', startDate: null, endDate: null });
    expect(ok).toBe(true);
    expect(store.getState().phase).toBe('ready');
    expect(api.team).toHaveLength(1);
    expect(store.getState().working.config.course.name).toBe('DevOps');
  });
});

describe('output', () => {
  it('exports the chosen weeks to an .ics file and can open it', async () => {
    const { store, api } = await start(dataset([{ ...A, locationId: 'l1', teacherIds: ['t1'] }, B]));
    const result = await store.actions.exportIcs({ weekStarts: [W], filteredOnly: false, calendarName: 'My: Calendar?', openAfter: true });
    expect(result).toEqual({ path: 'C:\\out\\My Calendar.ics', count: 2 });
    const content = api.saved[0].request.content;
    expect(content).toContain('BEGIN:VCALENDAR');
    expect(content).toContain('SUMMARY:Intro');
    expect(content).toContain('LOCATION:Room 1');
    expect(api.opened).toEqual(['C:\\out\\My Calendar.ics']);
  });

  it('exports only what the filter shows, and says so when that is nothing', async () => {
    const { store, api } = await start(dataset([{ ...A, locationId: 'l1' }, { ...B, locationId: 'l2' }]));
    store.actions.setFilters({ locationIds: ['l2'] });
    const result = await store.actions.exportIcs({ weekStarts: [W], filteredOnly: true, calendarName: 'x', openAfter: false });
    expect(result?.count).toBe(1);
    expect(api.saved[0].request.content).not.toContain('SUMMARY:Intro');
    store.actions.setFilters({ locationIds: ['nope'] });
    expect(await store.actions.exportIcs({ weekStarts: [W], filteredOnly: true, calendarName: 'x', openAfter: false })).toBeNull();
    expect(lastToast(store)?.kind).toBe('warning');
  });

  it('exports exactly the days between two dates', async () => {
    // A is on Sunday 22 Nov, B on Tuesday 24 Nov.
    const { store, api } = await start();
    const options = { weekStarts: [W], filteredOnly: false, calendarName: 'x', openAfter: false };
    const result = await store.actions.exportIcs({ ...options, dateFrom: '2026-11-23', dateTo: '2026-11-28' });
    expect(result?.count).toBe(1);
    expect(api.saved[0].request.content).toContain('SUMMARY:Lab');
    expect(api.saved[0].request.content).not.toContain('SUMMARY:Intro');
    // Both ends are inclusive.
    expect((await store.actions.exportIcs({ ...options, dateFrom: '2026-11-22', dateTo: '2026-11-24' }))?.count).toBe(2);
    expect((await store.actions.exportIcs({ ...options, dateFrom: '2026-11-22', dateTo: '2026-11-22' }))?.count).toBe(1);
    expect(await store.actions.exportIcs({ ...options, dateFrom: '2026-11-25', dateTo: '2026-11-28' })).toBeNull();
  });

  it('saves a week to a file and loads it into another week', async () => {
    const { store, api } = await start();
    const path = await store.actions.exportWeekFile(W, { filteredOnly: false });
    expect(path).toBe(`C:\\out\\week-${W}.week.json`);

    api.openAnswers.push({ path: 'C:\\in\\w.week.json', name: 'w.week.json', content: api.saved[0].request.content });
    await store.actions.pickWeekFile();
    const dialog = store.getState().dialog;
    if (dialog?.type !== 'import-week') throw new Error('expected the import dialog');
    expect(dialog.fileName).toBe('w.week.json');
    const result = store.actions.importWeek(dialog.template, { targetWeek: W2, mode: 'replace', applyTitle: true });
    expect(result?.eventCount).toBe(2);
    expect(getWeek(store.getState().working, W2).events.map((e) => e.title)).toEqual(['Intro', 'Lab']);
    expect(store.getState().diff).toHaveLength(2);
  });

  it('rejects a file that is not a week file', async () => {
    const { store, api } = await start();
    api.openAnswers.push({ path: 'x', name: 'x.json', content: '{"type":"something-else"}' });
    await store.actions.pickWeekFile();
    expect(store.getState().dialog).toBeNull();
    expect(lastToast(store)?.kind).toBe('error');
  });

  it('repeats a week into following weeks', async () => {
    const { store } = await start();
    const count = store.actions.repeatWeek({ sourceWeek: W, targetWeeks: [W, W2, '2026-12-06'], mode: 'add', copyTitle: false });
    expect(count).toBe(2);
    expect(getWeek(store.getState().working, W2).events).toHaveLength(2);
    expect(getWeek(store.getState().working, '2026-12-06').events).toHaveLength(2);
    store.actions.undo();
    expect(store.getState().diff).toEqual([]);
  });

  it('round-trips a week template through the shared helpers used above', () => {
    const template = exportWeekTemplate(BASE, W, '2026-11-24T08:00:00.000Z');
    expect(serializeWeekTemplate(template)).toContain('"team-schedule-week"');
  });
});

describe('robustness', () => {
  it('never lets a failing bridge reject an action or leave the busy state on', async () => {
    const { store, api } = await start();
    store.actions.saveEvent(W, ev('c'));
    await store.whenIdle();
    for (const call of ['fetch', 'publish', 'loadRemote', 'applyUpdate', 'discardLocal', 'saveTextFile', 'openTextFile']) {
      api.throwOn = call;
      await expect(store.actions.confirmPublish('')).resolves.toBeUndefined();
      await expect(store.actions.requestUpdate()).resolves.toBeUndefined();
      await expect(store.actions.checkForUpdates({ interactive: true })).resolves.toBeUndefined();
      await expect(store.actions.discardLocalChanges()).resolves.toBeUndefined();
      await expect(store.actions.exportIcs({ weekStarts: [W], filteredOnly: false, calendarName: 'x', openAfter: false })).resolves.toBeDefined();
      await expect(store.actions.pickWeekFile()).resolves.toBeUndefined();
      expect(store.getState().busy).toBeNull();
    }
  });

  it('reports a failed local save once and recovers', async () => {
    const { store, api } = await start();
    api.throwOn = 'writeWorking';
    store.actions.saveEvent(W, ev('c'));
    await store.whenIdle();
    store.actions.saveEvent(W, ev('d'));
    await store.whenIdle();
    expect(store.getState().toasts.filter((toast) => toast.sticky)).toHaveLength(1);
    api.throwOn = null;
    store.actions.saveEvent(W, ev('e'));
    await store.whenIdle();
    expect(getWeek(parse(api.working), W).events.map((e) => e.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('switches language at once and remembers it', async () => {
    const { store, api } = await start();
    store.actions.setLanguage('he');
    expect(store.getState().lang).toBe('he');
    await Promise.resolve();
    expect(api.settings.language).toBe('he');
    store.actions.requestPublish();
    expect(lastToast(store)?.message).toMatch(/[\u0590-\u05FF]/);
  });

  it('closes the window after writing pending edits', async () => {
    const { store, api } = await start();
    store.actions.saveEvent(W, ev('c'));
    store.actions.closeWindowNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.closed).toBe(true);
    expect(findEvent(parse(api.working), W, 'c')).toBeDefined();
  });

  /** Asks to close while the working folder cannot be written; returns the dialog that comes up instead. */
  async function closeOverUnwrittenEdits(): Promise<Rig & { dialog: Extract<DialogState, { type: 'error' }> }> {
    const rig = await start();
    rig.api.throwOn = 'writeWorking';
    rig.store.actions.saveEvent(W, ev('c'));
    rig.store.actions.closeWindowNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const dialog = rig.store.getState().dialog;
    if (dialog?.type !== 'error') throw new Error(`expected the "could not save" dialog, got ${dialog?.type ?? 'none'}`);
    return { ...rig, dialog };
  }

  it('does not close over edits that could not be written to disk; trying again saves and closes', async () => {
    const { api, dialog } = await closeOverUnwrittenEdits();
    expect(api.closed).toBe(false);
    expect(dialog.actions).toHaveLength(2);
    const retry = dialog.actions?.find((action) => action.primary);

    // Still failing: the question simply comes back.
    await retry?.run();
    expect(api.closed).toBe(false);

    api.throwOn = null;
    await retry?.run();
    expect(api.closed).toBe(true);
    expect(findEvent(parse(api.working), W, 'c')).toBeDefined();
  });

  it('closes without the edits only when the user says so', async () => {
    const { api, dialog } = await closeOverUnwrittenEdits();
    await dialog.actions?.find((action) => !action.primary)?.run();
    expect(api.closed).toBe(true);
    expect(findEvent(parse(api.working), W, 'c')).toBeUndefined();
  });

  it('writes edits that failed to be written as soon as writing works again, without a new edit', async () => {
    const { store, api } = await start();
    api.throwOn = 'writeWorking';
    store.actions.saveEvent(W, ev('c'));
    await store.whenIdle();
    expect(findEvent(parse(api.working), W, 'c')).toBeUndefined();
    api.throwOn = null;
    await store.whenIdle();
    expect(findEvent(parse(api.working), W, 'c')).toBeDefined();
  });
});
