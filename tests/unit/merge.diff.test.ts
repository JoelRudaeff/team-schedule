/**
 * The two-way diff (diffDatasets) and the commit message that is built from it (summarizeDiff).
 */
import { describe, expect, it } from 'vitest';
import { diffDatasets, summarizeDiff, type DiffItem, type ItemValue } from '@shared/merge';
import { ENTITY_LIST_KEY, sortEvents } from '@shared/model';
import type {
  CourseInfo,
  Dataset,
  DayIndex,
  EntityKind,
  IsoDate,
  NamedItem,
  ScheduleConfig,
  ScheduleEvent,
  Subject,
  TimeGrid,
} from '@shared/types';

// ───────────────────────────── fixtures ─────────────────────────────

const W1: IsoDate = '2026-11-22';
const W2: IsoDate = '2026-11-29';
const W3: IsoDate = '2026-12-06';
const W4: IsoDate = '2026-12-13';

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

function keysOf(diff: readonly DiffItem[]): string[] {
  return diff.map((item) => item.key);
}

// ───────────────────────────── diffDatasets ─────────────────────────────

describe('diffDatasets', () => {
  const DOCKER = event('e1', {
    title: 'Docker basics',
    subjectId: 's1',
    locationId: 'l1',
    teacherIds: ['t1'],
    classIds: ['c1'],
    notes: 'Bring a laptop',
  });

  it('finds nothing between a dataset and itself or an equal copy', () => {
    const dataset = makeDataset(
      { subjects: [{ id: 's1', name: 'Lab', color: GREEN }], teachers: [{ id: 't1', name: 'Dana' }] },
      { [W1]: { title: 'Week 12', events: [DOCKER] } },
    );
    expect(diffDatasets(dataset, dataset)).toEqual([]);
    expect(diffDatasets(dataset, structuredClone(dataset))).toEqual([]);
  });

  it('treats a missing week like a stored week without a title and without events', () => {
    const missing = makeDataset({}, { [W1]: { events: [DOCKER] } });
    const storedEmpty = makeDataset({}, { [W1]: { events: [DOCKER] }, [W2]: {} });
    expect(storedEmpty.weeks[W2]).toEqual({ weekStart: W2, title: '', events: [] });
    expect(diffDatasets(missing, storedEmpty)).toEqual([]);
    expect(diffDatasets(storedEmpty, missing)).toEqual([]);
  });

  describe('settings', () => {
    type SettingCase = [
      key: string,
      kind: 'course' | 'timeGrid',
      field: string,
      changed: Partial<ScheduleConfig>,
      before: ItemValue,
      after: ItemValue,
    ];
    const CASES: SettingCase[] = [
      ['course.name', 'course', 'name', { course: { ...COURSE, name: 'DevOps 2027' } }, 'DevOps 2026', 'DevOps 2027'],
      ['course.startDate', 'course', 'startDate', { course: { ...COURSE, startDate: null } }, '2026-09-06', null],
      ['course.endDate', 'course', 'endDate', { course: { ...COURSE, endDate: '2027-01-31' } }, null, '2027-01-31'],
      ['timeGrid.dayStart', 'timeGrid', 'dayStart', { timeGrid: { ...GRID, dayStart: 450 } }, 480, 450],
      ['timeGrid.dayEnd', 'timeGrid', 'dayEnd', { timeGrid: { ...GRID, dayEnd: 1320 } }, 1200, 1320],
      ['timeGrid.slotMinutes', 'timeGrid', 'slotMinutes', { timeGrid: { ...GRID, slotMinutes: 45 } }, 30, 45],
    ];

    it.each(CASES)('reports %s as one modified item', (key, kind, field, changed, before, after) => {
      expect(diffDatasets(makeDataset(), makeDataset(changed))).toStrictEqual([
        { key, kind, field, change: 'modified', before, after, changedFields: [] },
      ]);
    });

    it('reports every changed field on its own and leaves the others out', () => {
      const after = makeDataset({
        course: { name: 'DevOps 2027', startDate: '2026-09-06', endDate: '2027-01-31' },
        timeGrid: { dayStart: 480, dayEnd: 1320, slotMinutes: 60 },
      });
      expect(keysOf(diffDatasets(makeDataset(), after))).toEqual([
        'course.name',
        'course.endDate',
        'timeGrid.dayEnd',
        'timeGrid.slotMinutes',
      ]);
    });
  });

  describe.each(KINDS)('the %s list', (kind) => {
    const alpha = entry(kind, 'a', 'Alpha');
    const beta = entry(kind, 'b', 'Beta');
    const before = makeDataset(list(kind, alpha, beta));

    it('reports an added entry', () => {
      const gamma = entry(kind, 'c', 'Gamma');
      expect(diffDatasets(before, makeDataset(list(kind, alpha, beta, gamma)))).toStrictEqual([
        { key: `${kind}:c`, kind, id: 'c', change: 'added', before: undefined, after: gamma, changedFields: [] },
      ]);
    });

    it('reports a renamed entry and names the field', () => {
      const renamed = { ...beta, name: 'בטא' };
      expect(diffDatasets(before, makeDataset(list(kind, alpha, renamed)))).toStrictEqual([
        { key: `${kind}:b`, kind, id: 'b', change: 'modified', before: beta, after: renamed, changedFields: ['name'] },
      ]);
    });

    it('reports a deleted entry', () => {
      expect(diffDatasets(before, makeDataset(list(kind, beta)))).toStrictEqual([
        { key: `${kind}:a`, kind, id: 'a', change: 'deleted', before: alpha, after: undefined, changedFields: [] },
      ]);
    });

    it('does not report an entry that was replaced by an equal copy', () => {
      expect(diffDatasets(before, makeDataset(list(kind, { ...alpha }, { ...beta })))).toEqual([]);
    });
  });

  describe('subjects', () => {
    const lab: Subject = { id: 's1', name: 'Lab', color: GREEN };
    const before = makeDataset({ subjects: [lab] });
    const CASES: [what: string, after: Subject, changedFields: string[]][] = [
      ['a new colour', { id: 's1', name: 'Lab', color: RED }, ['color']],
      ['a new name', { id: 's1', name: 'Laboratory', color: GREEN }, ['name']],
      ['a new name and a new colour', { id: 's1', name: 'Laboratory', color: RED }, ['name', 'color']],
    ];

    it.each(CASES)('names the changed fields for %s', (_what, after, changedFields) => {
      expect(diffDatasets(before, makeDataset({ subjects: [after] }))).toStrictEqual([
        { key: 'subject:s1', kind: 'subject', id: 's1', change: 'modified', before: lab, after, changedFields },
      ]);
    });
  });

  describe('events', () => {
    const before = makeDataset({}, { [W1]: { title: 'Week 12', events: [DOCKER] } });
    const withEvents = (...events: ScheduleEvent[]): Dataset => makeDataset({}, { [W1]: { title: 'Week 12', events } });

    it('reports an added event', () => {
      const k8s = event('e2', { day: 1, title: 'Kubernetes' });
      expect(diffDatasets(before, withEvents(DOCKER, k8s))).toStrictEqual([
        {
          key: `event:${W1}:e2`,
          kind: 'event',
          id: 'e2',
          weekStart: W1,
          change: 'added',
          before: undefined,
          after: k8s,
          changedFields: [],
        },
      ]);
    });

    it('reports a deleted event', () => {
      expect(diffDatasets(before, withEvents())).toStrictEqual([
        {
          key: `event:${W1}:e1`,
          kind: 'event',
          id: 'e1',
          weekStart: W1,
          change: 'deleted',
          before: DOCKER,
          after: undefined,
          changedFields: [],
        },
      ]);
    });

    const FIELD_EDITS: [field: string, patch: Partial<ScheduleEvent>][] = [
      ['day', { day: 3 }],
      ['start', { start: 555 }],
      ['end', { end: 700 }],
      ['title', { title: 'Docker advanced' }],
      ['subjectId', { subjectId: null }],
      ['locationId', { locationId: 'l2' }],
      ['teacherIds', { teacherIds: ['t1', 't2'] }],
      ['classIds', { classIds: [] }],
      ['notes', { notes: '' }],
    ];

    it.each(FIELD_EDITS)('reports a changed %s as one modified item that names the field', (field, patch) => {
      const edited = { ...DOCKER, ...patch };
      expect(diffDatasets(before, withEvents(edited))).toStrictEqual([
        {
          key: `event:${W1}:e1`,
          kind: 'event',
          id: 'e1',
          weekStart: W1,
          change: 'modified',
          before: DOCKER,
          after: edited,
          changedFields: [field],
        },
      ]);
    });

    it('lists several changed fields in the order of the event fields', () => {
      const edited = event('e1', {
        day: 2,
        start: 600,
        end: 690,
        title: 'Docker advanced',
        subjectId: null,
        locationId: 'l2',
        teacherIds: [],
        classIds: ['c1', 'c2'],
        notes: '',
      });
      expect(diffDatasets(before, withEvents(edited))[0].changedFields).toEqual([
        'day',
        'start',
        'end',
        'title',
        'subjectId',
        'locationId',
        'teacherIds',
        'classIds',
        'notes',
      ]);
      const retimed = { ...DOCKER, notes: 'Room changed', end: 660, start: 570 };
      expect(diffDatasets(before, withEvents(retimed))[0].changedFields).toEqual(['start', 'end', 'notes']);
    });

    it('compares teacher and class lists by content, not by identity', () => {
      const copy = { ...DOCKER, teacherIds: [...DOCKER.teacherIds], classIds: [...DOCKER.classIds] };
      expect(diffDatasets(before, withEvents(copy))).toEqual([]);
    });

    it('sees the same id in two weeks as two different events', () => {
      const after = makeDataset({}, { [W1]: { title: 'Week 12', events: [DOCKER] }, [W2]: { events: [DOCKER] } });
      expect(diffDatasets(before, after)).toMatchObject([{ key: `event:${W2}:e1`, weekStart: W2, change: 'added' }]);
    });

    it('hands out the stored objects themselves as before and after', () => {
      const after = withEvents({ ...DOCKER, title: 'Docker advanced' });
      const [item] = diffDatasets(before, after);
      expect(item.before).toBe(before.weeks[W1].events[0]);
      expect(item.after).toBe(after.weeks[W1].events[0]);
    });
  });

  describe('week titles', () => {
    it('reports a changed title', () => {
      const before = makeDataset({}, { [W1]: { title: 'Week 12', events: [DOCKER] } });
      const after = makeDataset({}, { [W1]: { title: 'שבוע 12 – Docker', events: [DOCKER] } });
      expect(diffDatasets(before, after)).toStrictEqual([
        {
          key: `weekTitle:${W1}`,
          kind: 'weekTitle',
          weekStart: W1,
          change: 'modified',
          before: 'Week 12',
          after: 'שבוע 12 – Docker',
          changedFields: [],
        },
      ]);
    });

    it('reports the title of a week that exists only because of that title', () => {
      const named = makeDataset({}, { [W2]: { title: 'Holiday' } });
      const item = { key: `weekTitle:${W2}`, kind: 'weekTitle', weekStart: W2, change: 'modified', changedFields: [] };
      expect(diffDatasets(makeDataset(), named)).toStrictEqual([{ ...item, before: '', after: 'Holiday' }]);
      expect(diffDatasets(named, makeDataset())).toStrictEqual([{ ...item, before: 'Holiday', after: '' }]);
    });

    it('does not report the title of a new week that has none', () => {
      const after = makeDataset({}, { [W2]: { events: [event('e1')] } });
      expect(keysOf(diffDatasets(makeDataset(), after))).toEqual([`event:${W2}:e1`]);
    });
  });

  describe('order', () => {
    it('goes through the settings, the four lists and then the weeks by date', () => {
      const before = makeDataset(
        {
          subjects: [{ id: 's1', name: 'Lab', color: GREEN }],
          locations: [{ id: 'l1', name: 'Room 101' }],
          teachers: [{ id: 't1', name: 'Dana' }],
          classes: [],
        },
        // The later week is stored first on purpose: the order has to come from the dates.
        { [W2]: { title: 'B', events: [event('x')] }, [W1]: { title: 'A', events: [event('y')] } },
      );
      const after = makeDataset(
        {
          course: { name: 'DevOps 2027', startDate: null, endDate: '2027-01-31' },
          timeGrid: { dayStart: 420, dayEnd: 1320, slotMinutes: 60 },
          subjects: [{ id: 's1', name: 'Lab', color: RED }],
          locations: [],
          teachers: [{ id: 't1', name: 'Dana L.' }],
          classes: [{ id: 'c1', name: 'Class 1' }],
        },
        { [W2]: { title: 'B2', events: [event('x', { day: 1 })] }, [W1]: { title: 'A2', events: [event('y', { day: 1 })] } },
      );
      expect(keysOf(diffDatasets(before, after))).toEqual([
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
      ]);
    });

    it('puts the week title first and orders the events by their newest version', () => {
      const before = makeDataset(
        {},
        {
          [W1]: {
            title: 'Old',
            events: [event('moved', { day: 0 }), event('kept', { day: 2 }), event('gone', { day: 4 }), event('renamed', { day: 1 })],
          },
        },
      );
      const after = makeDataset(
        {},
        {
          [W1]: {
            title: 'New',
            events: [
              event('moved', { day: 5 }),
              event('kept', { day: 2 }),
              event('new', { day: 3 }),
              event('renamed', { day: 1, title: 'Renamed' }),
            ],
          },
        },
      );
      // "gone" keeps the place of its last version (Thursday); "moved" is listed where it is now (Friday).
      expect(diffDatasets(before, after).map((item) => [item.key, item.change])).toEqual([
        [`weekTitle:${W1}`, 'modified'],
        [`event:${W1}:renamed`, 'modified'],
        [`event:${W1}:new`, 'added'],
        [`event:${W1}:gone`, 'deleted'],
        [`event:${W1}:moved`, 'modified'],
      ]);
    });

    it('orders events of the same day by start, end and id', () => {
      const after = makeDataset(
        {},
        {
          [W1]: {
            events: [
              event('b', { start: 600, end: 660 }),
              event('a', { start: 600, end: 660 }),
              event('c', { start: 600, end: 630 }),
              event('d', { start: 540, end: 720 }),
            ],
          },
        },
      );
      expect(keysOf(diffDatasets(makeDataset(), after))).toEqual(['d', 'c', 'a', 'b'].map((id) => `event:${W1}:${id}`));
    });

    it('keeps the new order of a list and puts deleted entries last, in their old order', () => {
      const names = (...ids: string[]): NamedItem[] => ids.map((id) => ({ id, name: id.toUpperCase() }));
      const before = makeDataset({ teachers: names('a', 'b', 'c', 'd') });
      const after = makeDataset({
        teachers: [{ id: 'd', name: 'D2' }, { id: 'x', name: 'X' }, { id: 'a', name: 'A2' }],
      });
      expect(diffDatasets(before, after).map((item) => [item.key, item.change])).toEqual([
        ['teacher:d', 'modified'],
        ['teacher:x', 'added'],
        ['teacher:a', 'modified'],
        ['teacher:b', 'deleted'],
        ['teacher:c', 'deleted'],
      ]);
    });

    it('does not report a list that was only reordered', () => {
      const dana = { id: 't1', name: 'Dana' };
      const noam = { id: 't2', name: 'Noam' };
      expect(diffDatasets(makeDataset({ teachers: [dana, noam] }), makeDataset({ teachers: [noam, dana] }))).toEqual([]);
    });
  });

  it('does not change the datasets it compares', () => {
    const before = makeDataset(
      { teachers: [{ id: 't1', name: 'Dana' }] },
      { [W1]: { title: 'Week 12', events: [DOCKER, event('e2', { day: 3 })] } },
    );
    const after = makeDataset(
      { teachers: [{ id: 't2', name: 'Noam' }] },
      { [W1]: { events: [{ ...DOCKER, day: 5 }] }, [W2]: { title: 'Next', events: [event('e9')] } },
    );
    const snapshot = JSON.stringify([before, after]);
    // Both datasets are deep-frozen, so a write would throw; the snapshot also catches a replaced object.
    expect(diffDatasets(before, after)).toHaveLength(7);
    expect(JSON.stringify([before, after])).toBe(snapshot);
  });
});

// ───────────────────────────── summarizeDiff ─────────────────────────────

function eventItem(
  change: DiffItem['change'],
  weekStart: IsoDate,
  id: string,
  patch: Partial<ScheduleEvent> = {},
  changedFields: string[] = [],
): DiffItem {
  const value = event(id, patch);
  return {
    key: `event:${weekStart}:${id}`,
    kind: 'event',
    id,
    weekStart,
    change,
    before: change === 'added' ? undefined : value,
    after: change === 'deleted' ? undefined : value,
    changedFields,
  };
}

function titleItem(weekStart: IsoDate, before: string, after: string): DiffItem {
  return { key: `weekTitle:${weekStart}`, kind: 'weekTitle', weekStart, change: 'modified', before, after, changedFields: [] };
}

function listItem(change: DiffItem['change'], kind: EntityKind, id: string): DiffItem {
  const value = entry(kind, id, `Entry ${id}`);
  return {
    key: `${kind}:${id}`,
    kind,
    id,
    change,
    before: change === 'added' ? undefined : value,
    after: change === 'deleted' ? undefined : value,
    changedFields: change === 'modified' ? ['name'] : [],
  };
}

function settingItem(kind: 'course' | 'timeGrid', field: string, before: ItemValue, after: ItemValue): DiffItem {
  return { key: `${kind}.${field}`, kind, field, change: 'modified', before, after, changedFields: [] };
}

function times<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

describe('summarizeDiff', () => {
  describe('subject', () => {
    const subjectOf = (...diff: DiffItem[]): string => summarizeDiff(diff).subject;

    it('is exactly "Update schedule" for an empty diff, with an empty body', () => {
      expect(summarizeDiff([])).toEqual({ subject: 'Update schedule', body: '' });
    });

    it('counts added, changed and deleted events and names the touched week', () => {
      expect(
        subjectOf(
          eventItem('added', W1, 'a'),
          eventItem('added', W1, 'b'),
          eventItem('modified', W1, 'c'),
          eventItem('deleted', W1, 'd'),
          eventItem('deleted', W1, 'e'),
          eventItem('deleted', W1, 'f'),
        ),
      ).toBe('Update schedule: events +2 ~1 -3 (week 2026-11-22)');
    });

    const ZERO_COUNTS: [changes: DiffItem['change'][], counts: string][] = [
      [['added'], '+1'],
      [['modified'], '~1'],
      [['deleted'], '-1'],
      [['added', 'deleted'], '+1 -1'],
      [['modified', 'added', 'modified'], '+1 ~2'],
      [['deleted', 'modified', 'deleted'], '~1 -2'],
    ];

    it.each(ZERO_COUNTS)('leaves out the counts that are zero: %j', (changes, counts) => {
      const diff = changes.map((change, index) => eventItem(change, W1, `e${index}`));
      expect(subjectOf(...diff)).toBe(`Update schedule: events ${counts} (week 2026-11-22)`);
    });

    it('names two or three touched weeks in ascending order', () => {
      expect(subjectOf(eventItem('added', W2, 'a'), eventItem('deleted', W1, 'b'))).toBe(
        'Update schedule: events +1 -1 (weeks 2026-11-22, 2026-11-29)',
      );
      expect(subjectOf(eventItem('added', W3, 'a'), eventItem('added', W1, 'b'), eventItem('added', W2, 'c'))).toBe(
        'Update schedule: events +3 (weeks 2026-11-22, 2026-11-29, 2026-12-06)',
      );
    });

    it('only counts the weeks when more than three are touched', () => {
      const diff = [W1, W2, W3, W4].flatMap((week) => [eventItem('added', week, 'a'), eventItem('modified', week, 'b')]);
      expect(subjectOf(...diff)).toBe('Update schedule: events +4 ~4 (4 weeks)');
    });

    it('counts changed week titles', () => {
      expect(subjectOf(titleItem(W1, '', 'Week 12'))).toBe('Update schedule: 1 week title');
      expect(subjectOf(titleItem(W1, '', 'Week 12'), titleItem(W2, 'Old', ''))).toBe('Update schedule: 2 week titles');
    });

    it('does not count a week as touched because of its title', () => {
      expect(subjectOf(titleItem(W2, '', 'Next'), eventItem('added', W1, 'a'))).toBe(
        'Update schedule: events +1 (week 2026-11-22); 1 week title',
      );
    });

    it('counts the changes of all four lists together', () => {
      expect(
        subjectOf(
          listItem('added', 'subject', 's1'),
          listItem('added', 'location', 'l1'),
          listItem('modified', 'teacher', 't1'),
          listItem('deleted', 'class', 'c1'),
        ),
      ).toBe('Update schedule: lists +2 ~1 -1');
      expect(subjectOf(listItem('deleted', 'teacher', 't1'))).toBe('Update schedule: lists -1');
    });

    it('says "settings" once for any number of course and time-grid changes', () => {
      expect(subjectOf(settingItem('course', 'name', 'A', 'B'))).toBe('Update schedule: settings');
      expect(subjectOf(settingItem('timeGrid', 'dayStart', 480, 450))).toBe('Update schedule: settings');
      expect(
        subjectOf(
          settingItem('course', 'name', 'A', 'B'),
          settingItem('course', 'endDate', null, '2027-01-31'),
          settingItem('timeGrid', 'slotMinutes', 30, 45),
        ),
      ).toBe('Update schedule: settings');
    });

    it('joins the parts with "; " in a fixed order, whatever the order of the items', () => {
      expect(
        subjectOf(
          settingItem('course', 'name', 'A', 'B'),
          listItem('added', 'teacher', 't1'),
          titleItem(W1, '', 'Week 12'),
          eventItem('modified', W1, 'a'),
        ),
      ).toBe('Update schedule: events ~1 (week 2026-11-22); 1 week title; lists +1; settings');
    });

    describe('length', () => {
      const threeWeeks = [eventItem('added', W1, 'a'), eventItem('modified', W2, 'b'), eventItem('deleted', W3, 'c')];
      const twoTitles = [titleItem(W1, '', 'A'), titleItem(W2, '', 'B')];
      const lists = [listItem('added', 'teacher', 't1'), listItem('modified', 'location', 'l1'), listItem('deleted', 'class', 'c1')];
      const setting = settingItem('course', 'name', 'A', 'B');

      it('keeps the week list while the line fits into 100 characters', () => {
        const subject = subjectOf(...threeWeeks, ...twoTitles, setting);
        expect(subject).toBe(
          'Update schedule: events +1 ~1 -1 (weeks 2026-11-22, 2026-11-29, 2026-12-06); 2 week titles; settings',
        );
        expect(subject).toHaveLength(100);
      });

      it('shortens the week list to a count when the line would pass 100 characters', () => {
        const withNames =
          'Update schedule: events +1 ~1 -1 (weeks 2026-11-22, 2026-11-29, 2026-12-06); 2 week titles; lists +1 ~1 -1; settings';
        expect(withNames.length).toBeGreaterThan(100);
        expect(subjectOf(...threeWeeks, ...twoTitles, ...lists, setting)).toBe(
          'Update schedule: events +1 ~1 -1 (3 weeks); 2 week titles; lists +1 ~1 -1; settings',
        );
      });

      it('writes "(1 week)" when a single named week has to be shortened', () => {
        const diff = [
          ...times(100, (i) => eventItem('added', W1, `a${i}`)),
          ...times(100, (i) => eventItem('modified', W1, `m${i}`)),
          ...times(100, (i) => eventItem('deleted', W1, `d${i}`)),
          ...times(10, (i) => titleItem(`2027-01-${String(i + 10)}`, '', 'T')),
          ...times(10, (i) => listItem('added', 'teacher', `a${i}`)),
          ...times(10, (i) => listItem('modified', 'teacher', `m${i}`)),
          ...times(10, (i) => listItem('deleted', 'teacher', `d${i}`)),
          setting,
        ];
        const withName =
          'Update schedule: events +100 ~100 -100 (week 2026-11-22); 10 week titles; lists +10 ~10 -10; settings';
        expect(withName.length).toBeGreaterThan(100);
        expect(subjectOf(...diff)).toBe(
          'Update schedule: events +100 ~100 -100 (1 week); 10 week titles; lists +10 ~10 -10; settings',
        );
      });

      it('cuts the line and ends it in "..." when even the short form is too long', () => {
        const diff = [
          ...times(1000, (i) => eventItem('added', W1, `a${i}`)),
          ...times(1000, (i) => eventItem('modified', W2, `m${i}`)),
          ...times(1000, (i) => eventItem('deleted', W3, `d${i}`)),
          ...times(1000, (i) => titleItem(`week-${i}`, '', 'T')),
          ...times(1000, (i) => listItem('added', 'teacher', `a${i}`)),
          ...times(1000, (i) => listItem('modified', 'teacher', `m${i}`)),
          ...times(1000, (i) => listItem('deleted', 'teacher', `d${i}`)),
          setting,
        ];
        const short = 'Update schedule: events +1000 ~1000 -1000 (3 weeks); 1000 week titles; lists +1000 ~1000 -1000; settings';
        expect(short.length).toBeGreaterThan(100);
        const { subject } = summarizeDiff(diff);
        expect(subject).toBe(`${short.slice(0, 97)}...`);
        expect(subject).toHaveLength(100);
      });
    });
  });

  describe('body', () => {
    const bodyOf = (before: Dataset, after: Dataset): string => summarizeDiff(diffDatasets(before, after)).body;
    const week = (...events: ScheduleEvent[]): Dataset => makeDataset({}, { [W1]: { events } });
    const DOCKER = event('e1', { title: 'Docker basics' });

    it('describes an added event with its date, weekday and hours', () => {
      expect(bodyOf(week(), week(DOCKER))).toBe('+ 2026-11-22 Sun 09:00-10:30 "Docker basics"');
    });

    it('describes a changed event by its new version and says what changed', () => {
      const before = week(event('e1', { title: 'Docker basics', day: 1, start: 600, end: 660, locationId: 'l1' }));
      const after = week(event('e1', { title: 'Docker basics', locationId: 'l2' }));
      expect(bodyOf(before, after)).toBe('~ 2026-11-22 Sun 09:00-10:30 "Docker basics" (time, location)');
    });

    it('describes a deleted event by its last version', () => {
      expect(bodyOf(week(DOCKER), week())).toBe('- 2026-11-22 Sun 09:00-10:30 "Docker basics"');
    });

    const DAYS: [day: DayIndex, date: string, name: string][] = [
      [0, '2026-11-29', 'Sun'],
      [1, '2026-11-30', 'Mon'],
      [2, '2026-12-01', 'Tue'],
      [3, '2026-12-02', 'Wed'],
      [4, '2026-12-03', 'Thu'],
      [5, '2026-12-04', 'Fri'],
      [6, '2026-12-05', 'Sat'],
    ];

    it.each(DAYS)("uses the event's own date and English day name: day %i → %s %s", (day, date, name) => {
      // The week starts on 29 November, so the dates also have to cross into December.
      const after = makeDataset({}, { [W2]: { events: [event('e1', { day, title: 'Exam' })] } });
      expect(bodyOf(makeDataset(), after)).toBe(`+ ${date} ${name} 09:00-10:30 "Exam"`);
    });

    it('writes the hours as HH:MM, up to 24:00', () => {
      expect(bodyOf(week(), week(event('e1', { start: 15, end: 1440, title: 'Night shift' })))).toBe(
        '+ 2026-11-22 Sun 00:15-24:00 "Night shift"',
      );
    });

    it('shows an untitled event with empty quotes', () => {
      expect(bodyOf(week(), week(event('e1', { title: '' })))).toBe('+ 2026-11-22 Sun 09:00-10:30 ""');
    });

    const FULL = event('e1', {
      day: 1,
      title: 'Docker basics',
      subjectId: 's1',
      locationId: 'l1',
      teacherIds: ['t1'],
      classIds: ['c1'],
      notes: 'Bring a laptop',
    });
    const PART_EDITS: [word: string, patch: Partial<ScheduleEvent>][] = [
      ['time', { day: 2 }],
      ['time', { start: 555 }],
      ['time', { end: 720 }],
      ['time', { day: 2, start: 600, end: 690 }],
      ['title', { title: 'Docker advanced' }],
      ['subject', { subjectId: 's2' }],
      ['location', { locationId: null }],
      ['teachers', { teacherIds: ['t1', 't2'] }],
      ['classes', { classIds: [] }],
      ['notes', { notes: '' }],
    ];

    it.each(PART_EDITS)('says "(%s)" for a change of %j', (word, patch) => {
      const edited = { ...FULL, ...patch };
      const line = bodyOf(week(FULL), week(edited));
      expect(line.endsWith(` "${edited.title}" (${word})`)).toBe(true);
      expect(line.startsWith('~ ')).toBe(true);
    });

    it('lists the changed parts in a fixed order', () => {
      const edited = event('e1', {
        day: 2,
        start: 600,
        end: 690,
        title: 'Docker advanced',
        subjectId: 's2',
        locationId: 'l2',
        teacherIds: [],
        classIds: ['c2'],
        notes: '',
      });
      expect(bodyOf(week(FULL), week(edited))).toBe(
        '~ 2026-11-24 Tue 10:00-11:30 "Docker advanced" (time, title, subject, location, teachers, classes, notes)',
      );
    });

    it('describes a week title, also when it was or becomes empty', () => {
      const titled = (title: string): Dataset => makeDataset({}, { [W1]: { title, events: [DOCKER] } });
      expect(bodyOf(titled('old'), titled('new'))).toBe('~ 2026-11-22 title: "old" -> "new"');
      expect(bodyOf(titled(''), titled('שבוע 12'))).toBe('~ 2026-11-22 title: "" -> "שבוע 12"');
      expect(bodyOf(titled('Week 12'), titled(''))).toBe('~ 2026-11-22 title: "Week 12" -> ""');
    });

    it('describes list entries', () => {
      const before = makeDataset({
        subjects: [{ id: 's1', name: 'Lab', color: GREEN }, { id: 's2', name: 'Exam', color: RED }],
        teachers: [{ id: 't1', name: 'Dana' }],
        classes: [{ id: 'c2', name: 'Class 2' }],
      });
      const after = makeDataset({
        subjects: [{ id: 's1', name: 'Lab', color: BLUE }, { id: 's2', name: 'Final exam', color: BLUE }, { id: 's3', name: 'מעבדה', color: GREEN }],
        locations: [{ id: 'l1', name: 'Room 101' }],
        teachers: [{ id: 't1', name: 'Dana L.' }],
        classes: [],
      });
      expect(bodyOf(before, after).split('\n')).toEqual([
        '~ subject "Lab" (color)',
        '~ subject "Exam" -> "Final exam" (color)',
        '+ subject "מעבדה"',
        '+ location "Room 101"',
        '~ teacher "Dana" -> "Dana L."',
        '- class "Class 2"',
      ]);
    });

    it('describes settings', () => {
      const before = makeDataset({ course: { name: 'A', startDate: null, endDate: '2027-01-31' } });
      const after = makeDataset({
        course: { name: 'B', startDate: '2026-09-06', endDate: null },
        timeGrid: { dayStart: 450, dayEnd: 1440, slotMinutes: 45 },
      });
      expect(bodyOf(before, after).split('\n')).toEqual([
        '~ course name: "A" -> "B"',
        '~ course startDate: none -> 2026-09-06',
        '~ course endDate: 2027-01-31 -> none',
        '~ timeGrid dayStart: 08:00 -> 07:30',
        '~ timeGrid dayEnd: 20:00 -> 24:00',
        '~ timeGrid slotMinutes: 30 -> 45',
      ]);
    });

    it('keeps names as the user typed them', () => {
      const after = makeDataset(
        { locations: [{ id: 'l1', name: ' חדר "אלף" ' }] },
        { [W1]: { events: [event('e1', { title: 'מבוא ל-Docker' })] } },
      );
      expect(bodyOf(makeDataset(), after).split('\n')).toEqual([
        '+ location " חדר "אלף" "',
        '+ 2026-11-22 Sun 09:00-10:30 "מבוא ל-Docker"',
      ]);
    });

    it('flattens line breaks inside a name, so every item stays on one line', () => {
      const after = makeDataset({ teachers: [{ id: 't1', name: 'Dana\r\nLevi' }] }, { [W1]: { title: 'Week\n12' } });
      expect(bodyOf(makeDataset(), after).split('\n')).toEqual(['+ teacher "Dana Levi"', '~ 2026-11-22 title: "" -> "Week 12"']);
    });

    it('writes one line per item in the order of the items it is given', () => {
      const diff = [
        eventItem('deleted', W2, 'z', { title: 'Last' }),
        settingItem('timeGrid', 'slotMinutes', 30, 15),
        titleItem(W1, 'a', 'b'),
        listItem('added', 'class', 'c1'),
      ];
      expect(summarizeDiff(diff).body.split('\n')).toEqual([
        '- 2026-11-29 Sun 09:00-10:30 "Last"',
        '~ timeGrid slotMinutes: 30 -> 15',
        '~ 2026-11-22 title: "a" -> "b"',
        '+ class "Entry c1"',
      ]);
    });

    it('stops after 30 lines and counts the rest', () => {
      const items = (count: number): DiffItem[] => times(count, (i) => listItem('added', 'teacher', `t${i}`));
      const lines = (count: number): string[] => summarizeDiff(items(count)).body.split('\n');

      expect(lines(30)).toHaveLength(30);
      expect(lines(30)[29]).toBe('+ teacher "Entry t29"');

      expect(lines(31)).toHaveLength(31);
      expect(lines(31)[29]).toBe('+ teacher "Entry t29"');
      expect(lines(31)[30]).toBe('... and 1 more');

      expect(lines(75)).toHaveLength(31);
      expect(lines(75)[30]).toBe('... and 45 more');
    });

    it('never fails on an item it cannot describe', () => {
      const oddWeek = eventItem('added', 'next-week', 'e1', { title: 'Odd' });
      const noValue: DiffItem = { ...eventItem('added', W1, 'e2'), after: undefined };
      const noEntry: DiffItem = { ...listItem('deleted', 'teacher', 't1'), before: undefined };
      expect(summarizeDiff([oddWeek, noValue, noEntry]).body.split('\n')).toEqual([
        '+ next-week Sun 09:00-10:30 "Odd"',
        `+ event:${W1}:e2`,
        '- teacher:t1',
      ]);
    });
  });

  it('builds the whole message for a typical set of unpublished changes', () => {
    const before = makeDataset(
      {
        subjects: [{ id: 's1', name: 'Lab', color: GREEN }],
        teachers: [{ id: 't1', name: 'Dana' }],
        classes: [{ id: 'c2', name: 'Class 2' }],
      },
      {
        [W1]: {
          title: 'old',
          events: [
            event('e1', { title: 'Docker basics', day: 1, locationId: null }),
            event('e2', { title: 'Kubernetes', day: 2, start: 780, end: 840 }),
          ],
        },
      },
    );
    const after = makeDataset(
      {
        course: { ...COURSE, name: 'DevOps 2027' },
        timeGrid: { ...GRID, dayStart: 450 },
        subjects: [{ id: 's1', name: 'Lab', color: BLUE }],
        locations: [{ id: 'l1', name: 'Room 101' }],
        teachers: [{ id: 't1', name: 'Dana L.' }],
        classes: [],
      },
      {
        [W1]: {
          title: 'new',
          events: [
            event('e1', { title: 'Docker basics', day: 0, locationId: 'l1' }),
            event('e3', { title: 'Retrospective', day: 4, start: 900, end: 960 }),
          ],
        },
      },
    );
    expect(summarizeDiff(diffDatasets(before, after))).toEqual({
      subject: 'Update schedule: events +1 ~1 -1 (week 2026-11-22); 1 week title; lists +1 ~2 -1; settings',
      body: [
        '~ course name: "DevOps 2026" -> "DevOps 2027"',
        '~ timeGrid dayStart: 08:00 -> 07:30',
        '~ subject "Lab" (color)',
        '+ location "Room 101"',
        '~ teacher "Dana" -> "Dana L."',
        '- class "Class 2"',
        '~ 2026-11-22 title: "old" -> "new"',
        '~ 2026-11-22 Sun 09:00-10:30 "Docker basics" (time, location)',
        '- 2026-11-24 Tue 13:00-14:00 "Kubernetes"',
        '+ 2026-11-26 Thu 15:00-16:00 "Retrospective"',
      ].join('\n'),
    });
  });
});
