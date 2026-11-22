/**
 * Tests for src/shared/model.ts: the pure operations on a dataset.
 *
 * The sample dataset is frozen all the way down, so an operation that changes what it was
 * given fails its test with a TypeError instead of passing by accident.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SUBJECT_COLORS } from '@shared/colors';
import {
  ENTITY_LIST_KEY,
  addEntity,
  compareEvents,
  countEntityUsage,
  datasetsEqual,
  deepEqual,
  entityList,
  eventsOverlap,
  findClashes,
  findEntity,
  findEntityByName,
  findEvent,
  findSubject,
  getWeek,
  hasActiveFilters,
  isValidTimeGrid,
  isWeekEmpty,
  matchesFilters,
  normalizeEvent,
  pruneEmptyWeeks,
  removeEntity,
  removeEvent,
  setWeekEvents,
  setWeekTitle,
  sortEvents,
  updateCourse,
  updateEntity,
  updateTimeGrid,
  upsertEvent,
  validateEvent,
  visibleRange,
  type Clash,
} from '@shared/model';
import {
  EMPTY_FILTERS,
  type CourseInfo,
  type Dataset,
  type DayIndex,
  type EntityKind,
  type Filters,
  type IsoDate,
  type ScheduleConfig,
  type ScheduleEvent,
  type SlotMinutes,
  type Subject,
  type TimeGrid,
  type WeekData,
} from '@shared/types';

// ───────────────────────────── fixtures ─────────────────────────────

const W1: IsoDate = '2026-11-22';
const W2: IsoDate = '2026-11-29';
const W3: IsoDate = '2026-12-06';
/** A week the sample dataset does not have. */
const W4: IsoDate = '2026-12-13';

const KINDS: readonly EntityKind[] = ['subject', 'location', 'teacher', 'class'];

function event(id: string, patch: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id,
    day: 0,
    start: 540,
    end: 600,
    title: '',
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

/** The same object with its keys in the opposite order. */
function reverseKeys<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).reverse()) as T;
}

const DOCKER = event('a', {
  day: 0,
  start: 540,
  end: 630,
  title: 'Docker basics',
  subjectId: 's1',
  locationId: 'l1',
  teacherIds: ['t1'],
  classIds: ['c1', 'c2'],
  notes: 'Bring a laptop',
});
const LAB = event('b', {
  day: 0,
  start: 660,
  end: 720,
  title: 'מעבדה',
  subjectId: 's2',
  locationId: 'l2',
  teacherIds: ['t2'],
  classIds: ['c1'],
});
const FREE = event('c', { day: 2, start: 780, end: 840 });
const REVIEW = event('d', {
  day: 1,
  start: 540,
  end: 600,
  title: 'Review',
  subjectId: 's1',
  locationId: 'l1',
  teacherIds: ['t1', 't2'],
  classIds: ['c2'],
});

/**
 * Two entries in every list. Week 1 has a title and three events, week 2 one event and no
 * title, week 3 a title and no events.
 */
const SAMPLE = deepFreeze<Dataset>({
  config: {
    course: { name: 'DevOps 2026', startDate: '2026-09-06', endDate: '2027-01-31' },
    timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
    subjects: [
      { id: 's1', name: 'Lecture', color: '#2563EB' },
      { id: 's2', name: 'מעבדה', color: '#16A34A' },
    ],
    locations: [
      { id: 'l1', name: 'Room 101' },
      { id: 'l2', name: 'חדר 7' },
    ],
    teachers: [
      { id: 't1', name: 'Dana' },
      { id: 't2', name: 'נועה' },
    ],
    classes: [
      { id: 'c1', name: 'Class 1' },
      { id: 'c2', name: 'Class 2' },
    ],
  },
  weeks: {
    [W1]: { weekStart: W1, title: 'Week 12', events: [DOCKER, LAB, FREE] },
    [W2]: { weekStart: W2, title: '', events: [REVIEW] },
    [W3]: { weekStart: W3, title: 'Holiday', events: [] },
  },
});

/** The sample with other settings and / or other weeks, frozen like the sample. */
function sampleWith(config: Partial<ScheduleConfig>, weeks: Record<IsoDate, WeekData> = SAMPLE.weeks): Dataset {
  return deepFreeze<Dataset>({ config: { ...SAMPLE.config, ...config }, weeks });
}

/** Every part of the settings except the list of `kind` must be the very object of the sample. */
function expectOtherSettingsShared(result: Dataset, kind: EntityKind): void {
  expect(result.config.course).toBe(SAMPLE.config.course);
  expect(result.config.timeGrid).toBe(SAMPLE.config.timeGrid);
  for (const other of KINDS) {
    if (other !== kind) expect(entityList(result.config, other)).toBe(entityList(SAMPLE.config, other));
  }
}

// ───────────────────────────── lists of the settings ─────────────────────────────

describe('entityList, findEntity and findSubject', () => {
  it('maps every kind to its list in the settings', () => {
    expect(ENTITY_LIST_KEY).toEqual({
      subject: 'subjects',
      location: 'locations',
      teacher: 'teachers',
      class: 'classes',
    });
    expect(entityList(SAMPLE.config, 'subject')).toBe(SAMPLE.config.subjects);
    expect(entityList(SAMPLE.config, 'location')).toBe(SAMPLE.config.locations);
    expect(entityList(SAMPLE.config, 'teacher')).toBe(SAMPLE.config.teachers);
    expect(entityList(SAMPLE.config, 'class')).toBe(SAMPLE.config.classes);
  });

  it('finds an entry by its id', () => {
    expect(findEntity(SAMPLE.config, 'subject', 's2')).toBe(SAMPLE.config.subjects[1]);
    expect(findEntity(SAMPLE.config, 'location', 'l2')).toBe(SAMPLE.config.locations[1]);
    expect(findEntity(SAMPLE.config, 'teacher', 't1')).toBe(SAMPLE.config.teachers[0]);
    expect(findEntity(SAMPLE.config, 'class', 'c2')).toBe(SAMPLE.config.classes[1]);
  });

  it('looks only in the list of the given kind', () => {
    const config = deepFreeze<ScheduleConfig>({
      ...SAMPLE.config,
      subjects: [{ id: 'x1', name: 'Subject', color: '#DC2626' }],
      locations: [{ id: 'x1', name: 'Location' }],
      teachers: [{ id: 'x1', name: 'Teacher' }],
      classes: [{ id: 'x1', name: 'Class' }],
    });
    expect(KINDS.map((kind) => findEntity(config, kind, 'x1')?.name)).toEqual(['Subject', 'Location', 'Teacher', 'Class']);
    expect(findEntity(SAMPLE.config, 'teacher', 'l1')).toBeUndefined();
    expect(findEntity(SAMPLE.config, 'location', 't1')).toBeUndefined();
  });

  it.each<string | null>([null, '', 'unknown'])('finds nothing for the id %j', (id) => {
    for (const kind of KINDS) expect(findEntity(SAMPLE.config, kind, id)).toBeUndefined();
    expect(findSubject(SAMPLE.config, id)).toBeUndefined();
  });

  it('findSubject returns the subject together with its colour', () => {
    expect(findSubject(SAMPLE.config, 's2')).toBe(SAMPLE.config.subjects[1]);
    expect(findSubject(SAMPLE.config, 's2')?.color).toBe('#16A34A');
    expect(findSubject(SAMPLE.config, 'l1')).toBeUndefined();
  });
});

// ───────────────────────────── deepEqual ─────────────────────────────

describe('deepEqual', () => {
  it.each<[unknown, unknown]>([
    [1, 1],
    ['a', 'a'],
    ['', ''],
    [true, true],
    [null, null],
    [[], []],
    [{}, {}],
    [
      [1, 'a', null, [2, [3]]],
      [1, 'a', null, [2, [3]]],
    ],
    [{ a: null }, { a: null }],
    [{ a: 1, b: { c: [1, 2, { d: 'x' }] } }, { a: 1, b: { c: [1, 2, { d: 'x' }] } }],
  ])('%j equals %j', (a, b) => {
    expect(deepEqual(a, b)).toBe(true);
    expect(deepEqual(b, a)).toBe(true);
  });

  it.each<[unknown, unknown]>([
    [1, 2],
    [1, '1'],
    [0, false],
    [0, null],
    ['', null],
    [null, {}],
    [null, []],
    [[], {}],
    [['a'], { 0: 'a' }],
    [
      [1, 2],
      [2, 1],
    ],
    [[1], [1, 2]],
    [
      [1, [2]],
      [1, [3]],
    ],
    [[{ a: 1 }], [{ a: 2 }]],
    [{ a: 1 }, { a: 2 }],
    [{ a: 1 }, { b: 1 }],
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: null }, {}],
    [{ a: [] }, { a: {} }],
    [{ a: 'x' }, { a: ['x'] }],
    [{ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }],
  ])('%j differs from %j', (a, b) => {
    expect(deepEqual(a, b)).toBe(false);
    expect(deepEqual(b, a)).toBe(false);
  });

  it('is true for one and the same object', () => {
    expect(deepEqual(SAMPLE, SAMPLE)).toBe(true);
    expect(deepEqual(SAMPLE.weeks[W1].events, SAMPLE.weeks[W1].events)).toBe(true);
  });

  it('ignores the order of the keys', () => {
    expect(deepEqual({ a: 1, b: { c: 2, d: [3] } }, { b: { d: [3], c: 2 }, a: 1 })).toBe(true);
    expect(deepEqual(DOCKER, reverseKeys(DOCKER))).toBe(true);
  });

  it('counts a property that is set to undefined as absent', () => {
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEqual({ a: undefined }, { b: undefined })).toBe(true);
    expect(deepEqual({ a: { b: undefined } }, { a: {} })).toBe(true);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1, b: null })).toBe(false);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1, c: 2 })).toBe(false);
  });

  it('does not take a member that every object inherits for a property of the other value', () => {
    // What JSON.parse makes of a file that really has such a key: an own property.
    const ownProto: unknown = JSON.parse('{"__proto__":{}}');
    expect(deepEqual(ownProto, { other: {} })).toBe(false);
    expect(deepEqual({ other: {} }, ownProto)).toBe(false);
    expect(deepEqual(ownProto, JSON.parse('{"__proto__":{}}'))).toBe(true);
    expect(deepEqual(ownProto, JSON.parse('{"__proto__":{"a":1}}'))).toBe(false);
    expect(deepEqual({ constructor: 1 }, { other: 1 })).toBe(false);
    expect(deepEqual({ toString: null }, { other: null })).toBe(false);
  });
});

// ───────────────────────────── events ─────────────────────────────

describe('normalizeEvent', () => {
  it('trims the title and the notes, and keeps what is inside them', () => {
    const result = normalizeEvent(event('e1', { title: '  Docker  basics \n', notes: '\t line 1\n  line 2 \n' }));
    expect(result.title).toBe('Docker  basics');
    expect(result.notes).toBe('line 1\n  line 2');
  });

  it('removes duplicate teacher and class ids and sorts them as plain text', () => {
    const result = normalizeEvent(
      event('e1', { teacherIds: ['t2', 't10', 'T1', 't2', 't1'], classIds: ['ב', 'c', 'א', 'c', 'B'] }),
    );
    expect(result.teacherIds).toEqual(['T1', 't1', 't10', 't2']);
    expect(result.classIds).toEqual(['B', 'c', 'א', 'ב']);
  });

  it('turns an empty subject or location id into null and keeps a real one', () => {
    expect(normalizeEvent(event('e1', { subjectId: '', locationId: '' }))).toMatchObject({
      subjectId: null,
      locationId: null,
    });
    expect(normalizeEvent(event('e1', { subjectId: 's1', locationId: 'l1' }))).toMatchObject({
      subjectId: 's1',
      locationId: 'l1',
    });
    expect(normalizeEvent(event('e1'))).toMatchObject({ subjectId: null, locationId: null });
  });

  it('rounds start and end to whole minutes', () => {
    expect(normalizeEvent(event('e1', { start: 539.6, end: 600.4 }))).toMatchObject({ start: 540, end: 600 });
    expect(normalizeEvent(event('e1', { start: 0.2, end: 1439.7 }))).toMatchObject({ start: 0, end: 1440 });
  });

  it('keeps the id and the day as they are', () => {
    expect(normalizeEvent(event(' e 1 ', { day: 6 }))).toMatchObject({ id: ' e 1 ', day: 6 });
  });

  it('returns a new event with new lists and leaves the given one alone', () => {
    const given = deepFreeze(event('e1', { title: ' x ', teacherIds: ['t2', 't1'], classIds: ['c1'] }));
    const result = normalizeEvent(given);
    expect(result).not.toBe(given);
    expect(result.teacherIds).not.toBe(given.teacherIds);
    expect(result.classIds).not.toBe(given.classIds);
    expect(given).toEqual(event('e1', { title: ' x ', teacherIds: ['t2', 't1'], classIds: ['c1'] }));
  });

  it('changes nothing in an event that is canonical already, however often it is applied', () => {
    expect(normalizeEvent(DOCKER)).toEqual(DOCKER);
    const messy = event('e1', { title: ' x ', notes: ' y ', subjectId: '', teacherIds: ['b', 'a', 'b'], start: 539.5 });
    const once = normalizeEvent(messy);
    expect(normalizeEvent(once)).toEqual(once);
  });

  it('keeps the ten fields of an event and nothing else', () => {
    const withMore = { ...event('e1'), color: '#FFFFFF', weekStart: W1 };
    expect(Object.keys(normalizeEvent(withMore)).sort()).toEqual([
      'classIds',
      'day',
      'end',
      'id',
      'locationId',
      'notes',
      'start',
      'subjectId',
      'teacherIds',
      'title',
    ]);
  });

  it('does not validate', () => {
    const impossible = event('', { day: 9 as DayIndex, start: 700, end: 600 });
    expect(normalizeEvent(impossible)).toEqual(impossible);
  });
});

describe('compareEvents and sortEvents', () => {
  it.each<[string, ScheduleEvent, ScheduleEvent]>([
    ['the day first', event('z', { day: 0, start: 1000, end: 1100 }), event('a', { day: 1, start: 0, end: 10 })],
    ['then the start', event('z', { start: 540, end: 700 }), event('a', { start: 600, end: 610 })],
    ['then the end', event('z', { start: 540, end: 600 }), event('a', { start: 540, end: 660 })],
    ['then the id', event('a'), event('b')],
    ['ids as plain text, so capitals come first', event('B'), event('a')],
    ['ids as plain text, not as numbers', event('e10'), event('e9')],
  ])('compares %s', (_name, earlier, later) => {
    expect(compareEvents(earlier, later)).toBeLessThan(0);
    expect(compareEvents(later, earlier)).toBeGreaterThan(0);
  });

  it('calls two events equal when day, start, end and id are the same', () => {
    expect(compareEvents(DOCKER, DOCKER)).toBe(0);
    expect(compareEvents(event('a', { title: 'One' }), event('a', { title: 'Two', locationId: 'l1' }))).toBe(0);
  });

  it('sortEvents returns a new sorted list of the same events and leaves the given list alone', () => {
    const given = deepFreeze([FREE, REVIEW, LAB, DOCKER]);
    const sorted = sortEvents(given);
    expect(sorted).not.toBe(given);
    expect(sorted.map((e) => e.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(sorted[0]).toBe(DOCKER);
    expect(sorted[3]).toBe(FREE);
    expect(given.map((e) => e.id)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('sortEvents copes with no events and with a single event', () => {
    expect(sortEvents([])).toEqual([]);
    expect(sortEvents([DOCKER])).toEqual([DOCKER]);
  });
});

describe('validateEvent', () => {
  it('finds nothing wrong with a valid event, also at the edges of the day and of the week', () => {
    expect(validateEvent(DOCKER)).toEqual([]);
    expect(validateEvent(event('e1', { day: 0, start: 0, end: 1 }))).toEqual([]);
    expect(validateEvent(event('e1', { day: 6, start: 1439, end: 1440 }))).toEqual([]);
    expect(validateEvent(event('e1', { start: 0, end: 1440 }))).toEqual([]);
    expect(validateEvent(event('e1', { start: 547, end: 548 }))).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['an empty id', ''],
    ['an id that is a number', 17],
    ['an id that is null', null],
  ])('reports %s as missing-id', (_name, id) => {
    expect(validateEvent({ ...event('e1'), id: id as string })).toEqual(['missing-id']);
  });

  it.each([7, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('reports the day %d as bad-day', (day) => {
    expect(validateEvent(event('e1', { day: day as DayIndex }))).toEqual(['bad-day']);
  });

  it.each<[string, number, number]>([
    ['ends when it starts', 600, 600],
    ['ends before it starts', 600, 540],
    ['starts before midnight', -15, 60],
    ['ends after 24:00', 1380, 1441],
    ['starts at a fraction of a minute', 540.5, 600],
    ['ends at a fraction of a minute', 540, 600.5],
    ['has a start that is not a number', Number.NaN, 600],
    ['has an end that is not a number', 540, Number.NaN],
  ])('reports an event that %s as bad-time-range', (_name, start, end) => {
    expect(validateEvent(event('e1', { start, end }))).toEqual(['bad-time-range']);
  });

  it('reports everything that is wrong at once', () => {
    const issues = validateEvent(event('', { day: 9 as DayIndex, start: 700, end: 600 }));
    expect([...issues].sort()).toEqual(['bad-day', 'bad-time-range', 'missing-id']);
  });
});

// ───────────────────────────── weeks ─────────────────────────────

describe('getWeek, findEvent and isWeekEmpty', () => {
  it('getWeek returns the stored week', () => {
    expect(getWeek(SAMPLE, W1)).toBe(SAMPLE.weeks[W1]);
    expect(getWeek(SAMPLE, W3)).toBe(SAMPLE.weeks[W3]);
  });

  it('getWeek returns a new empty week for a week that is not stored, without storing it', () => {
    const week = getWeek(SAMPLE, W4);
    expect(week).toEqual({ weekStart: W4, title: '', events: [] });
    expect(W4 in SAMPLE.weeks).toBe(false);
    expect(getWeek(SAMPLE, W4)).not.toBe(week);
    expect(getWeek(SAMPLE, W4).events).not.toBe(week.events);
  });

  it('findEvent finds an event in its own week only', () => {
    expect(findEvent(SAMPLE, W1, 'b')).toBe(LAB);
    expect(findEvent(SAMPLE, W2, 'd')).toBe(REVIEW);
    expect(findEvent(SAMPLE, W2, 'b')).toBeUndefined();
    expect(findEvent(SAMPLE, W1, 'unknown')).toBeUndefined();
    expect(findEvent(SAMPLE, W3, 'a')).toBeUndefined();
    expect(findEvent(SAMPLE, W4, 'a')).toBeUndefined();
  });

  it('isWeekEmpty is true only for a week without a title and without events', () => {
    expect(isWeekEmpty({ weekStart: W1, title: '', events: [] })).toBe(true);
    expect(isWeekEmpty(getWeek(SAMPLE, W4))).toBe(true);
    expect(isWeekEmpty(SAMPLE.weeks[W1])).toBe(false);
    expect(isWeekEmpty(SAMPLE.weeks[W2])).toBe(false);
    expect(isWeekEmpty(SAMPLE.weeks[W3])).toBe(false);
  });
});

describe('upsertEvent', () => {
  it('adds a new event at its place in the sorted week', () => {
    const added = event('n', { day: 1, start: 600, end: 660, title: 'New' });
    const result = upsertEvent(SAMPLE, W1, added);
    expect(result.weeks[W1].events.map((e) => e.id)).toEqual(['a', 'b', 'n', 'c']);
    expect(result.weeks[W1].events[2]).toEqual(added);
    expect(result.weeks[W1].title).toBe('Week 12');
    expect(result.weeks[W1].weekStart).toBe(W1);
  });

  it('shares everything it does not change with the dataset it was given', () => {
    const result = upsertEvent(SAMPLE, W1, event('n', { day: 6 }));
    expect(result).not.toBe(SAMPLE);
    expect(result.config).toBe(SAMPLE.config);
    expect(result.weeks[W2]).toBe(SAMPLE.weeks[W2]);
    expect(result.weeks[W3]).toBe(SAMPLE.weeks[W3]);
    expect(result.weeks[W1].events[0]).toBe(DOCKER);
    expect(result.weeks[W1].events[1]).toBe(LAB);
    expect(result.weeks[W1].events[2]).toBe(FREE);
    expect(SAMPLE.weeks[W1].events).toEqual([DOCKER, LAB, FREE]);
  });

  it('creates the week when it does not exist yet', () => {
    const result = upsertEvent(SAMPLE, W4, event('n'));
    expect(result.weeks[W4]).toEqual({ weekStart: W4, title: '', events: [event('n')] });
    expect(Object.keys(result.weeks).sort()).toEqual([W1, W2, W3, W4]);
  });

  it('adds to a week that so far only has a title', () => {
    const result = upsertEvent(SAMPLE, W3, event('n'));
    expect(result.weeks[W3]).toEqual({ weekStart: W3, title: 'Holiday', events: [event('n')] });
  });

  it('replaces the event with the same id and moves it to its new place', () => {
    const moved: ScheduleEvent = { ...DOCKER, day: 4, title: 'Docker, moved' };
    const result = upsertEvent(SAMPLE, W1, moved);
    expect(result.weeks[W1].events.map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(result.weeks[W1].events[2]).toEqual(moved);
    expect(result.weeks[W1].events[0]).toBe(LAB);
    expect(result.weeks[W1].events[1]).toBe(FREE);
  });

  it('stores the event in canonical form', () => {
    const messy = event('n', {
      title: '  New  ',
      notes: ' note\n',
      subjectId: '',
      locationId: '',
      teacherIds: ['t2', 't1', 't2'],
      classIds: ['c2', 'c1'],
      start: 540.4,
      end: 599.6,
    });
    expect(upsertEvent(SAMPLE, W4, deepFreeze(messy)).weeks[W4].events).toEqual([
      event('n', { title: 'New', notes: 'note', teacherIds: ['t1', 't2'], classIds: ['c1', 'c2'] }),
    ]);
  });

  it('returns the same dataset when the stored event is already identical', () => {
    expect(upsertEvent(SAMPLE, W1, DOCKER)).toBe(SAMPLE);
    expect(upsertEvent(SAMPLE, W1, structuredClone(DOCKER))).toBe(SAMPLE);
    expect(upsertEvent(SAMPLE, W1, reverseKeys(DOCKER))).toBe(SAMPLE);
  });

  it('returns the same dataset when the event only differs from the stored one before it is normalized', () => {
    const sameAfterwards: ScheduleEvent = {
      ...DOCKER,
      title: ' Docker basics ',
      classIds: ['c2', 'c1', 'c2'],
      notes: 'Bring a laptop\n',
    };
    expect(upsertEvent(SAMPLE, W1, sameAfterwards)).toBe(SAMPLE);
  });

  it('treats the same id in another week as another event', () => {
    const result = upsertEvent(SAMPLE, W2, { ...DOCKER, title: 'Copy' });
    expect(result.weeks[W2].events.map((e) => e.id)).toEqual(['a', 'd']);
    expect(result.weeks[W2].events[1]).toBe(REVIEW);
    expect(result.weeks[W1]).toBe(SAMPLE.weeks[W1]);
  });
});

describe('removeEvent', () => {
  it('removes the event and keeps the rest of the week', () => {
    const result = removeEvent(SAMPLE, W1, 'b');
    expect(result.weeks[W1]).toEqual({ weekStart: W1, title: 'Week 12', events: [DOCKER, FREE] });
    expect(result.weeks[W1].events[0]).toBe(DOCKER);
    expect(result.weeks[W1].events[1]).toBe(FREE);
    expect(result.config).toBe(SAMPLE.config);
    expect(result.weeks[W2]).toBe(SAMPLE.weeks[W2]);
    expect(result.weeks[W3]).toBe(SAMPLE.weeks[W3]);
  });

  it('drops the week when its last event goes and it has no title', () => {
    const result = removeEvent(SAMPLE, W2, 'd');
    expect(W2 in result.weeks).toBe(false);
    expect(Object.keys(result.weeks).sort()).toEqual([W1, W3]);
    expect(result.weeks[W1]).toBe(SAMPLE.weeks[W1]);
  });

  it('keeps a week that still has a title after its last event went', () => {
    const dataset = sampleWith({}, { [W1]: { weekStart: W1, title: 'Week 12', events: [DOCKER] } });
    expect(removeEvent(dataset, W1, 'a').weeks[W1]).toEqual({ weekStart: W1, title: 'Week 12', events: [] });
  });

  it.each<[string, IsoDate, string]>([
    ['the week does not exist', W4, 'a'],
    ['the week has no such event', W1, 'unknown'],
    ['the event is in another week', W1, 'd'],
    ['the week has no events at all', W3, 'a'],
  ])('returns the same dataset when %s', (_reason, weekStart, eventId) => {
    expect(removeEvent(SAMPLE, weekStart, eventId)).toBe(SAMPLE);
  });
});

describe('setWeekTitle', () => {
  it('names a week, without the white space around the name', () => {
    const result = setWeekTitle(SAMPLE, W1, '  שבוע 12 – Docker \n');
    expect(result.weeks[W1].title).toBe('שבוע 12 – Docker');
    expect(result.weeks[W1].events).toBe(SAMPLE.weeks[W1].events);
    expect(result.config).toBe(SAMPLE.config);
    expect(result.weeks[W2]).toBe(SAMPLE.weeks[W2]);
    expect(result.weeks[W3]).toBe(SAMPLE.weeks[W3]);
  });

  it('names a week that so far only has events', () => {
    expect(setWeekTitle(SAMPLE, W2, 'Week 13').weeks[W2]).toEqual({ weekStart: W2, title: 'Week 13', events: [REVIEW] });
  });

  it('creates the week when it does not exist yet', () => {
    expect(setWeekTitle(SAMPLE, W4, 'Exams').weeks[W4]).toEqual({ weekStart: W4, title: 'Exams', events: [] });
  });

  it('drops a week without events when its title is cleared', () => {
    const result = setWeekTitle(SAMPLE, W3, '   ');
    expect(W3 in result.weeks).toBe(false);
    expect(Object.keys(result.weeks).sort()).toEqual([W1, W2]);
  });

  it('keeps a week with events when its title is cleared', () => {
    const result = setWeekTitle(SAMPLE, W1, '');
    expect(result.weeks[W1]).toEqual({ weekStart: W1, title: '', events: [DOCKER, LAB, FREE] });
  });

  it.each<[string, IsoDate, string]>([
    ['the title is the same', W1, 'Week 12'],
    ['the title only differs in the white space around it', W1, '  Week 12\n'],
    ['a week without a title gets an empty title', W2, ''],
    ['a week that does not exist gets an empty title', W4, ''],
    ['a week that does not exist gets a title of white space', W4, ' \t '],
  ])('returns the same dataset when %s', (_reason, weekStart, title) => {
    expect(setWeekTitle(SAMPLE, weekStart, title)).toBe(SAMPLE);
  });
});

describe('setWeekEvents', () => {
  it('replaces all events of the week, normalized and sorted, and keeps the title', () => {
    const late = event('y', { day: 5, title: ' Late ', teacherIds: ['t2', 't1'] });
    const early = event('x', { day: 1 });
    const result = setWeekEvents(SAMPLE, W1, deepFreeze([late, early]));
    expect(result.weeks[W1]).toEqual({
      weekStart: W1,
      title: 'Week 12',
      events: [early, event('y', { day: 5, title: 'Late', teacherIds: ['t1', 't2'] })],
    });
    expect(result.config).toBe(SAMPLE.config);
    expect(result.weeks[W2]).toBe(SAMPLE.weeks[W2]);
    expect(result.weeks[W3]).toBe(SAMPLE.weeks[W3]);
  });

  it('creates the week when it does not exist yet', () => {
    expect(setWeekEvents(SAMPLE, W4, [FREE, DOCKER]).weeks[W4]).toEqual({
      weekStart: W4,
      title: '',
      events: [DOCKER, FREE],
    });
  });

  it('drops a week without a title when it is left without events', () => {
    const result = setWeekEvents(SAMPLE, W2, []);
    expect(W2 in result.weeks).toBe(false);
    expect(Object.keys(result.weeks).sort()).toEqual([W1, W3]);
  });

  it('keeps a week with a title when it is left without events', () => {
    expect(setWeekEvents(SAMPLE, W1, []).weeks[W1]).toEqual({ weekStart: W1, title: 'Week 12', events: [] });
  });

  it('returns the same dataset when the week already has exactly these events', () => {
    expect(setWeekEvents(SAMPLE, W1, SAMPLE.weeks[W1].events)).toBe(SAMPLE);
    const sameInAnotherShape = [structuredClone(FREE), reverseKeys(LAB), { ...DOCKER, classIds: ['c2', 'c1'] }];
    expect(setWeekEvents(SAMPLE, W1, sameInAnotherShape)).toBe(SAMPLE);
    expect(setWeekEvents(SAMPLE, W3, [])).toBe(SAMPLE);
    expect(setWeekEvents(SAMPLE, W4, [])).toBe(SAMPLE);
  });
});

describe('pruneEmptyWeeks', () => {
  it('removes every week that has neither a title nor events, and only those', () => {
    const later: IsoDate = '2026-12-20';
    const dataset = sampleWith(
      {},
      {
        [W4]: { weekStart: W4, title: '', events: [] },
        ...SAMPLE.weeks,
        [later]: { weekStart: later, title: '', events: [] },
      },
    );
    const result = pruneEmptyWeeks(dataset);
    expect(Object.keys(result.weeks).sort()).toEqual([W1, W2, W3]);
    expect(result.weeks[W1]).toBe(SAMPLE.weeks[W1]);
    expect(result.weeks[W2]).toBe(SAMPLE.weeks[W2]);
    expect(result.weeks[W3]).toBe(SAMPLE.weeks[W3]);
    expect(result.config).toBe(dataset.config);
  });

  it('returns the same dataset when there is nothing to remove', () => {
    expect(pruneEmptyWeeks(SAMPLE)).toBe(SAMPLE);
    const noWeeks = sampleWith({}, {});
    expect(pruneEmptyWeeks(noWeeks)).toBe(noWeeks);
  });
});

// ───────────────────────────── course and time grid ─────────────────────────────

describe('updateCourse', () => {
  it('changes only what the patch names', () => {
    expect(updateCourse(SAMPLE, { name: 'Cloud 2027' }).config.course).toEqual({
      name: 'Cloud 2027',
      startDate: '2026-09-06',
      endDate: '2027-01-31',
    });
    expect(updateCourse(SAMPLE, { startDate: '2026-10-11' }).config.course).toEqual({
      name: 'DevOps 2026',
      startDate: '2026-10-11',
      endDate: '2027-01-31',
    });
    expect(updateCourse(SAMPLE, { endDate: '2027-02-28' }).config.course).toEqual({
      name: 'DevOps 2026',
      startDate: '2026-09-06',
      endDate: '2027-02-28',
    });
  });

  it('applies a patch of all three fields', () => {
    const course: CourseInfo = { name: 'קורס ענן', startDate: '2027-03-07', endDate: '2027-07-30' };
    expect(updateCourse(SAMPLE, deepFreeze(course)).config.course).toEqual(course);
  });

  it('trims the name', () => {
    expect(updateCourse(SAMPLE, { name: '  קורס ענן \n' }).config.course.name).toBe('קורס ענן');
  });

  it('can clear the name', () => {
    expect(updateCourse(SAMPLE, { name: '   ' }).config.course.name).toBe('');
  });

  it('clears a date that is set to null', () => {
    expect(updateCourse(SAMPLE, { startDate: null }).config.course).toEqual({
      name: 'DevOps 2026',
      startDate: null,
      endDate: '2027-01-31',
    });
    expect(updateCourse(SAMPLE, { startDate: null, endDate: null }).config.course).toEqual({
      name: 'DevOps 2026',
      startDate: null,
      endDate: null,
    });
  });

  it('sets a date that was not set', () => {
    const noDates = sampleWith({ course: { name: 'DevOps 2026', startDate: null, endDate: null } });
    expect(updateCourse(noDates, { endDate: '2027-01-31' }).config.course).toEqual({
      name: 'DevOps 2026',
      startDate: null,
      endDate: '2027-01-31',
    });
  });

  it('shares the rest of the dataset', () => {
    const result = updateCourse(SAMPLE, { name: 'Cloud 2027' });
    expect(result).not.toBe(SAMPLE);
    expect(result.weeks).toBe(SAMPLE.weeks);
    expect(result.config.timeGrid).toBe(SAMPLE.config.timeGrid);
    for (const kind of KINDS) expect(entityList(result.config, kind)).toBe(entityList(SAMPLE.config, kind));
  });

  it.each<[string, Partial<CourseInfo>]>([
    ['the patch is empty', {}],
    ['the patch repeats the current values', { name: 'DevOps 2026', startDate: '2026-09-06', endDate: '2027-01-31' }],
    ['the name only differs in the white space around it', { name: ' DevOps 2026 ' }],
    ['the patch only holds undefined', { name: undefined, startDate: undefined, endDate: undefined }],
  ])('returns the same dataset when %s', (_reason, patch) => {
    expect(updateCourse(SAMPLE, patch)).toBe(SAMPLE);
  });
});

/** Changes to the sample grid (08:00–20:00, 30-minute rows) that make it invalid. */
const INVALID_GRID_PATCHES: [string, Partial<TimeGrid>][] = [
  ['the day ends when it starts', { dayEnd: 480 }],
  ['the day ends before it starts', { dayStart: 1215 }],
  ['the start is not a multiple of 15', { dayStart: 485 }],
  ['the end is not a multiple of 15', { dayEnd: 1190 }],
  ['the start is before midnight', { dayStart: -15 }],
  ['the end is after 24:00', { dayEnd: 1455 }],
  ['the start is not a whole minute', { dayStart: 472.5 }],
  ['the end is not a whole minute', { dayEnd: 1207.5 }],
  ['the start is not a number', { dayStart: Number.NaN }],
  ['the end is not a number', { dayEnd: Number.POSITIVE_INFINITY }],
  ['the rows are 20 minutes', { slotMinutes: 20 as SlotMinutes }],
  ['the rows are 0 minutes', { slotMinutes: 0 as SlotMinutes }],
  ['the rows are 90 minutes', { slotMinutes: 90 as SlotMinutes }],
  ['the rows are minus 15 minutes', { slotMinutes: -15 as SlotMinutes }],
];

describe('isValidTimeGrid', () => {
  it.each<TimeGrid>([
    { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
    { dayStart: 0, dayEnd: 1440, slotMinutes: 15 },
    { dayStart: 0, dayEnd: 15, slotMinutes: 60 },
    { dayStart: 1425, dayEnd: 1440, slotMinutes: 45 },
    { dayStart: 495, dayEnd: 1185, slotMinutes: 60 },
  ])('accepts %j', (grid) => {
    expect(isValidTimeGrid(grid)).toBe(true);
  });

  it.each(INVALID_GRID_PATCHES)('rejects a grid in which %s', (_reason, patch) => {
    expect(isValidTimeGrid({ ...SAMPLE.config.timeGrid, ...patch })).toBe(false);
  });
});

describe('updateTimeGrid', () => {
  it('changes only what the patch names', () => {
    expect(updateTimeGrid(SAMPLE, { dayStart: 420 }).config.timeGrid).toEqual({
      dayStart: 420,
      dayEnd: 1200,
      slotMinutes: 30,
    });
    expect(updateTimeGrid(SAMPLE, { dayEnd: 1440 }).config.timeGrid).toEqual({
      dayStart: 480,
      dayEnd: 1440,
      slotMinutes: 30,
    });
    expect(updateTimeGrid(SAMPLE, { slotMinutes: 45 }).config.timeGrid).toEqual({
      dayStart: 480,
      dayEnd: 1200,
      slotMinutes: 45,
    });
  });

  it('applies a patch of all three fields', () => {
    const grid: TimeGrid = { dayStart: 0, dayEnd: 1440, slotMinutes: 60 };
    expect(updateTimeGrid(SAMPLE, deepFreeze(grid)).config.timeGrid).toEqual(grid);
  });

  it('takes midnight as a start like any other time', () => {
    expect(updateTimeGrid(SAMPLE, { dayStart: 0 }).config.timeGrid.dayStart).toBe(0);
  });

  it('judges the grid that results, not each field of the patch on its own', () => {
    expect(updateTimeGrid(SAMPLE, { dayStart: 1215 })).toBe(SAMPLE);
    expect(updateTimeGrid(SAMPLE, { dayStart: 1215, dayEnd: 1320 }).config.timeGrid).toEqual({
      dayStart: 1215,
      dayEnd: 1320,
      slotMinutes: 30,
    });
    expect(updateTimeGrid(SAMPLE, { dayEnd: 450 })).toBe(SAMPLE);
    expect(updateTimeGrid(SAMPLE, { dayStart: 360, dayEnd: 450 }).config.timeGrid).toEqual({
      dayStart: 360,
      dayEnd: 450,
      slotMinutes: 30,
    });
  });

  it('shares the rest of the dataset', () => {
    const result = updateTimeGrid(SAMPLE, { slotMinutes: 60 });
    expect(result).not.toBe(SAMPLE);
    expect(result.weeks).toBe(SAMPLE.weeks);
    expect(result.config.course).toBe(SAMPLE.config.course);
    for (const kind of KINDS) expect(entityList(result.config, kind)).toBe(entityList(SAMPLE.config, kind));
  });

  it.each(INVALID_GRID_PATCHES)('returns the same dataset when %s', (_reason, patch) => {
    expect(updateTimeGrid(SAMPLE, patch)).toBe(SAMPLE);
  });

  it.each<[string, Partial<TimeGrid>]>([
    ['the patch is empty', {}],
    ['the patch repeats the current values', { dayStart: 480, dayEnd: 1200, slotMinutes: 30 }],
    ['the patch only holds undefined', { dayStart: undefined, dayEnd: undefined, slotMinutes: undefined }],
  ])('returns the same dataset when %s', (_reason, patch) => {
    expect(updateTimeGrid(SAMPLE, patch)).toBe(SAMPLE);
  });
});

// ───────────────────────────── subjects, locations, teachers, classes ─────────────────────────────

describe('addEntity', () => {
  it.each(KINDS)('appends a %s to the end of its list, with the name trimmed', (kind) => {
    const before = entityList(SAMPLE.config, kind);
    const result = addEntity(SAMPLE, kind, deepFreeze({ id: 'new1', name: '  כיתה חדשה \n' }));
    const after = entityList(result.config, kind);
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toMatchObject({ id: 'new1', name: 'כיתה חדשה' });
    expect(result.weeks).toBe(SAMPLE.weeks);
    expectOtherSettingsShared(result, kind);
    expect(before).toHaveLength(2);
  });

  it('gives a subject the colour it comes with, written as #RRGGBB', () => {
    const colorOf = (color: string): string =>
      addEntity(SAMPLE, 'subject', { id: 'new1', name: 'Exam', color }).config.subjects[2].color;
    expect(colorOf('#7C3AED')).toBe('#7C3AED');
    expect(colorOf('#7c3aed')).toBe('#7C3AED');
    expect(colorOf(' 7c3aed ')).toBe('#7C3AED');
    expect(colorOf('#fa0')).toBe('#FFAA00');
    expect(colorOf('#2563EB')).toBe('#2563EB');
  });

  it('gives a subject without a colour the next free colour of the palette', () => {
    expect(SAMPLE.config.subjects.map((s) => s.color)).toEqual(DEFAULT_SUBJECT_COLORS.slice(0, 2));
    expect(addEntity(SAMPLE, 'subject', { id: 'new1', name: 'Exam' }).config.subjects[2]).toEqual({
      id: 'new1',
      name: 'Exam',
      color: DEFAULT_SUBJECT_COLORS[2],
    });
  });

  it.each(['blue', '', '#12345', '#GGGGGG', 'rgb(1,2,3)'])(
    'gives a subject with the invalid colour %j the next free colour of the palette',
    (color) => {
      expect(addEntity(SAMPLE, 'subject', { id: 'new1', name: 'Exam', color }).config.subjects[2]).toEqual({
        id: 'new1',
        name: 'Exam',
        color: DEFAULT_SUBJECT_COLORS[2],
      });
    },
  );

  it('treats a colour that is there but undefined like no colour at all', () => {
    // An optional colour that a caller hands on unset; the parameter type accepts such an object.
    const item = deepFreeze({ id: 'new1', name: 'Exam', color: undefined });
    expect(addEntity(SAMPLE, 'subject', item).config.subjects[2]).toEqual({
      id: 'new1',
      name: 'Exam',
      color: DEFAULT_SUBJECT_COLORS[2],
    });
  });

  it('skips the palette colours that are in use, in whatever notation they are stored', () => {
    const used = (colors: string[]): Dataset =>
      sampleWith({ subjects: colors.map((color, index) => ({ id: `s${index}`, name: `Subject ${index}`, color })) });
    const nextColor = (colors: string[]): string =>
      addEntity(used(colors), 'subject', { id: 'new1', name: 'Exam' }).config.subjects[colors.length].color;
    expect(nextColor([])).toBe(DEFAULT_SUBJECT_COLORS[0]);
    expect(nextColor([DEFAULT_SUBJECT_COLORS[0], DEFAULT_SUBJECT_COLORS[2]])).toBe(DEFAULT_SUBJECT_COLORS[1]);
    expect(nextColor([DEFAULT_SUBJECT_COLORS[0].toLowerCase(), '#ABCDEF'])).toBe(DEFAULT_SUBJECT_COLORS[1]);
  });

  it('uses a palette colour a second time when all of them are in use', () => {
    const full = sampleWith({
      subjects: DEFAULT_SUBJECT_COLORS.map((color, index) => ({ id: `s${index}`, name: `Subject ${index}`, color })),
    });
    const added = addEntity(full, 'subject', { id: 'new1', name: 'Exam' }).config.subjects[DEFAULT_SUBJECT_COLORS.length];
    expect(DEFAULT_SUBJECT_COLORS).toContain(added.color);
  });

  it.each<EntityKind>(['location', 'teacher', 'class'])('drops the colour of a %s', (kind) => {
    const item: Subject = { id: 'new1', name: 'New', color: '#7C3AED' };
    const added = entityList(addEntity(SAMPLE, kind, item).config, kind)[2];
    expect(added).toEqual({ id: 'new1', name: 'New' });
    expect('color' in added).toBe(false);
  });

  it('accepts an id that is in use in another list', () => {
    const result = addEntity(SAMPLE, 'class', { id: 't1', name: 'Class 3' });
    expect(result.config.classes[2]).toEqual({ id: 't1', name: 'Class 3' });
    expect(result.config.teachers).toBe(SAMPLE.config.teachers);
  });

  it.each(KINDS)('returns the same dataset when the id of the new %s is already in its list', (kind) => {
    const taken = entityList(SAMPLE.config, kind)[1].id;
    expect(addEntity(SAMPLE, kind, { id: taken, name: 'Another name' })).toBe(SAMPLE);
  });

  it.each(KINDS)('returns the same dataset when the new %s has no name or no id', (kind) => {
    expect(addEntity(SAMPLE, kind, { id: 'new1', name: '' })).toBe(SAMPLE);
    expect(addEntity(SAMPLE, kind, { id: 'new1', name: ' \t\n ' })).toBe(SAMPLE);
    expect(addEntity(SAMPLE, kind, { id: '', name: 'New' })).toBe(SAMPLE);
  });
});

describe('updateEntity', () => {
  it.each(KINDS)('renames a %s, trims the new name and keeps the entry in its place', (kind) => {
    const before = entityList(SAMPLE.config, kind);
    const result = updateEntity(SAMPLE, kind, before[0].id, deepFreeze({ name: '  שם חדש ' }));
    const after = entityList(result.config, kind);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual({ ...before[0], name: 'שם חדש' });
    expect(after[1]).toBe(before[1]);
    expect(result.weeks).toBe(SAMPLE.weeks);
    expectOtherSettingsShared(result, kind);
  });

  it('changes the colour of a subject and writes it as #RRGGBB', () => {
    expect(updateEntity(SAMPLE, 'subject', 's1', { color: 'dc2626' }).config.subjects).toEqual([
      { id: 's1', name: 'Lecture', color: '#DC2626' },
      { id: 's2', name: 'מעבדה', color: '#16A34A' },
    ]);
    expect(updateEntity(SAMPLE, 'subject', 's2', { color: '#fa0' }).config.subjects[1]).toEqual({
      id: 's2',
      name: 'מעבדה',
      color: '#FFAA00',
    });
  });

  it('changes the name and the colour of a subject at once', () => {
    expect(updateEntity(SAMPLE, 'subject', 's1', { name: 'Talk', color: '#000000' }).config.subjects[0]).toEqual({
      id: 's1',
      name: 'Talk',
      color: '#000000',
    });
  });

  it('ignores an empty name but still applies the colour', () => {
    expect(updateEntity(SAMPLE, 'subject', 's1', { name: '   ', color: '#000000' }).config.subjects[0]).toEqual({
      id: 's1',
      name: 'Lecture',
      color: '#000000',
    });
  });

  it('ignores an invalid colour but still applies the name', () => {
    expect(updateEntity(SAMPLE, 'subject', 's1', { name: 'Talk', color: 'blue' }).config.subjects[0]).toEqual({
      id: 's1',
      name: 'Talk',
      color: '#2563EB',
    });
  });

  it.each<EntityKind>(['location', 'teacher', 'class'])('ignores a colour for a %s', (kind) => {
    const first = entityList(SAMPLE.config, kind)[0];
    expect(updateEntity(SAMPLE, kind, first.id, { color: '#000000' })).toBe(SAMPLE);
    const renamed = entityList(updateEntity(SAMPLE, kind, first.id, { name: 'Renamed', color: '#000000' }).config, kind)[0];
    expect(renamed).toEqual({ id: first.id, name: 'Renamed' });
    expect('color' in renamed).toBe(false);
  });

  it('leaves the events alone: they point to the entry by its id', () => {
    const result = updateEntity(SAMPLE, 'location', 'l1', { name: 'Room 102' });
    expect(result.weeks).toBe(SAMPLE.weeks);
    expect(findEntity(result.config, 'location', DOCKER.locationId)?.name).toBe('Room 102');
  });

  it.each<[string, EntityKind, string, { name?: string; color?: string }]>([
    ['the id is unknown', 'teacher', 'unknown', { name: 'Renamed' }],
    ['the id belongs to another list', 'teacher', 'l1', { name: 'Renamed' }],
    ['the patch is empty', 'subject', 's1', {}],
    ['the patch only holds undefined', 'subject', 's1', { name: undefined, color: undefined }],
    ['the name is the same', 'location', 'l2', { name: 'חדר 7' }],
    ['the name only differs in the white space around it', 'class', 'c1', { name: '  Class 1 ' }],
    ['the new name is empty', 'teacher', 't1', { name: '' }],
    ['the new name is only white space', 'teacher', 't1', { name: ' \t ' }],
    ['the colour is the same', 'subject', 's1', { color: '#2563EB' }],
    ['the colour is the same in another notation', 'subject', 's1', { color: ' 2563eb ' }],
    ['the colour is invalid', 'subject', 's1', { color: '#12345' }],
    ['the name and the colour are the same', 'subject', 's2', { name: 'מעבדה', color: '#16a34a' }],
  ])('returns the same dataset when %s', (_reason, kind, id, patch) => {
    expect(updateEntity(SAMPLE, kind, id, patch)).toBe(SAMPLE);
  });
});

describe('removeEntity', () => {
  it('deletes a subject and clears it from the events of every week', () => {
    const result = removeEntity(SAMPLE, 'subject', 's1');
    expect(result.config.subjects).toEqual([{ id: 's2', name: 'מעבדה', color: '#16A34A' }]);
    expect(result.config.subjects[0]).toBe(SAMPLE.config.subjects[1]);
    expect(result.weeks[W1].events).toEqual([{ ...DOCKER, subjectId: null }, LAB, FREE]);
    expect(result.weeks[W2].events).toEqual([{ ...REVIEW, subjectId: null }]);
    expectOtherSettingsShared(result, 'subject');
  });

  it('deletes a location and clears it from the events of every week', () => {
    const result = removeEntity(SAMPLE, 'location', 'l1');
    expect(result.config.locations).toEqual([{ id: 'l2', name: 'חדר 7' }]);
    expect(result.weeks[W1].events).toEqual([{ ...DOCKER, locationId: null }, LAB, FREE]);
    expect(result.weeks[W2].events).toEqual([{ ...REVIEW, locationId: null }]);
    expectOtherSettingsShared(result, 'location');
  });

  it('deletes a teacher and takes the id out of the events of every week', () => {
    const result = removeEntity(SAMPLE, 'teacher', 't1');
    expect(result.config.teachers).toEqual([{ id: 't2', name: 'נועה' }]);
    expect(result.weeks[W1].events).toEqual([{ ...DOCKER, teacherIds: [] }, LAB, FREE]);
    expect(result.weeks[W2].events).toEqual([{ ...REVIEW, teacherIds: ['t2'] }]);
    expectOtherSettingsShared(result, 'teacher');
  });

  it('deletes a class and takes the id out of the events of every week', () => {
    const result = removeEntity(SAMPLE, 'class', 'c1');
    expect(result.config.classes).toEqual([{ id: 'c2', name: 'Class 2' }]);
    expect(result.weeks[W1].events).toEqual([{ ...DOCKER, classIds: ['c2'] }, { ...LAB, classIds: [] }, FREE]);
    expectOtherSettingsShared(result, 'class');
  });

  it('shares every event and every week it does not have to change', () => {
    const result = removeEntity(SAMPLE, 'class', 'c1');
    expect(result.weeks[W1]).not.toBe(SAMPLE.weeks[W1]);
    expect(result.weeks[W1].events[0]).not.toBe(DOCKER);
    expect(result.weeks[W1].events[2]).toBe(FREE);
    expect(result.weeks[W1].title).toBe('Week 12');
    expect(result.weeks[W2]).toBe(SAMPLE.weeks[W2]);
    expect(result.weeks[W3]).toBe(SAMPLE.weeks[W3]);
    expect(Object.keys(result.weeks).sort()).toEqual([W1, W2, W3]);
  });

  it.each(KINDS)('touches only the references of a %s when other lists use the same id', (kind) => {
    const everywhere = event('e', { subjectId: 'x1', locationId: 'x1', teacherIds: ['x1', 'x2'], classIds: ['x1', 'x2'] });
    const dataset = sampleWith(
      {
        subjects: [{ id: 'x1', name: 'Subject', color: '#DC2626' }],
        locations: [{ id: 'x1', name: 'Location' }],
        teachers: [{ id: 'x1', name: 'Teacher' }],
        classes: [{ id: 'x1', name: 'Class' }],
      },
      { [W1]: { weekStart: W1, title: '', events: [everywhere] } },
    );
    const stripped: Record<EntityKind, ScheduleEvent> = {
      subject: { ...everywhere, subjectId: null },
      location: { ...everywhere, locationId: null },
      teacher: { ...everywhere, teacherIds: ['x2'] },
      class: { ...everywhere, classIds: ['x2'] },
    };
    const result = removeEntity(dataset, kind, 'x1');
    expect(result.weeks[W1].events).toEqual([stripped[kind]]);
    for (const other of KINDS) {
      expect(entityList(result.config, other)).toHaveLength(other === kind ? 0 : 1);
    }
  });

  it('deletes an entry that no event uses without touching the weeks', () => {
    const dataset = sampleWith({ teachers: [...SAMPLE.config.teachers, { id: 't3', name: 'Avi' }] });
    const result = removeEntity(dataset, 'teacher', 't3');
    expect(result.config.teachers).toEqual(SAMPLE.config.teachers);
    expect(result.weeks).toBe(dataset.weeks);
  });

  it('clears references to an entry that is no longer in the list', () => {
    const dangling = event('e', { locationId: 'gone', teacherIds: ['gone', 't1'] });
    const dataset = sampleWith({}, { [W1]: { weekStart: W1, title: '', events: [dangling] } });
    const result = removeEntity(dataset, 'location', 'gone');
    expect(result.weeks[W1].events).toEqual([{ ...dangling, locationId: null }]);
    expect(result.config).toBe(dataset.config);
  });

  it.each(KINDS)('returns the same dataset when no %s and no event has the id', (kind) => {
    expect(removeEntity(SAMPLE, kind, 'unknown')).toBe(SAMPLE);
    expect(removeEntity(SAMPLE, kind, '')).toBe(SAMPLE);
  });

  it('returns the same dataset when the id only exists in a list of another kind', () => {
    expect(removeEntity(SAMPLE, 'teacher', 'c1')).toBe(SAMPLE);
    expect(removeEntity(SAMPLE, 'subject', 'l1')).toBe(SAMPLE);
  });
});

describe('countEntityUsage', () => {
  it.each<[EntityKind, string, number]>([
    ['subject', 's1', 2],
    ['subject', 's2', 1],
    ['location', 'l1', 2],
    ['location', 'l2', 1],
    ['teacher', 't1', 2],
    ['teacher', 't2', 2],
    ['class', 'c1', 2],
    ['class', 'c2', 2],
  ])('counts the events of all weeks that use the %s %s: %d', (kind, id, count) => {
    expect(countEntityUsage(SAMPLE, kind, id)).toBe(count);
  });

  it('counts nothing for an id that no event uses, or that is used as another kind', () => {
    expect(countEntityUsage(SAMPLE, 'teacher', 'unknown')).toBe(0);
    expect(countEntityUsage(SAMPLE, 'teacher', 'c1')).toBe(0);
    expect(countEntityUsage(SAMPLE, 'location', 's1')).toBe(0);
    expect(countEntityUsage(sampleWith({}, {}), 'subject', 's1')).toBe(0);
  });

  it('counts references to an entry that is no longer in the list', () => {
    const dataset = sampleWith({}, { [W1]: { weekStart: W1, title: '', events: [event('e', { locationId: 'gone' })] } });
    expect(countEntityUsage(dataset, 'location', 'gone')).toBe(1);
  });

  it('agrees with removeEntity: nothing uses the entry afterwards', () => {
    for (const kind of KINDS) {
      for (const { id } of entityList(SAMPLE.config, kind)) {
        expect(countEntityUsage(removeEntity(SAMPLE, kind, id), kind, id)).toBe(0);
      }
    }
  });
});

describe('findEntityByName', () => {
  it('finds an entry by its name, whatever the case and the white space around it', () => {
    expect(findEntityByName(SAMPLE.config, 'location', 'Room 101')).toBe(SAMPLE.config.locations[0]);
    expect(findEntityByName(SAMPLE.config, 'location', 'room 101')).toBe(SAMPLE.config.locations[0]);
    expect(findEntityByName(SAMPLE.config, 'location', '  ROOM 101\n')).toBe(SAMPLE.config.locations[0]);
    expect(findEntityByName(SAMPLE.config, 'subject', 'lecture')).toBe(SAMPLE.config.subjects[0]);
    expect(findEntityByName(SAMPLE.config, 'class', 'CLASS 2')).toBe(SAMPLE.config.classes[1]);
  });

  it('finds a Hebrew name', () => {
    expect(findEntityByName(SAMPLE.config, 'location', ' חדר 7 ')).toBe(SAMPLE.config.locations[1]);
    expect(findEntityByName(SAMPLE.config, 'teacher', 'נועה')).toBe(SAMPLE.config.teachers[1]);
  });

  it('ignores the white space around a stored name too', () => {
    const config = sampleWith({ locations: [{ id: 'l9', name: '  Lab 3 ' }] }).config;
    expect(findEntityByName(config, 'location', 'lab 3')).toBe(config.locations[0]);
  });

  it('returns the first of several entries with the same name', () => {
    const config = sampleWith({
      teachers: [
        { id: 't1', name: 'Dana' },
        { id: 't7', name: 'dana' },
      ],
    }).config;
    expect(findEntityByName(config, 'teacher', 'DANA')).toBe(config.teachers[0]);
  });

  it('looks only in the list of the given kind', () => {
    expect(findEntityByName(SAMPLE.config, 'teacher', 'Room 101')).toBeUndefined();
    expect(findEntityByName(SAMPLE.config, 'subject', 'מעבדה')).toBe(SAMPLE.config.subjects[1]);
    expect(findEntityByName(SAMPLE.config, 'location', 'מעבדה')).toBeUndefined();
  });

  it('wants the whole name', () => {
    expect(findEntityByName(SAMPLE.config, 'location', 'Room')).toBeUndefined();
    expect(findEntityByName(SAMPLE.config, 'location', 'Room 1010')).toBeUndefined();
    expect(findEntityByName(SAMPLE.config, 'location', 'Room  101')).toBeUndefined();
  });

  it('finds nothing for an empty name, even when an entry has no name', () => {
    const config = sampleWith({ teachers: [{ id: 't9', name: '' }] }).config;
    expect(findEntityByName(config, 'teacher', '')).toBeUndefined();
    expect(findEntityByName(config, 'teacher', '   ')).toBeUndefined();
    expect(findEntityByName(SAMPLE.config, 'teacher', '')).toBeUndefined();
  });
});

// ───────────────────────────── filters ─────────────────────────────

function filters(patch: Partial<Filters>): Filters {
  return deepFreeze<Filters>({ locationIds: [], classIds: [], teacherIds: [], subjectIds: [], ...patch });
}

/** The ids of the four sample events that pass the filter. */
function passing(patch: Partial<Filters>): string[] {
  return [DOCKER, LAB, FREE, REVIEW].filter((e) => matchesFilters(e, filters(patch))).map((e) => e.id);
}

describe('hasActiveFilters', () => {
  it('is false while every list is empty', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters(filters({}))).toBe(false);
  });

  it.each<keyof Filters>(['locationIds', 'classIds', 'teacherIds', 'subjectIds'])(
    'is true as soon as %s holds an id',
    (key) => {
      expect(hasActiveFilters(filters({ [key]: ['x'] }))).toBe(true);
    },
  );
});

describe('matchesFilters', () => {
  it('lets every event pass while no filter is set', () => {
    expect(passing({})).toEqual(['a', 'b', 'c', 'd']);
    expect(matchesFilters(FREE, EMPTY_FILTERS)).toBe(true);
  });

  it('filters by location, and an event without a location does not pass', () => {
    expect(passing({ locationIds: ['l1'] })).toEqual(['a', 'd']);
    expect(passing({ locationIds: ['l2'] })).toEqual(['b']);
  });

  it('filters by subject, and an event without a subject does not pass', () => {
    expect(passing({ subjectIds: ['s1'] })).toEqual(['a', 'd']);
    expect(passing({ subjectIds: ['s2'] })).toEqual(['b']);
  });

  it('filters by class: one class in common is enough', () => {
    expect(passing({ classIds: ['c1'] })).toEqual(['a', 'b']);
    expect(passing({ classIds: ['c2'] })).toEqual(['a', 'd']);
  });

  it('filters by teacher: one teacher in common is enough', () => {
    expect(passing({ teacherIds: ['t1'] })).toEqual(['a', 'd']);
    expect(passing({ teacherIds: ['t2'] })).toEqual(['b', 'd']);
  });

  it('joins the ids inside one list with OR', () => {
    expect(passing({ locationIds: ['l1', 'l2'] })).toEqual(['a', 'b', 'd']);
    expect(passing({ subjectIds: ['s2', 's1'] })).toEqual(['a', 'b', 'd']);
    expect(passing({ classIds: ['c1', 'c2'] })).toEqual(['a', 'b', 'd']);
    expect(passing({ teacherIds: ['t1', 't2'] })).toEqual(['a', 'b', 'd']);
    expect(passing({ locationIds: ['unknown', 'l2'] })).toEqual(['b']);
    expect(passing({ teacherIds: ['unknown', 't1'] })).toEqual(['a', 'd']);
  });

  it('joins the lists with AND', () => {
    expect(passing({ locationIds: ['l1'], teacherIds: ['t2'] })).toEqual(['d']);
    expect(passing({ classIds: ['c1'], subjectIds: ['s1'] })).toEqual(['a']);
    expect(passing({ classIds: ['c1'], teacherIds: ['t2'] })).toEqual(['b']);
    expect(passing({ locationIds: ['l2'], subjectIds: ['s1'] })).toEqual([]);
    expect(passing({ locationIds: ['l1', 'l2'], classIds: ['c2'] })).toEqual(['a', 'd']);
  });

  it('wants an event to pass all four lists when all four are set', () => {
    const all = { locationIds: ['l1'], classIds: ['c2'], teacherIds: ['t1'], subjectIds: ['s1'] };
    expect(passing(all)).toEqual(['a', 'd']);
    expect(passing({ ...all, locationIds: ['l2'] })).toEqual([]);
    expect(passing({ ...all, classIds: ['c1'] })).toEqual(['a']);
    expect(passing({ ...all, teacherIds: ['t2'] })).toEqual(['d']);
    expect(passing({ ...all, subjectIds: ['s2'] })).toEqual([]);
  });

  it('lets nothing pass a list of ids that no event has', () => {
    expect(passing({ locationIds: ['unknown'] })).toEqual([]);
    expect(passing({ classIds: ['unknown'] })).toEqual([]);
    expect(passing({ teacherIds: ['unknown'] })).toEqual([]);
    expect(passing({ subjectIds: ['unknown'] })).toEqual([]);
  });

  it('matches an event that points to a deleted entry by the id it still carries', () => {
    const dangling = event('e', { locationId: 'gone', classIds: ['gone'] });
    expect(matchesFilters(dangling, filters({ locationIds: ['gone'] }))).toBe(true);
    expect(matchesFilters(dangling, filters({ classIds: ['gone'] }))).toBe(true);
    expect(matchesFilters(dangling, filters({ locationIds: ['l1'] }))).toBe(false);
  });
});

// ───────────────────────────── double bookings ─────────────────────────────

describe('eventsOverlap', () => {
  const base = event('x', { day: 2, start: 600, end: 660 });

  it.each<[string, Partial<ScheduleEvent>]>([
    ['at the same time', { start: 600, end: 660 }],
    ['that starts earlier and ends inside it', { start: 570, end: 610 }],
    ['that starts inside it and ends later', { start: 650, end: 700 }],
    ['inside it', { start: 610, end: 620 }],
    ['around it', { start: 0, end: 1440 }],
    ['that has its last minute in common', { start: 659, end: 700 }],
    ['that has its first minute in common', { start: 500, end: 601 }],
  ])('is true for an event %s', (_name, patch) => {
    const other = event('y', { day: 2, ...patch });
    expect(eventsOverlap(base, other)).toBe(true);
    expect(eventsOverlap(other, base)).toBe(true);
  });

  it.each<[string, Partial<ScheduleEvent>]>([
    ['that ends when it starts', { start: 540, end: 600 }],
    ['that starts when it ends', { start: 660, end: 700 }],
    ['earlier that day', { start: 480, end: 540 }],
    ['later that day', { start: 900, end: 960 }],
    ['at the same time on another day', { day: 3, start: 600, end: 660 }],
    ['around it on another day', { day: 1, start: 0, end: 1440 }],
  ])('is false for an event %s', (_name, patch) => {
    const other = event('y', { day: 2, ...patch });
    expect(eventsOverlap(base, other)).toBe(false);
    expect(eventsOverlap(other, base)).toBe(false);
  });

  it('is true for an event and itself', () => {
    expect(eventsOverlap(base, base)).toBe(true);
  });
});

/** Clashes in a fixed order, so that a test does not depend on the order they were found in. */
function inOrder(clashes: Record<string, Clash[]>): Record<string, Clash[]> {
  const sortKey = (clash: Clash): string => `${clash.otherId} ${clash.reason} ${clash.sharedId}`;
  return Object.fromEntries(
    Object.entries(clashes).map(([id, list]) => [
      id,
      [...list].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0)),
    ]),
  );
}

/** Events `x` and `y` on the same day, 09:00–10:00 and 09:30–10:30 unless a patch says otherwise. */
function pair(x: Partial<ScheduleEvent>, y: Partial<ScheduleEvent>): ScheduleEvent[] {
  return deepFreeze([event('x', { start: 540, end: 600, ...x }), event('y', { start: 570, end: 630, ...y })]);
}

describe('findClashes', () => {
  it('reports two overlapping events in the same location, each with the other one', () => {
    expect(findClashes(pair({ locationId: 'l1' }, { locationId: 'l1' }))).toEqual({
      x: [{ otherId: 'y', reason: 'location', sharedId: 'l1' }],
      y: [{ otherId: 'x', reason: 'location', sharedId: 'l1' }],
    });
  });

  it('reports two overlapping events with a teacher in common', () => {
    expect(findClashes(pair({ teacherIds: ['t1', 't2'] }, { teacherIds: ['t2', 't3'] }))).toEqual({
      x: [{ otherId: 'y', reason: 'teacher', sharedId: 't2' }],
      y: [{ otherId: 'x', reason: 'teacher', sharedId: 't2' }],
    });
  });

  it('reports two overlapping events with a class in common', () => {
    expect(findClashes(pair({ classIds: ['c1'] }, { classIds: ['c1', 'c2'] }))).toEqual({
      x: [{ otherId: 'y', reason: 'class', sharedId: 'c1' }],
      y: [{ otherId: 'x', reason: 'class', sharedId: 'c1' }],
    });
  });

  it('reports every reason, and every teacher and class in common, as a clash of its own', () => {
    const clashes = findClashes(
      pair(
        { locationId: 'l1', teacherIds: ['t1', 't2'], classIds: ['c1', 'c2'] },
        { locationId: 'l1', teacherIds: ['t1', 't2', 't3'], classIds: ['c2'] },
      ),
    );
    expect(inOrder(clashes)).toEqual({
      x: [
        { otherId: 'y', reason: 'class', sharedId: 'c2' },
        { otherId: 'y', reason: 'location', sharedId: 'l1' },
        { otherId: 'y', reason: 'teacher', sharedId: 't1' },
        { otherId: 'y', reason: 'teacher', sharedId: 't2' },
      ],
      y: [
        { otherId: 'x', reason: 'class', sharedId: 'c2' },
        { otherId: 'x', reason: 'location', sharedId: 'l1' },
        { otherId: 'x', reason: 'teacher', sharedId: 't1' },
        { otherId: 'x', reason: 'teacher', sharedId: 't2' },
      ],
    });
  });

  const everything: Partial<ScheduleEvent> = { locationId: 'l1', teacherIds: ['t1'], classIds: ['c1'] };

  it.each<[string, Partial<ScheduleEvent>, Partial<ScheduleEvent>]>([
    [
      'overlap but have no location, teacher or class in common',
      { locationId: 'l1', teacherIds: ['t1'], classIds: ['c1'] },
      { locationId: 'l2', teacherIds: ['t2'], classIds: ['c2'] },
    ],
    ['overlap but have no location, teachers or classes at all', {}, {}],
    ['share everything, but one ends when the other starts', everything, { ...everything, start: 600, end: 660 }],
    ['share everything, but are hours apart', everything, { ...everything, start: 780, end: 840 }],
    ['share everything at the same time, but on different days', { ...everything, day: 1 }, { ...everything, day: 2, start: 540 }],
    ['only share an id between a teacher and a class', { teacherIds: ['x1'] }, { classIds: ['x1'] }],
    ['only share an id between a location and a teacher', { locationId: 'x1' }, { teacherIds: ['x1'] }],
  ])('reports nothing for two events that %s', (_name, x, y) => {
    expect(findClashes(pair(x, y))).toEqual({});
  });

  it('lists only the events that clash', () => {
    const events = deepFreeze([
      event('x', { locationId: 'l1' }),
      event('y', { locationId: 'l1' }),
      event('elsewhere', { locationId: 'l2' }),
      event('another-day', { locationId: 'l1', day: 4 }),
    ]);
    expect(Object.keys(findClashes(events)).sort()).toEqual(['x', 'y']);
  });

  it('reports each pair of a chain of overlapping events', () => {
    const events = deepFreeze([
      event('first', { start: 540, end: 600, locationId: 'l1' }),
      event('second', { start: 570, end: 630, locationId: 'l1' }),
      event('third', { start: 600, end: 660, locationId: 'l1' }),
    ]);
    expect(inOrder(findClashes(events))).toEqual({
      first: [{ otherId: 'second', reason: 'location', sharedId: 'l1' }],
      second: [
        { otherId: 'first', reason: 'location', sharedId: 'l1' },
        { otherId: 'third', reason: 'location', sharedId: 'l1' },
      ],
      third: [{ otherId: 'second', reason: 'location', sharedId: 'l1' }],
    });
  });

  it('reports all pairs of three events that are double-booked together', () => {
    const events = deepFreeze(['x', 'y', 'z'].map((id) => event(id, { teacherIds: ['t1'] })));
    expect(inOrder(findClashes(events))).toEqual({
      x: [
        { otherId: 'y', reason: 'teacher', sharedId: 't1' },
        { otherId: 'z', reason: 'teacher', sharedId: 't1' },
      ],
      y: [
        { otherId: 'x', reason: 'teacher', sharedId: 't1' },
        { otherId: 'z', reason: 'teacher', sharedId: 't1' },
      ],
      z: [
        { otherId: 'x', reason: 'teacher', sharedId: 't1' },
        { otherId: 'y', reason: 'teacher', sharedId: 't1' },
      ],
    });
  });

  it('finds the same clashes whatever the order of the events', () => {
    const events = [
      event('p', { start: 540, end: 660, locationId: 'l1', teacherIds: ['t1'] }),
      event('q', { start: 600, end: 720, locationId: 'l1', classIds: ['c1'] }),
      event('r', { start: 630, end: 690, teacherIds: ['t1'], classIds: ['c1'] }),
      event('s', { day: 3, locationId: 'l1', teacherIds: ['t1'], classIds: ['c1'] }),
    ];
    const expected = inOrder(findClashes(events));
    expect(Object.keys(expected).sort()).toEqual(['p', 'q', 'r']);
    expect(inOrder(findClashes([...events].reverse()))).toEqual(expected);
    expect(inOrder(findClashes([events[2], events[0], events[3], events[1]]))).toEqual(expected);
  });

  it('reports nothing for no events, for a single event and for the sample weeks', () => {
    expect(findClashes([])).toEqual({});
    expect(findClashes([DOCKER])).toEqual({});
    expect(findClashes(SAMPLE.weeks[W1].events)).toEqual({});
    expect(findClashes(SAMPLE.weeks[W2].events)).toEqual({});
  });

  it('copes with event ids that are also names of members every object has', () => {
    // A week file can be edited by hand, and the parser takes any non-empty text for an id.
    const events = deepFreeze([
      event('constructor', { locationId: 'l1' }),
      event('__proto__', { locationId: 'l1' }),
      event('toString', { day: 3 }),
    ]);
    const clashes = findClashes(events);
    const clashesOf = (id: string): Clash[] | undefined => clashes[id];
    expect(Object.keys(clashes).sort()).toEqual(['__proto__', 'constructor']);
    expect(clashesOf('constructor')).toEqual([{ otherId: '__proto__', reason: 'location', sharedId: 'l1' }]);
    expect(clashesOf('__proto__')).toEqual([{ otherId: 'constructor', reason: 'location', sharedId: 'l1' }]);
    expect(clashesOf('toString')).toBeUndefined();
    expect(clashesOf('hasOwnProperty')).toBeUndefined();
  });
});

// ───────────────────────────── visible time range ─────────────────────────────

type Span = [start: number, end: number];

function spans(list: readonly Span[]): ScheduleEvent[] {
  return deepFreeze(list.map(([start, end], index) => event(`e${index}`, { day: (index % 7) as DayIndex, start, end })));
}

/** The definition taken literally: add one row at a time until the events fit or the day is full. */
function widenedRowByRow(grid: TimeGrid, list: readonly Span[]): { start: number; end: number } {
  let start = grid.dayStart;
  let end = grid.dayEnd;
  for (const [eventStart, eventEnd] of list) {
    while (start > eventStart) start = Math.max(0, start - grid.slotMinutes);
    while (end < eventEnd) end = Math.min(1440, end + grid.slotMinutes);
  }
  return { start, end };
}

describe('visibleRange', () => {
  const GRID = deepFreeze<TimeGrid>({ dayStart: 480, dayEnd: 1200, slotMinutes: 30 });

  it.each<[string, TimeGrid, Span[], { start: number; end: number }]>([
    ['there are no events', GRID, [], { start: 480, end: 1200 }],
    ['every event is inside the configured day', GRID, [[540, 600], [900, 1020]], { start: 480, end: 1200 }],
    ['an event fills the configured day exactly', GRID, [[480, 1200]], { start: 480, end: 1200 }],
    ['an event starts 15 minutes early', GRID, [[465, 540]], { start: 450, end: 1200 }],
    ['an event starts exactly one row early', GRID, [[450, 540]], { start: 450, end: 1200 }],
    ['an event starts one minute more than one row early', GRID, [[449, 540]], { start: 420, end: 1200 }],
    ['an event ends 10 minutes late', GRID, [[1140, 1210]], { start: 480, end: 1230 }],
    ['an event ends exactly one row late', GRID, [[1140, 1230]], { start: 480, end: 1230 }],
    ['an event ends one minute more than one row late', GRID, [[1140, 1231]], { start: 480, end: 1260 }],
    ['one event lies before the day and another one after it', GRID, [[300, 330], [1320, 1380]], { start: 300, end: 1380 }],
    ['the earliest and the latest event are different ones', GRID, [[600, 1260], [450, 500], [700, 720]], { start: 450, end: 1260 }],
    ['rows of 15 minutes have to be added', { ...GRID, slotMinutes: 15 }, [[471, 1202]], { start: 465, end: 1215 }],
    ['rows of 45 minutes have to be added', { ...GRID, slotMinutes: 45 }, [[420, 1260]], { start: 390, end: 1290 }],
    ['rows of 60 minutes have to be added', { ...GRID, slotMinutes: 60 }, [[470, 1205]], { start: 420, end: 1260 }],
    ['a whole row would start before midnight', { dayStart: 30, dayEnd: 1200, slotMinutes: 60 }, [[0, 60]], { start: 0, end: 1200 }],
    ['a whole row would end after 24:00', { dayStart: 480, dayEnd: 1410, slotMinutes: 60 }, [[1380, 1440]], { start: 480, end: 1440 }],
    ['an event lasts the whole day', { ...GRID, slotMinutes: 45 }, [[0, 1440]], { start: 0, end: 1440 }],
    ['the configured day is the whole day already', { dayStart: 0, dayEnd: 1440, slotMinutes: 60 }, [[0, 1440], [600, 660]], { start: 0, end: 1440 }],
  ])('when %s', (_name, grid, list, expected) => {
    expect(visibleRange(grid, spans(list))).toEqual(expected);
  });

  it('never shows less than the configured day', () => {
    expect(visibleRange(GRID, spans([[600, 660]]))).toEqual({ start: 480, end: 1200 });
    expect(visibleRange(GRID, spans([[0, 15]])).end).toBe(1200);
    expect(visibleRange(GRID, spans([[1425, 1440]])).start).toBe(480);
  });

  it('agrees with adding one row at a time, for many grids and events', () => {
    const days: Span[] = [[480, 1200], [495, 1185], [0, 1440], [15, 1425], [600, 615], [705, 720], [1425, 1440], [0, 15]];
    const eventLists: Span[][] = [
      [[0, 1440]],
      [[0, 1]],
      [[1439, 1440]],
      [[7, 8], [1432, 1433]],
      [[479, 481]],
      [[1199, 1201]],
      [[600, 660]],
      [[1, 2], [3, 4]],
      [[100, 200], [1300, 1400]],
      [[250, 251]],
      [[1337, 1338]],
      [[614, 616], [704, 721]],
    ];
    const slots: SlotMinutes[] = [15, 30, 45, 60];
    for (const slotMinutes of slots) {
      for (const [dayStart, dayEnd] of days) {
        const grid = deepFreeze<TimeGrid>({ dayStart, dayEnd, slotMinutes });
        for (const list of eventLists) {
          expect(visibleRange(grid, spans(list)), JSON.stringify({ grid, list })).toEqual(widenedRowByRow(grid, list));
        }
      }
    }
  });

  it('returns a new object and leaves the grid alone', () => {
    const range = visibleRange(GRID, []);
    expect(range).toEqual({ start: 480, end: 1200 });
    expect(range).not.toBe(GRID);
    expect(visibleRange(GRID, [])).not.toBe(range);
    expect(GRID).toEqual({ dayStart: 480, dayEnd: 1200, slotMinutes: 30 });
  });
});

// ───────────────────────────── comparing datasets ─────────────────────────────

describe('datasetsEqual', () => {
  it('is true for one and the same dataset and for a deep copy of it', () => {
    expect(datasetsEqual(SAMPLE, SAMPLE)).toBe(true);
    expect(datasetsEqual(SAMPLE, structuredClone(SAMPLE))).toBe(true);
    expect(datasetsEqual(structuredClone(SAMPLE), SAMPLE)).toBe(true);
  });

  it('ignores the order of the keys at every level', () => {
    const reordered: Dataset = {
      weeks: {
        [W3]: reverseKeys(SAMPLE.weeks[W3]),
        [W2]: reverseKeys({ ...SAMPLE.weeks[W2], events: SAMPLE.weeks[W2].events.map(reverseKeys) }),
        [W1]: reverseKeys({ ...SAMPLE.weeks[W1], events: SAMPLE.weeks[W1].events.map(reverseKeys) }),
      },
      config: reverseKeys({
        course: reverseKeys(SAMPLE.config.course),
        timeGrid: reverseKeys(SAMPLE.config.timeGrid),
        subjects: SAMPLE.config.subjects.map(reverseKeys),
        locations: SAMPLE.config.locations.map(reverseKeys),
        teachers: SAMPLE.config.teachers.map(reverseKeys),
        classes: SAMPLE.config.classes.map(reverseKeys),
      }),
    };
    expect(Object.keys(reordered.weeks)).toEqual([W3, W2, W1]);
    expect(Object.keys(reordered.config)).toEqual(Object.keys(SAMPLE.config).reverse());
    expect(Object.keys(reordered.weeks[W1].events[0])).toEqual(Object.keys(DOCKER).reverse());
    expect(datasetsEqual(SAMPLE, reordered)).toBe(true);
    expect(datasetsEqual(reordered, SAMPLE)).toBe(true);
  });

  it('ignores weeks that have neither a title nor events', () => {
    const empty: WeekData = { weekStart: W4, title: '', events: [] };
    const withEmptyWeek = sampleWith({}, { ...SAMPLE.weeks, [W4]: empty });
    expect(datasetsEqual(SAMPLE, withEmptyWeek)).toBe(true);
    expect(datasetsEqual(withEmptyWeek, SAMPLE)).toBe(true);
    expect(datasetsEqual(sampleWith({}, { [W4]: empty }), sampleWith({}, {}))).toBe(true);
    expect(datasetsEqual(sampleWith({}, {}), sampleWith({}, { [W4]: empty }))).toBe(true);
  });

  it.each<[string, (dataset: Dataset) => Dataset]>([
    ['the course name', (d) => updateCourse(d, { name: 'Cloud 2027' })],
    ['a course date', (d) => updateCourse(d, { endDate: null })],
    ['the time grid', (d) => updateTimeGrid(d, { slotMinutes: 60 })],
    ['an added entry', (d) => addEntity(d, 'teacher', { id: 't3', name: 'Avi' })],
    ['a renamed entry', (d) => updateEntity(d, 'class', 'c1', { name: 'Class A' })],
    ['the colour of a subject', (d) => updateEntity(d, 'subject', 's1', { color: '#000000' })],
    ['a deleted entry', (d) => removeEntity(d, 'location', 'l2')],
    ['the order of a list', (d) => ({ ...d, config: { ...d.config, teachers: [...d.config.teachers].reverse() } })],
    ['the title of a week', (d) => setWeekTitle(d, W1, 'Week 13')],
    ['a new week that only has a title', (d) => setWeekTitle(d, W4, 'Exams')],
    ['a week that is gone', (d) => setWeekTitle(d, W3, '')],
    ['an added event', (d) => upsertEvent(d, W2, event('n'))],
    ['a deleted event', (d) => removeEvent(d, W1, 'c')],
    ['the time of an event', (d) => upsertEvent(d, W1, { ...FREE, start: 795 })],
    ['the day of an event', (d) => upsertEvent(d, W1, { ...FREE, day: 3 })],
    ['a teacher of an event', (d) => upsertEvent(d, W1, { ...FREE, teacherIds: ['t1'] })],
    ['the notes of an event', (d) => upsertEvent(d, W1, { ...FREE, notes: 'Bring a laptop' })],
    ['all events of a week', (d) => setWeekEvents(d, W1, [])],
  ])('sees a difference in %s', (_name, change) => {
    const changed = change(SAMPLE);
    expect(changed).not.toBe(SAMPLE);
    expect(datasetsEqual(SAMPLE, changed)).toBe(false);
    expect(datasetsEqual(changed, SAMPLE)).toBe(false);
  });

  it('sees that an event moved to another week', () => {
    const moved = upsertEvent(removeEvent(SAMPLE, W1, 'c'), W2, FREE);
    expect(datasetsEqual(SAMPLE, moved)).toBe(false);
    expect(datasetsEqual(moved, upsertEvent(removeEvent(SAMPLE, W1, 'c'), W2, structuredClone(FREE)))).toBe(true);
  });

  it('is true again after an edit is taken back', () => {
    const added = upsertEvent(SAMPLE, W4, event('n'));
    const takenBack = removeEvent(added, W4, 'n');
    expect(takenBack).not.toBe(SAMPLE);
    expect(datasetsEqual(takenBack, SAMPLE)).toBe(true);
    const renamed = updateEntity(updateEntity(SAMPLE, 'teacher', 't1', { name: 'Dan' }), 'teacher', 't1', { name: 'Dana' });
    expect(datasetsEqual(renamed, SAMPLE)).toBe(true);
  });
});
