/**
 * Tests for src/shared/serialize.ts: the canonical text of the data files, the parsing
 * rules, and the conversion between a dataset and the files in the repository.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SUBJECT_COLORS, normalizeHex } from '@shared/colors';
import { compareEvents, datasetsEqual } from '@shared/model';
import * as paths from '@shared/paths';
import {
  DEFAULT_TIME_GRID,
  buildFileMap,
  createDefaultConfig,
  datasetToFiles,
  emptyDataset,
  eventIdOfLine,
  filesToDataset,
  isDataPath,
  isTitleLine,
  parseConfig,
  parseWeek,
  serializeConfig,
  serializeWeek,
  weekPath,
  weekStartFromPath,
} from '@shared/serialize';
import {
  CONFIG_PATH,
  DataFormatError,
  FORMAT_VERSION,
  type Dataset,
  type DayIndex,
  type FileMap,
  type ScheduleConfig,
  type ScheduleEvent,
  type SlotMinutes,
  type WeekData,
} from '@shared/types';

// ───────────────────────────── helpers ─────────────────────────────

type Json = Record<string, unknown>;

/** Lines joined the way the canonical format ends them: "\n" after every line, the last one too. */
function text(...lines: string[]): string {
  return lines.map((line) => `${line}\n`).join('');
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

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

/** The DataFormatError thrown by `run`. Anything else that is thrown, or nothing at all, fails the test. */
function rejection(run: () => unknown): DataFormatError {
  try {
    run();
  } catch (error) {
    if (error instanceof DataFormatError) return error;
    throw error;
  }
  throw new Error('expected a DataFormatError, but nothing was thrown');
}

// ───────────────────────────── the examples of the contract ─────────────────────────────

/** The schedule.json example in the file comment of serialize.ts, as data … */
const CONTRACT_CONFIG: ScheduleConfig = {
  course: { name: 'DevOps 2026', startDate: '2026-09-06', endDate: null },
  timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
  subjects: [
    { id: 'k3x9p2aqz1', name: 'Networking', color: '#2563EB' },
    { id: 'p0o9i8u7y6', name: 'מעבדה', color: '#16A34A' },
  ],
  locations: [{ id: 'a1b2c3d4e5', name: 'Room 101' }],
  teachers: [],
  classes: [],
};

/** … and as the exact text it must be written as. */
const CONTRACT_CONFIG_TEXT = text(
  '{',
  '"formatVersion": 1,',
  '"course": {"name":"DevOps 2026","startDate":"2026-09-06","endDate":null},',
  '"timeGrid": {"dayStart":"08:00","dayEnd":"20:00","slotMinutes":30},',
  '"subjects": [',
  '{"id":"k3x9p2aqz1","name":"Networking","color":"#2563EB"},',
  '{"id":"p0o9i8u7y6","name":"מעבדה","color":"#16A34A"}',
  '],',
  '"locations": [',
  '{"id":"a1b2c3d4e5","name":"Room 101"}',
  '],',
  '"teachers": [],',
  '"classes": []',
  '}',
);

/** The weeks/2026-11-22.json example in the file comment of serialize.ts, as data … */
const CONTRACT_WEEK: WeekData = {
  weekStart: '2026-11-22',
  title: 'שבוע 12 – Docker',
  events: [
    event('q1w2e3r4t5', {
      day: 0,
      start: 540,
      end: 630,
      title: 'Docker basics',
      subjectId: 'k3x9p2aqz1',
      locationId: 'a1b2c3d4e5',
      teacherIds: ['t1'],
      classIds: ['c1', 'c2'],
    }),
    event('z9y8x7w6v5', { day: 2, start: 780, end: 840 }),
  ],
};

/** … and as the exact text it must be written as. */
const CONTRACT_WEEK_TEXT = text(
  '{',
  '"formatVersion": 1,',
  '"weekStart": "2026-11-22",',
  '"title": "שבוע 12 – Docker",',
  '"events": [',
  '{"id":"q1w2e3r4t5","day":0,"start":"09:00","end":"10:30","title":"Docker basics","subject":"k3x9p2aqz1","location":"a1b2c3d4e5","teachers":["t1"],"classes":["c1","c2"],"notes":""},',
  '{"id":"z9y8x7w6v5","day":2,"start":"13:00","end":"14:00","title":"","subject":null,"location":null,"teachers":[],"classes":[],"notes":""}',
  ']',
  '}',
);

// ───────────────────────────── input for the parsers ─────────────────────────────

/** A valid schedule.json as a plain object; a test breaks or removes one detail (undefined removes the key). */
function configJson(patch: Json = {}): Json {
  return {
    formatVersion: 1,
    course: { name: 'Course', startDate: '2026-09-06', endDate: '2027-01-31' },
    timeGrid: { dayStart: '08:00', dayEnd: '20:00', slotMinutes: 30 },
    subjects: [{ id: 's1', name: 'Lecture', color: '#2563EB' }],
    locations: [{ id: 'l1', name: 'Room 101' }],
    teachers: [{ id: 't1', name: 'Dana' }],
    classes: [{ id: 'c1', name: 'Class 1' }],
    ...patch,
  };
}

function parseConfigJson(patch: Json = {}): ScheduleConfig {
  return parseConfig(JSON.stringify(configJson(patch)));
}

/** A valid event as it is written on disk. */
function eventJson(patch: Json = {}): Json {
  return {
    id: 'e1',
    day: 1,
    start: '09:00',
    end: '10:00',
    title: 'Title',
    subject: 's1',
    location: 'l1',
    teachers: ['t1'],
    classes: ['c1'],
    notes: 'Notes',
    ...patch,
  };
}

function weekJson(patch: Json = {}): Json {
  return { formatVersion: 1, weekStart: '2026-11-22', title: 'Week', events: [eventJson()], ...patch };
}

function parseWeekJson(patch: Json = {}): WeekData {
  return parseWeek(JSON.stringify(weekJson(patch)));
}

/** The single event of a week file whose only event is `eventJson(patch)`. */
function parseOneEvent(patch: Json): ScheduleEvent {
  return parseWeekJson({ events: [eventJson(patch)] }).events[0];
}

// ───────────────────────────── canonical text ─────────────────────────────

describe('canonical text', () => {
  it('writes the schedule.json example of the contract byte for byte', () => {
    expect(serializeConfig(CONTRACT_CONFIG)).toBe(CONTRACT_CONFIG_TEXT);
  });

  it('writes the week example of the contract byte for byte', () => {
    expect(serializeWeek(CONTRACT_WEEK)).toBe(CONTRACT_WEEK_TEXT);
  });

  it('writes Hebrew as it is and escapes quotes and backslashes inside names (schedule.json)', () => {
    const config: ScheduleConfig = {
      course: { name: 'קורס "DevOps" \\ 2026', startDate: null, endDate: null },
      timeGrid: { dayStart: 0, dayEnd: 1440, slotMinutes: 45 },
      subjects: [{ id: 's1', name: 'מעבדה "א"', color: '#16A34A' }],
      locations: [
        { id: 'l1', name: 'C:\\rooms\\101' },
        { id: 'l2', name: 'חדר 7' },
      ],
      teachers: [],
      classes: [{ id: 'c1', name: "כיתה מס' 1" }],
    };
    expect(serializeConfig(config)).toBe(
      text(
        '{',
        '"formatVersion": 1,',
        String.raw`"course": {"name":"קורס \"DevOps\" \\ 2026","startDate":null,"endDate":null},`,
        '"timeGrid": {"dayStart":"00:00","dayEnd":"24:00","slotMinutes":45},',
        '"subjects": [',
        String.raw`{"id":"s1","name":"מעבדה \"א\"","color":"#16A34A"}`,
        '],',
        '"locations": [',
        String.raw`{"id":"l1","name":"C:\\rooms\\101"},`,
        '{"id":"l2","name":"חדר 7"}',
        '],',
        '"teachers": [],',
        '"classes": [',
        `{"id":"c1","name":"כיתה מס' 1"}`,
        ']',
        '}',
      ),
    );
  });

  it('writes Hebrew as it is and escapes quotes, backslashes and line breaks inside texts (week file)', () => {
    const week: WeekData = {
      weekStart: '2026-11-22',
      title: 'שבוע "פתיחה" \\ Week 1',
      events: [
        event('e1', {
          title: 'מבוא ל-"Docker"',
          start: 540,
          end: 630,
          subjectId: 's1',
          locationId: 'l1',
          teacherIds: ['t1'],
          classIds: ['c1', 'c2'],
          notes: 'שורה 1\nשורה 2\tC:\\temp',
        }),
        event('e2', { day: 6, start: 1380, end: 1440 }),
      ],
    };
    expect(serializeWeek(week)).toBe(
      text(
        '{',
        '"formatVersion": 1,',
        '"weekStart": "2026-11-22",',
        String.raw`"title": "שבוע \"פתיחה\" \\ Week 1",`,
        '"events": [',
        String.raw`{"id":"e1","day":0,"start":"09:00","end":"10:30","title":"מבוא ל-\"Docker\"","subject":"s1","location":"l1","teachers":["t1"],"classes":["c1","c2"],"notes":"שורה 1\nשורה 2\tC:\\temp"},`,
        '{"id":"e2","day":6,"start":"23:00","end":"24:00","title":"","subject":null,"location":null,"teachers":[],"classes":[],"notes":""}',
        ']',
        '}',
      ),
    );
  });

  it('writes an empty list as [] on the line of its key', () => {
    expect(serializeConfig(emptyDataset().config)).toBe(
      text(
        '{',
        '"formatVersion": 1,',
        '"course": {"name":"","startDate":null,"endDate":null},',
        '"timeGrid": {"dayStart":"08:00","dayEnd":"20:00","slotMinutes":30},',
        '"subjects": [],',
        '"locations": [],',
        '"teachers": [],',
        '"classes": []',
        '}',
      ),
    );
    expect(serializeWeek({ weekStart: '2026-11-29', title: 'Holiday', events: [] })).toBe(
      text('{', '"formatVersion": 1,', '"weekStart": "2026-11-29",', '"title": "Holiday",', '"events": []', '}'),
    );
  });

  it('writes the format version this build supports', () => {
    expect(serializeConfig(CONTRACT_CONFIG).split('\n')[1]).toBe(`"formatVersion": ${FORMAT_VERSION},`);
    expect(serializeWeek(CONTRACT_WEEK).split('\n')[1]).toBe(`"formatVersion": ${FORMAT_VERSION},`);
  });

  it('keeps the order of the config lists as given', () => {
    const config: ScheduleConfig = {
      ...CONTRACT_CONFIG,
      teachers: [
        { id: 'z', name: 'Zohar' },
        { id: 'a', name: 'Avi' },
        { id: 'm', name: 'Maya' },
      ],
    };
    const ids = serializeConfig(config)
      .split('\n')
      .filter((line) => /"name":"(Zohar|Avi|Maya)"/.test(line))
      .map(eventIdOfLine);
    expect(ids).toEqual(['z', 'a', 'm']);
  });

  it('sorts the events of a week by day, start, end and id', () => {
    const week: WeekData = {
      weekStart: '2026-11-22',
      title: '',
      events: [
        event('f', { day: 3 }),
        event('e', { day: 1, start: 600, end: 660 }),
        event('d', { day: 1, start: 540, end: 660 }),
        event('c', { day: 1, start: 540, end: 600 }),
        event('b', { day: 0 }),
        event('a', { day: 1, start: 540, end: 600 }),
      ],
    };
    const ids = serializeWeek(week).split('\n').map(eventIdOfLine).filter(Boolean);
    expect(ids).toEqual(['b', 'a', 'c', 'd', 'e', 'f']);
  });

  it('writes events normalized: texts trimmed, id lists unique and sorted, empty references as null', () => {
    const week: WeekData = {
      weekStart: '2026-11-22',
      title: 'Week',
      events: [
        event('e1', {
          title: '  Docker  ',
          notes: '\n bring a laptop \t',
          subjectId: '',
          locationId: '',
          teacherIds: ['t2', 't1', 't2'],
          classIds: ['c9', 'c10', 'c9'],
        }),
      ],
    };
    expect(serializeWeek(week).split('\n')[5]).toBe(
      '{"id":"e1","day":0,"start":"09:00","end":"10:00","title":"Docker","subject":null,"location":null,"teachers":["t1","t2"],"classes":["c10","c9"],"notes":"bring a laptop"}',
    );
  });

  it('does not change the week or the config it is given', () => {
    const week = deepFreeze<WeekData>({
      weekStart: '2026-11-22',
      title: 'Week',
      events: [event('b', { day: 4, teacherIds: ['t2', 't1'], title: ' x ' }), event('a', { day: 1 })],
    });
    const config = deepFreeze(structuredClone(CONTRACT_CONFIG));
    expect(() => serializeWeek(week)).not.toThrow();
    expect(() => serializeConfig(config)).not.toThrow();
    expect(week.events.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('writes a time at the very end of the day as 24:00', () => {
    const week: WeekData = {
      weekStart: '2026-11-22',
      title: '',
      events: [event('e1', { start: 0, end: 1440 })],
    };
    expect(serializeWeek(week)).toContain('"start":"00:00","end":"24:00"');
  });

  it('uses "\\n" line ends, one final newline and no indentation', () => {
    for (const fileText of [serializeConfig(CONTRACT_CONFIG), serializeWeek(CONTRACT_WEEK)]) {
      expect(fileText).not.toContain('\r');
      expect(fileText.endsWith('}\n')).toBe(true);
      expect(fileText.endsWith('\n\n')).toBe(false);
      const lines = fileText.slice(0, -1).split('\n');
      expect(lines.every((line) => line !== '' && line === line.trim())).toBe(true);
    }
  });

  it('keeps every event on exactly one line, whatever its texts contain', () => {
    const week: WeekData = {
      weekStart: '2026-11-22',
      title: 'line 1\nline 2',
      events: [
        event('e1', { title: 'a\r\nb', notes: 'first\nsecond\n\nthird "quoted" {braces} [brackets], commas' }),
        event('e2', { day: 1, notes: 'tab\there \\n is not a line break' }),
      ],
    };
    const lines = serializeWeek(week).split('\n');
    expect(lines).toHaveLength(10);
    expect(lines.slice(0, 5)).toEqual([
      '{',
      '"formatVersion": 1,',
      '"weekStart": "2026-11-22",',
      String.raw`"title": "line 1\nline 2",`,
      '"events": [',
    ]);
    expect(lines.slice(7)).toEqual([']', '}', '']);
    expect(parseWeek(lines.join('\n'))).toEqual(week);
  });

  it('never writes Hebrew as \\u escapes', () => {
    const week: WeekData = { weekStart: '2026-11-22', title: 'שבוע', events: [event('e1', { title: 'שיעור' })] };
    const fileText = serializeWeek(week);
    expect(fileText).toContain('"title": "שבוע"');
    expect(fileText).toContain('"title":"שיעור"');
    expect(fileText).not.toMatch(/\\u/i);
  });

  it('starts every event line with the id, which is what the blame mapper looks for', () => {
    const week: WeekData = {
      weekStart: '2026-11-22',
      title: 'Week',
      events: [
        event('plain', { day: 0 }),
        event('with "quotes"', { day: 1 }),
        event('back\\slash', { day: 2 }),
        event('מזהה', { day: 3 }),
        event('{"id":"fake"}', { day: 4, title: '{"id":"decoy"}' }),
      ],
    };
    const lines = serializeWeek(week).split('\n');
    expect(lines.slice(5, 10).map(eventIdOfLine)).toEqual([
      'plain',
      'with "quotes"',
      'back\\slash',
      'מזהה',
      '{"id":"fake"}',
    ]);
    expect(lines.filter((line) => eventIdOfLine(line) !== null)).toHaveLength(5);
  });

  it('has exactly one title line in a week file, even when an event is called "title"', () => {
    const week: WeekData = {
      weekStart: '2026-11-22',
      title: '"title": decoy',
      events: [event('e1', { title: '"title": "x"', notes: '"title":' })],
    };
    const lines = serializeWeek(week).split('\n');
    expect(lines.map(isTitleLine)).toEqual([false, false, false, true, false, false, false, false, false]);
  });
});

// ───────────────────────────── round trips ─────────────────────────────

describe('round trips', () => {
  it('reads back the examples of the contract', () => {
    expect(parseConfig(CONTRACT_CONFIG_TEXT)).toEqual(CONTRACT_CONFIG);
    expect(parseWeek(CONTRACT_WEEK_TEXT)).toEqual(CONTRACT_WEEK);
    expect(parseWeek(CONTRACT_WEEK_TEXT, '2026-11-22')).toEqual(CONTRACT_WEEK);
  });

  it('writes canonical text back identically', () => {
    expect(serializeConfig(parseConfig(CONTRACT_CONFIG_TEXT))).toBe(CONTRACT_CONFIG_TEXT);
    expect(serializeWeek(parseWeek(CONTRACT_WEEK_TEXT))).toBe(CONTRACT_WEEK_TEXT);
  });

  it('is stable for a hand-edited config: parse → serialize → parse gives the same config', () => {
    const handEdited = JSON.stringify(
      {
        comment: 'edited in Notepad',
        classes: [{ name: 'Class 2', id: 'c2', room: 'unknown key' }],
        timeGrid: { slotMinutes: 15, dayEnd: '18:10', dayStart: '7:05' },
        subjects: [
          { color: 'abc', name: ' Lab ', id: 's2' },
          { id: 's1', name: 'Lecture', color: '#2563eb' },
        ],
        course: { endDate: null, startDate: '2026-09-06', name: '  DevOps  ' },
      },
      null,
      4,
    );
    const first = parseConfig(handEdited);
    const written = serializeConfig(first);
    expect(parseConfig(written)).toEqual(first);
    expect(serializeConfig(parseConfig(written))).toBe(written);
    expect(first).toEqual({
      course: { name: '  DevOps  ', startDate: '2026-09-06', endDate: null },
      timeGrid: { dayStart: 425, dayEnd: 1090, slotMinutes: 15 },
      subjects: [
        { id: 's2', name: ' Lab ', color: '#AABBCC' },
        { id: 's1', name: 'Lecture', color: '#2563EB' },
      ],
      locations: [],
      teachers: [],
      classes: [{ id: 'c2', name: 'Class 2' }],
    });
  });

  it('is stable for a hand-edited week: parse → serialize → parse gives the same week', () => {
    const handEdited = JSON.stringify(
      {
        events: [
          {
            notes: ' bring a laptop ',
            classes: ['c2', 'c1', 'c2'],
            teachers: ['t2', 't1', 't2'],
            subject: '',
            title: '  Docker  ',
            end: '10:00',
            start: '9:05',
            day: 3,
            id: 'b',
            color: 'unknown key',
          },
          { id: 'a', day: 0, start: '08:00', end: '24:00' },
        ],
        title: '  Week 12  ',
        weekStart: '2026-11-22',
      },
      null,
      '\t',
    );
    const first = parseWeek(handEdited);
    const written = serializeWeek(first);
    expect(parseWeek(written)).toEqual(first);
    expect(serializeWeek(parseWeek(written))).toBe(written);
    expect(first).toEqual({
      weekStart: '2026-11-22',
      title: '  Week 12  ',
      events: [
        event('a', { day: 0, start: 480, end: 1440 }),
        event('b', {
          day: 3,
          start: 545,
          end: 600,
          title: 'Docker',
          teacherIds: ['t1', 't2'],
          classIds: ['c1', 'c2'],
          notes: 'bring a laptop',
        }),
      ],
    });
  });

  it('survives texts that are hard to write: quotes, backslashes, control characters, emoji, lone surrogates', () => {
    const nasty = 'א"ב\\ג\n\t\r\u0000\u001f\u2028\u2029 😀 \ud83d end';
    const config: ScheduleConfig = {
      course: { name: nasty, startDate: '2026-09-06', endDate: '2027-01-31' },
      timeGrid: { dayStart: 15, dayEnd: 1425, slotMinutes: 60 },
      subjects: [{ id: nasty, name: nasty, color: '#000000' }],
      locations: [{ id: 'l"1', name: nasty }],
      teachers: [{ id: 't\\1', name: '' }],
      classes: [{ id: 'כ1', name: nasty }],
    };
    const week: WeekData = {
      weekStart: '2026-11-22',
      title: nasty,
      events: [
        event(nasty, {
          title: nasty.trim(),
          notes: nasty.trim(),
          subjectId: nasty,
          locationId: 'l"1',
          teacherIds: ['t\\1'],
          classIds: ['כ1'],
        }),
      ],
    };
    expect(parseConfig(serializeConfig(config))).toEqual(config);
    expect(parseWeek(serializeWeek(week))).toEqual(week);
    expect(serializeWeek(week).split('\n')).toHaveLength(9);
  });

  it('round-trips randomly generated datasets through the files without any change', () => {
    const random = randomSource(20261122);
    for (let round = 0; round < 150; round++) {
      const dataset = randomDataset(random);
      const files = datasetToFiles(dataset);
      const parsed = filesToDataset(files);
      expect(parsed.problems).toEqual([]);
      expect(parsed.passthrough).toEqual({});
      expect(parsed.dataset).toEqual(dataset);
      expect(datasetToFiles(parsed.dataset)).toEqual(files);
    }
  });
});

/** Small deterministic generator (mulberry32): a failing round can be reproduced from the seed. */
function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A valid, canonical dataset with awkward texts in it. */
function randomDataset(random: () => number): Dataset {
  const int = (limit: number): number => Math.floor(random() * limit);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)];
  const letters = [...'abcxyz0189 אבגדהשת"\\/{}[]:,\'\n\t😀–'];
  const randomText = (): string => Array.from({ length: int(12) }, () => pick(letters)).join('');
  const ids = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  const some = (items: readonly string[]): string[] => items.filter(() => random() < 0.4);
  const date = (): string => `2026-${String(1 + int(12)).padStart(2, '0')}-${String(1 + int(28)).padStart(2, '0')}`;

  const subjectIds = ids('s', int(4));
  const locationIds = ids('l', int(4));
  const teacherIds = ids('t', int(5));
  const classIds = ids('c', int(5));
  const dayStart = int(48) * 15;
  const config: ScheduleConfig = {
    course: { name: randomText(), startDate: random() < 0.5 ? date() : null, endDate: random() < 0.5 ? date() : null },
    timeGrid: { dayStart, dayEnd: dayStart + (1 + int(48)) * 15, slotMinutes: pick<SlotMinutes>([15, 30, 45, 60]) },
    subjects: subjectIds.map((id) => ({ id, name: randomText(), color: pick(DEFAULT_SUBJECT_COLORS) })),
    locations: locationIds.map((id) => ({ id, name: randomText() })),
    teachers: teacherIds.map((id) => ({ id, name: randomText() })),
    classes: classIds.map((id) => ({ id, name: randomText() })),
  };

  const weeks: Dataset['weeks'] = {};
  for (const weekStart of some(['2026-11-15', '2026-11-22', '2026-11-29', '2026-12-06'])) {
    const events = ids('e', int(6)).map((id): ScheduleEvent => {
      const start = int(1440);
      return {
        id: `${id}${randomText().replace(/\s/g, '')}`,
        day: pick<DayIndex>([0, 1, 2, 3, 4, 5, 6]),
        start,
        end: start + 1 + int(1440 - start),
        title: randomText().trim(),
        subjectId: random() < 0.3 ? null : pick([...subjectIds, 'deleted-subject']),
        locationId: random() < 0.3 ? null : pick([...locationIds, 'deleted-location']),
        teacherIds: some([...teacherIds, 'deleted-teacher']).sort(),
        classIds: some([...classIds, 'deleted-class']).sort(),
        notes: randomText().trim(),
      };
    });
    const week: WeekData = { weekStart, title: randomText(), events: events.sort(compareEvents) };
    if (week.title !== '' || week.events.length > 0) weeks[weekStart] = week;
  }
  return { config, weeks };
}

// ───────────────────────────── parsing: what is tolerated ─────────────────────────────

describe('parsers are tolerant about layout', () => {
  it('accepts a leading byte-order mark', () => {
    expect(parseConfig(`\uFEFF${CONTRACT_CONFIG_TEXT}`)).toEqual(CONTRACT_CONFIG);
    expect(parseWeek(`\uFEFF${CONTRACT_WEEK_TEXT}`)).toEqual(CONTRACT_WEEK);
  });

  it('accepts CRLF line ends', () => {
    expect(parseConfig(CONTRACT_CONFIG_TEXT.replaceAll('\n', '\r\n'))).toEqual(CONTRACT_CONFIG);
    expect(parseWeek(CONTRACT_WEEK_TEXT.replaceAll('\n', '\r\n'))).toEqual(CONTRACT_WEEK);
  });

  it('accepts pretty-printed and minified JSON, with a byte-order mark and CRLF on top', () => {
    const layouts = (canonical: string): string[] => {
      const value: unknown = JSON.parse(canonical);
      return [
        JSON.stringify(value),
        JSON.stringify(value, null, 2),
        JSON.stringify(value, null, '\t'),
        `\uFEFF${JSON.stringify(value, null, 2).replaceAll('\n', '\r\n')}\r\n\r\n`,
        `\n\n  ${canonical}`,
      ];
    };
    for (const layout of layouts(CONTRACT_CONFIG_TEXT)) expect(parseConfig(layout)).toEqual(CONTRACT_CONFIG);
    for (const layout of layouts(CONTRACT_WEEK_TEXT)) expect(parseWeek(layout)).toEqual(CONTRACT_WEEK);
  });

  it('ignores unknown keys at every level of schedule.json', () => {
    const config = parseConfigJson({
      generator: 'some other tool',
      course: { name: 'Course', startDate: null, endDate: null, teacher: 'x' },
      timeGrid: { dayStart: '08:00', dayEnd: '20:00', slotMinutes: 30, firstDay: 1 },
      subjects: [{ id: 's1', name: 'Lecture', color: '#2563EB', icon: 'book' }],
      locations: [{ id: 'l1', name: 'Room 101', color: '#FFFFFF', floor: 2 }],
    });
    expect(config).toEqual({
      course: { name: 'Course', startDate: null, endDate: null },
      timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
      subjects: [{ id: 's1', name: 'Lecture', color: '#2563EB' }],
      locations: [{ id: 'l1', name: 'Room 101' }],
      teachers: [{ id: 't1', name: 'Dana' }],
      classes: [{ id: 'c1', name: 'Class 1' }],
    });
  });

  it('ignores unknown keys at every level of a week file', () => {
    const week = parseWeekJson({
      generator: 'some other tool',
      events: [eventJson({ subjectId: 'ignored', locationId: 'ignored', teacherIds: ['x'], color: '#000' })],
    });
    expect(week).toEqual({
      weekStart: '2026-11-22',
      title: 'Week',
      events: [
        event('e1', {
          day: 1,
          title: 'Title',
          subjectId: 's1',
          locationId: 'l1',
          teacherIds: ['t1'],
          classIds: ['c1'],
          notes: 'Notes',
        }),
      ],
    });
  });

  it('fills in everything that may be missing from schedule.json', () => {
    expect(parseConfig('{}')).toEqual({
      course: { name: '', startDate: null, endDate: null },
      timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
      subjects: [],
      locations: [],
      teachers: [],
      classes: [],
    });
  });

  it.each(['course', 'timeGrid', 'subjects', 'locations', 'teachers', 'classes', 'formatVersion'])(
    'accepts schedule.json without "%s"',
    (key) => {
      const expected = parseConfigJson();
      const defaults = parseConfig('{}');
      const config = parseConfigJson({ [key]: undefined });
      expect(config).toEqual(key === 'formatVersion' ? expected : { ...expected, [key]: Reflect.get(defaults, key) });
    },
  );

  it('reads a missing course name as an empty name', () => {
    expect(parseConfigJson({ course: { startDate: '2026-09-06', endDate: null } }).course).toEqual({
      name: '',
      startDate: '2026-09-06',
      endDate: null,
    });
  });

  it('gives every parse its own default grid, never the shared constant', () => {
    const first = parseConfig('{}');
    expect(first.timeGrid).toEqual(DEFAULT_TIME_GRID);
    expect(first.timeGrid).not.toBe(DEFAULT_TIME_GRID);
    expect(first.timeGrid).not.toBe(parseConfig('{}').timeGrid);
  });

  it('fills in everything that may be missing from a week file', () => {
    expect(parseWeek('{"weekStart":"2026-11-22"}')).toEqual({ weekStart: '2026-11-22', title: '', events: [] });
    const week = parseWeek('{"weekStart":"2026-11-22","events":[{"id":"e1","day":6,"start":"09:00","end":"10:00"}]}');
    expect(week.events).toEqual([event('e1', { day: 6 })]);
  });

  it('reads a null subject or location like a missing one', () => {
    expect(parseOneEvent({ subject: null, location: null })).toMatchObject({ subjectId: null, locationId: null });
    expect(parseOneEvent({ subject: undefined, location: undefined })).toMatchObject({
      subjectId: null,
      locationId: null,
    });
  });

  it('keeps dangling references as they are', () => {
    const parsed = parseOneEvent({
      subject: 'deleted-subject',
      location: 'deleted-location',
      teachers: ['deleted-teacher'],
      classes: ['deleted-class'],
    });
    expect(parsed).toMatchObject({
      subjectId: 'deleted-subject',
      locationId: 'deleted-location',
      teacherIds: ['deleted-teacher'],
      classIds: ['deleted-class'],
    });
  });

  it('de-duplicates and sorts id lists, and sorts the events', () => {
    const week = parseWeekJson({
      events: [
        eventJson({ id: 'late', day: 5, teachers: ['t3', 't1', 't3', 't2'], classes: ['b', 'a', 'B', 'a'] }),
        eventJson({ id: 'early', day: 0 }),
        eventJson({ id: 'b', day: 2, start: '08:00', end: '09:00' }),
        eventJson({ id: 'a', day: 2, start: '08:00', end: '09:00' }),
      ],
    });
    expect(week.events.map((e) => e.id)).toEqual(['early', 'a', 'b', 'late']);
    expect(week.events[3].teacherIds).toEqual(['t1', 't2', 't3']);
    expect(week.events[3].classIds).toEqual(['B', 'a', 'b']);
  });

  it('returns events in canonical form: texts trimmed, an empty reference read as none', () => {
    expect(parseOneEvent({ title: '  Docker  ', notes: '\n note \n', subject: '', location: '' })).toMatchObject({
      title: 'Docker',
      notes: 'note',
      subjectId: null,
      locationId: null,
    });
  });

  it('accepts any whole minute and the end of the day', () => {
    expect(parseOneEvent({ start: '00:00', end: '24:00' })).toMatchObject({ start: 0, end: 1440 });
    expect(parseOneEvent({ start: '09:07', end: '09:08' })).toMatchObject({ start: 547, end: 548 });
    expect(parseOneEvent({ start: '9:00', end: '23:59' })).toMatchObject({ start: 540, end: 1439 });
    expect(parseConfigJson({ timeGrid: { dayStart: '00:00', dayEnd: '24:00', slotMinutes: 60 } }).timeGrid).toEqual({
      dayStart: 0,
      dayEnd: 1440,
      slotMinutes: 60,
    });
    expect(parseConfigJson({ timeGrid: { dayStart: '08:10', dayEnd: '08:11', slotMinutes: 45 } }).timeGrid).toEqual({
      dayStart: 490,
      dayEnd: 491,
      slotMinutes: 45,
    });
  });

  it.each([15, 30, 45, 60])('accepts %d-minute rows', (slotMinutes) => {
    expect(parseConfigJson({ timeGrid: { dayStart: '08:00', dayEnd: '20:00', slotMinutes } }).timeGrid.slotMinutes).toBe(
      slotMinutes,
    );
  });

  it('returns subject colours as #RRGGBB', () => {
    const config = parseConfigJson({
      subjects: [
        { id: 's1', name: 'A', color: '#2563eb' },
        { id: 's2', name: 'B', color: 'abc' },
        { id: 's3', name: 'C', color: ' #FFF ' },
      ],
    });
    expect(config.subjects.map((s) => s.color)).toEqual(['#2563EB', '#AABBCC', '#FFFFFF']);
  });

  it('accepts the same id in different lists and an empty name', () => {
    const config = parseConfigJson({
      subjects: [{ id: 'x1', name: '', color: '#000000' }],
      locations: [{ id: 'x1', name: '' }],
      teachers: [{ id: 'x1', name: 'Dana' }],
      classes: [{ id: 'x1', name: 'Class 1' }],
    });
    expect(config.locations).toEqual([{ id: 'x1', name: '' }]);
    expect(config.teachers).toEqual([{ id: 'x1', name: 'Dana' }]);
  });

  it('accepts a course whose dates are both null, or in any order', () => {
    expect(parseConfigJson({ course: { name: 'C', startDate: null, endDate: null } }).course).toEqual({
      name: 'C',
      startDate: null,
      endDate: null,
    });
    expect(parseConfigJson({ course: { name: 'C', startDate: '2027-01-31', endDate: '2026-09-06' } }).course).toEqual({
      name: 'C',
      startDate: '2027-01-31',
      endDate: '2026-09-06',
    });
  });

  it('accepts a week title in Hebrew and keeps it exactly, spaces included', () => {
    expect(parseWeekJson({ title: ' שבוע 12 – Docker ' }).title).toBe(' שבוע 12 – Docker ');
  });

  it('accepts the expected week start when it matches', () => {
    expect(parseWeek(JSON.stringify(weekJson()), '2026-11-22').weekStart).toBe('2026-11-22');
  });
});

// ───────────────────────────── parsing: what is rejected ─────────────────────────────

interface Rejection {
  /** What is wrong, in the words of the test title. */
  name: string;
  /** The file's text. */
  input: string;
  /** The complete message of the DataFormatError. */
  message: string;
}

function brokenConfig(name: string, patch: Json, message: string): Rejection {
  return { name, input: JSON.stringify(configJson(patch)), message: `settings file: ${message}` };
}

function brokenWeek(name: string, patch: Json, message: string): Rejection {
  return { name, input: JSON.stringify(weekJson(patch)), message: `week file: ${message}` };
}

function brokenEvent(name: string, patch: Json, message: string): Rejection {
  return brokenWeek(name, { events: [eventJson(patch)] }, `event #1 ("e1"): ${message}`);
}

const HHMM = 'must be a time written as "HH:MM" between 00:00 and 24:00';
const DATE = 'must be null or a valid date written as YYYY-MM-DD';

describe('parseConfig is strict about meaning', () => {
  it.each(['', '   ', '{', '{"course": }', "{'course': {}}", '{"teachers": [],}', 'schedule', '\uFEFF\uFEFF{}'])(
    'rejects text that is not JSON: %j',
    (input) => {
      const error = rejection(() => parseConfig(input));
      expect(error.code).toBe('invalid');
      expect(error.message).toMatch(/^settings file: not valid JSON \(SyntaxError: .+\)$/);
    },
  );

  it.each<[string, string]>([
    ['[]', 'found a list'],
    ['null', 'found null'],
    ['"schedule"', 'found "schedule"'],
    ['7', 'found 7'],
    ['true', 'found true'],
  ])('rejects a root that is not an object: %s', (input, found) => {
    const error = rejection(() => parseConfig(input));
    expect(error.code).toBe('invalid');
    expect(error.message).toBe(`settings file: the top level must be an object (${found})`);
  });

  it.each<Rejection>([
    brokenConfig('a course that is a text', { course: 'DevOps' }, 'course must be an object (found "DevOps")'),
    brokenConfig('a course that is null', { course: null }, 'course must be an object (found null)'),
    brokenConfig('a course that is a list', { course: [] }, 'course must be an object (found a list)'),
    brokenConfig(
      'a course name that is not a text',
      { course: { name: 7, startDate: null, endDate: null } },
      'course.name must be a string (found 7)',
    ),
    brokenConfig(
      'a course name that is null',
      { course: { name: null, startDate: null, endDate: null } },
      'course.name must be a string (found null)',
    ),
    brokenConfig(
      'a start date that is a number',
      { course: { name: '', startDate: 20260906, endDate: null } },
      `course.startDate ${DATE} (found 20260906)`,
    ),
    brokenConfig(
      'a start date in another notation',
      { course: { name: '', startDate: '06/09/2026', endDate: null } },
      `course.startDate ${DATE} (found "06/09/2026")`,
    ),
    brokenConfig(
      'a start date without leading zeros',
      { course: { name: '', startDate: '2026-9-6', endDate: null } },
      `course.startDate ${DATE} (found "2026-9-6")`,
    ),
    brokenConfig(
      'a start date that does not exist',
      { course: { name: '', startDate: '2026-02-30', endDate: null } },
      `course.startDate ${DATE} (found "2026-02-30")`,
    ),
    brokenConfig(
      'an empty start date',
      { course: { name: '', startDate: '', endDate: null } },
      `course.startDate ${DATE} (found "")`,
    ),
    brokenConfig(
      'a course without a start date',
      { course: { name: '', endDate: null } },
      `course.startDate ${DATE} (it is missing)`,
    ),
    brokenConfig(
      'an end date that does not exist',
      { course: { name: '', startDate: null, endDate: '2026-13-01' } },
      `course.endDate ${DATE} (found "2026-13-01")`,
    ),
    brokenConfig(
      'an end date with a time attached',
      { course: { name: '', startDate: null, endDate: '2027-01-31T00:00:00Z' } },
      `course.endDate ${DATE} (found "2027-01-31T00:00:00Z")`,
    ),
    brokenConfig(
      'a course without an end date',
      { course: { name: '', startDate: null } },
      `course.endDate ${DATE} (it is missing)`,
    ),
  ])('rejects $name', ({ input, message }) => {
    const error = rejection(() => parseConfig(input));
    expect(error.code).toBe('invalid');
    expect(error.message).toBe(message);
  });

  it.each<Rejection>([
    brokenConfig('a time grid that is a text', { timeGrid: '08:00-20:00' }, 'timeGrid must be an object (found "08:00-20:00")'),
    brokenConfig('a time grid that is null', { timeGrid: null }, 'timeGrid must be an object (found null)'),
    brokenConfig('a time grid that is a list', { timeGrid: [] }, 'timeGrid must be an object (found a list)'),
    brokenConfig(
      'a day start in minutes',
      { timeGrid: { dayStart: 480, dayEnd: '20:00', slotMinutes: 30 } },
      `timeGrid.dayStart ${HHMM} (found 480)`,
    ),
    brokenConfig(
      'a day start after midnight of the next day',
      { timeGrid: { dayStart: '25:00', dayEnd: '26:00', slotMinutes: 30 } },
      `timeGrid.dayStart ${HHMM} (found "25:00")`,
    ),
    brokenConfig(
      'a day start with 60 minutes',
      { timeGrid: { dayStart: '08:60', dayEnd: '20:00', slotMinutes: 30 } },
      `timeGrid.dayStart ${HHMM} (found "08:60")`,
    ),
    brokenConfig(
      'a day start with seconds',
      { timeGrid: { dayStart: '08:00:00', dayEnd: '20:00', slotMinutes: 30 } },
      `timeGrid.dayStart ${HHMM} (found "08:00:00")`,
    ),
    brokenConfig(
      'a time grid without a day start',
      { timeGrid: { dayEnd: '20:00', slotMinutes: 30 } },
      `timeGrid.dayStart ${HHMM} (it is missing)`,
    ),
    brokenConfig(
      'a day end past 24:00',
      { timeGrid: { dayStart: '08:00', dayEnd: '24:01', slotMinutes: 30 } },
      `timeGrid.dayEnd ${HHMM} (found "24:01")`,
    ),
    brokenConfig(
      'a day end in words',
      { timeGrid: { dayStart: '08:00', dayEnd: '8pm', slotMinutes: 30 } },
      `timeGrid.dayEnd ${HHMM} (found "8pm")`,
    ),
    brokenConfig(
      'a time grid without a day end',
      { timeGrid: { dayStart: '08:00', slotMinutes: 30 } },
      `timeGrid.dayEnd ${HHMM} (it is missing)`,
    ),
    brokenConfig(
      'a day that ends when it starts',
      { timeGrid: { dayStart: '08:00', dayEnd: '08:00', slotMinutes: 30 } },
      'timeGrid.dayEnd must be after timeGrid.dayStart',
    ),
    brokenConfig(
      'a day that ends before it starts',
      { timeGrid: { dayStart: '20:00', dayEnd: '08:00', slotMinutes: 30 } },
      'timeGrid.dayEnd must be after timeGrid.dayStart',
    ),
    brokenConfig(
      '20-minute rows',
      { timeGrid: { dayStart: '08:00', dayEnd: '20:00', slotMinutes: 20 } },
      'timeGrid.slotMinutes must be one of 15, 30, 45, 60 (found 20)',
    ),
    brokenConfig(
      'a row height written as a text',
      { timeGrid: { dayStart: '08:00', dayEnd: '20:00', slotMinutes: '30' } },
      'timeGrid.slotMinutes must be one of 15, 30, 45, 60 (found "30")',
    ),
    brokenConfig(
      'a row height of zero',
      { timeGrid: { dayStart: '08:00', dayEnd: '20:00', slotMinutes: 0 } },
      'timeGrid.slotMinutes must be one of 15, 30, 45, 60 (found 0)',
    ),
    brokenConfig(
      'a time grid without a row height',
      { timeGrid: { dayStart: '08:00', dayEnd: '20:00' } },
      'timeGrid.slotMinutes must be one of 15, 30, 45, 60 (it is missing)',
    ),
  ])('rejects $name', ({ input, message }) => {
    const error = rejection(() => parseConfig(input));
    expect(error.code).toBe('invalid');
    expect(error.message).toBe(message);
  });

  it.each<Rejection>([
    brokenConfig('subjects that are an object', { subjects: {} }, 'subjects must be a list (found an object)'),
    brokenConfig('locations that are a text', { locations: 'Room 101' }, 'locations must be a list (found "Room 101")'),
    brokenConfig('teachers that are null', { teachers: null }, 'teachers must be a list (found null)'),
    brokenConfig('classes that are a number', { classes: 2 }, 'classes must be a list (found 2)'),
    brokenConfig(
      'a list entry that is a text',
      { locations: [{ id: 'l1', name: 'Room 101' }, 'Room 102'] },
      'location #2 must be an object (found "Room 102")',
    ),
    brokenConfig('a list entry that is null', { teachers: [null] }, 'teacher #1 must be an object (found null)'),
    brokenConfig('a list entry that is a list', { classes: [[]] }, 'class #1 must be an object (found a list)'),
    brokenConfig(
      'an entry without an id',
      { teachers: [{ id: 't1', name: 'Dana' }, { name: 'Noa' }] },
      'teacher #2: id must be a non-empty string (it is missing)',
    ),
    brokenConfig(
      'an entry with an empty id',
      { classes: [{ id: '', name: 'Class 1' }] },
      'class #1: id must be a non-empty string (found "")',
    ),
    brokenConfig(
      'an entry with a numeric id',
      { locations: [{ id: 101, name: 'Room 101' }] },
      'location #1: id must be a non-empty string (found 101)',
    ),
    brokenConfig(
      'an entry without a name',
      { subjects: [{ id: 's1', color: '#2563EB' }] },
      'subject #1 ("s1"): name must be a string (it is missing)',
    ),
    brokenConfig(
      'an entry with a numeric name',
      { classes: [{ id: 'c1', name: 1 }] },
      'class #1 ("c1"): name must be a string (found 1)',
    ),
    brokenConfig(
      'an entry with a null name',
      { teachers: [{ id: 't1', name: null }] },
      'teacher #1 ("t1"): name must be a string (found null)',
    ),
    brokenConfig(
      'an id that is used twice in one list',
      {
        locations: [
          { id: 'l1', name: 'Room 101' },
          { id: 'l2', name: 'Room 102' },
          { id: 'l1', name: 'Room 103' },
        ],
      },
      'location #3 ("l1"): the id is already used by location #1',
    ),
    brokenConfig(
      'a subject without a colour',
      { subjects: [{ id: 's1', name: 'Lecture' }] },
      'subject #1 ("s1"): color must be a colour written as #RRGGBB (it is missing)',
    ),
    brokenConfig(
      'a subject whose colour is a number',
      { subjects: [{ id: 's1', name: 'Lecture', color: 255 }] },
      'subject #1 ("s1"): color must be a colour written as #RRGGBB (found 255)',
    ),
    brokenConfig(
      'a subject whose colour is a colour name',
      { subjects: [{ id: 's1', name: 'Lecture', color: 'blue' }] },
      'subject #1 ("s1"): color must be a colour written as #RRGGBB (found "blue")',
    ),
    brokenConfig(
      'a subject whose colour has the wrong length',
      {
        subjects: [
          { id: 's1', name: 'Lecture', color: '#2563EB' },
          { id: 's2', name: 'Lab', color: '#2563E' },
        ],
      },
      'subject #2 ("s2"): color must be a colour written as #RRGGBB (found "#2563E")',
    ),
    brokenConfig(
      'a subject whose colour has letters that are not hex digits',
      { subjects: [{ id: 's1', name: 'Lecture', color: '#GGGGGG' }] },
      'subject #1 ("s1"): color must be a colour written as #RRGGBB (found "#GGGGGG")',
    ),
  ])('rejects $name', ({ input, message }) => {
    const error = rejection(() => parseConfig(input));
    expect(error.code).toBe('invalid');
    expect(error.message).toBe(message);
  });

  it.each<[unknown, string]>([
    ['1', 'found "1"'],
    [0, 'found 0'],
    [-1, 'found -1'],
    [0.5, 'found 0.5'],
    [null, 'found null'],
    [true, 'found true'],
    [[1], 'found a list'],
  ])('rejects a format version that is not a whole number from 1: %j', (formatVersion, found) => {
    const error = rejection(() => parseConfigJson({ formatVersion }));
    expect(error.code).toBe('invalid');
    expect(error.message).toBe(`settings file: formatVersion must be a whole number, 1 or higher (${found})`);
  });

  it('shortens a long offending value in the message', () => {
    const error = rejection(() => parseConfigJson({ course: 'x'.repeat(500) }));
    expect(error.message).toBe(`settings file: course must be an object (found "${'x'.repeat(59)}…)`);
    const emoji = rejection(() => parseConfigJson({ course: `${'x'.repeat(58)}😀😀` }));
    expect(emoji.message).toBe(`settings file: course must be an object (found "${'x'.repeat(58)}…)`);
  });
});

describe('parseWeek is strict about meaning', () => {
  it.each(['', '{', '{"weekStart": "2026-11-22",}', 'week', '[{]'])('rejects text that is not JSON: %j', (input) => {
    const error = rejection(() => parseWeek(input));
    expect(error.code).toBe('invalid');
    expect(error.message).toMatch(/^week file: not valid JSON \(SyntaxError: .+\)$/);
  });

  it.each<[string, string]>([
    ['[]', 'found a list'],
    ['null', 'found null'],
    ['"2026-11-22"', 'found "2026-11-22"'],
    ['12', 'found 12'],
  ])('rejects a root that is not an object: %s', (input, found) => {
    const error = rejection(() => parseWeek(input));
    expect(error.code).toBe('invalid');
    expect(error.message).toBe(`week file: the top level must be an object (${found})`);
  });

  it.each<Rejection>([
    brokenWeek(
      'a week without a week start',
      { weekStart: undefined },
      'weekStart must be a valid date written as YYYY-MM-DD (it is missing)',
    ),
    brokenWeek(
      'a week start that is null',
      { weekStart: null },
      'weekStart must be a valid date written as YYYY-MM-DD (found null)',
    ),
    brokenWeek(
      'a week start that is a number',
      { weekStart: 20261122 },
      'weekStart must be a valid date written as YYYY-MM-DD (found 20261122)',
    ),
    brokenWeek(
      'a week start in another notation',
      { weekStart: '22.11.2026' },
      'weekStart must be a valid date written as YYYY-MM-DD (found "22.11.2026")',
    ),
    brokenWeek(
      'a week start that does not exist',
      { weekStart: '2026-11-31' },
      'weekStart must be a valid date written as YYYY-MM-DD (found "2026-11-31")',
    ),
    brokenWeek(
      'a week that starts on a Monday',
      { weekStart: '2026-11-23' },
      'weekStart 2026-11-23 is a Monday, but a week must start on a Sunday',
    ),
    brokenWeek(
      'a week that starts on a Saturday',
      { weekStart: '2026-11-21' },
      'weekStart 2026-11-21 is a Saturday, but a week must start on a Sunday',
    ),
    brokenWeek('a title that is a number', { title: 12 }, 'title must be a string (found 12)'),
    brokenWeek('a title that is null', { title: null }, 'title must be a string (found null)'),
    brokenWeek('events that are an object', { events: {} }, 'events must be a list (found an object)'),
    brokenWeek('events that are a text', { events: 'none' }, 'events must be a list (found "none")'),
    brokenWeek('events that are null', { events: null }, 'events must be a list (found null)'),
    brokenWeek('an event that is null', { events: [null] }, 'event #1 must be an object (found null)'),
    brokenWeek(
      'an event that is a text',
      { events: [eventJson(), 'Docker basics'] },
      'event #2 must be an object (found "Docker basics")',
    ),
    brokenWeek('an event that is a list', { events: [[]] }, 'event #1 must be an object (found a list)'),
    brokenWeek(
      'an event without an id',
      { events: [eventJson(), eventJson({ id: undefined })] },
      'event #2: id must be a non-empty string (it is missing)',
    ),
    brokenWeek(
      'an event with an empty id',
      { events: [eventJson({ id: '' })] },
      'event #1: id must be a non-empty string (found "")',
    ),
    brokenWeek(
      'an event with a numeric id',
      { events: [eventJson({ id: 17 })] },
      'event #1: id must be a non-empty string (found 17)',
    ),
    brokenWeek(
      'two events with the same id',
      { events: [eventJson(), eventJson({ id: 'e2' }), eventJson({ day: 4 })] },
      'event #3 ("e1"): the id is already used by event #1',
    ),
  ])('rejects $name', ({ input, message }) => {
    const error = rejection(() => parseWeek(input));
    expect(error.code).toBe('invalid');
    expect(error.message).toBe(message);
  });

  const DAY = 'day must be a whole number from 0 (Sunday) to 6 (Saturday)';

  it.each<Rejection>([
    brokenEvent('a day after Saturday', { day: 7 }, `${DAY} (found 7)`),
    brokenEvent('a negative day', { day: -1 }, `${DAY} (found -1)`),
    brokenEvent('a day that is not a whole number', { day: 1.5 }, `${DAY} (found 1.5)`),
    brokenEvent('a day written as a text', { day: '1' }, `${DAY} (found "1")`),
    brokenEvent('a day written as a name', { day: 'Sunday' }, `${DAY} (found "Sunday")`),
    brokenEvent('a day that is null', { day: null }, `${DAY} (found null)`),
    brokenEvent('an event without a day', { day: undefined }, `${DAY} (it is missing)`),
    brokenEvent('a start in minutes', { start: 540 }, `start ${HHMM} (found 540)`),
    brokenEvent('a start without minutes', { start: '9' }, `start ${HHMM} (found "9")`),
    brokenEvent('a start with a dot', { start: '09.00' }, `start ${HHMM} (found "09.00")`),
    brokenEvent('a start on the next day', { start: '25:00', end: '26:00' }, `start ${HHMM} (found "25:00")`),
    brokenEvent('a negative start', { start: '-1:00' }, `start ${HHMM} (found "-1:00")`),
    brokenEvent('an event without a start', { start: undefined }, `start ${HHMM} (it is missing)`),
    brokenEvent('an end past 24:00', { end: '24:01' }, `end ${HHMM} (found "24:01")`),
    brokenEvent('an end with 60 minutes', { end: '10:60' }, `end ${HHMM} (found "10:60")`),
    brokenEvent('an end that is null', { end: null }, `end ${HHMM} (found null)`),
    brokenEvent('an event without an end', { end: undefined }, `end ${HHMM} (it is missing)`),
    brokenEvent('an event that ends when it starts', { start: '09:00', end: '09:00' }, 'end must be after start'),
    brokenEvent('an event that ends before it starts', { start: '10:00', end: '09:00' }, 'end must be after start'),
    brokenEvent('an event that ends at 00:00', { start: '23:00', end: '00:00' }, 'end must be after start'),
    brokenEvent('a subject that is a number', { subject: 5 }, 'subject must be an id (a string) or null (found 5)'),
    brokenEvent(
      'a subject that is an object',
      { subject: { id: 's1' } },
      'subject must be an id (a string) or null (found an object)',
    ),
    brokenEvent(
      'a location that is a list',
      { location: ['l1'] },
      'location must be an id (a string) or null (found a list)',
    ),
    brokenEvent(
      'a location that is a boolean',
      { location: false },
      'location must be an id (a string) or null (found false)',
    ),
    brokenEvent('teachers that are a single id', { teachers: 't1' }, 'teachers must be a list of ids (found "t1")'),
    brokenEvent('teachers that are null', { teachers: null }, 'teachers must be a list of ids (found null)'),
    brokenEvent(
      'teachers with a number among them',
      { teachers: ['t1', 2] },
      'teachers #2 must be an id (a string) (found 2)',
    ),
    brokenEvent('classes that are an object', { classes: {} }, 'classes must be a list of ids (found an object)'),
    brokenEvent(
      'classes with null among them',
      { classes: [null, 'c1'] },
      'classes #1 must be an id (a string) (found null)',
    ),
    brokenEvent(
      'classes with a nested list among them',
      { classes: ['c1', 'c2', ['c3']] },
      'classes #3 must be an id (a string) (found a list)',
    ),
    brokenEvent('an event title that is a number', { title: 1 }, 'title must be a string (found 1)'),
    brokenEvent('an event title that is null', { title: null }, 'title must be a string (found null)'),
    brokenEvent('notes that are a list', { notes: ['a'] }, 'notes must be a string (found a list)'),
  ])('rejects $name', ({ input, message }) => {
    const error = rejection(() => parseWeek(input));
    expect(error.code).toBe('invalid');
    expect(error.message).toBe(message);
  });

  it('names the event by its position and id, exactly like the example in the task', () => {
    const input = JSON.stringify(
      weekJson({
        events: [
          eventJson({ id: 'a' }),
          eventJson({ id: 'b' }),
          eventJson({ id: 'q1w2e3r4t5', start: '10:30', end: '09:00' }),
        ],
      }),
    );
    const error = rejection(() => parseWeek(input));
    expect(error.code).toBe('invalid');
    expect(error.message).toBe('week file: event #3 ("q1w2e3r4t5"): end must be after start');
  });

  it('rejects a week start that differs from the expected one', () => {
    const error = rejection(() => parseWeek(JSON.stringify(weekJson()), '2026-11-29'));
    expect(error.code).toBe('invalid');
    expect(error.message).toBe(
      'week file: weekStart is 2026-11-22, but 2026-11-29 was expected (the date inside the file must match its file name)',
    );
  });

  it('rejects every week file when the expected week start is not a Sunday', () => {
    const sameMonday = rejection(() => parseWeek(JSON.stringify(weekJson({ weekStart: '2026-11-23' })), '2026-11-23'));
    expect(sameMonday.message).toBe('week file: weekStart 2026-11-23 is a Monday, but a week must start on a Sunday');
    const sundayBefore = rejection(() => parseWeek(JSON.stringify(weekJson()), '2026-11-23'));
    expect(sundayBefore.message).toContain('weekStart is 2026-11-22, but 2026-11-23 was expected');
  });

  it('reports the first problem only and stops there', () => {
    const input = JSON.stringify(weekJson({ events: [eventJson({ day: 9, start: 'x', end: 'y' }), 'broken'] }));
    expect(rejection(() => parseWeek(input)).message).toBe(
      'week file: event #1 ("e1"): day must be a whole number from 0 (Sunday) to 6 (Saturday) (found 9)',
    );
  });

  it('throws a DataFormatError that is a real Error with a name', () => {
    const error = rejection(() => parseWeek('{}'));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DataFormatError');
  });
});

describe('files written by a newer version', () => {
  it.each<[unknown]>([[FORMAT_VERSION + 1], [99], [FORMAT_VERSION + 0.5]])(
    'reports formatVersion %j as newer-version for both kinds of file',
    (formatVersion) => {
      const config = rejection(() => parseConfigJson({ formatVersion }));
      expect(config.code).toBe('newer-version');
      expect(config.message).toBe(
        `settings file: written by a newer version of Team Schedule (formatVersion ${String(formatVersion)}; this version reads up to ${FORMAT_VERSION})`,
      );
      const week = rejection(() => parseWeekJson({ formatVersion }));
      expect(week.code).toBe('newer-version');
      expect(week.message).toBe(
        `week file: written by a newer version of Team Schedule (formatVersion ${String(formatVersion)}; this version reads up to ${FORMAT_VERSION})`,
      );
    },
  );

  it('checks the version before anything else, because a newer file may look completely different', () => {
    const futureConfig = '{"formatVersion":2,"course":"moved elsewhere","timeGrid":[],"subjects":{"s1":"Lecture"}}';
    expect(rejection(() => parseConfig(futureConfig)).code).toBe('newer-version');
    const futureWeek = '{"formatVersion":3,"week":{"start":"2026-11-22"},"events":{"e1":{}}}';
    expect(rejection(() => parseWeek(futureWeek)).code).toBe('newer-version');
    expect(rejection(() => parseWeek(futureWeek, '2026-11-29')).code).toBe('newer-version');
  });

  it('reads a number too large for JSON as newer, not as invalid', () => {
    expect(rejection(() => parseWeek('{"formatVersion":1e999,"weekStart":"2026-11-22"}')).code).toBe('newer-version');
  });

  it('accepts the current version and a missing version', () => {
    expect(parseWeekJson({ formatVersion: FORMAT_VERSION }).weekStart).toBe('2026-11-22');
    expect(parseWeekJson({ formatVersion: undefined }).weekStart).toBe('2026-11-22');
    expect(parseConfigJson({ formatVersion: FORMAT_VERSION })).toEqual(parseConfigJson({ formatVersion: undefined }));
  });
});

// ───────────────────────────── dataset ↔ files ─────────────────────────────

const WEEK_22 = 'weeks/2026-11-22.json';
const WEEK_29 = 'weeks/2026-11-29.json';

const LATER_WEEK: WeekData = {
  weekStart: '2026-11-29',
  title: 'Week 13',
  events: [event('n1', { day: 4, start: 600, end: 720, title: 'Kubernetes', locationId: 'a1b2c3d4e5' })],
};

function contractDataset(): Dataset {
  return {
    config: structuredClone(CONTRACT_CONFIG),
    weeks: { '2026-11-22': structuredClone(CONTRACT_WEEK), '2026-11-29': structuredClone(LATER_WEEK) },
  };
}

function contractFiles(): FileMap {
  return {
    [CONFIG_PATH]: CONTRACT_CONFIG_TEXT,
    [WEEK_22]: CONTRACT_WEEK_TEXT,
    [WEEK_29]: serializeWeek(LATER_WEEK),
  };
}

describe('datasetToFiles', () => {
  it('writes schedule.json and one file per week, named after its Sunday', () => {
    expect(datasetToFiles(contractDataset())).toEqual(contractFiles());
    expect(Object.keys(datasetToFiles(contractDataset()))).toEqual([CONFIG_PATH, WEEK_22, WEEK_29]);
  });

  it('lists the weeks in ascending order whatever the order in the dataset', () => {
    const { config, weeks } = contractDataset();
    const reversed: Dataset = { config, weeks: { '2026-11-29': weeks['2026-11-29'], '2026-11-22': weeks['2026-11-22'] } };
    expect(Object.keys(datasetToFiles(reversed))).toEqual([CONFIG_PATH, WEEK_22, WEEK_29]);
  });

  it('always writes schedule.json, even for an empty dataset', () => {
    const files = datasetToFiles(emptyDataset());
    expect(Object.keys(files)).toEqual([CONFIG_PATH]);
    expect(files[CONFIG_PATH]).toBe(serializeConfig(emptyDataset().config));
  });

  it('omits weeks that have neither a title nor events', () => {
    const dataset = contractDataset();
    dataset.weeks['2026-12-06'] = { weekStart: '2026-12-06', title: '', events: [] };
    dataset.weeks['2026-11-29'] = { weekStart: '2026-11-29', title: '', events: [] };
    expect(Object.keys(datasetToFiles(dataset))).toEqual([CONFIG_PATH, WEEK_22]);
  });

  it('keeps a week that only has a title, and a week that only has events', () => {
    const dataset = emptyDataset();
    dataset.weeks['2026-11-22'] = { weekStart: '2026-11-22', title: 'Holiday', events: [] };
    dataset.weeks['2026-11-29'] = { weekStart: '2026-11-29', title: '', events: [event('e1')] };
    const files = datasetToFiles(dataset);
    expect(Object.keys(files)).toEqual([CONFIG_PATH, WEEK_22, WEEK_29]);
    expect(files[WEEK_22]).toBe(serializeWeek(dataset.weeks['2026-11-22']));
    expect(files[WEEK_29]).toBe(serializeWeek(dataset.weeks['2026-11-29']));
  });

  it('only produces data paths and does not change the dataset', () => {
    const dataset = deepFreeze(contractDataset());
    const files = datasetToFiles(dataset);
    expect(Object.keys(files).every(isDataPath)).toBe(true);
    expect(Object.keys(files).slice(1).map(weekStartFromPath)).toEqual(Object.keys(dataset.weeks));
  });
});

describe('filesToDataset', () => {
  it('builds the dataset from schedule.json and the week files', () => {
    const result = filesToDataset(contractFiles());
    expect(result.dataset).toEqual(contractDataset());
    expect(result.problems).toEqual([]);
    expect(result.passthrough).toEqual({});
  });

  it('is the inverse of datasetToFiles for canonical files', () => {
    expect(datasetToFiles(filesToDataset(contractFiles()).dataset)).toEqual(contractFiles());
    const parsed = filesToDataset(datasetToFiles(contractDataset()));
    expect(datasetsEqual(parsed.dataset, contractDataset())).toBe(true);
  });

  it('reports a missing schedule.json and continues with the default settings and empty lists', () => {
    const files = contractFiles();
    delete files[CONFIG_PATH];
    const result = filesToDataset(files);
    expect(result.problems).toEqual([{ path: 'schedule.json', code: 'missing-config', message: 'schedule.json is missing' }]);
    expect(result.dataset.config).toEqual({
      course: { name: '', startDate: null, endDate: null },
      timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
      subjects: [],
      locations: [],
      teachers: [],
      classes: [],
    });
    expect(result.dataset.config).toEqual({ ...createDefaultConfig('en'), subjects: [] });
    expect(result.dataset.weeks).toEqual(contractDataset().weeks);
    expect(result.passthrough).toEqual({});
  });

  it('turns no files at all into an empty dataset with a missing-config problem', () => {
    const result = filesToDataset({});
    expect(result.dataset).toEqual(emptyDataset());
    expect(result.problems.map((p) => p.code)).toEqual(['missing-config']);
    expect(result.passthrough).toEqual({});
  });

  it('keeps an unparseable schedule.json as raw text and continues with the default settings', () => {
    const broken = '\uFEFF{\r\n  "course": {"name": "DevOps",\r\n';
    const result = filesToDataset({ ...contractFiles(), [CONFIG_PATH]: broken });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ path: 'schedule.json', code: 'invalid' });
    expect(result.problems[0].message).toMatch(/^settings file: not valid JSON/);
    expect(result.passthrough).toEqual({ [CONFIG_PATH]: broken });
    expect(result.dataset.config).toEqual(emptyDataset().config);
    expect(result.dataset.weeks).toEqual(contractDataset().weeks);
  });

  it('reports a schedule.json that breaks a rule with the message of the parser', () => {
    const broken = JSON.stringify(configJson({ subjects: [{ id: 's1', name: 'Lecture', color: 'blue' }] }));
    const result = filesToDataset({ [CONFIG_PATH]: broken });
    expect(result.problems).toEqual([
      {
        path: 'schedule.json',
        code: 'invalid',
        message: 'settings file: subject #1 ("s1"): color must be a colour written as #RRGGBB (found "blue")',
      },
    ]);
    expect(result.passthrough).toEqual({ [CONFIG_PATH]: broken });
  });

  it('reports a schedule.json from a newer version as newer-version and keeps its text', () => {
    const newer = '{"formatVersion":2,"settings":{}}';
    const result = filesToDataset({ ...contractFiles(), [CONFIG_PATH]: newer });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ path: 'schedule.json', code: 'newer-version' });
    expect(result.passthrough).toEqual({ [CONFIG_PATH]: newer });
    expect(result.dataset.config).toEqual(emptyDataset().config);
  });

  it('leaves out an unparseable week, keeps its raw text, and still loads everything else', () => {
    const broken = '\uFEFF{ "weekStart": "2026-11-29",\r\n  "events": [ {"id": "n1" \r\n';
    const result = filesToDataset({ ...contractFiles(), [WEEK_29]: broken });
    expect(result.dataset).toEqual({ config: CONTRACT_CONFIG, weeks: { '2026-11-22': CONTRACT_WEEK } });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ path: WEEK_29, code: 'invalid' });
    expect(result.problems[0].message).toMatch(/^week file: not valid JSON/);
    expect(result.passthrough).toEqual({ [WEEK_29]: broken });
    expect(result.passthrough[WEEK_29]).toBe(broken);
  });

  it('leaves out a week that breaks a rule and says which event is wrong', () => {
    const broken = JSON.stringify(weekJson({ weekStart: '2026-11-29', events: [eventJson({ end: '08:00' })] }));
    const result = filesToDataset({ ...contractFiles(), [WEEK_29]: broken });
    expect(Object.keys(result.dataset.weeks)).toEqual(['2026-11-22']);
    expect(result.problems).toEqual([
      { path: WEEK_29, code: 'invalid', message: 'week file: event #1 ("e1"): end must be after start' },
    ]);
    expect(result.passthrough).toEqual({ [WEEK_29]: broken });
  });

  it('reports a week from a newer version as newer-version and keeps its text', () => {
    const newer = '{"formatVersion":7,"weekStart":"2026-11-29","days":[]}';
    const result = filesToDataset({ ...contractFiles(), [WEEK_29]: newer });
    expect(Object.keys(result.dataset.weeks)).toEqual(['2026-11-22']);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ path: WEEK_29, code: 'newer-version' });
    expect(result.passthrough).toEqual({ [WEEK_29]: newer });
  });

  it('rejects a week file whose name is not a Sunday, whatever date it carries inside', () => {
    const monday = 'weeks/2026-11-23.json';
    const sameDateInside = JSON.stringify(weekJson({ weekStart: '2026-11-23' }));
    const sundayInside = JSON.stringify(weekJson({ weekStart: '2026-11-22' }));

    const first = filesToDataset({ [CONFIG_PATH]: CONTRACT_CONFIG_TEXT, [monday]: sameDateInside });
    expect(first.dataset.weeks).toEqual({});
    expect(first.problems).toEqual([
      {
        path: monday,
        code: 'invalid',
        message: 'week file: weekStart 2026-11-23 is a Monday, but a week must start on a Sunday',
      },
    ]);
    expect(first.passthrough).toEqual({ [monday]: sameDateInside });

    const second = filesToDataset({ [CONFIG_PATH]: CONTRACT_CONFIG_TEXT, [monday]: sundayInside });
    expect(second.dataset.weeks).toEqual({});
    expect(second.problems).toHaveLength(1);
    expect(second.problems[0]).toMatchObject({ path: monday, code: 'invalid' });
    expect(second.problems[0].message).toContain('weekStart is 2026-11-22, but 2026-11-23 was expected');
    expect(second.passthrough).toEqual({ [monday]: sundayInside });
  });

  it('rejects a week file whose date inside differs from its name, instead of loading it under either date', () => {
    const result = filesToDataset({ [CONFIG_PATH]: CONTRACT_CONFIG_TEXT, [WEEK_29]: CONTRACT_WEEK_TEXT });
    expect(result.dataset.weeks).toEqual({});
    expect(result.problems).toEqual([
      {
        path: WEEK_29,
        code: 'invalid',
        message:
          'week file: weekStart is 2026-11-22, but 2026-11-29 was expected (the date inside the file must match its file name)',
      },
    ]);
    expect(result.passthrough).toEqual({ [WEEK_29]: CONTRACT_WEEK_TEXT });
  });

  it('ignores every path that is not a data path, whatever it contains', () => {
    const others: FileMap = {
      'README.md': '# Schedule',
      '.gitattributes': '*.json text eol=lf\n',
      'weeks/notes.txt': 'not json',
      'weeks/2026-13-01.json': 'not json',
      'weeks/2026-11-22.json.bak': 'not json',
      'Weeks/2026-11-22.json': 'not json',
      'weeks/archive/2026-11-22.json': 'not json',
      'weeks\\2026-11-22.json': 'not json',
      './schedule.json': 'not json',
      'backup/schedule.json': 'not json',
      'weeks/../schedule.json': 'not json',
    };
    const result = filesToDataset({ ...others, ...contractFiles() });
    expect(result.dataset).toEqual(contractDataset());
    expect(result.problems).toEqual([]);
    expect(result.passthrough).toEqual({});

    const alone = filesToDataset(others);
    expect(alone.dataset).toEqual(emptyDataset());
    expect(alone.problems.map((p) => p.code)).toEqual(['missing-config']);
    expect(alone.passthrough).toEqual({});
  });

  it('skips week files that parse to an empty week, without a problem and without keeping them', () => {
    const result = filesToDataset({
      ...contractFiles(),
      'weeks/2026-12-06.json': serializeWeek({ weekStart: '2026-12-06', title: '', events: [] }),
      'weeks/2026-12-13.json': '{"weekStart":"2026-12-13"}',
      'weeks/2026-12-20.json': '\uFEFF{\r\n  "weekStart": "2026-12-20",\r\n  "title": "",\r\n  "events": []\r\n}\r\n',
    });
    expect(result.dataset).toEqual(contractDataset());
    expect(result.problems).toEqual([]);
    expect(result.passthrough).toEqual({});
  });

  it('keeps a week that only has a title', () => {
    const titleOnly: WeekData = { weekStart: '2026-12-06', title: 'חופשת חנוכה', events: [] };
    const result = filesToDataset({ ...contractFiles(), 'weeks/2026-12-06.json': serializeWeek(titleOnly) });
    expect(result.dataset.weeks['2026-12-06']).toEqual(titleOnly);
    expect(result.problems).toEqual([]);
  });

  it('reports a zero-length data file as invalid and keeps it', () => {
    const result = filesToDataset({ [CONFIG_PATH]: '', [WEEK_22]: '' });
    expect(result.problems.map((p) => [p.path, p.code])).toEqual([
      ['schedule.json', 'invalid'],
      [WEEK_22, 'invalid'],
    ]);
    expect(result.passthrough).toEqual({ [CONFIG_PATH]: '', [WEEK_22]: '' });
    expect(result.dataset).toEqual(emptyDataset());
  });

  it('lists schedule.json first and then the weeks in ascending order, whatever order the files come in', () => {
    const shuffled: FileMap = {
      'weeks/2026-12-06.json': 'x',
      [WEEK_29]: serializeWeek(LATER_WEEK),
      'weeks/2026-11-15.json': 'x',
      [CONFIG_PATH]: 'x',
      [WEEK_22]: CONTRACT_WEEK_TEXT,
    };
    const result = filesToDataset(shuffled);
    expect(result.problems.map((p) => p.path)).toEqual([
      'schedule.json',
      'weeks/2026-11-15.json',
      'weeks/2026-12-06.json',
    ]);
    expect(Object.keys(result.dataset.weeks)).toEqual(['2026-11-22', '2026-11-29']);
  });

  it.each([
    '',
    ' ',
    '\uFEFF',
    'null',
    'true',
    '0',
    '"text"',
    '[]',
    '[[[[[[',
    '{',
    '}',
    '{"formatVersion":"x"}',
    '{"formatVersion":99}',
    '{"weekStart":5}',
    '{"weekStart":"2026-11-22","events":{}}',
    '{"weekStart":"2026-11-22","events":[null]}',
    '{"weekStart":"2026-11-22","events":[{"id":{}}]}',
    '{"weekStart":"2026-11-22","events":[{"id":"a","day":0,"start":[],"end":{}}]}',
    '{"course":[],"timeGrid":7,"subjects":"x"}',
    '{"subjects":[{"id":"s","name":"n","color":{}}]}',
    '{"__proto__":{"weekStart":"2026-11-22"},"constructor":null,"toString":1}',
    `{"weekStart":"2026-11-22","events":${'['.repeat(5000)}${']'.repeat(5000)}}`,
    '\u0000',
    '\ud800',
  ])('never throws, and keeps the text of what it cannot use: %j', (content) => {
    const files: FileMap = { [CONFIG_PATH]: content, [WEEK_22]: content, [WEEK_29]: CONTRACT_WEEK_TEXT };
    const result = filesToDataset(files);
    for (const problem of result.problems) {
      expect(problem.code === 'invalid' || problem.code === 'newer-version').toBe(true);
      expect(problem.message).not.toBe('');
      expect(result.passthrough[problem.path]).toBe(files[problem.path]);
    }
    expect(Object.keys(result.passthrough)).toEqual(result.problems.map((p) => p.path));
    expect(result.problems.map((p) => p.path)).toContain(WEEK_22);
    expect(result.problems.map((p) => p.path)).toContain(WEEK_29);
    expect(result.dataset.weeks).toEqual({});
  });

  it('does not throw even when a caller hands over something that is not text', () => {
    const files = { [CONFIG_PATH]: 42, [WEEK_22]: null, [WEEK_29]: CONTRACT_WEEK_TEXT.replace('11-22', '11-29') };
    const result = filesToDataset(files as unknown as FileMap);
    expect(result.problems.map((p) => [p.path, p.code])).toEqual([
      ['schedule.json', 'invalid'],
      [WEEK_22, 'invalid'],
    ]);
    expect(Object.keys(result.dataset.weeks)).toEqual(['2026-11-29']);
  });

  it('does not change the files it is given', () => {
    const files = deepFreeze({ ...contractFiles(), 'weeks/2026-12-06.json': 'broken' });
    expect(() => filesToDataset(files)).not.toThrow();
  });

  it('gives every result its own default settings', () => {
    const first = filesToDataset({});
    const second = filesToDataset({});
    expect(first.dataset.config).not.toBe(second.dataset.config);
    expect(first.dataset.config.timeGrid).not.toBe(DEFAULT_TIME_GRID);
    first.dataset.config.subjects.push({ id: 's1', name: 'Lecture', color: '#2563EB' });
    expect(second.dataset.config.subjects).toEqual([]);
    expect(filesToDataset({}).dataset.config.subjects).toEqual([]);
  });
});

describe('buildFileMap', () => {
  it('is datasetToFiles when nothing is passed through', () => {
    expect(buildFileMap(contractDataset(), {})).toEqual(datasetToFiles(contractDataset()));
  });

  it('adds the passed-through files to the files of the dataset', () => {
    const passthrough: FileMap = { 'weeks/2026-12-06.json': 'from a newer version' };
    expect(buildFileMap(contractDataset(), passthrough)).toEqual({
      ...contractFiles(),
      'weeks/2026-12-06.json': 'from a newer version',
    });
  });

  it('lets the passed-through text win on the same path', () => {
    const passthrough: FileMap = { [CONFIG_PATH]: 'raw settings', [WEEK_29]: 'raw week' };
    const files = buildFileMap(contractDataset(), passthrough);
    expect(files).toEqual({ [CONFIG_PATH]: 'raw settings', [WEEK_22]: CONTRACT_WEEK_TEXT, [WEEK_29]: 'raw week' });
  });

  it('does not change its arguments', () => {
    const dataset = deepFreeze(contractDataset());
    const passthrough = deepFreeze<FileMap>({ [WEEK_29]: 'raw week' });
    expect(() => buildFileMap(dataset, passthrough)).not.toThrow();
  });

  it('writes back byte for byte what filesToDataset could not read, so nothing is ever destroyed', () => {
    const files: FileMap = {
      [CONFIG_PATH]: '\uFEFF{"formatVersion": 2, "anything": "at all"}\r\n',
      'weeks/2026-11-15.json': 'not json at all',
      [WEEK_22]: CONTRACT_WEEK_TEXT,
      'weeks/2026-11-23.json': JSON.stringify(weekJson({ weekStart: '2026-11-23' }), null, 2),
      [WEEK_29]: '{"formatVersion":3,"weekStart":"2026-11-29"}',
    };
    const { dataset, passthrough } = filesToDataset(files);
    expect(buildFileMap(dataset, passthrough)).toEqual(files);
  });

  it('still writes the edits of readable weeks while unreadable files pass through', () => {
    const files: FileMap = { ...contractFiles(), [WEEK_29]: 'not json at all' };
    const { dataset, passthrough } = filesToDataset(files);
    dataset.weeks['2026-11-22'] = { ...dataset.weeks['2026-11-22'], title: 'Renamed' };
    const rebuilt = buildFileMap(dataset, passthrough);
    expect(rebuilt[WEEK_29]).toBe('not json at all');
    expect(rebuilt[WEEK_22]).toBe(CONTRACT_WEEK_TEXT.replace('"title": "שבוע 12 – Docker"', '"title": "Renamed"'));
    expect(rebuilt[CONFIG_PATH]).toBe(CONTRACT_CONFIG_TEXT);
  });
});

// ───────────────────────────── new schedules ─────────────────────────────

describe('createDefaultConfig', () => {
  it.each<['en' | 'he', string[]]>([
    ['en', ['Lecture', 'Lab', 'Workshop', 'Exam', 'Meeting', 'Other']],
    ['he', ['הרצאה', 'מעבדה', 'סדנה', 'מבחן', 'פגישה', 'אחר']],
  ])('creates six starter subjects with %s names and the first six palette colours', (lang, names) => {
    const config = createDefaultConfig(lang);
    expect(config.subjects.map((s) => s.name)).toEqual(names);
    expect(config.subjects.map((s) => s.color)).toEqual(DEFAULT_SUBJECT_COLORS.slice(0, 6));
    expect(config.subjects).toHaveLength(6);
    for (const subject of config.subjects) {
      expect(normalizeHex(subject.color)).toBe(subject.color);
      expect(subject.id).toMatch(/^[a-z0-9]{10}$/);
    }
    expect(new Set(config.subjects.map((s) => s.id)).size).toBe(6);
    expect(new Set(config.subjects.map((s) => s.color)).size).toBe(6);
  });

  it.each<['en' | 'he']>([['en'], ['he']])('starts with an empty course, the default grid and empty lists (%s)', (lang) => {
    const config = createDefaultConfig(lang);
    expect(config.course).toEqual({ name: '', startDate: null, endDate: null });
    expect(config.timeGrid).toEqual({ dayStart: 480, dayEnd: 1200, slotMinutes: 30 });
    expect(config.locations).toEqual([]);
    expect(config.teachers).toEqual([]);
    expect(config.classes).toEqual([]);
    expect(Object.keys(config).sort()).toEqual(['classes', 'course', 'locations', 'subjects', 'teachers', 'timeGrid']);
  });

  it('gives every call fresh ids and fresh objects', () => {
    const first = createDefaultConfig('en');
    const second = createDefaultConfig('en');
    const ids = [...first.subjects, ...second.subjects].map((s) => s.id);
    expect(new Set(ids).size).toBe(12);
    expect(first.timeGrid).not.toBe(second.timeGrid);
    expect(first.timeGrid).not.toBe(DEFAULT_TIME_GRID);
    expect(first.locations).not.toBe(second.locations);
  });

  it.each<['en' | 'he']>([['en'], ['he']])('can be written and read back unchanged (%s)', (lang) => {
    const config = createDefaultConfig(lang);
    expect(parseConfig(serializeConfig(config))).toEqual(config);
  });
});

describe('emptyDataset', () => {
  it('has the default grid, an empty course, empty lists and no weeks', () => {
    expect(emptyDataset()).toEqual({
      config: {
        course: { name: '', startDate: null, endDate: null },
        timeGrid: { dayStart: 480, dayEnd: 1200, slotMinutes: 30 },
        subjects: [],
        locations: [],
        teachers: [],
        classes: [],
      },
      weeks: {},
    });
  });

  it('uses the given config as it is', () => {
    const config = createDefaultConfig('he');
    const dataset = emptyDataset(config);
    expect(dataset.config).toBe(config);
    expect(dataset.weeks).toEqual({});
  });

  it('returns independent objects on every call', () => {
    const first = emptyDataset();
    const second = emptyDataset();
    expect(first).not.toBe(second);
    expect(first.config).not.toBe(second.config);
    expect(first.weeks).not.toBe(second.weeks);
    expect(first.config.timeGrid).not.toBe(DEFAULT_TIME_GRID);
    first.config.teachers.push({ id: 't1', name: 'Dana' });
    first.weeks['2026-11-22'] = structuredClone(CONTRACT_WEEK);
    expect(second).toEqual(emptyDataset());
  });

  it('keeps the default grid constant as documented', () => {
    expect(DEFAULT_TIME_GRID).toEqual({ dayStart: 480, dayEnd: 1200, slotMinutes: 30 });
  });
});

describe('path helpers', () => {
  it('are re-exported from the paths module', () => {
    expect(weekPath).toBe(paths.weekPath);
    expect(weekStartFromPath).toBe(paths.weekStartFromPath);
    expect(isDataPath).toBe(paths.isDataPath);
    expect(eventIdOfLine).toBe(paths.eventIdOfLine);
    expect(isTitleLine).toBe(paths.isTitleLine);
  });
});
