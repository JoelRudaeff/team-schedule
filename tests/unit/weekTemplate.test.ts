import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SUBJECT_COLORS } from '@shared/colors';
import { DataFormatError, type Dataset, type IsoDate, type ScheduleEvent } from '@shared/types';
import {
  WEEK_TEMPLATE_EXTENSION,
  WEEK_TEMPLATE_TYPE,
  copyWeek,
  exportWeekTemplate,
  importWeekTemplate,
  parseWeekTemplate,
  serializeWeekTemplate,
  type CopyWeekOptions,
  type ImportWeekOptions,
  type ImportWeekResult,
  type TemplateEvent,
  type WeekTemplate,
} from '@shared/weekTemplate';

// ───────────────────────────── fixtures ─────────────────────────────

/** Three consecutive Sundays. */
const SOURCE = '2026-11-22';
const TARGET = '2026-11-29';
const LATER = '2026-12-06';

const EXPORTED_AT = '2026-11-21T10:15:00.000Z';

const NOTHING_CREATED = { subjects: 0, locations: 0, teachers: 0, classes: 0 };

/**
 * Frozen all the way down: a function that modified one of its inputs would throw a
 * TypeError, so every test in this file also checks that inputs are left alone.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value) as unknown[]) deepFreeze(child);
  }
  return value;
}

function scheduleEvent(overrides: Partial<ScheduleEvent> & { id: string }): ScheduleEvent {
  return {
    day: 0,
    start: 540,
    end: 600,
    title: '',
    subjectId: null,
    locationId: null,
    teacherIds: [],
    classIds: [],
    notes: '',
    ...overrides,
  };
}

const DOCKER = scheduleEvent({
  id: 'q1w2e3r4t5',
  day: 0,
  start: 540,
  end: 630,
  title: 'Docker basics',
  subjectId: 's-lab',
  locationId: 'l-101',
  teacherIds: ['t-dana', 't-yossi'],
  classIds: ['c-1'],
  notes: 'Bring a laptop',
});

const NETWORKS = scheduleEvent({
  id: 'z9y8x7w6v5',
  day: 2,
  start: 780,
  end: 840,
  title: 'מבוא לרשתות',
  subjectId: 's-lecture',
  locationId: 'l-lab',
  teacherIds: ['t-yossi'],
  classIds: ['c-1', 'c-2'],
});

/** Nothing but a time, and it ends at midnight. */
const LATE = scheduleEvent({ id: 'm5n6b7v8c9', day: 6, start: 1320, end: 1440 });

type WeekInput = { title?: string; events: ScheduleEvent[] };

const SOURCE_WEEK: WeekInput = { title: 'Week 12 - Docker', events: [DOCKER, NETWORKS, LATE] };

/** A schedule with two entries in every list and the given weeks (by default only the source week). */
function schedule(weeks: Record<IsoDate, WeekInput> = { [SOURCE]: SOURCE_WEEK }): Dataset {
  const dataset: Dataset = {
    config: {
      course: { name: 'DevOps 2026', startDate: '2026-09-06', endDate: null },
      timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
      subjects: [
        { id: 's-lab', name: 'Lab', color: '#16A34A' },
        { id: 's-lecture', name: 'הרצאה', color: '#2563EB' },
      ],
      locations: [
        { id: 'l-101', name: 'Room 101' },
        { id: 'l-lab', name: 'מעבדה 2' },
      ],
      teachers: [
        { id: 't-dana', name: 'Dana' },
        { id: 't-yossi', name: 'יוסי' },
      ],
      classes: [
        { id: 'c-1', name: 'Class 1' },
        { id: 'c-2', name: 'Class 2' },
      ],
    },
    weeks: Object.fromEntries(
      Object.entries(weeks).map(([weekStart, week]) => [
        weekStart,
        { weekStart, title: week.title ?? '', events: week.events },
      ]),
    ),
  };
  return deepFreeze(dataset);
}

/** What the source week of `schedule()` looks like as a week file. */
const SOURCE_TEMPLATE: WeekTemplate = deepFreeze({
  type: 'team-schedule-week',
  formatVersion: 1,
  exportedAt: EXPORTED_AT,
  sourceWeek: SOURCE,
  title: 'Week 12 - Docker',
  events: [
    {
      day: 0,
      start: '09:00',
      end: '10:30',
      title: 'Docker basics',
      notes: 'Bring a laptop',
      subject: { id: 's-lab', name: 'Lab', color: '#16A34A' },
      location: { id: 'l-101', name: 'Room 101' },
      teachers: [
        { id: 't-dana', name: 'Dana' },
        { id: 't-yossi', name: 'יוסי' },
      ],
      classes: [{ id: 'c-1', name: 'Class 1' }],
    },
    {
      day: 2,
      start: '13:00',
      end: '14:00',
      title: 'מבוא לרשתות',
      notes: '',
      subject: { id: 's-lecture', name: 'הרצאה', color: '#2563EB' },
      location: { id: 'l-lab', name: 'מעבדה 2' },
      teachers: [{ id: 't-yossi', name: 'יוסי' }],
      classes: [
        { id: 'c-1', name: 'Class 1' },
        { id: 'c-2', name: 'Class 2' },
      ],
    },
    {
      day: 6,
      start: '22:00',
      end: '24:00',
      title: '',
      notes: '',
      subject: null,
      location: null,
      teachers: [],
      classes: [],
    },
  ],
});

function templateEvent(overrides: Partial<TemplateEvent> = {}): TemplateEvent {
  return {
    day: 1,
    start: '09:00',
    end: '10:00',
    title: 'Imported',
    notes: '',
    subject: null,
    location: null,
    teachers: [],
    classes: [],
    ...overrides,
  };
}

function template(events: TemplateEvent[], title = ''): WeekTemplate {
  const built: WeekTemplate = {
    type: WEEK_TEMPLATE_TYPE,
    formatVersion: 1,
    exportedAt: EXPORTED_AT,
    sourceWeek: SOURCE,
    title,
    events,
  };
  return deepFreeze(built);
}

/** "n1", "n2", … in the order they are asked for. */
function idSequence(): () => string {
  let count = 0;
  return () => `n${++count}`;
}

/** Hands out exactly the given ids, in order. */
function idsFrom(...ids: string[]): () => string {
  const queue = [...ids];
  return () => {
    const id = queue.shift();
    if (id === undefined) throw new Error('More ids were asked for than this test expects');
    return id;
  };
}

function importInto(
  dataset: Dataset,
  source: WeekTemplate,
  options: Partial<ImportWeekOptions> = {},
  newId: () => string = idSequence(),
): ImportWeekResult {
  return importWeekTemplate(dataset, source, { targetWeek: TARGET, mode: 'add', applyTitle: false, ...options }, newId);
}

function repeat(dataset: Dataset, options: Partial<CopyWeekOptions> = {}, newId: () => string = idSequence()): Dataset {
  return copyWeek(dataset, { sourceWeek: SOURCE, targetWeeks: [TARGET], mode: 'add', copyTitle: false, ...options }, newId);
}

function eventsOf(dataset: Dataset, weekStart: IsoDate): ScheduleEvent[] {
  return dataset.weeks[weekStart]?.events ?? [];
}

// ───────────────────────────── export ─────────────────────────────

describe('week file constants', () => {
  it('match the documented file', () => {
    expect(WEEK_TEMPLATE_TYPE).toBe('team-schedule-week');
    // Used both as the file name ending and as the dialog filter, so it carries no leading dot.
    expect(WEEK_TEMPLATE_EXTENSION).toBe('week.json');
  });
});

describe('exportWeekTemplate', () => {
  it('takes a snapshot of the week that carries the names of everything it refers to', () => {
    expect(exportWeekTemplate(schedule(), SOURCE, EXPORTED_AT)).toStrictEqual(SOURCE_TEMPLATE);
  });

  it('keeps the events in the order of the week', () => {
    const exported = exportWeekTemplate(schedule(), SOURCE, EXPORTED_AT);
    expect(exported.events.map((event) => [event.day, event.start])).toEqual([
      [0, '09:00'],
      [2, '13:00'],
      [6, '22:00'],
    ]);
  });

  it('exports only the events the filter lets through, and still the title', () => {
    const include = vi.fn((event: ScheduleEvent) => event.locationId !== 'l-lab');

    const exported = exportWeekTemplate(schedule(), SOURCE, EXPORTED_AT, include);

    expect(exported.title).toBe('Week 12 - Docker');
    expect(exported.events).toStrictEqual([SOURCE_TEMPLATE.events[0], SOURCE_TEMPLATE.events[2]]);
    // Every event is offered exactly once, and nothing but the event is passed along.
    expect(include.mock.calls).toEqual([[DOCKER], [NETWORKS], [LATE]]);
  });

  it('exports a week without events when the filter matches nothing', () => {
    const exported = exportWeekTemplate(schedule(), SOURCE, EXPORTED_AT, () => false);
    expect(exported).toStrictEqual({ ...SOURCE_TEMPLATE, events: [] });
  });

  it('exports references to deleted entries as null and leaves them out of the lists', () => {
    const orphan = scheduleEvent({
      id: 'orphan',
      title: 'Orphan',
      subjectId: 'deleted-subject',
      locationId: 'deleted-location',
      teacherIds: ['deleted-teacher', 't-dana'],
      classIds: ['deleted-class'],
    });

    const exported = exportWeekTemplate(schedule({ [SOURCE]: { events: [orphan] } }), SOURCE, EXPORTED_AT);

    expect(exported.events).toStrictEqual([
      {
        day: 0,
        start: '09:00',
        end: '10:00',
        title: 'Orphan',
        notes: '',
        subject: null,
        location: null,
        teachers: [{ id: 't-dana', name: 'Dana' }],
        classes: [],
      },
    ]);
  });

  it('exports an empty week for a week the schedule does not have', () => {
    expect(exportWeekTemplate(schedule(), LATER, EXPORTED_AT)).toStrictEqual({
      type: 'team-schedule-week',
      formatVersion: 1,
      exportedAt: EXPORTED_AT,
      sourceWeek: LATER,
      title: '',
      events: [],
    });
  });

  it('exports a week that only has a title', () => {
    const exported = exportWeekTemplate(schedule({ [SOURCE]: { title: 'חופשת חנוכה', events: [] } }), SOURCE, EXPORTED_AT);
    expect(exported.title).toBe('חופשת חנוכה');
    expect(exported.events).toEqual([]);
  });

  it('writes any minute of the day as HH:MM', () => {
    const odd = scheduleEvent({ id: 'odd', start: 7, end: 1439 });
    const [exported] = exportWeekTemplate(schedule({ [SOURCE]: { events: [odd] } }), SOURCE, EXPORTED_AT).events;
    expect([exported.start, exported.end]).toEqual(['00:07', '23:59']);
  });
});

// ───────────────────────────── the file text ─────────────────────────────

const SOURCE_FILE_TEXT = `{
  "type": "team-schedule-week",
  "formatVersion": 1,
  "exportedAt": "2026-11-21T10:15:00.000Z",
  "sourceWeek": "2026-11-22",
  "title": "Week 12 - Docker",
  "events": [
    {
      "day": 0,
      "start": "09:00",
      "end": "10:30",
      "title": "Docker basics",
      "notes": "Bring a laptop",
      "subject": {
        "id": "s-lab",
        "name": "Lab",
        "color": "#16A34A"
      },
      "location": {
        "id": "l-101",
        "name": "Room 101"
      },
      "teachers": [
        {
          "id": "t-dana",
          "name": "Dana"
        },
        {
          "id": "t-yossi",
          "name": "יוסי"
        }
      ],
      "classes": [
        {
          "id": "c-1",
          "name": "Class 1"
        }
      ]
    },
    {
      "day": 2,
      "start": "13:00",
      "end": "14:00",
      "title": "מבוא לרשתות",
      "notes": "",
      "subject": {
        "id": "s-lecture",
        "name": "הרצאה",
        "color": "#2563EB"
      },
      "location": {
        "id": "l-lab",
        "name": "מעבדה 2"
      },
      "teachers": [
        {
          "id": "t-yossi",
          "name": "יוסי"
        }
      ],
      "classes": [
        {
          "id": "c-1",
          "name": "Class 1"
        },
        {
          "id": "c-2",
          "name": "Class 2"
        }
      ]
    },
    {
      "day": 6,
      "start": "22:00",
      "end": "24:00",
      "title": "",
      "notes": "",
      "subject": null,
      "location": null,
      "teachers": [],
      "classes": []
    }
  ]
}
`;

describe('serializeWeekTemplate', () => {
  it('writes pretty-printed JSON with the documented keys in the documented order', () => {
    expect(serializeWeekTemplate(SOURCE_TEMPLATE)).toBe(SOURCE_FILE_TEXT);
  });

  it('uses "\\n" line ends, ends with a newline and keeps Hebrew readable', () => {
    const text = serializeWeekTemplate(SOURCE_TEMPLATE);
    expect(text).not.toContain('\r');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).toContain('"מבוא לרשתות"');
    expect(text).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  });

  it('writes a week without events', () => {
    const empty = template([], 'Holiday');
    expect(serializeWeekTemplate(empty)).toBe(
      '{\n' +
        '  "type": "team-schedule-week",\n' +
        '  "formatVersion": 1,\n' +
        '  "exportedAt": "2026-11-21T10:15:00.000Z",\n' +
        '  "sourceWeek": "2026-11-22",\n' +
        '  "title": "Holiday",\n' +
        '  "events": []\n' +
        '}\n',
    );
  });

  it('writes the same text whatever order the keys of the object are in, and no key it does not know', () => {
    const shuffled = JSON.parse(
      JSON.stringify({
        events: SOURCE_TEMPLATE.events.map((event) => ({
          id: 'an event id must never reach a week file',
          classes: event.classes.map((ref) => ({ name: ref.name, id: ref.id, extra: true })),
          teachers: event.teachers.map((ref) => ({ name: ref.name, id: ref.id })),
          location: event.location && { name: event.location.name, id: event.location.id },
          subject: event.subject && {
            color: event.subject.color,
            usage: 12,
            name: event.subject.name,
            id: event.subject.id,
          },
          notes: event.notes,
          title: event.title,
          end: event.end,
          start: event.start,
          day: event.day,
        })),
        comment: 'not part of the format',
        title: SOURCE_TEMPLATE.title,
        sourceWeek: SOURCE_TEMPLATE.sourceWeek,
        exportedAt: SOURCE_TEMPLATE.exportedAt,
        formatVersion: 1,
        type: 'team-schedule-week',
      }),
    ) as WeekTemplate;

    expect(serializeWeekTemplate(shuffled)).toBe(SOURCE_FILE_TEXT);
  });

  it('escapes what JSON has to escape', () => {
    const tricky = template([templateEvent({ title: 'He said "hi" \\ bye', notes: 'line 1\nline 2\ttabbed' })]);
    const text = serializeWeekTemplate(tricky);
    expect(text).toContain('"title": "He said \\"hi\\" \\\\ bye"');
    expect(text).toContain('"notes": "line 1\\nline 2\\ttabbed"');
    expect(parseWeekTemplate(text)).toStrictEqual(tricky);
  });
});

describe('export → serialize → parse', () => {
  it('gives back the exported week unchanged', () => {
    const exported = exportWeekTemplate(schedule(), SOURCE, EXPORTED_AT);
    expect(parseWeekTemplate(serializeWeekTemplate(exported))).toStrictEqual(exported);
  });

  it('is stable: writing the parsed file again gives the same text', () => {
    const text = serializeWeekTemplate(exportWeekTemplate(schedule(), SOURCE, EXPORTED_AT));
    expect(serializeWeekTemplate(parseWeekTemplate(text))).toBe(text);
  });

  it('round-trips an empty week, a filtered week and a week with deleted references', () => {
    const orphan = scheduleEvent({ id: 'orphan', subjectId: 'deleted', teacherIds: ['deleted', 't-yossi'] });
    const dataset = schedule({ [SOURCE]: SOURCE_WEEK, [TARGET]: { events: [orphan] } });
    const exports = [
      exportWeekTemplate(dataset, LATER, EXPORTED_AT),
      exportWeekTemplate(dataset, SOURCE, EXPORTED_AT, (event) => event.day === 2),
      exportWeekTemplate(dataset, TARGET, EXPORTED_AT),
    ];
    for (const exported of exports) {
      expect(parseWeekTemplate(serializeWeekTemplate(exported))).toStrictEqual(exported);
    }
  });
});

// ───────────────────────────── parse ─────────────────────────────

const FILE_EVENT = {
  day: 0,
  start: '09:00',
  end: '10:30',
  title: 'Docker basics',
  notes: 'Bring a laptop',
  subject: { id: 's1', name: 'Lab', color: '#16A34A' },
  location: { id: 'l1', name: 'Room 101' },
  teachers: [{ id: 't1', name: 'Dana' }],
  classes: [{ id: 'c1', name: 'Class 1' }],
};

/** A valid week file with one event; a key set to `undefined` is left out of the file. */
function weekFile(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'team-schedule-week',
    formatVersion: 1,
    exportedAt: EXPORTED_AT,
    sourceWeek: SOURCE,
    title: 'Week 12',
    events: [FILE_EVENT],
    ...patch,
  });
}

function weekFileWithEvent(patch: Record<string, unknown>): string {
  return weekFile({ events: [{ ...FILE_EVENT, ...patch }] });
}

/** The DataFormatError the parser answers with; any other outcome fails the test. */
function rejection(text: string): DataFormatError {
  try {
    parseWeekTemplate(text);
  } catch (error) {
    if (error instanceof DataFormatError) return error;
    throw error;
  }
  throw new Error('parseWeekTemplate accepted the text');
}

describe('parseWeekTemplate', () => {
  it('reads a week file', () => {
    expect(parseWeekTemplate(SOURCE_FILE_TEXT)).toStrictEqual(SOURCE_TEMPLATE);
  });

  describe('rejects as invalid', () => {
    it.each<[string, string]>([
      ['an empty file', ''],
      ['text that is not JSON', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'],
      ['JSON that is cut off', weekFile().slice(0, -10)],
      ['a list', '[]'],
      ['a number', '42'],
      ['a text', '"team-schedule-week"'],
      ['null', 'null'],
      ['an object without a type', weekFile({ type: undefined })],
      ['another type', weekFile({ type: 'team-schedule-settings' })],
      ['the type in another case', weekFile({ type: 'Team-Schedule-Week' })],
      ['a type that is not a text', weekFile({ type: 1 })],
      ['a week file of the repository', '{"formatVersion":1,"weekStart":"2026-11-22","title":"","events":[]}'],
    ])('%s', (_name, text) => {
      const error = rejection(text);
      expect(error.code).toBe('invalid');
      expect(error.name).toBe('DataFormatError');
      expect(error.message).not.toBe('');
    });

    it.each<[string, unknown]>([
      ['zero', 0],
      ['a negative number', -1],
      ['a fraction below 1', 0.5],
      ['a text', '1'],
      ['null', null],
      ['a list', [1]],
    ])('a formatVersion that is %s', (_name, formatVersion) => {
      expect(rejection(weekFile({ formatVersion })).code).toBe('invalid');
    });

    it.each<[string, unknown]>([
      ['is missing', undefined],
      ['is null', null],
      ['is a number', 20261122],
      ['is not a date', 'next week'],
      ['is written day first', '22-11-2026'],
      ['is written without leading zeros', '2026-11-5'],
      ['carries a time', '2026-11-22T00:00:00.000Z'],
      ['is a day that does not exist', '2026-02-30'],
      ['is 29 February of a common year', '2027-02-29'],
    ])('a sourceWeek that %s', (_name, sourceWeek) => {
      const error = rejection(weekFile({ sourceWeek }));
      expect(error.code).toBe('invalid');
      expect(error.message).toContain('sourceWeek');
    });

    it.each<[string, Record<string, unknown>]>([
      ['exportedAt that is a number', { exportedAt: 1795256100000 }],
      ['exportedAt that is null', { exportedAt: null }],
      ['title that is a number', { title: 12 }],
      ['title that is null', { title: null }],
      ['title that is an object', { title: { text: 'Week 12' } }],
      ['events that are an object', { events: { 0: FILE_EVENT } }],
      ['events that are a text', { events: 'none' }],
      ['events that are null', { events: null }],
      ['an event that is null', { events: [null] }],
      ['an event that is a text', { events: ['Docker basics'] }],
      ['an event that is a list', { events: [[FILE_EVENT]] }],
    ])('%s', (_name, patch) => {
      expect(rejection(weekFile(patch)).code).toBe('invalid');
    });

    it.each<[string, Record<string, unknown>]>([
      ['no day', { day: undefined }],
      ['day 7', { day: 7 }],
      ['day -1', { day: -1 }],
      ['half a day', { day: 1.5 }],
      ['a day written as text', { day: '0' }],
      ['a day that is null', { day: null }],
      ['no start', { start: undefined }],
      ['no end', { end: undefined }],
      ['a start in minutes', { start: 540 }],
      ['an end in minutes', { end: 630 }],
      ['a start that is not a time', { start: 'morning' }],
      ['an end that is not a time', { end: 'noon' }],
      ['an empty start', { start: '' }],
      ['a start without minutes', { start: '9' }],
      ['an end with seconds', { end: '10:30:00' }],
      ['an end with 60 minutes', { end: '10:60' }],
      ['an end after 24:00', { end: '24:01' }],
      ['an end at 25:00', { end: '25:00' }],
      ['a start at 24:00', { start: '24:00', end: '24:00' }],
      ['an end equal to the start', { start: '09:00', end: '09:00' }],
      ['an end before the start', { start: '10:30', end: '09:00' }],
      ['a title that is a number', { title: 5 }],
      ['a title that is null', { title: null }],
      ['notes that are a list', { notes: ['Bring a laptop'] }],
      ['notes that are null', { notes: null }],
    ])('an event with %s', (_name, patch) => {
      const error = rejection(weekFileWithEvent(patch));
      expect(error.code).toBe('invalid');
      expect(error.message).toContain('events[0]');
    });

    it.each<[string, Record<string, unknown>]>([
      ['a subject that is only a name', { subject: 'Lab' }],
      ['a subject that is a list', { subject: [{ id: 's1', name: 'Lab', color: '#16A34A' }] }],
      ['a subject without an id', { subject: { name: 'Lab', color: '#16A34A' } }],
      ['a subject whose id is a number', { subject: { id: 7, name: 'Lab', color: '#16A34A' } }],
      ['a subject without a name', { subject: { id: 's1', color: '#16A34A' } }],
      ['a subject whose name is null', { subject: { id: 's1', name: null, color: '#16A34A' } }],
      ['a subject without a colour', { subject: { id: 's1', name: 'Lab' } }],
      ['a subject with a colour name', { subject: { id: 's1', name: 'Lab', color: 'green' } }],
      ['a subject with a colour of five digits', { subject: { id: 's1', name: 'Lab', color: '#16A34' } }],
      ['a subject whose colour is a number', { subject: { id: 's1', name: 'Lab', color: 1483594 } }],
      ['a location that is only a name', { location: 'Room 101' }],
      ['a location that is a list', { location: [] }],
      ['a location without an id', { location: { name: 'Room 101' } }],
      ['a location whose id is null', { location: { id: null, name: 'Room 101' } }],
      ['a location without a name', { location: { id: 'l1' } }],
      ['teachers that are a single object', { teachers: { id: 't1', name: 'Dana' } }],
      ['teachers that are a text', { teachers: 'Dana' }],
      ['teachers that are null', { teachers: null }],
      ['a teacher that is only a name', { teachers: ['Dana'] }],
      ['a teacher that is null', { teachers: [null] }],
      ['a teacher without an id', { teachers: [{ name: 'Dana' }] }],
      ['a teacher whose id is a number', { teachers: [{ id: 1, name: 'Dana' }] }],
      ['a teacher without a name', { teachers: [{ id: 't1' }] }],
      ['classes that are a single object', { classes: { id: 'c1', name: 'Class 1' } }],
      ['classes that are null', { classes: null }],
      ['a class that is only an id', { classes: ['c1'] }],
      ['a class without a name', { classes: [{ id: 'c1' }] }],
      ['a class whose name is a number', { classes: [{ id: 'c1', name: 1 }] }],
    ])('an event with %s', (_name, patch) => {
      expect(rejection(weekFileWithEvent(patch)).code).toBe('invalid');
    });

    it('and says which event and which key is wrong', () => {
      const second = { ...FILE_EVENT, end: '08:00' };
      expect(rejection(weekFile({ events: [FILE_EVENT, second] })).message).toContain('events[1]');
      expect(rejection(weekFile({ events: [FILE_EVENT, { ...FILE_EVENT, start: '9h' }] })).message).toContain(
        'events[1].start',
      );
      expect(rejection(weekFileWithEvent({ teachers: [{ id: 't1', name: 'Dana' }, { id: 't2' }] })).message).toContain(
        'events[0].teachers[1]',
      );
      expect(rejection(weekFileWithEvent({ subject: { id: 's1', name: 'Lab', color: 'green' } })).message).toContain(
        'events[0].subject.color',
      );
    });
  });

  describe('rejects as written by a newer version', () => {
    it.each([2, 3, 99, 1.5])('formatVersion %s', (formatVersion) => {
      const error = rejection(weekFile({ formatVersion }));
      expect(error.code).toBe('newer-version');
      expect(error.message).toContain(String(formatVersion));
    });

    it('before looking at the content, which a newer version may lay out differently', () => {
      const text = '{"type":"team-schedule-week","formatVersion":2,"weeks":[{"start":"2026-11-22","items":"…"}]}';
      expect(rejection(text).code).toBe('newer-version');
      expect(rejection(weekFile({ formatVersion: 2, sourceWeek: 'unknown', events: 'moved' })).code).toBe(
        'newer-version',
      );
    });

    it('but only when the file is a week file at all', () => {
      expect(rejection('{"type":"something-else","formatVersion":2}').code).toBe('invalid');
    });
  });

  describe('tolerates', () => {
    it('a byte order mark', () => {
      expect(parseWeekTemplate(`﻿${SOURCE_FILE_TEXT}`)).toStrictEqual(SOURCE_TEMPLATE);
    });

    it('Windows line ends', () => {
      expect(parseWeekTemplate(SOURCE_FILE_TEXT.replace(/\n/g, '\r\n'))).toStrictEqual(SOURCE_TEMPLATE);
    });

    it('a byte order mark and Windows line ends together, as Notepad writes them', () => {
      expect(parseWeekTemplate(`﻿${SOURCE_FILE_TEXT.replace(/\n/g, '\r\n')}`)).toStrictEqual(SOURCE_TEMPLATE);
    });

    it('any JSON layout', () => {
      expect(parseWeekTemplate(JSON.stringify(SOURCE_TEMPLATE))).toStrictEqual(SOURCE_TEMPLATE);
      expect(parseWeekTemplate(JSON.stringify(SOURCE_TEMPLATE, null, '\t'))).toStrictEqual(SOURCE_TEMPLATE);
    });

    it('unknown keys, and does not pass them on', () => {
      const text = JSON.stringify({
        ...SOURCE_TEMPLATE,
        comment: 'copied from last year',
        exportedBy: { name: 'Dana' },
        events: SOURCE_TEMPLATE.events.map((event) => ({
          ...event,
          id: 'q1w2e3r4t5',
          colour: 'blue',
          subject: event.subject && { ...event.subject, usage: 3 },
          location: event.location && { ...event.location, floor: 2 },
          teachers: event.teachers.map((ref) => ({ ...ref, email: 'someone@example.com' })),
          classes: event.classes.map((ref) => ({ ...ref, size: 24 })),
        })),
      });
      expect(parseWeekTemplate(text)).toStrictEqual(SOURCE_TEMPLATE);
    });

    it('a file that holds nothing but its type and its week', () => {
      expect(parseWeekTemplate('{"type":"team-schedule-week","sourceWeek":"2026-11-22"}')).toStrictEqual({
        type: 'team-schedule-week',
        formatVersion: 1,
        exportedAt: '',
        sourceWeek: '2026-11-22',
        title: '',
        events: [],
      });
    });

    it('an event that holds nothing but a day and its times', () => {
      const parsed = parseWeekTemplate(weekFile({ events: [{ day: 3, start: '13:00', end: '13:45' }] }));
      expect(parsed.events).toStrictEqual([
        {
          day: 3,
          start: '13:00',
          end: '13:45',
          title: '',
          notes: '',
          subject: null,
          location: null,
          teachers: [],
          classes: [],
        },
      ]);
    });

    it('a subject and a location that are null', () => {
      const [event] = parseWeekTemplate(weekFileWithEvent({ subject: null, location: null })).events;
      expect(event.subject).toBeNull();
      expect(event.location).toBeNull();
    });

    it('times without a leading zero, and writes them as HH:MM', () => {
      const [event] = parseWeekTemplate(weekFileWithEvent({ start: '9:00', end: '9:05' })).events;
      expect([event.start, event.end]).toEqual(['09:00', '09:05']);
    });

    it('any minute of the day, from 00:00 to 24:00', () => {
      const [odd] = parseWeekTemplate(weekFileWithEvent({ start: '00:00', end: '00:01' })).events;
      const [whole] = parseWeekTemplate(weekFileWithEvent({ start: '0:00', end: '24:00' })).events;
      const [late] = parseWeekTemplate(weekFileWithEvent({ start: '23:59', end: '24:00' })).events;
      expect([odd.start, odd.end]).toEqual(['00:00', '00:01']);
      expect([whole.start, whole.end]).toEqual(['00:00', '24:00']);
      expect([late.start, late.end]).toEqual(['23:59', '24:00']);
    });

    it.each([
      ['#16a34a', '#16A34A'],
      ['16A34A', '#16A34A'],
      ['#abc', '#AABBCC'],
      ['FFF', '#FFFFFF'],
    ])('the subject colour %s, and gives it back as %s', (color, expected) => {
      const [event] = parseWeekTemplate(weekFileWithEvent({ subject: { id: 's1', name: 'Lab', color } })).events;
      expect(event.subject).toStrictEqual({ id: 's1', name: 'Lab', color: expected });
    });

    it('a reference without an id (the import gives such an entry a new one)', () => {
      const [event] = parseWeekTemplate(
        weekFileWithEvent({ location: { id: '', name: 'Room 101' }, teachers: [{ id: '', name: 'Dana' }] }),
      ).events;
      expect(event.location).toStrictEqual({ id: '', name: 'Room 101' });
      expect(event.teachers).toStrictEqual([{ id: '', name: 'Dana' }]);
    });

    it('an exportedAt that is not a timestamp (it is only information)', () => {
      expect(parseWeekTemplate(weekFile({ exportedAt: 'last Thursday' })).exportedAt).toBe('last Thursday');
    });

    it('a sourceWeek that is not a Sunday, and names the Sunday of that week', () => {
      // Wednesday and Saturday of the week of 22 November, and the Sunday after it.
      expect(parseWeekTemplate(weekFile({ sourceWeek: '2026-11-25' })).sourceWeek).toBe('2026-11-22');
      expect(parseWeekTemplate(weekFile({ sourceWeek: '2026-11-28' })).sourceWeek).toBe('2026-11-22');
      expect(parseWeekTemplate(weekFile({ sourceWeek: '2026-11-29' })).sourceWeek).toBe('2026-11-29');
      // Friday 1 January 2027 lies in the week that starts in December.
      expect(parseWeekTemplate(weekFile({ sourceWeek: '2027-01-01' })).sourceWeek).toBe('2026-12-27');
    });

    it('a title and notes exactly as written, spaces included', () => {
      const parsed = parseWeekTemplate(weekFile({ title: '  Week 12 ', events: [{ ...FILE_EVENT, notes: ' a\n b ' }] }));
      expect(parsed.title).toBe('  Week 12 ');
      expect(parsed.events[0].notes).toBe(' a\n b ');
    });

    it('formatVersion 1 written as 1.0', () => {
      const text = weekFile().replace('"formatVersion":1', '"formatVersion":1.0');
      expect(text).toContain('1.0');
      expect(parseWeekTemplate(text).formatVersion).toBe(1);
    });
  });
});

// ───────────────────────────── import ─────────────────────────────

describe('importWeekTemplate', () => {
  describe('in add mode', () => {
    it('adds the events of the file to an empty week, with fresh ids', () => {
      const dataset = schedule();

      const result = importInto(dataset, SOURCE_TEMPLATE);

      expect(result.eventCount).toBe(3);
      expect(result.created).toEqual(NOTHING_CREATED);
      expect(result.dataset.weeks[TARGET]).toStrictEqual({
        weekStart: TARGET,
        title: '',
        events: [
          { ...DOCKER, id: 'n1' },
          { ...NETWORKS, id: 'n2' },
          { ...LATE, id: 'n3' },
        ],
      });
    });

    it('leaves everything else exactly as it was', () => {
      const dataset = schedule();

      const result = importInto(dataset, SOURCE_TEMPLATE);

      expect(result.dataset).not.toBe(dataset);
      expect(result.dataset.config).toBe(dataset.config);
      expect(result.dataset.weeks[SOURCE]).toBe(dataset.weeks[SOURCE]);
      expect(Object.keys(result.dataset.weeks).sort()).toEqual([SOURCE, TARGET]);
    });

    it('keeps the events the week already has, as the very same objects', () => {
      const early = scheduleEvent({ id: 'early', day: 0, start: 480, end: 510, title: 'Stand-up' });
      const friday = scheduleEvent({ id: 'friday', day: 5, start: 600, end: 660, title: 'Review' });
      const dataset = schedule({ [SOURCE]: SOURCE_WEEK, [TARGET]: { title: 'Week 13', events: [early, friday] } });

      const result = importInto(dataset, SOURCE_TEMPLATE);

      const events = eventsOf(result.dataset, TARGET);
      expect(result.eventCount).toBe(3);
      expect(events.map((event) => event.id)).toEqual(['early', 'n1', 'n2', 'friday', 'n3']);
      expect(events[0]).toBe(early);
      expect(events[3]).toBe(friday);
      expect(result.dataset.weeks[TARGET].title).toBe('Week 13');
    });

    it('returns the very same dataset when the file has no events and no title is applied', () => {
      const dataset = schedule();
      const withTitleOnly = template([], 'Holiday');

      const untouched = importInto(dataset, withTitleOnly, { mode: 'add', applyTitle: false });
      const nothingToApply = importInto(dataset, template([], '   '), { mode: 'add', applyTitle: true });

      expect(untouched.dataset).toBe(dataset);
      expect(untouched.eventCount).toBe(0);
      expect(untouched.created).toEqual(NOTHING_CREATED);
      expect(nothingToApply.dataset).toBe(dataset);
    });
  });

  describe('in replace mode', () => {
    it('removes the events the week had and keeps its title', () => {
      const old = scheduleEvent({ id: 'old', day: 4, title: 'Old lesson' });
      const dataset = schedule({ [SOURCE]: SOURCE_WEEK, [TARGET]: { title: 'Week 13', events: [old] } });

      const result = importInto(dataset, SOURCE_TEMPLATE, { mode: 'replace' });

      expect(result.eventCount).toBe(3);
      expect(result.dataset.weeks[TARGET]).toStrictEqual({
        weekStart: TARGET,
        title: 'Week 13',
        events: [
          { ...DOCKER, id: 'n1' },
          { ...NETWORKS, id: 'n2' },
          { ...LATE, id: 'n3' },
        ],
      });
      expect(result.dataset.weeks[SOURCE]).toBe(dataset.weeks[SOURCE]);
    });

    it('fills a week that had nothing', () => {
      const result = importInto(schedule(), SOURCE_TEMPLATE, { mode: 'replace' });
      expect(eventsOf(result.dataset, TARGET).map((event) => event.id)).toEqual(['n1', 'n2', 'n3']);
    });

    it('empties the week when the file has no events', () => {
      const old = scheduleEvent({ id: 'old' });
      const titled = schedule({ [TARGET]: { title: 'Week 13', events: [old] } });
      const untitled = schedule({ [TARGET]: { events: [old] } });

      const keptForItsTitle = importInto(titled, template([]), { mode: 'replace' });
      const dropped = importInto(untitled, template([]), { mode: 'replace' });

      expect(keptForItsTitle.eventCount).toBe(0);
      expect(keptForItsTitle.dataset.weeks[TARGET]).toStrictEqual({ weekStart: TARGET, title: 'Week 13', events: [] });
      // A week without title and events is an empty week, and those are not stored.
      expect(TARGET in dropped.dataset.weeks).toBe(false);
    });

    it('returns the very same dataset when an empty file replaces an empty week', () => {
      const dataset = schedule();
      expect(importInto(dataset, template([]), { mode: 'replace' }).dataset).toBe(dataset);
    });

    it('can replace the week the file was exported from', () => {
      const dataset = schedule();

      const result = importInto(dataset, exportWeekTemplate(dataset, SOURCE, EXPORTED_AT), {
        targetWeek: SOURCE,
        mode: 'replace',
      });

      expect(result.created).toEqual(NOTHING_CREATED);
      expect(result.dataset.weeks[SOURCE]).toStrictEqual({
        weekStart: SOURCE,
        title: 'Week 12 - Docker',
        events: [
          { ...DOCKER, id: 'n1' },
          { ...NETWORKS, id: 'n2' },
          { ...LATE, id: 'n3' },
        ],
      });
    });
  });

  describe('event ids', () => {
    it('come from the id generator, one per event', () => {
      const newId = vi.fn(idSequence());

      const result = importInto(schedule(), SOURCE_TEMPLATE, {}, newId);

      expect(newId).toHaveBeenCalledTimes(3);
      expect(eventsOf(result.dataset, TARGET).map((event) => event.id)).toEqual(['n1', 'n2', 'n3']);
    });

    it('never repeat an id the week already holds', () => {
      const old = scheduleEvent({ id: 'old', day: 4 });
      const dataset = schedule({ [TARGET]: { events: [old] } });

      const result = importInto(dataset, template([templateEvent()]), { mode: 'add' }, idsFrom('old', 'fresh'));

      const events = eventsOf(result.dataset, TARGET);
      expect(events.map((event) => event.id)).toEqual(['fresh', 'old']);
      expect(events[1]).toBe(old);
    });

    it('never reuse the id of an event that is being replaced', () => {
      // To the change list, the merge and git blame the same id means "the same event, edited".
      const old = scheduleEvent({ id: 'old', day: 4 });
      const dataset = schedule({ [TARGET]: { events: [old] } });

      const result = importInto(dataset, template([templateEvent()]), { mode: 'replace' }, idsFrom('old', 'fresh'));

      expect(eventsOf(result.dataset, TARGET).map((event) => event.id)).toEqual(['fresh']);
    });

    it('are different from each other even when the generator repeats itself', () => {
      const result = importInto(
        schedule(),
        template([templateEvent({ day: 0 }), templateEvent({ day: 1 }), templateEvent({ day: 2 })]),
        {},
        idsFrom('a', 'a', 'b', 'a', 'b', 'c'),
      );
      expect(eventsOf(result.dataset, TARGET).map((event) => event.id)).toEqual(['a', 'b', 'c']);
    });

    it('fail loudly instead of looping forever when the generator only ever gives one id', () => {
      const twoEvents = template([templateEvent({ day: 0 }), templateEvent({ day: 1 })]);
      expect(() => importInto(schedule(), twoEvents, {}, () => 'always-the-same')).toThrow(/id generator/);
    });
  });

  describe('events', () => {
    it('get the time, title and notes of the file', () => {
      const result = importInto(
        schedule(),
        template([templateEvent({ day: 5, start: '9:05', end: '24:00', title: 'Hackathon', notes: 'Pizza at 20:00' })]),
      );
      expect(eventsOf(result.dataset, TARGET)).toStrictEqual([
        {
          id: 'n1',
          day: 5,
          start: 545,
          end: 1440,
          title: 'Hackathon',
          subjectId: null,
          locationId: null,
          teacherIds: [],
          classIds: [],
          notes: 'Pizza at 20:00',
        },
      ]);
    });

    it('are stored in the order of the week, whatever order the file has', () => {
      const result = importInto(
        schedule(),
        template([
          templateEvent({ day: 5, title: 'Friday' }),
          templateEvent({ day: 1, start: '14:00', end: '15:00', title: 'Monday afternoon' }),
          templateEvent({ day: 1, start: '08:00', end: '09:00', title: 'Monday morning' }),
        ]),
      );
      expect(eventsOf(result.dataset, TARGET).map((event) => event.title)).toEqual([
        'Monday morning',
        'Monday afternoon',
        'Friday',
      ]);
    });

    it('are stored in canonical form: trimmed texts, unique sorted ids', () => {
      const result = importInto(
        schedule(),
        template([
          templateEvent({
            title: '  Padded  ',
            notes: '\n kept line \n',
            teachers: [
              { id: 't-yossi', name: 'יוסי' },
              { id: 't-dana', name: 'Dana' },
              { id: 'elsewhere', name: 'dana' },
            ],
            classes: [
              { id: 'c-2', name: 'Class 2' },
              { id: 'c-1', name: 'Class 1' },
            ],
          }),
        ]),
      );
      expect(eventsOf(result.dataset, TARGET)[0]).toMatchObject({
        title: 'Padded',
        notes: 'kept line',
        teacherIds: ['t-dana', 't-yossi'],
        classIds: ['c-1', 'c-2'],
      });
    });

    it('are counted, also when the file holds the same event twice', () => {
      const result = importInto(schedule(), template([templateEvent(), templateEvent()]));
      expect(result.eventCount).toBe(2);
      expect(eventsOf(result.dataset, TARGET)).toHaveLength(2);
    });
  });

  describe('references', () => {
    it('are matched by id first, whatever the entry is called in the file', () => {
      const dataset = schedule();

      const result = importInto(
        dataset,
        template([
          templateEvent({
            subject: { id: 's-lab', name: 'Renamed since', color: '#000000' },
            location: { id: 'l-lab', name: 'Lab 2 (old name)' },
            teachers: [{ id: 't-yossi', name: 'Yossi' }],
            classes: [{ id: 'c-2', name: '' }],
          }),
        ]),
      );

      expect(eventsOf(result.dataset, TARGET)[0]).toMatchObject({
        subjectId: 's-lab',
        locationId: 'l-lab',
        teacherIds: ['t-yossi'],
        classIds: ['c-2'],
      });
      expect(result.created).toEqual(NOTHING_CREATED);
      // Nothing is renamed or recoloured to match the file.
      expect(result.dataset.config).toBe(dataset.config);
    });

    it('are matched by name when the id is unknown, ignoring case and surrounding spaces', () => {
      const dataset = schedule();

      const result = importInto(
        dataset,
        template([
          templateEvent({
            subject: { id: 'elsewhere-1', name: '  LAB ', color: '#000000' },
            location: { id: 'elsewhere-2', name: 'room 101' },
            teachers: [
              { id: 'elsewhere-3', name: 'DANA' },
              { id: 'elsewhere-4', name: ' יוסי ' },
            ],
            classes: [{ id: 'elsewhere-5', name: 'class 2\t' }],
          }),
        ]),
      );

      expect(eventsOf(result.dataset, TARGET)[0]).toMatchObject({
        subjectId: 's-lab',
        locationId: 'l-101',
        teacherIds: ['t-dana', 't-yossi'],
        classIds: ['c-2'],
      });
      expect(result.created).toEqual(NOTHING_CREATED);
      expect(result.dataset.config).toBe(dataset.config);
    });

    it('prefer the entry with the same id over another entry with the same name', () => {
      const result = importInto(schedule(), template([templateEvent({ teachers: [{ id: 't-dana', name: 'יוסי' }] })]));
      expect(eventsOf(result.dataset, TARGET)[0].teacherIds).toEqual(['t-dana']);
    });

    it('match a name only inside its own list', () => {
      // "Lab" is a subject of the schedule, not a location.
      const result = importInto(schedule(), template([templateEvent({ location: { id: 'file-lab', name: 'Lab' } })]));
      expect(result.created).toEqual({ ...NOTHING_CREATED, locations: 1 });
      expect(eventsOf(result.dataset, TARGET)[0].locationId).toBe('file-lab');
    });

    it('create the entries the schedule does not have, keeping the ids of the file', () => {
      const dataset = schedule();

      const result = importInto(
        dataset,
        template([
          templateEvent({
            subject: { id: 'file-subject', name: ' Exam ', color: '#DC2626' },
            location: { id: 'file-location', name: 'אולם ב׳' },
            teachers: [{ id: 'file-teacher', name: 'Noa' }],
            classes: [{ id: 'file-class', name: 'Class 3' }],
          }),
        ]),
      );

      const { config } = result.dataset;
      expect(result.created).toEqual({ subjects: 1, locations: 1, teachers: 1, classes: 1 });
      expect(config.subjects).toStrictEqual([
        ...dataset.config.subjects,
        { id: 'file-subject', name: 'Exam', color: '#DC2626' },
      ]);
      expect(config.locations).toStrictEqual([...dataset.config.locations, { id: 'file-location', name: 'אולם ב׳' }]);
      expect(config.teachers).toStrictEqual([...dataset.config.teachers, { id: 'file-teacher', name: 'Noa' }]);
      expect(config.classes).toStrictEqual([...dataset.config.classes, { id: 'file-class', name: 'Class 3' }]);
      expect(eventsOf(result.dataset, TARGET)[0]).toMatchObject({
        subjectId: 'file-subject',
        locationId: 'file-location',
        teacherIds: ['file-teacher'],
        classIds: ['file-class'],
      });
      // The entries that were there keep their place and their identity; the rest of the settings too.
      expect(config.subjects[0]).toBe(dataset.config.subjects[0]);
      expect(config.course).toBe(dataset.config.course);
      expect(config.timeGrid).toBe(dataset.config.timeGrid);
    });

    it('keep an id of the file that another list happens to use', () => {
      const result = importInto(schedule(), template([templateEvent({ location: { id: 't-dana', name: 'Hall B' } })]));
      expect(result.dataset.config.locations.at(-1)).toStrictEqual({ id: 't-dana', name: 'Hall B' });
      expect(result.dataset.config.teachers).toHaveLength(2);
      expect(eventsOf(result.dataset, TARGET)[0].locationId).toBe('t-dana');
    });

    it('give a new id to a created entry that has none in the file', () => {
      const result = importInto(
        schedule(),
        template([
          templateEvent({
            subject: { id: '', name: 'Exam', color: '#DC2626' },
            teachers: [{ id: '', name: 'Noa' }],
          }),
        ]),
      );

      const subject = result.dataset.config.subjects.at(-1);
      const teacher = result.dataset.config.teachers.at(-1);
      const [event] = eventsOf(result.dataset, TARGET);
      expect(result.created).toEqual({ ...NOTHING_CREATED, subjects: 1, teachers: 1 });
      expect(subject).toMatchObject({ name: 'Exam', color: '#DC2626' });
      expect(teacher).toMatchObject({ name: 'Noa' });
      expect(subject?.id).toMatch(/^n\d+$/);
      expect(teacher?.id).toMatch(/^n\d+$/);
      expect(event.subjectId).toBe(subject?.id);
      expect(event.teacherIds).toEqual([teacher?.id]);
      expect(new Set([subject?.id, teacher?.id, event.id]).size).toBe(3);
    });

    it('take that new id from the generator until it is one the list does not use', () => {
      const result = importInto(
        schedule(),
        template([templateEvent({ teachers: [{ id: '', name: 'Noa' }] })]),
        {},
        idsFrom('t-dana', 't-yossi', 'free', 'event-id'),
      );
      expect(result.dataset.config.teachers.map((teacher) => teacher.id)).toEqual(['t-dana', 't-yossi', 'free']);
      expect(eventsOf(result.dataset, TARGET)[0]).toMatchObject({ id: 'event-id', teacherIds: ['free'] });
    });

    it('match an entry without an id by its name', () => {
      const result = importInto(schedule(), template([templateEvent({ teachers: [{ id: '', name: 'dana' }] })]));
      expect(result.created).toEqual(NOTHING_CREATED);
      expect(eventsOf(result.dataset, TARGET)[0].teacherIds).toEqual(['t-dana']);
    });

    it('create an entry once and use it for every later event that names it', () => {
      const result = importInto(
        schedule(),
        template([
          templateEvent({ day: 0, teachers: [{ id: 'file-noa', name: 'Noa' }] }),
          templateEvent({ day: 1, teachers: [{ id: 'file-noa', name: 'Noa' }] }),
          templateEvent({ day: 2, teachers: [{ id: 'another-id', name: ' noa' }] }),
          templateEvent({ day: 3, teachers: [{ id: '', name: 'NOA' }] }),
        ]),
      );

      expect(result.created).toEqual({ ...NOTHING_CREATED, teachers: 1 });
      expect(result.dataset.config.teachers.map((teacher) => teacher.name)).toEqual(['Dana', 'יוסי', 'Noa']);
      for (const event of eventsOf(result.dataset, TARGET)) expect(event.teacherIds).toEqual(['file-noa']);
    });

    it('count what was created per list', () => {
      const exam = { id: 'file-exam', name: 'Exam', color: '#DC2626' };
      const result = importInto(
        schedule(),
        template([
          templateEvent({
            day: 0,
            subject: exam,
            location: { id: 'file-hall', name: 'Hall' },
            teachers: [
              { id: 'file-noa', name: 'Noa' },
              { id: 'file-avi', name: 'Avi' },
              { id: 't-dana', name: 'Dana' },
            ],
            classes: [{ id: 'file-class', name: 'Class 3' }],
          }),
          templateEvent({
            day: 1,
            subject: exam,
            location: { id: 'elsewhere', name: 'room 101' },
            teachers: [{ id: 'file-avi', name: 'Avi' }],
            classes: [{ id: 'elsewhere', name: 'class 1' }],
          }),
        ]),
      );
      expect(result.created).toEqual({ subjects: 1, locations: 1, teachers: 2, classes: 1 });
      expect(result.eventCount).toBe(2);
    });

    it('take the colour of a new subject from the file, and leave a known subject its own colour', () => {
      const dataset = schedule();
      const result = importInto(
        dataset,
        template([
          templateEvent({ day: 0, subject: { id: 'file-exam', name: 'Exam', color: '#7C3AED' } }),
          templateEvent({ day: 1, subject: { id: 'elsewhere', name: 'lab', color: '#7C3AED' } }),
        ]),
      );
      expect(result.dataset.config.subjects).toStrictEqual([
        { id: 's-lab', name: 'Lab', color: '#16A34A' },
        { id: 's-lecture', name: 'הרצאה', color: '#2563EB' },
        { id: 'file-exam', name: 'Exam', color: '#7C3AED' },
      ]);
    });

    it('give a new subject a free palette colour when a hand-built template has no usable one', () => {
      const result = importInto(
        schedule(),
        template([templateEvent({ subject: { id: 'file-exam', name: 'Exam', color: 'purple-ish' } })]),
      );
      // Blue and green are taken by the schedule's own subjects; red is the next palette colour.
      expect(DEFAULT_SUBJECT_COLORS.slice(0, 3)).toEqual(['#2563EB', '#16A34A', '#DC2626']);
      expect(result.dataset.config.subjects.at(-1)).toStrictEqual({ id: 'file-exam', name: 'Exam', color: '#DC2626' });
    });

    it('drop a reference that matches nothing and has no name to create an entry from', () => {
      const dataset = schedule();

      const result = importInto(
        dataset,
        template([
          templateEvent({
            subject: { id: 'ghost-subject', name: '   ', color: '#DC2626' },
            location: { id: 'ghost-location', name: '' },
            teachers: [
              { id: 'ghost-teacher', name: ' ' },
              { id: 't-dana', name: '' },
            ],
            classes: [{ id: '', name: '' }],
          }),
        ]),
      );

      expect(result.created).toEqual(NOTHING_CREATED);
      expect(result.dataset.config).toBe(dataset.config);
      expect(eventsOf(result.dataset, TARGET)[0]).toMatchObject({
        subjectId: null,
        locationId: null,
        // Still found by its id, although the file gives it no name.
        teacherIds: ['t-dana'],
        classIds: [],
      });
    });

    it('create entries in add mode and in replace mode alike', () => {
      const withNewTeacher = template([templateEvent({ teachers: [{ id: 'file-noa', name: 'Noa' }] })]);
      for (const mode of ['add', 'replace'] as const) {
        const result = importInto(schedule(), withNewTeacher, { mode });
        expect(result.created).toEqual({ ...NOTHING_CREATED, teachers: 1 });
        expect(result.dataset.config.teachers.at(-1)).toStrictEqual({ id: 'file-noa', name: 'Noa' });
      }
    });
  });

  describe('applyTitle', () => {
    const titled = (): Dataset => schedule({ [TARGET]: { title: 'Week 13', events: [scheduleEvent({ id: 'old' })] } });

    it('sets the title of the week from the file, trimmed', () => {
      const result = importInto(titled(), template([templateEvent()], '  Week 12 - Docker '), { applyTitle: true });
      expect(result.dataset.weeks[TARGET].title).toBe('Week 12 - Docker');
    });

    it('keeps the title of the week when it is switched off', () => {
      const result = importInto(titled(), template([templateEvent()], 'Week 12 - Docker'), { applyTitle: false });
      expect(result.dataset.weeks[TARGET].title).toBe('Week 13');
    });

    it('keeps the title of the week when the file has none', () => {
      for (const title of ['', '   ', '\n']) {
        const result = importInto(titled(), template([templateEvent()], title), { applyTitle: true });
        expect(result.dataset.weeks[TARGET].title).toBe('Week 13');
      }
    });

    it('works in replace mode too', () => {
      const result = importInto(titled(), template([templateEvent()], 'שבוע 12'), { mode: 'replace', applyTitle: true });
      expect(result.dataset.weeks[TARGET]).toMatchObject({ title: 'שבוע 12', events: [{ id: 'n1' }] });
      expect(eventsOf(result.dataset, TARGET)).toHaveLength(1);
    });

    it('can name a week from a file that has no events', () => {
      const dataset = titled();

      const result = importInto(dataset, template([], 'Holiday'), { mode: 'add', applyTitle: true });

      expect(result.eventCount).toBe(0);
      expect(result.dataset.weeks[TARGET].title).toBe('Holiday');
      expect(result.dataset.weeks[TARGET].events).toBe(dataset.weeks[TARGET].events);
    });

    it('creates the week when all it gets is a title', () => {
      const result = importInto(schedule(), template([], 'Holiday'), { applyTitle: true });
      expect(result.dataset.weeks[TARGET]).toStrictEqual({ weekStart: TARGET, title: 'Holiday', events: [] });
    });
  });

  describe('a template that did not come from the parser', () => {
    it.each<[string, Partial<TemplateEvent>]>([
      ['an end before the start', { start: '10:00', end: '09:00' }],
      ['an end equal to the start', { start: '10:00', end: '10:00' }],
      ['a start that is not a time', { start: 'soon' }],
      ['an end after 24:00', { end: '24:30' }],
    ])('is refused for %s', (_name, overrides) => {
      const dataset = schedule();
      const broken = template([templateEvent({ teachers: [{ id: 'file-noa', name: 'Noa' }] }), templateEvent(overrides)]);

      let caught: unknown;
      try {
        importInto(dataset, broken);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DataFormatError);
      expect(caught).toMatchObject({ code: 'invalid' });
      expect((caught as DataFormatError).message).toContain('events[1]');
    });
  });

  it('does not modify the dataset or the template it is given', () => {
    const dataset = schedule({
      [SOURCE]: SOURCE_WEEK,
      [TARGET]: { title: 'Week 13', events: [scheduleEvent({ id: 'old', teacherIds: ['t-dana'] })] },
    });
    const source = template(
      [
        templateEvent({
          subject: { id: 'file-exam', name: 'Exam', color: '#DC2626' },
          location: { id: '', name: 'Hall' },
          teachers: [{ id: 'file-noa', name: 'Noa' }],
          classes: [{ id: 'elsewhere', name: 'class 1' }],
        }),
      ],
      'Imported title',
    );
    const datasetBefore = structuredClone(dataset);
    const templateBefore = structuredClone(source);

    // The inputs are frozen all the way down, so an attempt to modify them would throw here.
    for (const mode of ['add', 'replace'] as const) {
      const result = importInto(dataset, source, { mode, applyTitle: true });
      expect(result.dataset).not.toBe(dataset);
    }

    expect(dataset).toStrictEqual(datasetBefore);
    expect(source).toStrictEqual(templateBefore);
  });

  it('brings a week into another schedule: known names are matched, the rest is created', () => {
    const file = serializeWeekTemplate(exportWeekTemplate(schedule(), SOURCE, EXPORTED_AT));
    const otherTeam: Dataset = deepFreeze({
      config: {
        course: { name: 'Another course', startDate: null, endDate: null },
        timeGrid: { dayStart: 420, dayEnd: 1320, slotMinutes: 60 },
        subjects: [{ id: 'their-lab', name: 'LAB', color: '#EA580C' }],
        locations: [],
        teachers: [{ id: 'their-yossi', name: 'יוסי' }],
        classes: [{ id: 'their-class', name: 'class 1' }],
      },
      weeks: {},
    });

    const result = importInto(otherTeam, parseWeekTemplate(file), { targetWeek: LATER, mode: 'replace', applyTitle: true });

    expect(result.eventCount).toBe(3);
    expect(result.created).toEqual({ subjects: 1, locations: 2, teachers: 1, classes: 1 });
    expect(result.dataset.config).toStrictEqual({
      course: { name: 'Another course', startDate: null, endDate: null },
      timeGrid: { dayStart: 420, dayEnd: 1320, slotMinutes: 60 },
      subjects: [
        { id: 'their-lab', name: 'LAB', color: '#EA580C' },
        { id: 's-lecture', name: 'הרצאה', color: '#2563EB' },
      ],
      locations: [
        { id: 'l-101', name: 'Room 101' },
        { id: 'l-lab', name: 'מעבדה 2' },
      ],
      teachers: [
        { id: 'their-yossi', name: 'יוסי' },
        { id: 't-dana', name: 'Dana' },
      ],
      classes: [
        { id: 'their-class', name: 'class 1' },
        { id: 'c-2', name: 'Class 2' },
      ],
    });
    expect(result.dataset.weeks).toStrictEqual({
      [LATER]: {
        weekStart: LATER,
        title: 'Week 12 - Docker',
        events: [
          {
            ...DOCKER,
            id: 'n1',
            subjectId: 'their-lab',
            teacherIds: ['t-dana', 'their-yossi'],
            classIds: ['their-class'],
          },
          {
            ...NETWORKS,
            id: 'n2',
            teacherIds: ['their-yossi'],
            classIds: ['c-2', 'their-class'],
          },
          { ...LATE, id: 'n3' },
        ],
      },
    });
  });
});

// ───────────────────────────── repeat week ─────────────────────────────

describe('copyWeek', () => {
  it('copies the events into every target week, same day and time, with fresh ids', () => {
    const dataset = schedule();

    const next = repeat(dataset, { targetWeeks: [TARGET, LATER] });

    expect(next.weeks[TARGET]).toStrictEqual({
      weekStart: TARGET,
      title: '',
      events: [
        { ...DOCKER, id: 'n1' },
        { ...NETWORKS, id: 'n2' },
        { ...LATE, id: 'n3' },
      ],
    });
    expect(next.weeks[LATER]).toStrictEqual({
      weekStart: LATER,
      title: '',
      events: [
        { ...DOCKER, id: 'n4' },
        { ...NETWORKS, id: 'n5' },
        { ...LATE, id: 'n6' },
      ],
    });
  });

  it('leaves the source week and the settings exactly as they were', () => {
    const dataset = schedule();

    const next = repeat(dataset, { targetWeeks: [TARGET, LATER], mode: 'replace', copyTitle: true });

    expect(next.weeks[SOURCE]).toBe(dataset.weeks[SOURCE]);
    expect(next.config).toBe(dataset.config);
  });

  it('copies into weeks before the source as well, in any order', () => {
    const next = repeat(schedule(), { targetWeeks: [LATER, '2026-11-15'] });
    expect(eventsOf(next, LATER).map((event) => event.id)).toEqual(['n1', 'n2', 'n3']);
    expect(eventsOf(next, '2026-11-15').map((event) => event.id)).toEqual(['n4', 'n5', 'n6']);
  });

  it('copies references as they are, also those to deleted entries', () => {
    const orphan = scheduleEvent({ id: 'orphan', subjectId: 'deleted-subject', teacherIds: ['deleted-teacher', 't-dana'] });
    const dataset = schedule({ [SOURCE]: { events: [orphan] } });

    const next = repeat(dataset);

    expect(eventsOf(next, TARGET)).toStrictEqual([{ ...orphan, id: 'n1' }]);
    expect(next.config).toBe(dataset.config);
  });

  it('skips the source week when it is listed as a target', () => {
    const dataset = schedule();

    const next = repeat(dataset, { targetWeeks: [SOURCE, TARGET], mode: 'replace' });

    expect(next.weeks[SOURCE]).toBe(dataset.weeks[SOURCE]);
    expect(eventsOf(next, TARGET).map((event) => event.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('writes a target that is listed twice only once', () => {
    const newId = vi.fn(idSequence());

    const next = repeat(schedule(), { targetWeeks: [TARGET, LATER, TARGET], mode: 'add' }, newId);

    expect(eventsOf(next, TARGET)).toHaveLength(3);
    expect(eventsOf(next, LATER)).toHaveLength(3);
    expect(newId).toHaveBeenCalledTimes(6);
  });

  describe('replace versus add', () => {
    const early = scheduleEvent({ id: 'early', day: 0, start: 480, end: 510, title: 'Stand-up' });
    const friday = scheduleEvent({ id: 'friday', day: 5, start: 600, end: 660, title: 'Review' });
    const busy = (): Dataset => schedule({ [SOURCE]: SOURCE_WEEK, [TARGET]: { title: 'Week 13', events: [early, friday] } });

    it('add keeps what the target week has, as the very same objects', () => {
      const next = repeat(busy(), { mode: 'add' });

      const events = eventsOf(next, TARGET);
      expect(events.map((event) => event.id)).toEqual(['early', 'n1', 'n2', 'friday', 'n3']);
      expect(events[0]).toBe(early);
      expect(events[3]).toBe(friday);
    });

    it('replace removes what the target week has', () => {
      const next = repeat(busy(), { mode: 'replace' });
      expect(eventsOf(next, TARGET).map((event) => event.id)).toEqual(['n1', 'n2', 'n3']);
    });

    it('both keep the title of the target week unless the title is copied', () => {
      expect(repeat(busy(), { mode: 'add' }).weeks[TARGET].title).toBe('Week 13');
      expect(repeat(busy(), { mode: 'replace' }).weeks[TARGET].title).toBe('Week 13');
    });

    it('both give the copies ids the target week does not use, not even for events that are replaced', () => {
      for (const mode of ['add', 'replace'] as const) {
        const next = repeat(busy(), { mode }, idsFrom('early', 'a', 'friday', 'a', 'b', 'c'));
        const copies = eventsOf(next, TARGET).filter((event) => event !== early && event !== friday);
        expect(copies.map((event) => event.id)).toEqual(['a', 'b', 'c']);
      }
    });
  });

  describe('copyTitle', () => {
    const named = (): Dataset => schedule({ [SOURCE]: SOURCE_WEEK, [TARGET]: { title: 'Week 13', events: [] } });

    it('gives every target week the title of the source week', () => {
      const next = repeat(named(), { targetWeeks: [TARGET, LATER], copyTitle: true });
      expect(next.weeks[TARGET].title).toBe('Week 12 - Docker');
      expect(next.weeks[LATER].title).toBe('Week 12 - Docker');
    });

    it('leaves the titles alone when it is switched off', () => {
      const next = repeat(named(), { targetWeeks: [TARGET, LATER], copyTitle: false });
      expect(next.weeks[TARGET].title).toBe('Week 13');
      expect(next.weeks[LATER].title).toBe('');
    });

    it('leaves the titles alone when the source week has no title', () => {
      const dataset = schedule({ [SOURCE]: { events: [DOCKER] }, [TARGET]: { title: 'Week 13', events: [] } });
      const next = repeat(dataset, { copyTitle: true });
      expect(next.weeks[TARGET].title).toBe('Week 13');
      expect(eventsOf(next, TARGET)).toHaveLength(1);
    });

    it('copies the title of a source week that has no events, and nothing else', () => {
      const old = scheduleEvent({ id: 'old' });
      const dataset = schedule({ [SOURCE]: { title: 'Holiday', events: [] }, [TARGET]: { events: [old] } });

      for (const mode of ['add', 'replace'] as const) {
        const next = repeat(dataset, { targetWeeks: [TARGET, LATER], mode, copyTitle: true });
        expect(next.weeks[TARGET]).toStrictEqual({ weekStart: TARGET, title: 'Holiday', events: [old] });
        expect(next.weeks[TARGET].events).toBe(dataset.weeks[TARGET].events);
        expect(next.weeks[LATER]).toStrictEqual({ weekStart: LATER, title: 'Holiday', events: [] });
      }
    });
  });

  describe('returns the very same dataset when there is nothing to do', () => {
    it('no target weeks', () => {
      const dataset = schedule();
      expect(repeat(dataset, { targetWeeks: [], mode: 'replace', copyTitle: true })).toBe(dataset);
    });

    it('the source week as the only target', () => {
      const dataset = schedule();
      const newId = vi.fn(idSequence());

      expect(repeat(dataset, { targetWeeks: [SOURCE, SOURCE], mode: 'replace', copyTitle: true }, newId)).toBe(dataset);
      expect(newId).not.toHaveBeenCalled();
    });

    it('a source week the schedule does not have', () => {
      const dataset = schedule({ [TARGET]: { title: 'Week 13', events: [scheduleEvent({ id: 'old' })] } });
      for (const mode of ['add', 'replace'] as const) {
        expect(repeat(dataset, { targetWeeks: [TARGET, LATER], mode, copyTitle: true })).toBe(dataset);
      }
    });

    it('a source week without events never empties a target week, not in replace mode either', () => {
      const old = scheduleEvent({ id: 'old' });
      const dataset = schedule({ [SOURCE]: { title: 'Holiday', events: [] }, [TARGET]: { events: [old] } });

      const next = repeat(dataset, { targetWeeks: [TARGET, LATER], mode: 'replace', copyTitle: false });

      expect(next).toBe(dataset);
    });

    it('a title that every target week already has', () => {
      const dataset = schedule({ [SOURCE]: { title: 'Holiday', events: [] }, [TARGET]: { title: 'Holiday', events: [] } });
      expect(repeat(dataset, { copyTitle: true })).toBe(dataset);
    });
  });

  it('does not modify the dataset it is given', () => {
    const dataset = schedule({
      [SOURCE]: SOURCE_WEEK,
      [TARGET]: { title: 'Week 13', events: [scheduleEvent({ id: 'old', classIds: ['c-1'] })] },
    });
    const before = structuredClone(dataset);

    // Frozen all the way down: modifying it would throw here.
    for (const mode of ['add', 'replace'] as const) {
      const next = repeat(dataset, { targetWeeks: [SOURCE, TARGET, LATER], mode, copyTitle: true });
      expect(next).not.toBe(dataset);
    }

    expect(dataset).toStrictEqual(before);
  });

  it('gives a week that can be exported and imported again like any other', () => {
    const repeated = repeat(schedule(), { copyTitle: true });

    const exported = exportWeekTemplate(repeated, TARGET, EXPORTED_AT);

    expect(exported).toStrictEqual({ ...SOURCE_TEMPLATE, sourceWeek: TARGET });
  });
});
