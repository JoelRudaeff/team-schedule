/**
 * Tests for src/shared/paths.ts: which paths are data files, and the two line patterns
 * that map `git blame` output back to the events and the title of a week.
 */
import { describe, expect, it } from 'vitest';
import { eventIdOfLine, isDataPath, isTitleLine, weekPath, weekStartFromPath } from '@shared/paths';
import { serializeWeek } from '@shared/serialize';
import { CONFIG_PATH, WEEKS_DIR, type ScheduleEvent, type WeekData } from '@shared/types';

// ───────────────────────────── fixtures ─────────────────────────────

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

/** Paths that must never be taken for a week file. Most of them differ from a real one in a single detail. */
const NOT_WEEK_PATHS: readonly string[] = [
  // Leaving the weeks folder, or not being directly in it.
  'weeks/../x.json',
  'weeks/../2026-11-22.json',
  'weeks/../weeks/2026-11-22.json',
  'weeks/./2026-11-22.json',
  'weeks/archive/2026-11-22.json',
  'weeks/2026/2026-11-22.json',
  'archive/weeks/2026-11-22.json',
  'weeks/2026-11-22.json/extra.json',
  'weeks//2026-11-22.json',
  './weeks/2026-11-22.json',
  '../weeks/2026-11-22.json',
  '/weeks/2026-11-22.json',
  'C:/repo/weeks/2026-11-22.json',
  '2026-11-22.json',
  // Backslashes: paths in the repository use forward slashes only.
  'weeks\\2026-11-22.json',
  '.\\weeks\\2026-11-22.json',
  'weeks/2026-11-22.json\\',
  'weeks\\..\\2026-11-22.json',
  // Upper and lower case: git is case-sensitive even though Windows is not.
  'Weeks/2026-11-22.json',
  'WEEKS/2026-11-22.json',
  'weeks/2026-11-22.JSON',
  'weeks/2026-11-22.Json',
  // Dates that do not exist.
  'weeks/2026-13-01.json',
  'weeks/2026-00-10.json',
  'weeks/2026-11-00.json',
  'weeks/2026-11-31.json',
  'weeks/2026-02-29.json',
  'weeks/2026-02-30.json',
  // Dates in another notation.
  'weeks/26-11-22.json',
  'weeks/2026-1-22.json',
  'weeks/2026-11-2.json',
  'weeks/20261122.json',
  'weeks/2026_11_22.json',
  'weeks/2026/11/22.json',
  'weeks/22-11-2026.json',
  'weeks/2026-11-22T00:00.json',
  'weeks/+2026-11-22.json',
  'weeks/٢٠٢٦-١١-٢٢.json',
  // Another extension, or more around the name.
  'weeks/2026-11-22',
  'weeks/2026-11-22.',
  'weeks/2026-11-22.txt',
  'weeks/2026-11-22.jsonc',
  'weeks/2026-11-22.json.bak',
  'weeks/2026-11-22.json~',
  'weeks/2026-11-22 (1).json',
  'weeks/copy of 2026-11-22.json',
  'weeks/2026-11-22 .json',
  'weeks/2026-11-22.json ',
  ' weeks/2026-11-22.json',
  'weeks/2026-11-22.json\n',
  'weeks/2026-11-22.json\r\n',
  '\nweeks/2026-11-22.json',
  'README.md\nweeks/2026-11-22.json',
  'weeks/2026-11-22.json\nREADME.md',
  // Not a week at all.
  'weeks/week.json',
  'weeks/.json',
  'weeks/',
  'weeks',
  '',
];

/** Paths that are neither `schedule.json` nor a week file. */
const NOT_DATA_PATHS: readonly string[] = [
  ...NOT_WEEK_PATHS,
  'Schedule.json',
  'SCHEDULE.JSON',
  'schedule.JSON',
  './schedule.json',
  '/schedule.json',
  '.\\schedule.json',
  'backup/schedule.json',
  'weeks/schedule.json',
  'weeks/../schedule.json',
  'schedule.json/',
  'schedule.json ',
  ' schedule.json',
  'schedule.json\n',
  'schedule.json.bak',
  'schedule.jsonc',
  'schedule',
  'schedule.jso',
  'README.md',
  'package.json',
  '.gitattributes',
  '.git/config',
  '.git/hooks/pre-commit',
];

// ───────────────────────────── file names ─────────────────────────────

describe('weekPath', () => {
  it('names the file of a week after its Sunday', () => {
    expect(weekPath('2026-11-22')).toBe('weeks/2026-11-22.json');
    expect(weekPath('2027-01-03')).toBe('weeks/2027-01-03.json');
  });

  it('puts the file directly in the weeks folder, with a forward slash', () => {
    const path = weekPath('2026-11-22');
    expect(path.startsWith(`${WEEKS_DIR}/`)).toBe(true);
    expect(path.split('/')).toHaveLength(2);
    expect(path).not.toContain('\\');
  });
});

describe('weekStartFromPath', () => {
  it('reads the date from the path of a week file', () => {
    expect(weekStartFromPath('weeks/2026-11-22.json')).toBe('2026-11-22');
  });

  it.each(['2026-11-22', '2026-11-29', '2026-12-27', '2027-01-03', '2028-02-27', '1999-12-26'])(
    'is the inverse of weekPath for %s',
    (weekStart) => {
      expect(weekStartFromPath(weekPath(weekStart))).toBe(weekStart);
    },
  );

  it('accepts a date that is not a Sunday: telling the user about it is the job of the week parser', () => {
    expect(weekStartFromPath('weeks/2026-11-23.json')).toBe('2026-11-23');
    expect(weekStartFromPath('weeks/2026-11-28.json')).toBe('2026-11-28');
  });

  it('accepts 29 February in a leap year only', () => {
    expect(weekStartFromPath('weeks/2028-02-29.json')).toBe('2028-02-29');
    expect(weekStartFromPath('weeks/2026-02-29.json')).toBeNull();
    expect(weekStartFromPath('weeks/2100-02-29.json')).toBeNull();
  });

  it.each(NOT_WEEK_PATHS)('returns null for %j', (path) => {
    expect(weekStartFromPath(path)).toBeNull();
  });

  it('returns null for schedule.json', () => {
    expect(weekStartFromPath(CONFIG_PATH)).toBeNull();
  });
});

describe('isDataPath', () => {
  it('accepts schedule.json', () => {
    expect(CONFIG_PATH).toBe('schedule.json');
    expect(isDataPath('schedule.json')).toBe(true);
  });

  it('accepts the file of a week', () => {
    expect(isDataPath('weeks/2026-11-22.json')).toBe(true);
    expect(isDataPath('weeks/2026-11-23.json')).toBe(true);
    expect(isDataPath('weeks/2028-02-29.json')).toBe(true);
  });

  it.each(['2026-11-22', '2026-11-29', '2027-01-03', '2028-02-27'])('accepts what weekPath makes of %s', (weekStart) => {
    expect(isDataPath(weekPath(weekStart))).toBe(true);
  });

  it.each(NOT_DATA_PATHS)('rejects %j', (path) => {
    expect(isDataPath(path)).toBe(false);
  });
});

// ───────────────────────────── lines of a week file ─────────────────────────────

const EVENT_LINE =
  '{"id":"q1w2e3r4t5","day":0,"start":"09:00","end":"10:30","title":"Docker basics","subject":"k3x9p2aqz1","location":"a1b2c3d4e5","teachers":["t1"],"classes":["c1","c2"],"notes":""}';

/** A week whose texts try to look like the lines the blame mapping searches for. */
const TRICKY_WEEK: WeekData = {
  weekStart: '2026-11-22',
  title: 'שבוע 12 – {"id":"decoy"} "title": decoy',
  events: [
    event('q1w2e3r4t5', { day: 0, title: 'Docker basics', notes: '"title": not this line' }),
    event('with "quotes"', { day: 1 }),
    event('back\\slash', { day: 2 }),
    event('ends with a backslash\\', { day: 3 }),
    event('מזהה', { day: 4 }),
    event('{"id":"inner"}', { day: 5, title: '{"id":"decoy"}', notes: '\n{"id":"decoy"}' }),
    event('z9y8x7w6v5', { day: 6 }),
  ],
};

const TRICKY_IDS = TRICKY_WEEK.events.map((e) => e.id);

/** What each line of the canonical text of TRICKY_WEEK is. */
const TRICKY_WEEK_LINE_IDS = [null, null, null, null, null, ...TRICKY_IDS, null, null, null];
const TRICKY_WEEK_TITLE_LINES = TRICKY_WEEK_LINE_IDS.map((_id, index) => index === 3);

describe('eventIdOfLine', () => {
  it('reads the id of an event line', () => {
    expect(eventIdOfLine(EVENT_LINE)).toBe('q1w2e3r4t5');
  });

  it('does not care whether a comma follows the line', () => {
    expect(eventIdOfLine(`${EVENT_LINE},`)).toBe('q1w2e3r4t5');
  });

  it('does not care about the "\\r" of a file with CRLF line ends', () => {
    expect(eventIdOfLine(`${EVENT_LINE}\r`)).toBe('q1w2e3r4t5');
    expect(eventIdOfLine(`${EVENT_LINE},\r`)).toBe('q1w2e3r4t5');
  });

  it('does not care about white space in front of the line', () => {
    expect(eventIdOfLine(`\t${EVENT_LINE},`)).toBe('q1w2e3r4t5');
    expect(eventIdOfLine(`    ${EVENT_LINE}`)).toBe('q1w2e3r4t5');
  });

  it.each<[string, string]>([
    [String.raw`{"id":"a\"b","day":0}`, 'a"b'],
    [String.raw`{"id":"\"","day":0}`, '"'],
    [String.raw`{"id":"a\\b","day":0}`, 'a\\b'],
    [String.raw`{"id":"a\\","day":0}`, 'a\\'],
    [String.raw`{"id":"\\\"","day":0}`, '\\"'],
    [String.raw`{"id":"\\\\","day":0}`, '\\\\'],
    [String.raw`{"id":"a\/b","day":0}`, 'a/b'],
    [String.raw`{"id":"tab\tnew\nline","day":0}`, 'tab\tnew\nline'],
    [String.raw`{"id":"\u05d0\u05d1","day":0}`, 'אב'],
    [String.raw`{"id":"\ud83d\ude00","day":0}`, '😀'],
  ])('decodes the escaped characters of the id in %s', (line, id) => {
    expect(eventIdOfLine(line)).toBe(id);
    expect(eventIdOfLine(`${line},\r`)).toBe(id);
  });

  it.each([
    'q1w2e3r4t5',
    'מזהה',
    '😀',
    'with space',
    'with,comma',
    'with:colon',
    'with "quotes"',
    'with \\ backslash',
    'ends with a backslash\\',
    'ends with a quote"',
    '"',
    '\\',
    '\\"',
    '{"id":"inner"}',
    '","day":0',
    'line\nbreak',
    'carriage\rreturn',
    'tab\there',
    'control\u0000\u001f',
    'separators\u2028\u2029',
    'lone surrogate \ud83d',
    ' ',
  ])('reads back the id %j from a line written with JSON.stringify', (id) => {
    const line = JSON.stringify({ id, day: 0, title: 'x' });
    expect(eventIdOfLine(line)).toBe(id);
    expect(eventIdOfLine(`${line},`)).toBe(id);
  });

  it('stops at the end of the id, whatever the rest of the line contains', () => {
    expect(eventIdOfLine(String.raw`{"id":"e1","day":0,"title":"{\"id\":\"e2\"}","notes":"\"id\":\"e3\""}`)).toBe('e1');
    expect(eventIdOfLine('{"id":"e1"')).toBe('e1');
    expect(eventIdOfLine('{"id":"e1"}')).toBe('e1');
  });

  it.each([
    '',
    ' ',
    '{',
    '}',
    ']',
    '],',
    '"formatVersion": 1,',
    '"weekStart": "2026-11-22",',
    '"title": "Week 12",',
    '"events": [',
    '"events": []',
    String.raw`"title": "{\"id\":\"e1\"}",`,
    '"title": "{"id":"e1"}",',
    '"id":"e1"',
    'x{"id":"e1"}',
    '// {"id":"e1"}',
    '[{"id":"e1"}]',
  ])('returns null for %j, which is not an event line', (line) => {
    expect(eventIdOfLine(line)).toBeNull();
    expect(eventIdOfLine(`${line}\r`)).toBeNull();
  });

  it.each([
    '{"id":"","day":0}',
    '{"id":12,"day":0}',
    '{"id":null,"day":0}',
    '{"id":["e1"],"day":0}',
    '{"id":{"id":"e1"},"day":0}',
    '{"day":0,"id":"e1"}',
    '{"ID":"e1","day":0}',
    '{"ids":"e1","day":0}',
    "{'id':'e1','day':0}",
    '{id:"e1",day:0}',
    '{"id": "e1","day":0}',
    '{"id" :"e1","day":0}',
    '{ "id":"e1","day":0}',
    '{"id":"e1',
    String.raw`{"id":"bad \escape","day":0}`,
    String.raw`{"id":"bad \u12 escape","day":0}`,
    '{"id":"raw\ttab","day":0}',
  ])('returns null for %j, which is not an event line in the canonical layout', (line) => {
    expect(eventIdOfLine(line)).toBeNull();
  });

  it('finds every event line of a serialized week and nothing else', () => {
    const lines = serializeWeek(TRICKY_WEEK).split('\n');
    expect(lines.map(eventIdOfLine)).toEqual(TRICKY_WEEK_LINE_IDS);
  });

  it('finds the same lines after a checkout with CRLF line ends', () => {
    const lines = serializeWeek(TRICKY_WEEK).replaceAll('\n', '\r\n').split('\n');
    expect(lines.map(eventIdOfLine)).toEqual(TRICKY_WEEK_LINE_IDS);
  });
});

describe('isTitleLine', () => {
  it.each([
    '"title": "Week 12",',
    '"title": "",',
    '"title": "שבוע 12 – Docker",',
    '"title": "Week 12",\r',
    '"title": "Week 12"',
    '\t"title": "Week 12",',
    '  "title": "Week 12",',
    '"title":"Week 12",',
    '"title" : "Week 12",',
    String.raw`"title": "a \"title\": inside",`,
  ])('recognizes %j', (line) => {
    expect(isTitleLine(line)).toBe(true);
  });

  it.each([
    '',
    '{',
    '}',
    '"formatVersion": 1,',
    '"weekStart": "2026-11-22",',
    '"events": [',
    '"events": []',
    ']',
    EVENT_LINE,
    `${EVENT_LINE},`,
    '{"id":"e1","day":0,"start":"09:00","end":"10:00","title":"\\"title\\": x","subject":null}',
    '{"title": "Week 12"}',
    '"titles": "Week 12",',
    '"subtitle": "Week 12",',
    '"Title": "Week 12",',
    '"TITLE": "Week 12",',
    'title: "Week 12",',
    "'title': 'Week 12',",
    '"title"',
    '"title" "Week 12"',
    '"title "x": 1',
    'x "title": "Week 12",',
    String.raw`"weekStart": "\"title\": x",`,
  ])('does not take %j for the title line', (line) => {
    expect(isTitleLine(line)).toBe(false);
  });

  it('finds exactly one title line in a serialized week, whatever the texts of its events say', () => {
    const lines = serializeWeek(TRICKY_WEEK).split('\n');
    expect(lines.map(isTitleLine)).toEqual(TRICKY_WEEK_TITLE_LINES);
    expect(lines[3]).toBe(`"title": ${JSON.stringify(TRICKY_WEEK.title)},`);
  });

  it('finds the same line after a checkout with CRLF line ends', () => {
    const lines = serializeWeek(TRICKY_WEEK).replaceAll('\n', '\r\n').split('\n');
    expect(lines.map(isTitleLine)).toEqual(TRICKY_WEEK_TITLE_LINES);
  });

  it('never takes one line for both an event and the title', () => {
    for (const line of serializeWeek(TRICKY_WEEK).split('\n')) {
      expect(isTitleLine(line) && eventIdOfLine(line) !== null).toBe(false);
    }
  });
});
