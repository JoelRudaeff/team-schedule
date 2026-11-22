/**
 * mergeDatasets: the three-way rule row by row for settings, week titles, list entries and
 * events, the field groups of events and subjects, and the order and counts of the result.
 */
import { describe, expect, it } from 'vitest';
import {
  mergeDatasets,
  type ChangeType,
  type ItemValue,
  type MergeItem,
  type MergeResult,
  type MergeStatus,
} from '@shared/merge';
import { ENTITY_LIST_KEY, removeEntity, sortEvents } from '@shared/model';
import type {
  CourseInfo,
  Dataset,
  EntityKind,
  IsoDate,
  NamedItem,
  ScheduleConfig,
  ScheduleEvent,
  SlotMinutes,
  Subject,
  TimeGrid,
} from '@shared/types';

// ───────────────────────────── fixtures ─────────────────────────────

const W1: IsoDate = '2026-11-22';
const W2: IsoDate = '2026-11-29';
const W3: IsoDate = '2026-12-06';

const COURSE: CourseInfo = { name: 'DevOps 2026', startDate: '2026-09-06', endDate: null };
const GRID: TimeGrid = { dayStart: 480, dayEnd: 1200, slotMinutes: 30 };
const KINDS: EntityKind[] = ['subject', 'location', 'teacher', 'class'];

const BLUE = '#2563EB';
const GREEN = '#16A34A';
const RED = '#DC2626';

/** Sunday 09:00–10:30 unless the patch says otherwise. */
function event(id: string, patch: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id,
    day: 0,
    start: 540,
    end: 630,
    title: `Event ${id}`,
    subjectId: null,
    locationId: null,
    teacherIds: [],
    classIds: [],
    notes: '',
    ...patch,
  };
}

/** Frozen all the way down: code under test that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function makeDataset(
  config: Partial<ScheduleConfig> = {},
  weeks: Record<IsoDate, { title?: string; events?: ScheduleEvent[] }> = {},
): Dataset {
  return deepFreeze({
    config: { course: COURSE, timeGrid: GRID, subjects: [], locations: [], teachers: [], classes: [], ...config },
    weeks: Object.fromEntries(
      Object.entries(weeks).map(([weekStart, week]) => [
        weekStart,
        { weekStart, title: week.title ?? '', events: sortEvents(week.events ?? []) },
      ]),
    ),
  });
}

/** A list entry of the given kind; subjects carry the colour they cannot exist without. */
function entry(kind: EntityKind, id: string, name: string): NamedItem | Subject {
  return kind === 'subject' ? { id, name, color: BLUE } : { id, name };
}

/** A config patch that fills the list of `kind` with entries made by entry(). */
function list(kind: EntityKind, ...entries: (NamedItem | Subject)[]): Partial<ScheduleConfig> {
  return { [ENTITY_LIST_KEY[kind]]: entries };
}

function onlyItem(result: MergeResult): MergeItem {
  expect(result.items).toHaveLength(1);
  return result.items[0];
}

function itemFor(result: MergeResult, key: string): MergeItem {
  const item = result.items.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`the merge does not list ${key}`);
  return item;
}

function statuses(result: MergeResult): [key: string, status: MergeStatus][] {
  return result.items.map((item) => [item.key, item.status]);
}

// ───────────────────────────── the rule table ─────────────────────────────

/** What one version holds: '-' nothing, 'O' the original, 'A' / 'B' two different edits of it. */
type State = '-' | 'O' | 'A' | 'B';

type Row = [
  base: State,
  mine: State,
  theirs: State,
  mineChange: ChangeType,
  theirsChange: ChangeType,
  status: MergeStatus,
  merged: State,
  /** Whether conflictFields names the part that A and B disagree about. */
  blamed: boolean,
];

const RULE: Row[] = [
  // base mine theirs   I           they        status      merged
  ['-', 'A', '-', 'added', 'none', 'mine', 'A', false],
  ['-', '-', 'B', 'none', 'added', 'theirs', 'B', false],
  ['-', 'A', 'A', 'added', 'added', 'same', 'A', false],
  ['-', 'A', 'B', 'added', 'added', 'conflict', 'B', true],
  ['O', 'A', 'O', 'modified', 'none', 'mine', 'A', false],
  ['O', 'O', 'B', 'none', 'modified', 'theirs', 'B', false],
  ['O', 'A', 'A', 'modified', 'modified', 'same', 'A', false],
  ['O', 'A', 'B', 'modified', 'modified', 'conflict', 'B', true],
  ['O', 'B', 'A', 'modified', 'modified', 'conflict', 'A', true],
  ['O', '-', 'O', 'deleted', 'none', 'mine', '-', false],
  ['O', 'O', '-', 'none', 'deleted', 'theirs', '-', false],
  ['O', '-', '-', 'deleted', 'deleted', 'same', '-', false],
  ['O', '-', 'B', 'deleted', 'modified', 'conflict', 'B', false],
  ['O', 'A', '-', 'modified', 'deleted', 'conflict', '-', false],
];

/** One item, and a way to build a dataset in which only that item varies. */
interface ItemCase {
  title: string;
  key: string;
  /** False for settings and week titles: they always exist, so the '-' rows do not apply. */
  canBeAbsent: boolean;
  /** The part that 'A' and 'B' edit, as conflictFields names it. */
  group: string;
  value(state: State): ItemValue | undefined;
  dataset(state: State): Dataset;
}

function scalarCase<T extends string | number | null>(
  key: string,
  values: Record<'O' | 'A' | 'B', T>,
  build: (value: T) => Dataset,
): ItemCase {
  return {
    title: key,
    key,
    canBeAbsent: false,
    group: 'value',
    value: (state) => (state === '-' ? undefined : values[state]),
    dataset: (state) => {
      if (state === '-') throw new Error(`${key} always exists`);
      return build(values[state]);
    },
  };
}

function compositeCase<T extends NamedItem | ScheduleEvent>(
  title: string,
  key: string,
  group: string,
  values: Record<'O' | 'A' | 'B', T>,
  build: (value: T | undefined) => Dataset,
): ItemCase {
  return {
    title,
    key,
    canBeAbsent: true,
    group,
    value: (state) => (state === '-' ? undefined : values[state]),
    dataset: (state) => build(state === '-' ? undefined : values[state]),
  };
}

const CASES: ItemCase[] = [
  scalarCase('course.name', { O: 'DevOps 2026', A: 'DevOps 2026 (evening)', B: 'DevOps 2027' }, (name) =>
    makeDataset({ course: { ...COURSE, name } }),
  ),
  scalarCase<IsoDate | null>('course.startDate', { O: null, A: '2026-09-06', B: '2026-09-13' }, (startDate) =>
    makeDataset({ course: { ...COURSE, startDate } }),
  ),
  scalarCase<IsoDate | null>('course.endDate', { O: '2027-01-31', A: null, B: '2027-02-28' }, (endDate) =>
    makeDataset({ course: { ...COURSE, endDate } }),
  ),
  scalarCase('timeGrid.dayStart', { O: 480, A: 420, B: 540 }, (dayStart) =>
    makeDataset({ timeGrid: { ...GRID, dayStart } }),
  ),
  scalarCase('timeGrid.dayEnd', { O: 1200, A: 1080, B: 1320 }, (dayEnd) => makeDataset({ timeGrid: { ...GRID, dayEnd } })),
  scalarCase<SlotMinutes>('timeGrid.slotMinutes', { O: 30, A: 15, B: 60 }, (slotMinutes) =>
    makeDataset({ timeGrid: { ...GRID, slotMinutes } }),
  ),
  scalarCase(`weekTitle:${W1}`, { O: 'Week 12', A: 'Docker week', B: 'שבוע 12' }, (title) =>
    makeDataset({}, { [W1]: { title, events: [event('e1')] } }),
  ),
  ...KINDS.map((kind) =>
    compositeCase(
      `${kind}:x`,
      `${kind}:x`,
      'name',
      { O: entry(kind, 'x', 'Original'), A: entry(kind, 'x', 'Alpha'), B: entry(kind, 'x', 'Beta') },
      (value) => makeDataset(list(kind, entry(kind, 'other', 'Other'), ...(value ? [value] : []))),
    ),
  ),
  compositeCase(
    `event:${W1}:x`,
    `event:${W1}:x`,
    'title',
    { O: event('x', { title: 'Original' }), A: event('x', { title: 'Alpha' }), B: event('x', { title: 'Beta' }) },
    (value) => makeDataset({}, { [W1]: { title: 'Week 12', events: [event('other'), ...(value ? [value] : [])] } }),
  ),
];

describe.each(CASES)('three-way rule for $title', (item) => {
  const rows = RULE.filter(([base, mine, theirs]) => item.canBeAbsent || ![base, mine, theirs].includes('-'));

  it('is not listed when neither side changed it', () => {
    const unchanged: State[] = item.canBeAbsent ? ['O', '-'] : ['O'];
    for (const state of unchanged) {
      const result = mergeDatasets(item.dataset(state), item.dataset(state), item.dataset(state));
      expect(result).toEqual({ items: [], conflictCount: 0, mineCount: 0, theirsCount: 0 });
    }
  });

  it.each(rows)(
    'base %s · mine %s · theirs %s → I %s, they %s: %s',
    (base, mine, theirs, mineChange, theirsChange, status, merged, blamed) => {
      const result = mergeDatasets(item.dataset(base), item.dataset(mine), item.dataset(theirs));
      const { kind: _kind, field: _field, id: _id, weekStart: _weekStart, ...decided } = onlyItem(result);
      expect(decided).toStrictEqual({
        key: item.key,
        base: item.value(base),
        mine: item.value(mine),
        theirs: item.value(theirs),
        mineChange,
        theirsChange,
        status,
        merged: item.value(merged),
        conflictFields: blamed ? [item.group] : [],
      });
      expect(result.conflictCount).toBe(status === 'conflict' ? 1 : 0);
      expect(result.mineCount).toBe(mineChange === 'none' ? 0 : 1);
      expect(result.theirsCount).toBe(theirsChange === 'none' ? 0 : 1);
    },
  );
});

// ───────────────────────────── field groups ─────────────────────────────

describe('field groups of an event', () => {
  const ORIGINAL = event('e1', {
    day: 1,
    title: 'Docker basics',
    subjectId: 's1',
    locationId: 'l1',
    teacherIds: ['t1'],
    classIds: ['c1'],
    notes: 'Bring a laptop',
  });
  const edited = (patch: Partial<ScheduleEvent>): ScheduleEvent => ({ ...ORIGINAL, ...patch });
  const week = (value: ScheduleEvent | undefined): Dataset => makeDataset({}, { [W1]: { events: value ? [value] : [] } });
  /** Both sides start from ORIGINAL. */
  const mergeEvent = (mine: ScheduleEvent | undefined, theirs: ScheduleEvent | undefined): MergeItem =>
    onlyItem(mergeDatasets(week(ORIGINAL), week(mine), week(theirs)));
  /** The event did not exist before: both sides added it. */
  const mergeAdded = (mine: ScheduleEvent, theirs: ScheduleEvent): MergeItem =>
    onlyItem(mergeDatasets(week(undefined), week(mine), week(theirs)));

  /** For every group: an edit of mine and a different edit of theirs. */
  const EDITS: Record<string, [mine: Partial<ScheduleEvent>, theirs: Partial<ScheduleEvent>]> = {
    time: [{ day: 3 }, { start: 600, end: 690 }],
    title: [{ title: 'Docker advanced' }, { title: 'Docker deep dive' }],
    subjectId: [{ subjectId: 's2' }, { subjectId: null }],
    locationId: [{ locationId: null }, { locationId: 'l2' }],
    teacherIds: [{ teacherIds: ['t1', 't2'] }, { teacherIds: [] }],
    classIds: [{ classIds: ['c2'] }, { classIds: ['c1', 'c3'] }],
    notes: [{ notes: '' }, { notes: 'Room changed' }],
  };
  const GROUPS = Object.keys(EDITS);

  it('I move the day while they change the hours → the time is in conflict', () => {
    const item = mergeEvent(edited({ day: 3 }), edited({ start: 600, end: 690 }));
    expect(item.status).toBe('conflict');
    expect(item.conflictFields).toEqual(['time']);
    expect(item.merged).toBe(item.theirs);
  });

  it('I change the start while they change the end → still one conflict on the time', () => {
    const item = mergeEvent(edited({ start: 510 }), edited({ end: 660 }));
    expect(item.status).toBe('conflict');
    expect(item.conflictFields).toEqual(['time']);
  });

  it('I change the title while they change the time → combined', () => {
    const item = mergeEvent(edited({ title: 'Docker advanced' }), edited({ day: 3, start: 600, end: 690 }));
    expect(item).toMatchObject({ status: 'combined', mineChange: 'modified', theirsChange: 'modified', conflictFields: [] });
    expect(item.merged).toEqual(edited({ title: 'Docker advanced', day: 3, start: 600, end: 690 }));
  });

  it('I change the time while they change the title → combined the other way round', () => {
    const item = mergeEvent(edited({ day: 3, start: 600, end: 690 }), edited({ title: 'Docker advanced' }));
    expect(item.status).toBe('combined');
    expect(item.merged).toEqual(edited({ title: 'Docker advanced', day: 3, start: 600, end: 690 }));
  });

  it.each(GROUPS)('both changed the %s to different values → conflict that names only this group', (group) => {
    const [mine, theirs] = EDITS[group];
    const item = mergeEvent(edited(mine), edited(theirs));
    expect(item.status).toBe('conflict');
    expect(item.conflictFields).toEqual([group]);
    expect(item.merged).toBe(item.theirs);
  });

  const PAIRS = GROUPS.flatMap((mine) => GROUPS.filter((theirs) => theirs !== mine).map((theirs) => [mine, theirs]));

  it.each(PAIRS)('I change the %s and they change the %s → combined', (mineGroup, theirGroup) => {
    const mine = EDITS[mineGroup][0];
    const theirs = EDITS[theirGroup][1];
    const item = mergeEvent(edited(mine), edited(theirs));
    expect(item.status).toBe('combined');
    expect(item.conflictFields).toEqual([]);
    expect(item.merged).toEqual({ ...ORIGINAL, ...mine, ...theirs });
  });

  it('combines several groups from each side and keeps what nobody touched', () => {
    const item = mergeEvent(
      edited({ title: 'Docker advanced', teacherIds: ['t2'] }),
      edited({ day: 4, start: 780, end: 870, notes: '' }),
    );
    expect(item.status).toBe('combined');
    expect(item.merged).toStrictEqual({
      id: 'e1',
      day: 4,
      start: 780,
      end: 870,
      title: 'Docker advanced',
      subjectId: 's1',
      locationId: 'l1',
      teacherIds: ['t2'],
      classIds: ['c1'],
      notes: '',
    });
  });

  it('both made the same change to one group and different changes elsewhere → combined', () => {
    const item = mergeEvent(
      edited({ day: 4, start: 600, end: 660, title: 'Mine' }),
      edited({ day: 4, start: 600, end: 660, notes: 'Theirs' }),
    );
    expect(item.status).toBe('combined');
    expect(item.merged).toEqual(edited({ day: 4, start: 600, end: 660, title: 'Mine', notes: 'Theirs' }));
  });

  it('is still "combined" when the team made my change too and the result equals their version', () => {
    const item = mergeEvent(edited({ title: 'Agreed' }), edited({ title: 'Agreed', notes: 'Theirs' }));
    expect(item.status).toBe('combined');
    expect(item.merged).toEqual(item.theirs);
  });

  it('names every colliding group in the documented order', () => {
    const mine = edited(Object.assign({}, ...GROUPS.map((group) => EDITS[group][0])));
    const theirs = edited(Object.assign({}, ...GROUPS.map((group) => EDITS[group][1])));
    const item = mergeEvent(mine, theirs);
    expect(item.status).toBe('conflict');
    expect(item.conflictFields).toEqual(['time', 'title', 'subjectId', 'locationId', 'teacherIds', 'classIds', 'notes']);
  });

  it('leaves a group out of conflictFields when only one side changed it or both changed it alike', () => {
    const item = mergeEvent(
      edited({ title: 'Mine', notes: 'Agreed', locationId: 'l9' }),
      edited({ title: 'Theirs', notes: 'Agreed', classIds: [] }),
    );
    expect(item.status).toBe('conflict');
    expect(item.conflictFields).toEqual(['title']);
  });

  it('never mixes the two versions of a conflict: merged is the whole version of the team', () => {
    const theirs = edited({ title: 'Theirs', classIds: [] });
    const item = mergeEvent(edited({ title: 'Mine', locationId: 'l9' }), theirs);
    expect(item.status).toBe('conflict');
    expect(item.merged).toBe(item.theirs);
    expect(item.merged).toEqual(theirs);
  });

  it('two different events added under one id → conflict that names every differing group', () => {
    const item = mergeAdded(
      event('e1', { day: 1, title: 'Mine' }),
      event('e1', { day: 2, title: 'Theirs', notes: 'From the team' }),
    );
    expect(item).toMatchObject({ status: 'conflict', mineChange: 'added', theirsChange: 'added' });
    expect(item.conflictFields).toEqual(['time', 'title', 'notes']);
    expect(item.merged).toBe(item.theirs);
  });

  it('one side deleted what the other modified → conflict without a field to blame', () => {
    const iDeleted = mergeEvent(undefined, edited({ title: 'Theirs' }));
    expect(iDeleted).toMatchObject({ status: 'conflict', mineChange: 'deleted', theirsChange: 'modified', conflictFields: [] });
    expect(iDeleted.merged).toEqual(edited({ title: 'Theirs' }));

    const theyDeleted = mergeEvent(edited({ title: 'Mine' }), undefined);
    expect(theyDeleted).toMatchObject({ status: 'conflict', mineChange: 'modified', theirsChange: 'deleted', conflictFields: [] });
    expect(theyDeleted.merged).toBeUndefined();
  });

  it('compares teacher and class lists by content: an equal copy is not a change', () => {
    const copy = { ...ORIGINAL, teacherIds: [...ORIGINAL.teacherIds], classIds: [...ORIGINAL.classIds] };
    const item = mergeEvent(copy, edited({ teacherIds: ['t1', 't2'] }));
    expect(item).toMatchObject({ status: 'theirs', mineChange: 'none', theirsChange: 'modified' });

    const sameEdit = mergeEvent(edited({ classIds: ['c1', 'c2'] }), edited({ classIds: ['c1', 'c2'] }));
    expect(sameEdit.status).toBe('same');
  });

  it('hands out the stored objects themselves as base, mine and theirs', () => {
    const base = week(ORIGINAL);
    const mine = week(edited({ title: 'Mine' }));
    const theirs = week(edited({ title: 'Theirs' }));
    const item = onlyItem(mergeDatasets(base, mine, theirs));
    expect(item.base).toBe(base.weeks[W1].events[0]);
    expect(item.mine).toBe(mine.weeks[W1].events[0]);
    expect(item.theirs).toBe(theirs.weeks[W1].events[0]);
  });
});

describe('field groups of a subject', () => {
  const LAB: Subject = { id: 's1', name: 'Lab', color: GREEN };
  const subjects = (value: Subject | undefined): Dataset => makeDataset({ subjects: value ? [value] : [] });
  /** Both sides start from LAB. */
  const mergeSubject = (mine: Subject, theirs: Subject): MergeItem =>
    onlyItem(mergeDatasets(subjects(LAB), subjects(mine), subjects(theirs)));
  /** The subject did not exist before: both sides added it. */
  const mergeAdded = (mine: Subject, theirs: Subject): MergeItem =>
    onlyItem(mergeDatasets(subjects(undefined), subjects(mine), subjects(theirs)));

  it('I rename it while they recolour it → combined', () => {
    const item = mergeSubject({ ...LAB, name: 'Laboratory' }, { ...LAB, color: RED });
    expect(item).toMatchObject({ status: 'combined', conflictFields: [] });
    expect(item.merged).toStrictEqual({ id: 's1', name: 'Laboratory', color: RED });
  });

  it('I recolour it while they rename it → combined the other way round', () => {
    const item = mergeSubject({ ...LAB, color: RED }, { ...LAB, name: 'Laboratory' });
    expect(item.status).toBe('combined');
    expect(item.merged).toStrictEqual({ id: 's1', name: 'Laboratory', color: RED });
  });

  it('both recoloured it differently → conflict on the colour', () => {
    const item = mergeSubject({ ...LAB, color: RED }, { ...LAB, color: BLUE });
    expect(item).toMatchObject({ status: 'conflict', conflictFields: ['color'] });
    expect(item.merged).toEqual({ ...LAB, color: BLUE });
  });

  it('both renamed and recoloured it differently → conflict on both', () => {
    const item = mergeSubject({ id: 's1', name: 'Mine', color: RED }, { id: 's1', name: 'Theirs', color: BLUE });
    expect(item).toMatchObject({ status: 'conflict', conflictFields: ['name', 'color'] });
  });

  it('I renamed and recoloured it, they only recoloured it differently → only the colour collides', () => {
    const item = mergeSubject({ id: 's1', name: 'Mine', color: RED }, { ...LAB, color: BLUE });
    expect(item).toMatchObject({ status: 'conflict', conflictFields: ['color'] });
    expect(item.merged).toEqual({ ...LAB, color: BLUE });
  });

  it('both picked the same colour and I also renamed it → combined', () => {
    const item = mergeSubject({ id: 's1', name: 'Laboratory', color: RED }, { ...LAB, color: RED });
    expect(item.status).toBe('combined');
    expect(item.merged).toEqual({ id: 's1', name: 'Laboratory', color: RED });
  });

  it('two different subjects added under one id → conflict that names what differs', () => {
    const colourOnly = mergeAdded({ ...LAB, color: RED }, { ...LAB, color: BLUE });
    expect(colourOnly).toMatchObject({ status: 'conflict', mineChange: 'added', theirsChange: 'added', conflictFields: ['color'] });
    const both = mergeAdded({ id: 's1', name: 'Mine', color: RED }, { id: 's1', name: 'Theirs', color: BLUE });
    expect(both.conflictFields).toEqual(['name', 'color']);
  });
});

// ───────────────────────────── weeks, settings, references ─────────────────────────────

describe('week titles', () => {
  it('lists a week that exists only because of the title I gave it', () => {
    const mine = makeDataset({}, { [W2]: { title: 'Holiday' } });
    const item = onlyItem(mergeDatasets(makeDataset(), mine, makeDataset()));
    expect(item).toStrictEqual({
      key: `weekTitle:${W2}`,
      kind: 'weekTitle',
      weekStart: W2,
      base: '',
      mine: 'Holiday',
      theirs: '',
      mineChange: 'modified',
      theirsChange: 'none',
      status: 'mine',
      merged: 'Holiday',
      conflictFields: [],
    });
  });

  it('both named the same new week differently → conflict', () => {
    const mine = makeDataset({}, { [W2]: { title: 'Holiday' } });
    const theirs = makeDataset({}, { [W2]: { title: 'חופשה' } });
    const item = onlyItem(mergeDatasets(makeDataset(), mine, theirs));
    expect(item).toMatchObject({ status: 'conflict', base: '', mine: 'Holiday', theirs: 'חופשה', merged: 'חופשה', conflictFields: ['value'] });
  });

  it('both gave the week the same name → same', () => {
    const named = makeDataset({}, { [W2]: { title: 'Holiday' } });
    expect(onlyItem(mergeDatasets(makeDataset(), named, makeDataset({}, { [W2]: { title: 'Holiday' } }))).status).toBe('same');
  });

  it('they removed the title that I changed → conflict against an empty title', () => {
    const base = makeDataset({}, { [W1]: { title: 'Week 12', events: [event('e1')] } });
    const mine = makeDataset({}, { [W1]: { title: 'Docker week', events: [event('e1')] } });
    const theirs = makeDataset({}, { [W1]: { title: '', events: [event('e1')] } });
    expect(onlyItem(mergeDatasets(base, mine, theirs))).toMatchObject({
      status: 'conflict',
      mine: 'Docker week',
      theirs: '',
      merged: '',
      conflictFields: ['value'],
    });
  });

  it('they emptied the whole week while I renamed it → the title collides, the events are theirs', () => {
    const base = makeDataset({}, { [W1]: { title: 'Week 12', events: [event('e1'), event('e2', { day: 2 })] } });
    const mine = makeDataset({}, { [W1]: { title: 'Docker week', events: [event('e1'), event('e2', { day: 2 })] } });
    const result = mergeDatasets(base, mine, makeDataset());
    expect(statuses(result)).toEqual([
      [`weekTitle:${W1}`, 'conflict'],
      [`event:${W1}:e1`, 'theirs'],
      [`event:${W1}:e2`, 'theirs'],
    ]);
    expect(result.items.slice(1).map((item) => item.theirsChange)).toEqual(['deleted', 'deleted']);
  });

  it('keeps the title and the events of one week apart', () => {
    const base = makeDataset({}, { [W1]: { title: 'Week 12', events: [event('e1')] } });
    const mine = makeDataset({}, { [W1]: { title: 'Docker week', events: [event('e1')] } });
    const theirs = makeDataset({}, { [W1]: { title: 'Week 12', events: [event('e1', { day: 4 }), event('e2')] } });
    const result = mergeDatasets(base, mine, theirs);
    expect(statuses(result)).toEqual([
      [`weekTitle:${W1}`, 'mine'],
      [`event:${W1}:e1`, 'theirs'],
      [`event:${W1}:e2`, 'theirs'],
    ]);
    expect(result.conflictCount).toBe(0);
  });

  it('treats a stored week without title and events like a missing one', () => {
    const stored = makeDataset({}, { [W2]: {} });
    const titled = makeDataset({}, { [W2]: { title: 'Holiday' } });
    expect(mergeDatasets(stored, makeDataset(), stored).items).toEqual([]);
    expect(onlyItem(mergeDatasets(stored, titled, makeDataset()))).toMatchObject({ base: '', status: 'mine' });
  });
});

describe('course and time grid', () => {
  it('changes to different fields never collide', () => {
    const mine = makeDataset({ course: { ...COURSE, name: 'Mine' }, timeGrid: { ...GRID, dayStart: 420 } });
    const theirs = makeDataset({
      course: { ...COURSE, endDate: '2027-01-31' },
      timeGrid: { ...GRID, dayEnd: 1320, slotMinutes: 60 },
    });
    const result = mergeDatasets(makeDataset(), mine, theirs);
    expect(statuses(result)).toEqual([
      ['course.name', 'mine'],
      ['course.endDate', 'theirs'],
      ['timeGrid.dayStart', 'mine'],
      ['timeGrid.dayEnd', 'theirs'],
      ['timeGrid.slotMinutes', 'theirs'],
    ]);
    expect(result).toMatchObject({ conflictCount: 0, mineCount: 2, theirsCount: 3 });
  });

  it('one field changed to two values collides without dragging its neighbours along', () => {
    const mine = makeDataset({
      course: { name: 'Mine', startDate: '2026-09-13', endDate: null },
      timeGrid: { dayStart: 420, dayEnd: 1320, slotMinutes: 30 },
    });
    const theirs = makeDataset({
      course: { name: 'Theirs', startDate: '2026-09-13', endDate: '2027-01-31' },
      timeGrid: { dayStart: 450, dayEnd: 1200, slotMinutes: 60 },
    });
    const result = mergeDatasets(makeDataset(), mine, theirs);
    expect(statuses(result)).toEqual([
      ['course.name', 'conflict'],
      ['course.startDate', 'same'],
      ['course.endDate', 'theirs'],
      ['timeGrid.dayStart', 'conflict'],
      ['timeGrid.dayEnd', 'mine'],
      ['timeGrid.slotMinutes', 'theirs'],
    ]);
    expect(itemFor(result, 'course.name')).toMatchObject({ merged: 'Theirs', conflictFields: ['value'] });
    expect(itemFor(result, 'timeGrid.dayStart')).toMatchObject({ mine: 420, theirs: 450, merged: 450, conflictFields: ['value'] });
  });

  it('a date that one side sets and the other clears is a conflict like any other', () => {
    const base = makeDataset({ course: { ...COURSE, endDate: '2027-01-31' } });
    const mine = makeDataset({ course: { ...COURSE, endDate: null } });
    const theirs = makeDataset({ course: { ...COURSE, endDate: '2027-02-28' } });
    expect(onlyItem(mergeDatasets(base, mine, theirs))).toMatchObject({
      key: 'course.endDate',
      status: 'conflict',
      mine: null,
      theirs: '2027-02-28',
      merged: '2027-02-28',
      mineChange: 'modified',
      theirsChange: 'modified',
    });
  });
});

describe('references', () => {
  const DANA = { id: 't1', name: 'Dana' };
  const base = makeDataset(
    { teachers: [DANA] },
    { [W1]: { events: [event('e1', { teacherIds: ['t1'] }), event('e2', { day: 1 })] } },
  );

  it('deleting a list entry is one item: the events that use it are not touched', () => {
    const mine = makeDataset({ teachers: [] }, { [W1]: { events: [event('e1', { teacherIds: ['t1'] }), event('e2', { day: 1 })] } });
    const item = onlyItem(mergeDatasets(base, mine, base));
    expect(item).toMatchObject({ key: 'teacher:t1', status: 'mine', mineChange: 'deleted', merged: undefined });
  });

  it('the app strips the references itself, which shows up as separate event items', () => {
    const mine = deepFreeze(removeEntity(base, 'teacher', 't1'));
    const result = mergeDatasets(base, mine, base);
    expect(statuses(result)).toEqual([
      ['teacher:t1', 'mine'],
      [`event:${W1}:e1`, 'mine'],
    ]);
    expect(itemFor(result, `event:${W1}:e1`).merged).toEqual(event('e1', { teacherIds: [] }));
  });

  it('an event may point to an entry that exists nowhere: that is not a change', () => {
    const dangling = makeDataset({}, { [W1]: { events: [event('e1', { locationId: 'gone', classIds: ['gone'] })] } });
    expect(mergeDatasets(dangling, dangling, dangling).items).toEqual([]);
  });
});

// ───────────────────────────── order, counts, shape ─────────────────────────────

describe('order of the items', () => {
  it('goes through the settings, the four lists and then the weeks by date', () => {
    const base = makeDataset(
      {
        subjects: [{ id: 's1', name: 'Lab', color: GREEN }],
        locations: [{ id: 'l1', name: 'Room 101' }],
        teachers: [{ id: 't1', name: 'Dana' }],
        classes: [{ id: 'c1', name: 'Class 1' }],
      },
      // The later week is stored first on purpose: the order has to come from the dates.
      { [W2]: { title: 'B', events: [event('x')] }, [W1]: { title: 'A', events: [event('y')] } },
    );
    const mine = makeDataset(
      {
        course: { name: 'Mine', startDate: null, endDate: '2027-01-31' },
        timeGrid: GRID,
        subjects: [{ id: 's1', name: 'Lab', color: RED }],
        locations: [{ id: 'l1', name: 'Room 101' }],
        teachers: [{ id: 't1', name: 'Dana L.' }],
        classes: [{ id: 'c1', name: 'Class 1' }],
      },
      { [W2]: { title: 'B', events: [event('x', { day: 2 })] }, [W1]: { title: 'A mine', events: [event('y')] } },
    );
    const theirs = makeDataset(
      {
        course: COURSE,
        timeGrid: { dayStart: 420, dayEnd: 1320, slotMinutes: 60 },
        subjects: [{ id: 's1', name: 'Lab', color: GREEN }],
        locations: [],
        teachers: [{ id: 't1', name: 'Dana' }],
        classes: [{ id: 'c1', name: 'כיתה 1' }],
      },
      { [W3]: { events: [event('z')] }, [W2]: { title: 'B theirs', events: [event('x')] }, [W1]: { title: 'A', events: [event('y', { notes: 'n' })] } },
    );
    expect(mergeDatasets(base, mine, theirs).items.map((item) => item.key)).toEqual([
      'course.name',
      'course.startDate',
      'course.endDate',
      'timeGrid.dayStart',
      'timeGrid.dayEnd',
      'timeGrid.slotMinutes',
      'subject:s1',
      'location:l1',
      'teacher:t1',
      'class:c1',
      `weekTitle:${W1}`,
      `event:${W1}:y`,
      `weekTitle:${W2}`,
      `event:${W2}:x`,
      `event:${W3}:z`,
    ]);
  });

  it('lists a list in my order, then entries only the team has, then entries only base has', () => {
    const names = (...ids: string[]): NamedItem[] => ids.map((id) => ({ id, name: id }));
    const base = makeDataset({ teachers: names('b1', 'b2', 'b3', 'b4', 'b5') });
    const mine = makeDataset({
      teachers: [{ id: 'm1', name: 'm1' }, { id: 'b3', name: 'b3 mine' }, { id: 'b1', name: 'b1 mine' }],
    });
    const theirs = makeDataset({
      teachers: [{ id: 'b4', name: 'b4 theirs' }, { id: 't1', name: 't1' }, { id: 'b2', name: 'b2 theirs' }, { id: 'b1', name: 'b1' }],
    });
    expect(statuses(mergeDatasets(base, mine, theirs))).toEqual([
      ['teacher:m1', 'mine'],
      ['teacher:b3', 'conflict'],
      ['teacher:b1', 'mine'],
      ['teacher:b4', 'conflict'],
      ['teacher:t1', 'theirs'],
      ['teacher:b2', 'conflict'],
      ['teacher:b5', 'same'],
    ]);
  });

  it('puts the week title first and orders events by my version, else theirs, else the base version', () => {
    const base = makeDataset(
      {},
      { [W1]: { title: 'Old', events: [event('a', { day: 0 }), event('b', { day: 1 }), event('c', { day: 2 }), event('d', { day: 3 })] } },
    );
    const mine = makeDataset(
      {},
      { [W1]: { title: 'Old', events: [event('a', { day: 6 }), event('c', { day: 2 }), event('m', { day: 4 })] } },
    );
    const theirs = makeDataset(
      {},
      { [W1]: { title: 'New', events: [event('a', { day: 0 }), event('b', { day: 5 }), event('t', { day: 0, start: 480, end: 510 })] } },
    );
    // a: my Saturday · b: their Friday (I deleted it) · c: my Tuesday · d: base Wednesday (both deleted it)
    expect(statuses(mergeDatasets(base, mine, theirs))).toEqual([
      [`weekTitle:${W1}`, 'theirs'],
      [`event:${W1}:t`, 'theirs'],
      [`event:${W1}:c`, 'theirs'],
      [`event:${W1}:d`, 'same'],
      [`event:${W1}:m`, 'mine'],
      [`event:${W1}:b`, 'conflict'],
      [`event:${W1}:a`, 'mine'],
    ]);
  });
});

describe('the result as a whole', () => {
  const base = makeDataset(
    { teachers: [{ id: 't1', name: 'Dana' }], subjects: [{ id: 's1', name: 'Lab', color: GREEN }] },
    { [W1]: { title: 'Week 12', events: [event('e1'), event('e2', { day: 1 }), event('e3', { day: 2 })] } },
  );
  const mine = makeDataset(
    { course: { ...COURSE, name: 'Mine' }, teachers: [{ id: 't1', name: 'Dana L.' }], subjects: [{ id: 's1', name: 'Laboratory', color: GREEN }] },
    { [W1]: { title: 'Docker week', events: [event('e1', { title: 'Mine' }), event('e3', { day: 2 }), event('e4', { day: 3 })] } },
  );
  const theirs = makeDataset(
    { teachers: [{ id: 't1', name: 'Dana Levi' }], subjects: [{ id: 's1', name: 'Lab', color: RED }], locations: [{ id: 'l1', name: 'Room 101' }] },
    { [W1]: { title: 'Docker week', events: [event('e1', { title: 'Theirs' }), event('e2', { day: 1 }), event('e3', { day: 4 })] } },
  );
  const result = mergeDatasets(base, mine, theirs);

  it('lists every item that differs from base on at least one side, and nothing else', () => {
    expect(statuses(result)).toEqual([
      ['course.name', 'mine'],
      ['subject:s1', 'combined'],
      ['location:l1', 'theirs'],
      ['teacher:t1', 'conflict'],
      [`weekTitle:${W1}`, 'same'],
      [`event:${W1}:e1`, 'conflict'],
      [`event:${W1}:e2`, 'mine'],
      [`event:${W1}:e3`, 'theirs'],
      [`event:${W1}:e4`, 'mine'],
    ]);
  });

  it('counts the conflicts and the changes of each side', () => {
    expect(result.conflictCount).toBe(2);
    // mine: course, subject, teacher, title, e1, e2, e4 · theirs: subject, location, teacher, title, e1, e3
    expect(result.mineCount).toBe(7);
    expect(result.theirsCount).toBe(6);
  });

  it('has the automatic result in merged: the team value for a conflict, nothing for a deletion', () => {
    expect(itemFor(result, 'subject:s1').merged).toEqual({ id: 's1', name: 'Laboratory', color: RED });
    expect(itemFor(result, 'teacher:t1').merged).toEqual({ id: 't1', name: 'Dana Levi' });
    expect(itemFor(result, `event:${W1}:e2`)).toMatchObject({ mineChange: 'deleted', merged: undefined });
    expect(itemFor(result, `weekTitle:${W1}`).merged).toBe('Docker week');
  });

  it('has conflictFields only on conflicts', () => {
    for (const item of result.items) {
      if (item.status !== 'conflict') expect(item.conflictFields).toEqual([]);
    }
    expect(itemFor(result, 'teacher:t1').conflictFields).toEqual(['name']);
    expect(itemFor(result, `event:${W1}:e1`).conflictFields).toEqual(['title']);
  });

  it('gives every item the ref of its key and nothing more', () => {
    const edited = makeDataset(
      { course: { ...COURSE, name: 'Mine' }, timeGrid: { ...GRID, slotMinutes: 60 }, teachers: [{ id: 't1', name: 'Dana L.' }], subjects: [{ id: 's1', name: 'Lab', color: GREEN }] },
      { [W1]: { title: 'Docker week', events: [event('e1'), event('e2', { day: 1 }), event('e3', { day: 5 })] } },
    );
    const change = { mineChange: 'modified', theirsChange: 'none', status: 'mine', conflictFields: [] };
    expect(mergeDatasets(base, edited, base).items).toStrictEqual([
      { key: 'course.name', kind: 'course', field: 'name', base: 'DevOps 2026', mine: 'Mine', theirs: 'DevOps 2026', merged: 'Mine', ...change },
      { key: 'timeGrid.slotMinutes', kind: 'timeGrid', field: 'slotMinutes', base: 30, mine: 60, theirs: 30, merged: 60, ...change },
      {
        key: 'teacher:t1',
        kind: 'teacher',
        id: 't1',
        base: { id: 't1', name: 'Dana' },
        mine: { id: 't1', name: 'Dana L.' },
        theirs: { id: 't1', name: 'Dana' },
        merged: { id: 't1', name: 'Dana L.' },
        ...change,
      },
      { key: `weekTitle:${W1}`, kind: 'weekTitle', weekStart: W1, base: 'Week 12', mine: 'Docker week', theirs: 'Week 12', merged: 'Docker week', ...change },
      {
        key: `event:${W1}:e3`,
        kind: 'event',
        id: 'e3',
        weekStart: W1,
        base: event('e3', { day: 2 }),
        mine: event('e3', { day: 5 }),
        theirs: event('e3', { day: 2 }),
        merged: event('e3', { day: 5 }),
        ...change,
      },
    ]);
  });

  it('does not change the datasets it compares', () => {
    const snapshot = JSON.stringify([base, mine, theirs]);
    // All three are deep-frozen, so a write would throw; the snapshot also catches a replaced object.
    mergeDatasets(base, mine, theirs);
    expect(JSON.stringify([base, mine, theirs])).toBe(snapshot);
  });
});
