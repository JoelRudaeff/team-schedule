/**
 * Item keys and single-item access: eventKey / weekTitleKey / entityKey, parseItemKey,
 * getItemValue and setItemValue.
 */
import { describe, expect, it } from 'vitest';
import {
  diffDatasets,
  entityKey,
  eventKey,
  getItemValue,
  parseItemKey,
  setItemValue,
  weekTitleKey,
  type ItemRef,
  type ItemValue,
} from '@shared/merge';
import { datasetsEqual, sortEvents } from '@shared/model';
import type { Dataset, IsoDate, ScheduleConfig, ScheduleEvent } from '@shared/types';

// ───────────────────────────── fixtures ─────────────────────────────

const W1: IsoDate = '2026-11-22';
const W2: IsoDate = '2026-11-29';

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
    config: {
      course: { name: 'DevOps 2026', startDate: '2026-09-06', endDate: null },
      timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
      subjects: [],
      locations: [],
      teachers: [],
      classes: [],
      ...config,
    },
    weeks: Object.fromEntries(
      Object.entries(weeks).map(([weekStart, week]) => [
        weekStart,
        { weekStart, title: week.title ?? '', events: sortEvents(week.events ?? []) },
      ]),
    ),
  });
}

function ref(key: string): ItemRef {
  const parsed = parseItemKey(key);
  if (!parsed) throw new Error(`not an item key: ${key}`);
  return parsed;
}

const LAB = { id: 's1', name: 'Lab', color: '#16A34A' };
const ROOM = { id: 'l1', name: 'Room 101' };
const DANA = { id: 't1', name: 'Dana' };
const CLASS_1 = { id: 'c1', name: 'Class 1' };
const DOCKER = event('e1', { title: 'Docker basics', subjectId: 's1', locationId: 'l1', teacherIds: ['t1'] });

/** One item of every key shape. */
const SAMPLE = makeDataset(
  { subjects: [LAB], locations: [ROOM], teachers: [DANA], classes: [CLASS_1] },
  { [W1]: { title: 'Week 12', events: [DOCKER] } },
);

// ───────────────────────────── keys ─────────────────────────────

describe('key helpers', () => {
  it('build the documented key shapes', () => {
    expect(eventKey('2026-11-22', 'q1w2e3r4t5')).toBe('event:2026-11-22:q1w2e3r4t5');
    expect(weekTitleKey('2026-11-22')).toBe('weekTitle:2026-11-22');
    expect(entityKey('subject', 'k3x9p2aqz1')).toBe('subject:k3x9p2aqz1');
    expect(entityKey('location', 'a1')).toBe('location:a1');
    expect(entityKey('teacher', 't1')).toBe('teacher:t1');
    expect(entityKey('class', 'c1')).toBe('class:c1');
  });
});

describe('parseItemKey', () => {
  const VALID: [string, Omit<ItemRef, 'key'>][] = [
    ['course.name', { kind: 'course', field: 'name' }],
    ['course.startDate', { kind: 'course', field: 'startDate' }],
    ['course.endDate', { kind: 'course', field: 'endDate' }],
    ['timeGrid.dayStart', { kind: 'timeGrid', field: 'dayStart' }],
    ['timeGrid.dayEnd', { kind: 'timeGrid', field: 'dayEnd' }],
    ['timeGrid.slotMinutes', { kind: 'timeGrid', field: 'slotMinutes' }],
    ['subject:k3x9p2aqz1', { kind: 'subject', id: 'k3x9p2aqz1' }],
    ['location:a1b2c3d4e5', { kind: 'location', id: 'a1b2c3d4e5' }],
    ['teacher:t1', { kind: 'teacher', id: 't1' }],
    ['class:c1', { kind: 'class', id: 'c1' }],
    ['weekTitle:2026-11-22', { kind: 'weekTitle', weekStart: '2026-11-22' }],
    ['event:2026-11-22:q1w2e3r4t5', { kind: 'event', weekStart: '2026-11-22', id: 'q1w2e3r4t5' }],
    // Entity keys split on the first ':' only, event keys after the fixed-width week.
    ['teacher:a:b', { kind: 'teacher', id: 'a:b' }],
    ['class::', { kind: 'class', id: ':' }],
    ['event:2026-11-22:a:b:c', { kind: 'event', weekStart: '2026-11-22', id: 'a:b:c' }],
    ['event:2026-11-22::', { kind: 'event', weekStart: '2026-11-22', id: ':' }],
    ['event:2026-11-22:2026-11-29', { kind: 'event', weekStart: '2026-11-22', id: '2026-11-29' }],
  ];

  it.each(VALID)('parses %s', (key, expected) => {
    expect(parseItemKey(key)).toStrictEqual({ key, ...expected });
  });

  it.each([
    '',
    'course',
    'course.',
    'course.title',
    'course:name',
    'timeGrid.dayStart ',
    'timeGrid.slot',
    'room:a1',
    'subjects:s1',
    'Subject:s1',
    'subject',
    'subject:',
    'location:',
    'weekTitle',
    'weekTitle:',
    'weekTitle:2026-11-2',
    'weekTitle:2026-11-22:x',
    'weekTitle:2026-02-30',
    'weekTitle:next-week!',
    'event',
    'event:',
    'event:2026-11-22',
    'event:2026-11-22:',
    'event:2026-11-22e1',
    'event:2026-11-2:e1',
    'event:2026-13-01:e1',
    'event:e1',
    'event::2026-11-22:e1',
  ])('rejects the malformed key %j', (key) => {
    expect(parseItemKey(key)).toBeNull();
  });

  it('reads back what the key helpers build', () => {
    expect(parseItemKey(eventKey(W1, 'a:b'))).toStrictEqual({
      key: `event:${W1}:a:b`,
      kind: 'event',
      weekStart: W1,
      id: 'a:b',
    });
    expect(parseItemKey(weekTitleKey(W2))).toStrictEqual({ key: `weekTitle:${W2}`, kind: 'weekTitle', weekStart: W2 });
    expect(parseItemKey(entityKey('class', 'c:1'))).toStrictEqual({ key: 'class:c:1', kind: 'class', id: 'c:1' });
  });
});

// ───────────────────────────── round trips ─────────────────────────────

describe('parseItemKey → getItemValue → setItemValue round trips', () => {
  const CASES: [key: string, original: ItemValue, replacement: ItemValue][] = [
    ['course.name', 'DevOps 2026', 'DevOps 2027'],
    ['course.startDate', '2026-09-06', null],
    ['course.endDate', null, '2027-01-31'],
    ['timeGrid.dayStart', 480, 450],
    ['timeGrid.dayEnd', 1200, 1320],
    ['timeGrid.slotMinutes', 30, 45],
    ['subject:s1', LAB, { id: 's1', name: 'Laboratory', color: '#DC2626' }],
    ['location:l1', ROOM, { id: 'l1', name: 'Room 1.01' }],
    ['teacher:t1', DANA, { id: 't1', name: 'Dana L.' }],
    ['class:c1', CLASS_1, { id: 'c1', name: 'כיתה 1' }],
    [`weekTitle:${W1}`, 'Week 12', 'שבוע 12 – Docker'],
    [`event:${W1}:e1`, DOCKER, event('e1', { day: 3, start: 600, end: 660, title: 'Moved', classIds: ['c1'] })],
  ];

  it.each(CASES)('%s', (key, original, replacement) => {
    const item = ref(key);
    expect(getItemValue(SAMPLE, item)).toEqual(original);

    const changed = setItemValue(SAMPLE, item, replacement);
    expect(getItemValue(changed, item)).toEqual(replacement);
    expect(diffDatasets(SAMPLE, changed).map((d) => d.key)).toEqual([key]);

    const restored = setItemValue(changed, item, original);
    expect(datasetsEqual(restored, SAMPLE)).toBe(true);
  });

  it.each(['subject:s1', 'location:l1', 'teacher:t1', 'class:c1', `event:${W1}:e1`])(
    '%s can be removed and put back',
    (key) => {
      const item = ref(key);
      const original = getItemValue(SAMPLE, item);

      const removed = setItemValue(SAMPLE, item, undefined);
      expect(getItemValue(removed, item)).toBeUndefined();
      expect(diffDatasets(SAMPLE, removed)).toMatchObject([{ key, change: 'deleted' }]);

      expect(datasetsEqual(setItemValue(removed, item, original), SAMPLE)).toBe(true);
    },
  );
});

// ───────────────────────────── getItemValue ─────────────────────────────

describe('getItemValue', () => {
  it('returns the stored objects themselves', () => {
    expect(getItemValue(SAMPLE, ref('subject:s1'))).toBe(SAMPLE.config.subjects[0]);
    expect(getItemValue(SAMPLE, ref(`event:${W1}:e1`))).toBe(SAMPLE.weeks[W1].events[0]);
  });

  it('gives undefined for an entity or event that does not exist', () => {
    expect(getItemValue(SAMPLE, ref('subject:nope'))).toBeUndefined();
    expect(getItemValue(SAMPLE, ref('teacher:s1'))).toBeUndefined();
    expect(getItemValue(SAMPLE, ref(`event:${W1}:nope`))).toBeUndefined();
    expect(getItemValue(SAMPLE, ref(`event:${W2}:e1`))).toBeUndefined();
  });

  it("gives '' for the title of a week that does not exist or has no title", () => {
    expect(getItemValue(SAMPLE, ref(`weekTitle:${W2}`))).toBe('');
    const untitled = makeDataset({}, { [W1]: { events: [event('e1')] } });
    expect(getItemValue(untitled, ref(`weekTitle:${W1}`))).toBe('');
  });

  it('gives undefined for a ref that names no item', () => {
    expect(getItemValue(SAMPLE, { key: 'course.title', kind: 'course', field: 'title' })).toBeUndefined();
    expect(getItemValue(SAMPLE, { key: 'course', kind: 'course' })).toBeUndefined();
    expect(getItemValue(SAMPLE, { key: 'timeGrid.rows', kind: 'timeGrid', field: 'rows' })).toBeUndefined();
    expect(getItemValue(SAMPLE, { key: 'subject:', kind: 'subject' })).toBeUndefined();
    expect(getItemValue(SAMPLE, { key: 'weekTitle:', kind: 'weekTitle' })).toBeUndefined();
    expect(getItemValue(SAMPLE, { key: 'event:', kind: 'event', id: 'e1' })).toBeUndefined();
    expect(getItemValue(SAMPLE, { key: 'event:', kind: 'event', weekStart: W1 })).toBeUndefined();
  });

  it('only sees weeks that the dataset really has (a damaged week id must not hit Object.prototype)', () => {
    for (const weekStart of ['constructor', 'toString', '__proto__']) {
      expect(getItemValue(SAMPLE, { key: `weekTitle:${weekStart}`, kind: 'weekTitle', weekStart })).toBe('');
      expect(getItemValue(SAMPLE, { key: `event:${weekStart}:e1`, kind: 'event', weekStart, id: 'e1' })).toBeUndefined();
    }
  });
});

// ───────────────────────────── setItemValue ─────────────────────────────

describe('setItemValue', () => {
  describe('course and time grid', () => {
    it('sets one field and leaves the others alone', () => {
      const next = setItemValue(SAMPLE, ref('course.endDate'), '2027-01-31');
      expect(next.config.course).toEqual({ name: 'DevOps 2026', startDate: '2026-09-06', endDate: '2027-01-31' });
      expect(next.config.timeGrid).toBe(SAMPLE.config.timeGrid);
      expect(next.weeks).toBe(SAMPLE.weeks);
    });

    it('does not validate the resulting course or grid', () => {
      const reversedCourse = setItemValue(SAMPLE, ref('course.endDate'), '2020-01-01');
      expect(reversedCourse.config.course.endDate).toBe('2020-01-01');

      const invertedGrid = setItemValue(SAMPLE, ref('timeGrid.dayStart'), 1300);
      expect(invertedGrid.config.timeGrid).toEqual({ dayStart: 1300, dayEnd: 1200, slotMinutes: 30 });

      const oddMinute = setItemValue(SAMPLE, ref('timeGrid.dayEnd'), 1201);
      expect(oddMinute.config.timeGrid.dayEnd).toBe(1201);
    });
  });

  describe('entities', () => {
    const three = makeDataset({
      locations: [
        { id: 'l1', name: 'Room 101' },
        { id: 'l2', name: 'Room 102' },
        { id: 'l3', name: 'Room 103' },
      ],
    });

    it('replaces an existing entry in place', () => {
      const next = setItemValue(three, ref('location:l2'), { id: 'l2', name: 'Lab B' });
      expect(next.config.locations).toEqual([
        { id: 'l1', name: 'Room 101' },
        { id: 'l2', name: 'Lab B' },
        { id: 'l3', name: 'Room 103' },
      ]);
    });

    it('appends an entry that does not exist yet to the end of its list', () => {
      const next = setItemValue(three, ref('location:l0'), { id: 'l0', name: 'Aula' });
      expect(next.config.locations.map((l) => l.id)).toEqual(['l1', 'l2', 'l3', 'l0']);
      expect(next.config.teachers).toBe(three.config.teachers);
    });

    it('keeps the colour of a subject', () => {
      const next = setItemValue(three, ref('subject:s9'), { id: 's9', name: 'Exam', color: '#DC2626' });
      expect(next.config.subjects).toEqual([{ id: 's9', name: 'Exam', color: '#DC2626' }]);
    });

    it('removes an entry without stripping the references that events hold', () => {
      const next = setItemValue(SAMPLE, ref('location:l1'), undefined);
      expect(next.config.locations).toEqual([]);
      expect(next.weeks[W1].events[0].locationId).toBe('l1');
      expect(next.weeks).toBe(SAMPLE.weeks);

      const withoutTeacher = setItemValue(SAMPLE, ref('teacher:t1'), undefined);
      expect(withoutTeacher.weeks[W1].events[0].teacherIds).toEqual(['t1']);
    });
  });

  describe('events', () => {
    const monday = event('e2', { day: 1 });
    const week = makeDataset(
      {},
      { [W1]: { events: [event('e1', { day: 0 }), event('e3', { day: 2 })] }, [W2]: { title: 'Named', events: [] } },
    );

    it('inserts a new event at its sorted position', () => {
      const next = setItemValue(week, ref(`event:${W1}:e2`), monday);
      expect(next.weeks[W1].events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
      expect(next.weeks[W1].events[1]).toBe(monday);
    });

    it('re-sorts the week when a replaced event moves', () => {
      const next = setItemValue(week, ref(`event:${W1}:e1`), event('e1', { day: 5 }));
      expect(next.weeks[W1].events.map((e) => e.id)).toEqual(['e3', 'e1']);
    });

    it('orders events of the same day by start, end and id', () => {
      let next = setItemValue(week, ref(`event:${W1}:b`), event('b', { day: 4, start: 600, end: 660 }));
      next = setItemValue(next, ref(`event:${W1}:a`), event('a', { day: 4, start: 600, end: 660 }));
      next = setItemValue(next, ref(`event:${W1}:c`), event('c', { day: 4, start: 600, end: 630 }));
      next = setItemValue(next, ref(`event:${W1}:d`), event('d', { day: 4, start: 540, end: 720 }));
      expect(next.weeks[W1].events.map((e) => e.id)).toEqual(['e1', 'e3', 'd', 'c', 'a', 'b']);
    });

    it('creates the week when it does not exist yet', () => {
      const next = setItemValue(SAMPLE, ref(`event:${W2}:e7`), event('e7'));
      expect(next.weeks[W2]).toEqual({ weekStart: W2, title: '', events: [event('e7')] });
      expect(next.weeks[W1]).toBe(SAMPLE.weeks[W1]);
    });

    it('drops a week whose last event is removed, unless the week has a title', () => {
      const untitled = makeDataset({}, { [W1]: { events: [event('e1')] } });
      expect(setItemValue(untitled, ref(`event:${W1}:e1`), undefined).weeks).toEqual({});

      const titled = setItemValue(SAMPLE, ref(`event:${W1}:e1`), undefined);
      expect(titled.weeks[W1]).toEqual({ weekStart: W1, title: 'Week 12', events: [] });
    });

    it('stores the event exactly as given (a merge must not rewrite a teammate’s text)', () => {
      const raw = event('e9', { title: '  spaced  ', notes: 'line 1\nline 2 ', teacherIds: ['t2', 't1'] });
      const next = setItemValue(week, ref(`event:${W1}:e9`), raw);
      expect(getItemValue(next, ref(`event:${W1}:e9`))).toBe(raw);
    });
  });

  describe('week titles', () => {
    it('creates a week that exists only because of its title', () => {
      const next = setItemValue(SAMPLE, ref(`weekTitle:${W2}`), 'Exam week');
      expect(next.weeks[W2]).toEqual({ weekStart: W2, title: 'Exam week', events: [] });
    });

    it("drops the week when the title becomes '' and it has no events", () => {
      const onlyTitle = makeDataset({}, { [W1]: { title: 'Holiday' } });
      expect(setItemValue(onlyTitle, ref(`weekTitle:${W1}`), '').weeks).toEqual({});
    });

    it("keeps a week with events when the title becomes ''", () => {
      const next = setItemValue(SAMPLE, ref(`weekTitle:${W1}`), '');
      expect(next.weeks[W1]).toEqual({ weekStart: W1, title: '', events: [DOCKER] });
    });

    it('keeps the title as typed', () => {
      expect(setItemValue(SAMPLE, ref(`weekTitle:${W1}`), ' שבוע 12 ').weeks[W1].title).toBe(' שבוע 12 ');
    });
  });

  describe('no change', () => {
    it.each([
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
      `event:${W1}:e1`,
    ])('returns the same dataset when %s already has an equal value', (key) => {
      const item = ref(key);
      const equalCopy = structuredClone(getItemValue(SAMPLE, item));
      expect(setItemValue(SAMPLE, item, equalCopy)).toBe(SAMPLE);
    });

    it('returns the same dataset when the thing to remove is not there', () => {
      expect(setItemValue(SAMPLE, ref('teacher:nobody'), undefined)).toBe(SAMPLE);
      expect(setItemValue(SAMPLE, ref(`event:${W1}:nothing`), undefined)).toBe(SAMPLE);
      expect(setItemValue(SAMPLE, ref(`event:${W2}:e1`), undefined)).toBe(SAMPLE);
      expect(setItemValue(SAMPLE, ref(`weekTitle:${W2}`), '')).toBe(SAMPLE);
    });
  });

  describe('calls that cannot be honoured leave the dataset alone', () => {
    const IGNORED: [what: string, key: string, value: ItemValue | undefined][] = [
      ['undefined for a course field', 'course.name', undefined],
      ['undefined for a time-grid field', 'timeGrid.dayEnd', undefined],
      ['undefined for a week title', `weekTitle:${W1}`, undefined],
      ['null for the course name', 'course.name', null],
      ['a number for the course name', 'course.name', 5],
      ['a number for a course date', 'course.startDate', 20260906],
      ['a string for a time-grid field', 'timeGrid.dayStart', '08:00'],
      ['null for a time-grid field', 'timeGrid.dayEnd', null],
      ['a row height the grid does not have', 'timeGrid.slotMinutes', 20],
      ['a number for a week title', `weekTitle:${W1}`, 12],
      ['an event for a list entry', 'location:l1', event('l1')],
      ['a string for a list entry', 'teacher:t1', 'Dana L.'],
      ['a subject without a colour', 'subject:s1', { id: 's1', name: 'Colourless' }],
      ['a list entry with another id', 'location:l1', { id: 'l2', name: 'Room 102' }],
      ['a list entry for an event', `event:${W1}:e1`, { id: 'e1', name: 'Not an event' }],
      ['an event with another id', `event:${W1}:e1`, event('e2')],
      ['a title for an event', `event:${W1}:e1`, 'Docker basics'],
    ];

    it.each(IGNORED)('%s', (_what, key, value) => {
      expect(setItemValue(SAMPLE, ref(key), value)).toBe(SAMPLE);
    });

    it('an event that lacks fields or has fields of the wrong type', () => {
      const item = ref(`event:${W1}:e1`);
      const { notes: _notes, ...withoutNotes } = event('e1');
      const broken: unknown[] = [
        withoutNotes,
        { ...event('e1'), day: '0' },
        { ...event('e1'), start: null },
        { ...event('e1'), teacherIds: 't1' },
        { ...event('e1'), classIds: [1, 2] },
        { ...event('e1'), subjectId: 7 },
      ];
      for (const value of broken) {
        // Such a value can only come from a damaged aside file, never from typed code.
        expect(setItemValue(SAMPLE, item, value as ItemValue)).toBe(SAMPLE);
      }
    });

    it('a ref that names no item', () => {
      expect(setItemValue(SAMPLE, { key: 'course.title', kind: 'course', field: 'title' }, 'x')).toBe(SAMPLE);
      expect(setItemValue(SAMPLE, { key: 'course', kind: 'course' }, 'x')).toBe(SAMPLE);
      expect(setItemValue(SAMPLE, { key: 'timeGrid.rows', kind: 'timeGrid', field: 'rows' }, 30)).toBe(SAMPLE);
      expect(setItemValue(SAMPLE, { key: 'teacher:', kind: 'teacher' }, { id: 't9', name: 'Noam' })).toBe(SAMPLE);
      expect(setItemValue(SAMPLE, { key: 'weekTitle:', kind: 'weekTitle' }, 'x')).toBe(SAMPLE);
      expect(setItemValue(SAMPLE, { key: 'event:', kind: 'event', id: 'e9' }, event('e9'))).toBe(SAMPLE);
      expect(setItemValue(SAMPLE, { key: 'event:', kind: 'event', weekStart: W1 }, event('e9'))).toBe(SAMPLE);
    });
  });

  it('never mutates the dataset it is given', () => {
    const before = JSON.stringify(SAMPLE);
    const edits: [string, ItemValue | undefined][] = [
      ['course.name', 'Other'],
      ['timeGrid.slotMinutes', 60],
      ['subject:s1', undefined],
      ['subject:s2', { id: 's2', name: 'Exam', color: '#DC2626' }],
      ['location:l1', { id: 'l1', name: 'Renamed' }],
      [`weekTitle:${W1}`, ''],
      [`weekTitle:${W2}`, 'New'],
      [`event:${W1}:e1`, undefined],
      [`event:${W1}:e1`, event('e1', { day: 6 })],
      [`event:${W1}:e0`, event('e0')],
    ];
    // SAMPLE is deep-frozen, so a mutation would throw here.
    for (const [key, value] of edits) setItemValue(SAMPLE, ref(key), value);
    expect(JSON.stringify(SAMPLE)).toBe(before);
  });
});
