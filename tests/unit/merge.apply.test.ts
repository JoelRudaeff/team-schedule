/**
 * applyMerge (resolutions, list order, week clean-up, reference repair, time-grid reset) and
 * the "aside" list that keeps my losing versions: applyAsideItem, addAsideItems, pruneAside.
 */
import { describe, expect, it } from 'vitest';
import {
  addAsideItems,
  applyAsideItem,
  applyMerge,
  eventKey,
  getItemValue,
  mergeDatasets,
  parseItemKey,
  pruneAside,
  weekTitleKey,
  type AppliedMerge,
  type AsideItem,
  type ItemRef,
  type ItemValue,
  type Resolution,
} from '@shared/merge';
import { ENTITY_LIST_KEY, countEntityUsage, datasetsEqual, entityList, removeEntity, sortEvents } from '@shared/model';
import type {
  CourseInfo,
  Dataset,
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

const NOW = '2026-11-22T08:30:00.000Z';
const LATER = '2026-11-23T17:00:00.000Z';

const COURSE: CourseInfo = { name: 'DevOps 2026', startDate: '2026-09-06', endDate: null };
const GRID: TimeGrid = { dayStart: 480, dayEnd: 1200, slotMinutes: 30 };
const KINDS: EntityKind[] = ['subject', 'location', 'teacher', 'class'];
const RESOLUTIONS: Resolution[] = ['mine', 'theirs', 'aside'];

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

/** The event field through which an event uses an entry of `kind`. */
function pointingTo(kind: EntityKind, id: string): Partial<ScheduleEvent> {
  switch (kind) {
    case 'subject':
      return { subjectId: id };
    case 'location':
      return { locationId: id };
    case 'teacher':
      return { teacherIds: [id] };
    case 'class':
      return { classIds: [id] };
  }
}

function ref(key: string): ItemRef {
  const parsed = parseItemKey(key);
  if (!parsed) throw new Error(`not an item key: ${key}`);
  return parsed;
}

function valueOf(dataset: Dataset, key: string): ItemValue | undefined {
  return getItemValue(dataset, ref(key));
}

function aside(key: string, mine: ItemValue | undefined, theirs: ItemValue | undefined, createdAt = NOW): AsideItem {
  return { ...ref(key), mine, theirs, createdAt };
}

/** What the aside file on disk can hold: the main process only promises objects with a key. */
function fromDisk(json: string): AsideItem[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('the aside file holds a list');
  return parsed.filter((item): item is AsideItem => typeof item === 'object' && item !== null && 'key' in item);
}

/** The list after a round trip through the aside file: JSON drops every `undefined` property. */
function reloaded(items: readonly AsideItem[]): AsideItem[] {
  return fromDisk(JSON.stringify(items));
}

interface MergeOptions {
  resolutions?: Record<string, Resolution>;
  defaultResolution?: Resolution;
}

/** mergeDatasets + applyMerge in one go; conflicts go to the team unless the options say otherwise. */
function merge(base: Dataset, mine: Dataset, theirs: Dataset, options: MergeOptions = {}): AppliedMerge {
  return applyMerge({
    mine,
    theirs,
    result: mergeDatasets(base, mine, theirs),
    resolutions: options.resolutions ?? {},
    defaultResolution: options.defaultResolution ?? 'theirs',
    now: NOW,
  });
}

const LAB: Subject = { id: 's1', name: 'Lab', color: GREEN };
const LECTURE: Subject = { id: 's2', name: 'Lecture', color: BLUE };
const ROOM: NamedItem = { id: 'l1', name: 'Room 101' };
const AULA: NamedItem = { id: 'l2', name: 'Aula' };
const DANA: NamedItem = { id: 't1', name: 'Dana' };
const NOAM: NamedItem = { id: 't2', name: 'Noam' };
const CLASS_1: NamedItem = { id: 'c1', name: 'Class 1' };
const CLASS_2: NamedItem = { id: 'c2', name: 'Class 2' };

const DOCKER = event('e1', {
  title: 'Docker basics',
  subjectId: 's1',
  locationId: 'l1',
  teacherIds: ['t1'],
  classIds: ['c1'],
});
const K8S = event('e2', {
  day: 1,
  title: 'Kubernetes',
  subjectId: 's2',
  locationId: 'l2',
  teacherIds: ['t2'],
  classIds: ['c1', 'c2'],
});
const REVIEW = event('e3', { day: 3, start: 780, end: 840, title: 'Review' });
const EXAM = event('e4', { day: 2, title: 'Exam', locationId: 'l2', classIds: ['c2'] });

/** The schedule as the team last shared it. */
const BASE = makeDataset(
  { subjects: [LAB, LECTURE], locations: [ROOM, AULA], teachers: [DANA, NOAM], classes: [CLASS_1, CLASS_2] },
  { [W1]: { title: 'Week 12', events: [DOCKER, K8S, REVIEW] }, [W2]: { events: [EXAM] } },
);

/** BASE after one person changed something of every kind (and deleted Class 2 the way the app does). */
const EDITED = makeDataset(
  {
    course: { name: 'DevOps 2027', startDate: '2026-09-06', endDate: '2027-01-31' },
    timeGrid: { dayStart: 450, dayEnd: 1200, slotMinutes: 60 },
    subjects: [{ ...LAB, color: RED }, LECTURE],
    locations: [ROOM, AULA, { id: 'l3', name: 'Lab B' }],
    teachers: [{ ...DANA, name: 'Dana L.' }, NOAM],
    classes: [CLASS_1],
  },
  {
    [W1]: {
      title: 'Docker week',
      events: [{ ...DOCKER, day: 4 }, { ...K8S, classIds: ['c1'] }, event('e5', { day: 5, title: 'Retro', locationId: 'l3' })],
    },
    [W3]: { title: 'Holiday' },
  },
);

// ───────────────────────────── applyMerge ─────────────────────────────

describe('applyMerge', () => {
  describe('when only one side changed', () => {
    it.each(RESOLUTIONS)('nothing changed by me → the result is the team version (default %s)', (defaultResolution) => {
      expect(merge(BASE, BASE, EDITED, { defaultResolution })).toEqual({ dataset: EDITED, aside: [], notes: [] });
    });

    it.each(RESOLUTIONS)(
      'nothing changed by them → the result is my version, whatever the resolutions (default %s)',
      (defaultResolution) => {
        const resolutions: Record<string, Resolution> = {
          'course.name': 'theirs',
          'teacher:t1': 'theirs',
          [eventKey(W1, 'e1')]: 'aside',
          [weekTitleKey(W1)]: 'aside',
        };
        expect(merge(BASE, EDITED, BASE, { defaultResolution, resolutions })).toEqual({
          dataset: EDITED,
          aside: [],
          notes: [],
        });
      },
    );

    it('nobody changed anything → the team version comes back untouched', () => {
      expect(merge(BASE, BASE, structuredClone(BASE))).toEqual({ dataset: BASE, aside: [], notes: [] });
    });

    it('both made exactly the same changes → that version, with nothing to decide', () => {
      expect(merge(BASE, EDITED, structuredClone(EDITED), { defaultResolution: 'aside' })).toEqual({
        dataset: EDITED,
        aside: [],
        notes: [],
      });
    });
  });

  describe('changes of both sides that do not collide', () => {
    const tal = { id: 't3', name: 'Tal' };
    const labB = { id: 'l3', name: 'Lab B' };
    const retro = event('e5', { day: 5, title: 'Retro', teacherIds: ['t3'] });
    const extra = event('e6', { day: 4, title: 'Extra lesson' });
    const mine = makeDataset(
      {
        course: { ...COURSE, name: 'DevOps 2027' },
        timeGrid: { ...GRID, dayStart: 450 },
        subjects: [LAB, LECTURE],
        locations: [ROOM, AULA],
        teachers: [{ ...DANA, name: 'Dana L.' }, NOAM, tal],
        classes: [CLASS_1, CLASS_2],
      },
      {
        [W1]: { title: 'Docker week', events: [{ ...DOCKER, title: 'Docker advanced' }, K8S, REVIEW, retro] },
        [W2]: { events: [EXAM] },
      },
    );
    const theirs = makeDataset(
      {
        course: { ...COURSE, endDate: '2027-01-31' },
        timeGrid: { ...GRID, dayEnd: 1320 },
        subjects: [{ ...LAB, color: RED }, LECTURE],
        locations: [ROOM, AULA, labB],
        teachers: [DANA, NOAM],
        classes: [CLASS_1, CLASS_2],
      },
      {
        [W1]: { title: 'Week 12', events: [{ ...DOCKER, day: 2, locationId: 'l3' }, K8S] },
        [W2]: { events: [EXAM, extra] },
        [W3]: { title: 'Holiday' },
      },
    );
    const expected = makeDataset(
      {
        course: { name: 'DevOps 2027', startDate: '2026-09-06', endDate: '2027-01-31' },
        timeGrid: { dayStart: 450, dayEnd: 1320, slotMinutes: 30 },
        subjects: [{ ...LAB, color: RED }, LECTURE],
        locations: [ROOM, AULA, labB],
        teachers: [{ ...DANA, name: 'Dana L.' }, NOAM, tal],
        classes: [CLASS_1, CLASS_2],
      },
      {
        [W1]: {
          title: 'Docker week',
          events: [{ ...DOCKER, title: 'Docker advanced', day: 2, locationId: 'l3' }, K8S, retro],
        },
        [W2]: { events: [EXAM, extra] },
        [W3]: { title: 'Holiday' },
      },
    );

    it('has nothing to decide', () => {
      const result = mergeDatasets(BASE, mine, theirs);
      expect(result.conflictCount).toBe(0);
      expect(result.items.find((item) => item.key === eventKey(W1, 'e1'))?.status).toBe('combined');
    });

    it.each(RESOLUTIONS)('keeps every change of both sides (default %s)', (defaultResolution) => {
      expect(merge(BASE, mine, theirs, { defaultResolution })).toEqual({ dataset: expected, aside: [], notes: [] });
    });

    it('is the same schedule when the two sides swap places (each list was only added to by one side)', () => {
      const swapped = merge(BASE, theirs, mine).dataset;
      expect(datasetsEqual(swapped, expected)).toBe(true);
      expect(swapped.config.teachers).toEqual([{ ...DANA, name: 'Dana L.' }, NOAM, tal]);
      expect(swapped.config.locations).toEqual([ROOM, AULA, labB]);
      expect(swapped.weeks).toEqual(expected.weeks);
    });
  });

  // ── one conflict at a time, for every shape a conflict can have ──

  interface ConflictCase {
    title: string;
    key: string;
    base: Dataset;
    mine: Dataset;
    theirs: Dataset;
    mineValue: ItemValue | undefined;
    theirValue: ItemValue | undefined;
  }

  const plain = event('e1', { title: 'Docker basics' });
  const bystander = event('e9', { day: 5, title: 'Bystander' });
  const weekWith = (value: ScheduleEvent | undefined): Dataset =>
    makeDataset({}, { [W1]: { title: 'Week 12', events: [bystander, ...(value ? [value] : [])] } });
  const mineEvent = { ...plain, title: 'Mine', notes: 'my notes' };
  const theirEvent = { ...plain, title: 'Theirs', day: 2 } satisfies ScheduleEvent;

  const CONFLICTS: ConflictCase[] = [
    {
      title: 'an event both edited',
      key: eventKey(W1, 'e1'),
      base: weekWith(plain),
      mine: weekWith(mineEvent),
      theirs: weekWith(theirEvent),
      mineValue: mineEvent,
      theirValue: theirEvent,
    },
    {
      title: 'an event I deleted and they edited',
      key: eventKey(W1, 'e1'),
      base: weekWith(plain),
      mine: weekWith(undefined),
      theirs: weekWith(theirEvent),
      mineValue: undefined,
      theirValue: theirEvent,
    },
    {
      title: 'an event I edited and they deleted',
      key: eventKey(W1, 'e1'),
      base: weekWith(plain),
      mine: weekWith(mineEvent),
      theirs: weekWith(undefined),
      mineValue: mineEvent,
      theirValue: undefined,
    },
    {
      title: 'an event both added under the same id',
      key: eventKey(W1, 'e1'),
      base: weekWith(undefined),
      mine: weekWith(mineEvent),
      theirs: weekWith(theirEvent),
      mineValue: mineEvent,
      theirValue: theirEvent,
    },
    {
      title: 'the only event of a week, which they deleted and I edited',
      key: eventKey(W2, 'e1'),
      base: makeDataset({}, { [W2]: { events: [plain] } }),
      mine: makeDataset({}, { [W2]: { events: [mineEvent] } }),
      theirs: makeDataset(),
      mineValue: mineEvent,
      theirValue: undefined,
    },
    {
      title: 'a teacher both renamed',
      key: 'teacher:t1',
      base: makeDataset({ teachers: [DANA, NOAM] }),
      mine: makeDataset({ teachers: [{ id: 't1', name: 'Dana L.' }, NOAM] }),
      theirs: makeDataset({ teachers: [{ id: 't1', name: 'Dana Levi' }, NOAM] }),
      mineValue: { id: 't1', name: 'Dana L.' },
      theirValue: { id: 't1', name: 'Dana Levi' },
    },
    {
      title: 'a location I deleted and they renamed',
      key: 'location:l2',
      base: makeDataset({ locations: [ROOM, AULA] }),
      mine: makeDataset({ locations: [ROOM] }),
      theirs: makeDataset({ locations: [ROOM, { id: 'l2', name: 'Auditorium' }] }),
      mineValue: undefined,
      theirValue: { id: 'l2', name: 'Auditorium' },
    },
    {
      title: 'a class I renamed and they deleted',
      key: 'class:c2',
      base: makeDataset({ classes: [CLASS_1, CLASS_2] }),
      mine: makeDataset({ classes: [CLASS_1, { id: 'c2', name: 'כיתה 2' }] }),
      theirs: makeDataset({ classes: [CLASS_1] }),
      mineValue: { id: 'c2', name: 'כיתה 2' },
      theirValue: undefined,
    },
    {
      title: 'a subject both recoloured',
      key: 'subject:s1',
      base: makeDataset({ subjects: [LAB, LECTURE] }),
      mine: makeDataset({ subjects: [{ ...LAB, color: RED }, LECTURE] }),
      theirs: makeDataset({ subjects: [{ ...LAB, color: BLUE }, LECTURE] }),
      mineValue: { ...LAB, color: RED },
      theirValue: { ...LAB, color: BLUE },
    },
    {
      title: 'a subject both added under the same id',
      key: 'subject:s9',
      base: makeDataset({ subjects: [LAB] }),
      mine: makeDataset({ subjects: [LAB, { id: 's9', name: 'Exam', color: RED }] }),
      theirs: makeDataset({ subjects: [LAB, { id: 's9', name: 'Test', color: RED }] }),
      mineValue: { id: 's9', name: 'Exam', color: RED },
      theirValue: { id: 's9', name: 'Test', color: RED },
    },
    {
      title: 'a week title',
      key: weekTitleKey(W1),
      base: makeDataset({}, { [W1]: { title: 'Week 12', events: [plain] } }),
      mine: makeDataset({}, { [W1]: { title: 'Docker week', events: [plain] } }),
      theirs: makeDataset({}, { [W1]: { title: 'שבוע 12', events: [plain] } }),
      mineValue: 'Docker week',
      theirValue: 'שבוע 12',
    },
    {
      title: 'the title of a week that exists only because of its title',
      key: weekTitleKey(W2),
      base: makeDataset(),
      mine: makeDataset({}, { [W2]: { title: 'Holiday' } }),
      theirs: makeDataset({}, { [W2]: { title: 'חופשה' } }),
      mineValue: 'Holiday',
      theirValue: 'חופשה',
    },
    {
      title: 'a week title that I changed and they removed',
      key: weekTitleKey(W2),
      base: makeDataset({}, { [W2]: { title: 'Holiday' } }),
      mine: makeDataset({}, { [W2]: { title: 'Passover' } }),
      theirs: makeDataset(),
      mineValue: 'Passover',
      theirValue: '',
    },
    {
      title: 'the course name',
      key: 'course.name',
      base: makeDataset(),
      mine: makeDataset({ course: { ...COURSE, name: 'DevOps (evening)' } }),
      theirs: makeDataset({ course: { ...COURSE, name: 'DevOps 2027' } }),
      mineValue: 'DevOps (evening)',
      theirValue: 'DevOps 2027',
    },
    {
      title: 'a course date that I cleared and they moved',
      key: 'course.startDate',
      base: makeDataset(),
      mine: makeDataset({ course: { ...COURSE, startDate: null } }),
      theirs: makeDataset({ course: { ...COURSE, startDate: '2026-09-13' } }),
      mineValue: null,
      theirValue: '2026-09-13',
    },
    {
      title: 'the start of the day',
      key: 'timeGrid.dayStart',
      base: makeDataset(),
      mine: makeDataset({ timeGrid: { ...GRID, dayStart: 420 } }),
      theirs: makeDataset({ timeGrid: { ...GRID, dayStart: 450 } }),
      mineValue: 420,
      theirValue: 450,
    },
    {
      title: 'the row height',
      key: 'timeGrid.slotMinutes',
      base: makeDataset(),
      mine: makeDataset({ timeGrid: { ...GRID, slotMinutes: 15 } }),
      theirs: makeDataset({ timeGrid: { ...GRID, slotMinutes: 60 } }),
      mineValue: 15,
      theirValue: 60,
    },
  ];

  describe.each(CONFLICTS)('conflict: $title', ({ key, base, mine, theirs, mineValue, theirValue }) => {
    it('is the one item of the merge', () => {
      const result = mergeDatasets(base, mine, theirs);
      expect(result.items.map((item) => [item.key, item.status])).toEqual([[key, 'conflict']]);
    });

    it("'theirs' keeps the team version and forgets mine", () => {
      const applied = merge(base, mine, theirs, { defaultResolution: 'theirs' });
      expect(valueOf(applied.dataset, key)).toEqual(theirValue);
      expect(datasetsEqual(applied.dataset, theirs)).toBe(true);
      expect(applied.aside).toEqual([]);
      expect(applied.notes).toEqual([]);
    });

    it("'mine' puts my version in", () => {
      const applied = merge(base, mine, theirs, { defaultResolution: 'mine' });
      expect(valueOf(applied.dataset, key)).toEqual(mineValue);
      expect(datasetsEqual(applied.dataset, mine)).toBe(true);
      expect(applied.aside).toEqual([]);
      expect(applied.notes).toEqual([]);
    });

    it("'aside' keeps the team version in the schedule and my version in the aside list", () => {
      const applied = merge(base, mine, theirs, { defaultResolution: 'aside' });
      expect(applied.dataset).toEqual(merge(base, mine, theirs, { defaultResolution: 'theirs' }).dataset);
      expect(applied.aside).toStrictEqual([{ ...ref(key), mine: mineValue, theirs: theirValue, createdAt: NOW }]);
      expect(applied.notes).toEqual([]);
    });

    it('a resolution for this key beats the default', () => {
      const applied = merge(base, mine, theirs, { defaultResolution: 'theirs', resolutions: { [key]: 'mine' } });
      expect(valueOf(applied.dataset, key)).toEqual(mineValue);
      const kept = merge(base, mine, theirs, { defaultResolution: 'mine', resolutions: { [key]: 'aside' } });
      expect(valueOf(kept.dataset, key)).toEqual(theirValue);
      expect(kept.aside).toHaveLength(1);
    });

    it('applyAsideItem brings my version back, after which nothing is left to decide', () => {
      const applied = merge(base, mine, theirs, { defaultResolution: 'aside' });
      expect(pruneAside(applied.aside, applied.dataset)).toEqual(applied.aside);

      const decided = applyAsideItem(applied.dataset, applied.aside[0]);
      expect(valueOf(decided, key)).toEqual(mineValue);
      expect(datasetsEqual(decided, mine)).toBe(true);
      expect(pruneAside(applied.aside, decided)).toEqual([]);
    });

    it('the aside entry still works after it was stored in the aside file', () => {
      const applied = merge(base, mine, theirs, { defaultResolution: 'aside' });
      const [stored] = reloaded(applied.aside);
      expect(datasetsEqual(applyAsideItem(applied.dataset, stored), mine)).toBe(true);
      expect(pruneAside([stored], theirs)).toEqual([stored]);
      expect(pruneAside([stored], mine)).toEqual([]);
    });

    it('re-merging my resolved copy against the team has nothing left to resolve', () => {
      for (const defaultResolution of RESOLUTIONS) {
        const applied = merge(base, mine, theirs, { defaultResolution });
        const again = mergeDatasets(theirs, applied.dataset, theirs);
        expect(again.conflictCount).toBe(0);
        expect(again.items.map((item) => [item.key, item.status])).toEqual(defaultResolution === 'mine' ? [[key, 'mine']] : []);
      }
    });
  });

  describe('resolutions', () => {
    const base = makeDataset({ teachers: [DANA] }, { [W1]: { title: 'Week 12', events: [plain] } });
    const mine = makeDataset(
      { course: { ...COURSE, name: 'Mine' }, teachers: [{ id: 't1', name: 'Dana L.' }], locations: [ROOM] },
      { [W1]: { title: 'Week 12', events: [mineEvent] } },
    );
    const theirs = makeDataset(
      { course: { ...COURSE, name: 'Theirs' }, teachers: [{ id: 't1', name: 'Dana Levi' }] },
      { [W1]: { title: 'Team week', events: [theirEvent] } },
    );
    const COURSE_KEY = 'course.name';
    const TEACHER_KEY = 'teacher:t1';
    const EVENT_KEY = eventKey(W1, 'e1');
    const chosen = (applied: AppliedMerge): (ItemValue | undefined)[] =>
      [COURSE_KEY, TEACHER_KEY, EVENT_KEY].map((key) => valueOf(applied.dataset, key));
    const MINE = ['Mine', { id: 't1', name: 'Dana L.' }, mineEvent];
    const THEIRS = ['Theirs', { id: 't1', name: 'Dana Levi' }, theirEvent];

    it('the fixture has three conflicts, one change of mine and one of theirs', () => {
      expect(mergeDatasets(base, mine, theirs).items.map((item) => [item.key, item.status])).toEqual([
        [COURSE_KEY, 'conflict'],
        ['location:l1', 'mine'],
        [TEACHER_KEY, 'conflict'],
        [weekTitleKey(W1), 'theirs'],
        [EVENT_KEY, 'conflict'],
      ]);
    });

    it('uses the default for every conflict without an entry', () => {
      expect(chosen(merge(base, mine, theirs, { defaultResolution: 'mine' }))).toEqual(MINE);
      expect(chosen(merge(base, mine, theirs, { defaultResolution: 'theirs' }))).toEqual(THEIRS);
      expect(chosen(merge(base, mine, theirs, { defaultResolution: 'aside' }))).toEqual(THEIRS);
    });

    it('settles each conflict by its own entry', () => {
      const applied = merge(base, mine, theirs, {
        defaultResolution: 'theirs',
        resolutions: { [COURSE_KEY]: 'mine', [EVENT_KEY]: 'aside' },
      });
      expect(chosen(applied)).toEqual(['Mine', { id: 't1', name: 'Dana Levi' }, theirEvent]);
      expect(applied.aside.map((item) => item.key)).toEqual([EVENT_KEY]);

      const opposite = merge(base, mine, theirs, {
        defaultResolution: 'mine',
        resolutions: { [COURSE_KEY]: 'theirs', [TEACHER_KEY]: 'aside' },
      });
      expect(chosen(opposite)).toEqual(['Theirs', { id: 't1', name: 'Dana Levi' }, mineEvent]);
      expect(opposite.aside.map((item) => item.key)).toEqual([TEACHER_KEY]);
    });

    it('keeps the changes that did not collide, whatever happens to the conflicts', () => {
      for (const defaultResolution of RESOLUTIONS) {
        const { dataset } = merge(base, mine, theirs, { defaultResolution });
        expect(dataset.config.locations).toEqual([ROOM]);
        expect(dataset.weeks[W1].title).toBe('Team week');
      }
    });

    it('ignores entries for items that are not conflicts and for keys the merge does not have', () => {
      const resolutions: Record<string, Resolution> = {
        'location:l1': 'theirs',
        [weekTitleKey(W1)]: 'mine',
        'course.endDate': 'aside',
        'teacher:nobody': 'aside',
        'not a key': 'mine',
      };
      const applied = merge(base, mine, theirs, { defaultResolution: 'mine', resolutions });
      expect(applied).toEqual(merge(base, mine, theirs, { defaultResolution: 'mine' }));
      expect(applied.dataset.config.locations).toEqual([ROOM]);
      expect(applied.dataset.weeks[W1].title).toBe('Team week');
      expect(applied.aside).toEqual([]);
    });

    it('lists what was set aside in the order of the merge, each with its ref and both versions', () => {
      const applied = merge(base, mine, theirs, { defaultResolution: 'aside' });
      expect(applied.aside).toStrictEqual([
        { key: COURSE_KEY, kind: 'course', field: 'name', mine: 'Mine', theirs: 'Theirs', createdAt: NOW },
        {
          key: TEACHER_KEY,
          kind: 'teacher',
          id: 't1',
          mine: { id: 't1', name: 'Dana L.' },
          theirs: { id: 't1', name: 'Dana Levi' },
          createdAt: NOW,
        },
        { key: EVENT_KEY, kind: 'event', id: 'e1', weekStart: W1, mine: mineEvent, theirs: theirEvent, createdAt: NOW },
      ]);
    });

    it('applying everything that was set aside ends where "mine" for every conflict would have', () => {
      const kept = merge(base, mine, theirs, { defaultResolution: 'aside' });
      const decided = kept.aside.reduce(applyAsideItem, kept.dataset);
      expect(decided).toEqual(merge(base, mine, theirs, { defaultResolution: 'mine' }).dataset);
    });
  });

  describe('list order', () => {
    const names = (...ids: string[]): NamedItem[] => ids.map((id) => ({ id, name: id }));

    it('keeps the order of the team and puts the entries only I added at the end, in my order', () => {
      const base = makeDataset({ teachers: names('a', 'b', 'c') });
      const mine = makeDataset({
        teachers: [{ id: 'm2', name: 'm2' }, { id: 'a', name: 'a' }, { id: 'm1', name: 'm1' }, { id: 'b', name: 'b mine' }, { id: 'c', name: 'c' }],
      });
      const theirs = makeDataset({ teachers: names('c', 't1', 'a', 'b') });
      expect(merge(base, mine, theirs).dataset.config.teachers).toEqual([
        { id: 'c', name: 'c' },
        { id: 't1', name: 't1' },
        { id: 'a', name: 'a' },
        { id: 'b', name: 'b mine' },
        { id: 'm2', name: 'm2' },
        { id: 'm1', name: 'm1' },
      ]);
    });

    it('takes out what I deleted and leaves a gap for nothing else', () => {
      const base = makeDataset({ classes: names('a', 'b', 'c', 'd') });
      const mine = makeDataset({ classes: names('a', 'c') });
      const theirs = makeDataset({ classes: names('d', 'c', 'b', 'a', 'e') });
      expect(merge(base, mine, theirs).dataset.config.classes).toEqual(names('c', 'a', 'e'));
    });

    it('puts an entry that the team deleted and I insist on (resolution mine) at the end', () => {
      const base = makeDataset({ locations: names('a', 'b', 'c') });
      const mine = makeDataset({ locations: [{ id: 'a', name: 'a mine' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }, { id: 'm', name: 'm' }] });
      const theirs = makeDataset({ locations: names('b', 'c') });
      expect(merge(base, mine, theirs, { defaultResolution: 'mine' }).dataset.config.locations).toEqual([
        { id: 'b', name: 'b' },
        { id: 'c', name: 'c' },
        { id: 'a', name: 'a mine' },
        { id: 'm', name: 'm' },
      ]);
      expect(merge(base, mine, theirs, { defaultResolution: 'theirs' }).dataset.config.locations).toEqual([
        { id: 'b', name: 'b' },
        { id: 'c', name: 'c' },
        { id: 'm', name: 'm' },
      ]);
    });

    it.each(KINDS)('works the same for the %s list', (kind) => {
      const base = makeDataset(list(kind, entry(kind, 'a', 'A'), entry(kind, 'b', 'B')));
      const mine = makeDataset(list(kind, entry(kind, 'm', 'M'), entry(kind, 'a', 'A mine'), entry(kind, 'b', 'B')));
      const theirs = makeDataset(list(kind, entry(kind, 'b', 'B theirs'), entry(kind, 't', 'T'), entry(kind, 'a', 'A')));
      expect(entityList(merge(base, mine, theirs).dataset.config, kind)).toEqual([
        entry(kind, 'b', 'B theirs'),
        entry(kind, 't', 'T'),
        entry(kind, 'a', 'A mine'),
        entry(kind, 'm', 'M'),
      ]);
    });

    it('does not carry over an order that I only rearranged', () => {
      const base = makeDataset({ teachers: names('a', 'b', 'c') });
      const mine = makeDataset({ teachers: names('c', 'b', 'a') });
      const theirs = makeDataset({ teachers: names('a', 'b', 'c', 'd') });
      expect(merge(base, mine, theirs).dataset.config.teachers).toEqual(names('a', 'b', 'c', 'd'));
    });
  });

  describe('weeks after the merge', () => {
    const ids = (dataset: Dataset, weekStart: IsoDate): string[] => dataset.weeks[weekStart].events.map((e) => e.id);

    it('puts my events at their sorted place among the events of the team', () => {
      const base = makeDataset({}, { [W1]: { events: [event('b', { day: 2 })] } });
      const mine = makeDataset(
        {},
        { [W1]: { events: [event('b', { day: 2 }), event('m1', { day: 1 }), event('m2', { day: 2, start: 480, end: 510 }), event('m3', { day: 6 })] } },
      );
      const theirs = makeDataset({}, { [W1]: { events: [event('b', { day: 2 }), event('t1', { day: 0 }), event('t2', { day: 4 })] } });
      expect(ids(merge(base, mine, theirs).dataset, W1)).toEqual(['t1', 'm1', 'm2', 'b', 't2', 'm3']);
    });

    it('moves an event to its new place when my version or a combined version changes its time', () => {
      const base = makeDataset({}, { [W1]: { events: [event('a', { day: 0 }), event('b', { day: 1 }), event('c', { day: 2 })] } });
      const mine = makeDataset({}, { [W1]: { events: [event('a', { day: 5 }), event('b', { day: 1 }), event('c', { day: 2, title: 'Mine' })] } });
      const theirs = makeDataset({}, { [W1]: { events: [event('a', { day: 0 }), event('b', { day: 1 }), event('c', { day: 0, start: 480, end: 510 })] } });
      const { dataset } = merge(base, mine, theirs);
      expect(ids(dataset, W1)).toEqual(['c', 'b', 'a']);
      expect(dataset.weeks[W1].events[0]).toEqual(event('c', { day: 0, start: 480, end: 510, title: 'Mine' }));
    });

    it('sorts every week, also one that no change touched', () => {
      const unsorted = [event('late', { day: 5 }), event('early', { day: 1 }), event('middle', { day: 3 })];
      const withWeek = (config: Partial<ScheduleConfig>): Dataset =>
        deepFreeze({
          config: { ...BASE.config, ...config },
          weeks: { [W2]: { weekStart: W2, title: '', events: unsorted } },
        });
      const base = withWeek({});
      expect(ids(merge(base, withWeek({ course: { ...COURSE, name: 'Mine' } }), base).dataset, W2)).toEqual(['early', 'middle', 'late']);
      expect(ids(merge(base, base, withWeek({ course: { ...COURSE, name: 'Theirs' } })).dataset, W2)).toEqual(['early', 'middle', 'late']);
    });

    it('creates the week for my event when the team has none', () => {
      const mine = makeDataset({}, { [W3]: { events: [event('m')] } });
      expect(merge(makeDataset(), mine, makeDataset({}, { [W1]: { title: 'Team' } })).dataset.weeks).toEqual({
        [W1]: { weekStart: W1, title: 'Team', events: [] },
        [W3]: { weekStart: W3, title: '', events: [event('m')] },
      });
    });

    it('drops a week that ends up without a title and without events', () => {
      const base = makeDataset({}, { [W1]: { events: [event('a')] }, [W2]: { title: 'Holiday' } });
      const mine = makeDataset();
      const theirs = makeDataset({}, { [W1]: { events: [event('a')] }, [W2]: { title: 'Holiday' }, [W3]: { title: 'Kept' } });
      expect(merge(base, mine, theirs).dataset.weeks).toEqual({ [W3]: { weekStart: W3, title: 'Kept', events: [] } });
    });

    it('drops an empty week that the team dataset still carries', () => {
      const theirs = makeDataset({ course: { ...COURSE, name: 'Theirs' } }, { [W1]: { events: [event('a')] }, [W2]: {} });
      const base = makeDataset({}, { [W1]: { events: [event('a')] } });
      expect(Object.keys(merge(base, base, theirs).dataset.weeks)).toEqual([W1]);
    });

    it('keeps a week whose last event I deleted when it has a title', () => {
      const base = makeDataset({}, { [W1]: { title: 'Week 12', events: [event('a')] } });
      const mine = makeDataset({}, { [W1]: { title: 'Week 12' } });
      expect(merge(base, mine, base).dataset.weeks).toEqual({ [W1]: { weekStart: W1, title: 'Week 12', events: [] } });
    });

    it('keeps the title of the team on a week to which I only added an event', () => {
      const base = makeDataset({}, { [W1]: { title: 'Week 12' } });
      const mine = makeDataset({}, { [W1]: { title: 'Week 12', events: [event('m')] } });
      const theirs = makeDataset({}, { [W1]: { title: 'Docker week' } });
      expect(merge(base, mine, theirs).dataset.weeks[W1]).toEqual({ weekStart: W1, title: 'Docker week', events: [event('m')] });
    });
  });

  describe('reference repair', () => {
    describe.each(KINDS)('%s', (kind) => {
      const used = entry(kind, 'x', 'Used');
      const other = entry(kind, 'o', 'Other');
      const using = event('e2', { day: 1, ...pointingTo(kind, 'x') });
      const base = makeDataset(list(kind, used, other), { [W1]: { events: [event('e1')] } });
      const deleted = makeDataset(list(kind, other), { [W1]: { events: [event('e1')] } });
      const inUse = makeDataset(list(kind, used, other), { [W1]: { events: [event('e1'), using] } });
      const note = { code: 'entity-restored', kind, id: 'x', name: 'Used' };

      it('I use what they deleted → the entry comes back at the end of its list, with a note', () => {
        const applied = merge(base, inUse, deleted);
        expect(entityList(applied.dataset.config, kind)).toEqual([other, used]);
        expect(applied.dataset.weeks[W1].events).toEqual([event('e1'), using]);
        expect(applied.notes).toEqual([note]);
      });

      it('they use what I deleted → the entry comes back at the end of its list, with a note', () => {
        const applied = merge(base, deleted, inUse);
        expect(entityList(applied.dataset.config, kind)).toEqual([other, used]);
        expect(applied.dataset.weeks[W1].events).toEqual([event('e1'), using]);
        expect(applied.notes).toEqual([note]);
      });

      it('stays deleted when nothing uses it', () => {
        expect(merge(base, deleted, base)).toEqual({ dataset: deleted, aside: [], notes: [] });
        expect(merge(base, base, deleted)).toEqual({ dataset: deleted, aside: [], notes: [] });
      });
    });

    it('adds one note per entry, however many events use it', () => {
      const base = makeDataset({ teachers: [DANA, NOAM] });
      const mine = makeDataset({ teachers: [NOAM] });
      const theirs = makeDataset(
        { teachers: [DANA, NOAM] },
        { [W1]: { events: [event('a', { teacherIds: ['t1'] }), event('b', { day: 1, teacherIds: ['t1', 't2'] })] }, [W2]: { events: [event('c', { teacherIds: ['t1'] })] } },
      );
      const applied = merge(base, mine, theirs);
      expect(applied.notes).toEqual([{ code: 'entity-restored', kind: 'teacher', id: 't1', name: 'Dana' }]);
      expect(applied.dataset.config.teachers).toEqual([NOAM, DANA]);
    });

    it('brings back my edited version when the team deleted the entry and my new event uses it', () => {
      const base = makeDataset({ locations: [ROOM, AULA] });
      const renamed = { id: 'l2', name: 'Auditorium' };
      const mine = makeDataset({ locations: [ROOM, renamed] }, { [W1]: { events: [event('m', { locationId: 'l2' })] } });
      const theirs = makeDataset({ locations: [ROOM] });
      // The conflict itself goes to the team (deleted), but an event of mine still needs the entry.
      for (const defaultResolution of ['theirs', 'aside'] satisfies Resolution[]) {
        const applied = merge(base, mine, theirs, { defaultResolution });
        expect(applied.dataset.config.locations).toEqual([ROOM, renamed]);
        expect(applied.notes).toEqual([{ code: 'entity-restored', kind: 'location', id: 'l2', name: 'Auditorium' }]);
      }
      const insisted = merge(base, mine, theirs, { defaultResolution: 'mine' });
      expect(insisted.dataset.config.locations).toEqual([ROOM, renamed]);
      expect(insisted.notes).toEqual([]);
    });

    it('brings back the edited version of the team when I deleted the entry and their event uses it', () => {
      const base = makeDataset({ subjects: [LAB, LECTURE] });
      const recoloured = { ...LAB, color: RED };
      const mine = makeDataset({ subjects: [LECTURE] });
      const theirs = makeDataset({ subjects: [recoloured, LECTURE] }, { [W1]: { events: [event('t', { subjectId: 's1' })] } });
      const applied = merge(base, mine, theirs, { defaultResolution: 'mine' });
      expect(applied.dataset.config.subjects).toEqual([LECTURE, recoloured]);
      expect(applied.notes).toEqual([{ code: 'entity-restored', kind: 'subject', id: 's1', name: 'Lab' }]);
    });

    it('needs no repair when the app stripped the references and the team did not add new ones', () => {
      const base = makeDataset({ teachers: [DANA, NOAM] }, { [W1]: { events: [event('a', { teacherIds: ['t1', 't2'] })] } });
      const mine = deepFreeze(removeEntity(base, 'teacher', 't1'));
      const theirs = makeDataset({ teachers: [DANA, NOAM] }, { [W1]: { events: [event('a', { teacherIds: ['t1', 't2'], title: 'Renamed' })] } });
      const applied = merge(base, mine, theirs);
      expect(applied.notes).toEqual([]);
      expect(applied.dataset.config.teachers).toEqual([NOAM]);
      expect(applied.dataset.weeks[W1].events).toEqual([event('a', { teacherIds: ['t2'], title: 'Renamed' })]);
    });

    it('repairs for the version of an event that won its conflict', () => {
      const base = makeDataset({ teachers: [DANA, NOAM] }, { [W1]: { events: [event('a', { teacherIds: ['t1'] })] } });
      const mine = deepFreeze(removeEntity(base, 'teacher', 't1'));
      const theirs = makeDataset({ teachers: [DANA, NOAM] }, { [W1]: { events: [event('a', { teacherIds: ['t1', 't2'] })] } });
      // The team keeps Dana on the event (conflict on the teachers): with their version she must exist …
      const theirWay = merge(base, mine, theirs, { defaultResolution: 'theirs' });
      expect(theirWay.dataset.config.teachers).toEqual([NOAM, DANA]);
      expect(theirWay.notes).toEqual([{ code: 'entity-restored', kind: 'teacher', id: 't1', name: 'Dana' }]);
      // … and with my version nobody uses her any more.
      const myWay = merge(base, mine, theirs, { defaultResolution: 'mine' });
      expect(myWay.dataset.config.teachers).toEqual([NOAM]);
      expect(myWay.notes).toEqual([]);
    });

    it('leaves a reference alone when neither side has the entry', () => {
      const dangling = event('a', { subjectId: 'gone', locationId: 'gone', teacherIds: ['gone'], classIds: ['gone'] });
      const base = makeDataset({}, { [W1]: { events: [dangling] } });
      const mine = makeDataset({}, { [W1]: { events: [dangling, event('m', { day: 1, locationId: 'nowhere' })] } });
      const applied = merge(base, mine, base);
      expect(applied.notes).toEqual([]);
      expect(applied.dataset).toEqual(mine);
    });

    it('writes the notes list by list: subjects, locations, teachers, classes', () => {
      const base = makeDataset({ subjects: [LAB], locations: [ROOM], teachers: [DANA], classes: [CLASS_1] });
      const mine = makeDataset();
      const theirs = makeDataset(
        { subjects: [LAB], locations: [ROOM], teachers: [DANA], classes: [CLASS_1] },
        { [W1]: { events: [event('t', { classIds: ['c1'], teacherIds: ['t1'], locationId: 'l1', subjectId: 's1' })] } },
      );
      expect(merge(base, mine, theirs).notes).toEqual([
        { code: 'entity-restored', kind: 'subject', id: 's1', name: 'Lab' },
        { code: 'entity-restored', kind: 'location', id: 'l1', name: 'Room 101' },
        { code: 'entity-restored', kind: 'teacher', id: 't1', name: 'Dana' },
        { code: 'entity-restored', kind: 'class', id: 'c1', name: 'Class 1' },
      ]);
    });
  });

  describe('time grid', () => {
    it('falls back to the whole grid of the team when the combination has no room for a day', () => {
      const mine = makeDataset({ timeGrid: { dayStart: 480, dayEnd: 600, slotMinutes: 15 } });
      const theirs = makeDataset({ timeGrid: { dayStart: 720, dayEnd: 1200, slotMinutes: 30 } });
      expect(mergeDatasets(makeDataset(), mine, theirs).conflictCount).toBe(0);
      const applied = merge(makeDataset(), mine, theirs);
      // 12:00–10:00 cannot be shown, so my shorter day and my row height are both given up.
      expect(applied.dataset.config.timeGrid).toEqual({ dayStart: 720, dayEnd: 1200, slotMinutes: 30 });
      expect(applied.notes).toEqual([{ code: 'time-grid-reset' }]);
    });

    it('also counts a day that would start and end at the same minute', () => {
      const mine = makeDataset({ timeGrid: { ...GRID, dayEnd: 720 } });
      const theirs = makeDataset({ timeGrid: { ...GRID, dayStart: 720 } });
      const applied = merge(makeDataset(), mine, theirs);
      expect(applied.dataset.config.timeGrid).toEqual({ dayStart: 720, dayEnd: 1200, slotMinutes: 30 });
      expect(applied.notes).toEqual([{ code: 'time-grid-reset' }]);
    });

    it('keeps a combination that still leaves room for a day', () => {
      const mine = makeDataset({ timeGrid: { dayStart: 480, dayEnd: 1080, slotMinutes: 15 } });
      const theirs = makeDataset({ timeGrid: { ...GRID, dayStart: 420 } });
      const applied = merge(makeDataset(), mine, theirs);
      expect(applied.dataset.config.timeGrid).toEqual({ dayStart: 420, dayEnd: 1080, slotMinutes: 15 });
      expect(applied.notes).toEqual([]);
    });

    it('depends on how a conflict about one end of the day was resolved', () => {
      const mine = makeDataset({ timeGrid: { dayStart: 660, dayEnd: 700, slotMinutes: 30 } });
      const theirs = makeDataset({ timeGrid: { ...GRID, dayStart: 720 } });
      const myWay = merge(makeDataset(), mine, theirs, { defaultResolution: 'mine' });
      expect(myWay.dataset.config.timeGrid).toEqual({ dayStart: 660, dayEnd: 700, slotMinutes: 30 });
      expect(myWay.notes).toEqual([]);

      const kept = merge(makeDataset(), mine, theirs, { defaultResolution: 'aside' });
      expect(kept.dataset.config.timeGrid).toEqual({ dayStart: 720, dayEnd: 1200, slotMinutes: 30 });
      expect(kept.notes).toEqual([{ code: 'time-grid-reset' }]);
      expect(kept.aside).toEqual([aside('timeGrid.dayStart', 660, 720)]);
    });

    it('lets both ends move at once when I win both conflicts', () => {
      const mine = makeDataset({ timeGrid: { dayStart: 1260, dayEnd: 1320, slotMinutes: 30 } });
      const theirs = makeDataset({ timeGrid: { dayStart: 420, dayEnd: 1080, slotMinutes: 30 } });
      const applied = merge(makeDataset(), mine, theirs, { defaultResolution: 'mine' });
      expect(applied.dataset.config.timeGrid).toEqual({ dayStart: 1260, dayEnd: 1320, slotMinutes: 30 });
      expect(applied.notes).toEqual([]);
    });

    it('puts the note about the grid after the notes about restored entries', () => {
      const base = makeDataset({ teachers: [DANA] });
      const mine = makeDataset({ teachers: [], timeGrid: { ...GRID, dayEnd: 600 } });
      const theirs = makeDataset(
        { teachers: [DANA], timeGrid: { ...GRID, dayStart: 720 } },
        { [W1]: { events: [event('t', { teacherIds: ['t1'] })] } },
      );
      expect(merge(base, mine, theirs).notes).toEqual([
        { code: 'entity-restored', kind: 'teacher', id: 't1', name: 'Dana' },
        { code: 'time-grid-reset' },
      ]);
    });
  });

  it('does not change the datasets or the merge result it is given', () => {
    const tal = { id: 't3', name: 'Tal' };
    const mine = makeDataset(
      { ...EDITED.config, teachers: [{ id: 't1', name: 'Mine' }, NOAM, tal] },
      { [W1]: { title: 'Mine', events: [{ ...DOCKER, title: 'Mine' }, event('m', { day: 6, teacherIds: ['t3'] })] } },
    );
    const result = deepFreeze(mergeDatasets(BASE, mine, EDITED));
    const snapshot = JSON.stringify([BASE, mine, EDITED, result]);
    // Everything is deep-frozen, so a write would throw; the snapshot also catches a replaced object.
    for (const defaultResolution of RESOLUTIONS) {
      const applied = applyMerge({ mine, theirs: EDITED, result, resolutions: {}, defaultResolution, now: NOW });
      expect(applied.dataset).not.toBe(EDITED);
    }
    expect(result.conflictCount).toBeGreaterThan(0);
    expect(JSON.stringify([BASE, mine, EDITED, result])).toBe(snapshot);
  });
});

// ───────────────────────────── applyAsideItem ─────────────────────────────

describe('applyAsideItem', () => {
  const working = makeDataset(
    { teachers: [DANA, NOAM], subjects: [LAB] },
    { [W1]: { title: 'Week 12', events: [event('a', { teacherIds: ['t1'] }), event('b', { day: 2 })] } },
  );

  it('replaces the current version by mine', () => {
    const mineVersion = event('b', { day: 4, title: 'Mine' });
    const next = applyAsideItem(working, aside(eventKey(W1, 'b'), mineVersion, event('b', { day: 2 })));
    expect(next.weeks[W1].events).toEqual([event('a', { teacherIds: ['t1'] }), mineVersion]);
    expect(applyAsideItem(working, aside('subject:s1', { ...LAB, color: RED }, LAB)).config.subjects).toEqual([{ ...LAB, color: RED }]);
    expect(applyAsideItem(working, aside(weekTitleKey(W1), 'Docker week', 'Week 12')).weeks[W1].title).toBe('Docker week');
    expect(applyAsideItem(working, aside('course.endDate', '2027-01-31', null)).config.course.endDate).toBe('2027-01-31');
  });

  it('adds what the team had deleted', () => {
    const tal = { id: 't3', name: 'Tal' };
    expect(applyAsideItem(working, aside('teacher:t3', tal, undefined)).config.teachers).toEqual([DANA, NOAM, tal]);
    const mineEvent = event('m', { day: 1 });
    expect(applyAsideItem(working, aside(eventKey(W2, 'm'), mineEvent, undefined)).weeks[W2]).toEqual({
      weekStart: W2,
      title: '',
      events: [mineEvent],
    });
  });

  it('deletes what I had deleted', () => {
    const next = applyAsideItem(working, aside(eventKey(W1, 'b'), undefined, event('b', { day: 2 })));
    expect(next.weeks[W1].events).toEqual([event('a', { teacherIds: ['t1'] })]);
  });

  it('takes a list entry out of every event that uses it when my version is "deleted" (like removing it in Settings)', () => {
    const next = applyAsideItem(working, aside('teacher:t1', undefined, DANA));
    expect(next.config.teachers).toEqual([NOAM]);
    // No event may be left pointing at a teacher who is no longer in the list.
    expect(next.weeks[W1].events[0].teacherIds).toEqual([]);
    expect(countEntityUsage(next, 'teacher', 't1')).toBe(0);
  });

  it('touches nothing but its own item', () => {
    const next = applyAsideItem(working, aside('teacher:t2', { id: 't2', name: 'Noam B.' }, NOAM));
    expect(next.config.teachers).toEqual([DANA, { id: 't2', name: 'Noam B.' }]);
    expect(next.config.subjects).toBe(working.config.subjects);
    expect(next.config.course).toBe(working.config.course);
    expect(next.weeks).toBe(working.weeks);
  });

  it('returns the same dataset when my version is already there', () => {
    expect(applyAsideItem(working, aside('teacher:t1', { ...DANA }, { id: 't1', name: 'Other' }))).toBe(working);
    expect(applyAsideItem(working, aside('teacher:t9', undefined, { id: 't9', name: 'Gone' }))).toBe(working);
    expect(applyAsideItem(working, aside(weekTitleKey(W2), '', 'Holiday'))).toBe(working);
  });

  describe('time grid', () => {
    const narrow = makeDataset({ timeGrid: { dayStart: 420, dayEnd: 1080, slotMinutes: 30 } });
    const lateStart = aside('timeGrid.dayStart', 1260, 420);
    const lateEnd = aside('timeGrid.dayEnd', 1320, 1080);

    it('refuses a value that would leave no room for a day, and hands back the same dataset', () => {
      expect(applyAsideItem(narrow, lateStart)).toBe(narrow);
      expect(applyAsideItem(narrow, aside('timeGrid.dayStart', 1080, 420))).toBe(narrow);
      expect(applyAsideItem(narrow, aside('timeGrid.dayEnd', 420, 1080))).toBe(narrow);
      expect(applyAsideItem(narrow, aside('timeGrid.dayEnd', 300, 1080))).toBe(narrow);
    });

    it('accepts the same value once the other end of the day has moved', () => {
      const widened = applyAsideItem(narrow, lateEnd);
      expect(widened.config.timeGrid).toEqual({ dayStart: 420, dayEnd: 1320, slotMinutes: 30 });
      expect(applyAsideItem(widened, lateStart).config.timeGrid).toEqual({ dayStart: 1260, dayEnd: 1320, slotMinutes: 30 });
    });

    it('leaves a refused entry in the aside list', () => {
      expect(pruneAside([lateStart, lateEnd], applyAsideItem(narrow, lateStart))).toEqual([lateStart, lateEnd]);
    });

    it('does not mind the row height', () => {
      expect(applyAsideItem(narrow, aside('timeGrid.slotMinutes', 15, 30)).config.timeGrid.slotMinutes).toBe(15);
    });
  });

  it('leaves the dataset alone, without failing, when the stored entry is damaged', () => {
    const damaged = fromDisk(
      JSON.stringify([
        { key: 'room:l1', kind: 'room', id: 'l1', mine: { id: 'l1', name: 'Room' }, createdAt: NOW },
        { key: 'teacher:t1', kind: 'teacher', mine: { id: 't1', name: 'No id in the ref' } },
        { key: 'teacher:t1', kind: 'teacher', id: 't1', mine: 'Dana' },
        { key: 'teacher:t1', kind: 'teacher', id: 't1', mine: { id: 't2', name: 'Another id' } },
        { key: 'subject:s1', kind: 'subject', id: 's1', mine: { id: 's1', name: 'No colour' } },
        { key: `event:${W1}:a`, kind: 'event', id: 'a', weekStart: W1, mine: { id: 'a', title: 'Half an event' } },
        { key: `event:${W1}:a`, kind: 'event', id: 'a', mine: event('a') },
        { key: 'weekTitle:constructor', kind: 'weekTitle', weekStart: 'constructor', mine: 12 },
        { key: 'course.name', kind: 'course', field: 'name' },
        { key: 'course.name', kind: 'course', field: 'title', mine: 'Unknown field' },
        { key: 'timeGrid.slotMinutes', kind: 'timeGrid', field: 'slotMinutes', mine: 20 },
        { key: 'only a key' },
      ]),
    );
    expect(damaged).toHaveLength(12);
    for (const item of damaged) expect(applyAsideItem(working, item)).toBe(working);
    expect(() => pruneAside(damaged, working)).not.toThrow();
  });

  it('does not change the dataset or the entry it is given', () => {
    const item = deepFreeze(aside(eventKey(W1, 'a'), event('a', { day: 6 }), event('a')));
    const snapshot = JSON.stringify([working, item]);
    applyAsideItem(working, item);
    expect(JSON.stringify([working, item])).toBe(snapshot);
  });
});

// ───────────────────────────── addAsideItems ─────────────────────────────

describe('addAsideItems', () => {
  const teacher = aside('teacher:t1', DANA, undefined);
  const lesson = aside(eventKey(W1, 'e1'), event('e1'), event('e1', { day: 1 }));
  const course = aside('course.name', 'Mine', 'Theirs');

  it('appends new entries after the existing ones', () => {
    expect(addAsideItems([teacher], [lesson, course])).toEqual([teacher, lesson, course]);
    expect(addAsideItems([], [lesson, course])).toEqual([lesson, course]);
  });

  it('replaces an entry of the same key where it stands: the newest wins', () => {
    const newer = aside('teacher:t1', { id: 't1', name: 'Dana L.' }, { id: 't1', name: 'Dana Levi' }, LATER);
    const merged = addAsideItems([teacher, lesson], [course, newer]);
    expect(merged).toEqual([newer, lesson, course]);
    expect(merged[0]).toBe(newer);
  });

  it('keeps only the last one when the added entries repeat a key', () => {
    const first = aside('course.name', 'First', 'Theirs');
    const last = aside('course.name', 'Last', 'Theirs', LATER);
    expect(addAsideItems([teacher], [first, lesson, last])).toEqual([teacher, last, lesson]);
  });

  it('tells keys of different items apart, also when they share an id', () => {
    const sameIdOtherWeek = aside(eventKey(W2, 'e1'), event('e1'), undefined);
    const sameIdOtherList = aside('class:t1', { id: 't1', name: 'A class' }, undefined);
    expect(addAsideItems([teacher, lesson], [sameIdOtherWeek, sameIdOtherList])).toEqual([
      teacher,
      lesson,
      sameIdOtherWeek,
      sameIdOtherList,
    ]);
  });

  it('gives back the existing entries when nothing is added, and nothing for nothing', () => {
    expect(addAsideItems([teacher, lesson], [])).toEqual([teacher, lesson]);
    expect(addAsideItems([], [])).toEqual([]);
  });

  it('always returns a new list and leaves both inputs alone', () => {
    const existing = deepFreeze([teacher, lesson]);
    const added = deepFreeze([course]);
    const merged = addAsideItems(existing, added);
    expect(merged).not.toBe(existing);
    expect(addAsideItems(existing, [])).not.toBe(existing);
    expect(existing).toEqual([teacher, lesson]);
    expect(added).toEqual([course]);
  });

  it('collects what several merges set aside', () => {
    const base = makeDataset({ teachers: [DANA] }, { [W1]: { events: [event('e1')] } });
    const mine = makeDataset({ teachers: [{ id: 't1', name: 'Dana L.' }] }, { [W1]: { events: [event('e1', { title: 'Mine' })] } });
    const theirs = makeDataset({ teachers: [{ id: 't1', name: 'Dana Levi' }] }, { [W1]: { events: [event('e1', { title: 'Theirs' })] } });
    const first = merge(base, mine, theirs, { defaultResolution: 'aside' });
    const kept = addAsideItems([], first.aside);
    expect(kept.map((item) => item.key)).toEqual(['teacher:t1', eventKey(W1, 'e1')]);

    // Later the event collides again: I edited the merged copy, and so did the team.
    const mineAgain = makeDataset({ teachers: [{ id: 't1', name: 'Dana Levi' }] }, { [W1]: { events: [event('e1', { title: 'Mine again' })] } });
    const theirsAgain = makeDataset({ teachers: [{ id: 't1', name: 'Dana Levi' }] }, { [W1]: { events: [event('e1', { title: 'Theirs again' })] } });
    const second = applyMerge({
      mine: mineAgain,
      theirs: theirsAgain,
      result: mergeDatasets(first.dataset, mineAgain, theirsAgain),
      resolutions: {},
      defaultResolution: 'aside',
      now: LATER,
    });
    const both = addAsideItems(kept, second.aside);
    expect(both.map((item) => [item.key, item.createdAt])).toEqual([
      ['teacher:t1', NOW],
      [eventKey(W1, 'e1'), LATER],
    ]);
    expect(both[1].mine).toEqual(event('e1', { title: 'Mine again' }));
  });
});

// ───────────────────────────── pruneAside ─────────────────────────────

describe('pruneAside', () => {
  const working = makeDataset(
    { course: { ...COURSE, name: 'Mine' }, teachers: [{ id: 't1', name: 'Dana L.' }], subjects: [LAB] },
    { [W1]: { title: 'Docker week', events: [event('e1', { title: 'Mine', teacherIds: ['t1'] })] } },
  );

  const SETTLED: [what: string, item: AsideItem][] = [
    ['an event', aside(eventKey(W1, 'e1'), event('e1', { title: 'Mine', teacherIds: ['t1'] }), event('e1'))],
    ['a list entry', aside('teacher:t1', { id: 't1', name: 'Dana L.' }, DANA)],
    ['a subject', aside('subject:s1', { ...LAB }, { ...LAB, color: RED })],
    ['a week title', aside(weekTitleKey(W1), 'Docker week', 'Week 12')],
    ['a setting', aside('course.name', 'Mine', 'Theirs')],
    ['a cleared date', aside('course.endDate', null, '2027-01-31')],
    ['an event I had deleted', aside(eventKey(W1, 'gone'), undefined, event('gone'))],
    ['a list entry I had deleted', aside('location:l1', undefined, ROOM)],
    ['the title of a week that does not exist, which I had left empty', aside(weekTitleKey(W3), '', 'Holiday')],
  ];

  it.each(SETTLED)('drops %s once the working copy has my version', (_what, item) => {
    expect(pruneAside([item], working)).toEqual([]);
  });

  const PENDING: [what: string, item: AsideItem][] = [
    ['an event that differs in one field', aside(eventKey(W1, 'e1'), event('e1', { title: 'Mine' }), event('e1'))],
    ['an event of the same id in another week', aside(eventKey(W2, 'e1'), event('e1', { title: 'Mine', teacherIds: ['t1'] }), undefined)],
    ['a list entry with another name', aside('teacher:t1', DANA, { id: 't1', name: 'Dana Levi' })],
    ['a subject with another colour', aside('subject:s1', { ...LAB, color: RED }, LAB)],
    ['a week title', aside(weekTitleKey(W1), 'Week 12', 'Docker week')],
    ['a setting', aside('timeGrid.dayStart', 420, 480)],
    ['an event I had deleted but that is still there', aside(eventKey(W1, 'e1'), undefined, event('e1'))],
    ['a list entry I had deleted but that is still there', aside('teacher:t1', undefined, DANA)],
    ['a list entry of mine that is not there', aside('location:l1', ROOM, undefined)],
  ];

  it.each(PENDING)('keeps %s', (_what, item) => {
    expect(pruneAside([item], working)).toEqual([item]);
  });

  it('keeps the remaining entries in their order and returns a new list', () => {
    const items = deepFreeze([PENDING[0][1], SETTLED[0][1], PENDING[1][1], SETTLED[1][1], PENDING[2][1]]);
    const pruned = pruneAside(items, working);
    expect(pruned).toEqual([PENDING[0][1], PENDING[1][1], PENDING[2][1]]);
    expect(pruned[0]).toBe(items[0]);
    expect(pruneAside(pruned, working)).not.toBe(pruned);
    expect(pruneAside([], working)).toEqual([]);
  });

  it('judges entries from the aside file like fresh ones', () => {
    const fresh = [...SETTLED, ...PENDING].map(([, item]) => item);
    expect(pruneAside(reloaded(fresh), working)).toEqual(reloaded(PENDING.map(([, item]) => item)));
  });

  it('does not change the dataset or the list it is given', () => {
    const items = deepFreeze(PENDING.map(([, item]) => item));
    const snapshot = JSON.stringify([working, items]);
    pruneAside(items, working);
    expect(JSON.stringify([working, items])).toBe(snapshot);
  });
});
