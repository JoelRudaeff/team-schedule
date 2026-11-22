import { describe, expect, it, vi } from 'vitest';
import { localDateTime } from '@shared/dates';
import {
  buildIcs,
  collectIcsEvents,
  escapeIcsText,
  foldIcsLine,
  formatIcsUtc,
  type IcsEvent,
  type IcsLabels,
} from '@shared/ics';
import type { Dataset, IsoDate, Minutes, ScheduleEvent } from '@shared/types';

// ───────────────────────────── helpers ─────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Size in UTF-8, measured by the platform's own encoder (the implementation does its own arithmetic). */
function octets(text: string): number {
  return encoder.encode(text).length;
}

/** RFC 5545 unfolding: a line break followed by one space or tab disappears. */
function unfold(text: string): string {
  return text.replace(/\r\n[ \t]/g, '');
}

/** The logical content lines of a calendar (unfolded, without the final empty piece). */
function contentLines(ics: string): string[] {
  return unfold(ics).split('\r\n').slice(0, -1);
}

function utc(date: IsoDate, minutes: Minutes, offsetHours: number): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 0, minutes) - offsetHours * 3_600_000);
}

/** Wall clock of a zone that is always two hours ahead of UTC (Israel in winter). */
const plusTwo = (date: IsoDate, minutes: Minutes): Date => utc(date, minutes, 2);
/** Wall clock = UTC. */
const zulu = (date: IsoDate, minutes: Minutes): Date => utc(date, minutes, 0);

const NOW = new Date('2026-11-21T10:15:00.000Z');

function icsEvent(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: 'e1-2026-11-22@team-schedule',
    date: '2026-11-22',
    start: 540,
    end: 600,
    summary: 'Lesson',
    location: '',
    description: '',
    categories: [],
    ...overrides,
  };
}

function build(events: readonly IcsEvent[], calendarName = 'Team'): string {
  return buildIcs(events, { calendarName, now: NOW, toInstant: plusTwo });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value) as unknown[]) deepFreeze(child);
  }
  return value;
}

// ───────────────────────────── escapeIcsText ─────────────────────────────

describe('escapeIcsText', () => {
  it.each([
    ['comma', 'a,b', 'a\\,b'],
    ['semicolon', 'a;b', 'a\\;b'],
    ['backslash', 'a\\b', 'a\\\\b'],
    ['newline', 'line 1\nline 2', 'line 1\\nline 2'],
    ['Windows newline', 'line 1\r\nline 2', 'line 1\\nline 2'],
    ['several newlines', 'a\n\nb\n', 'a\\n\\nb\\n'],
    ['Hebrew with punctuation', 'שלום, עולם; כן', 'שלום\\, עולם\\; כן'],
    ['nothing to escape', 'Room 101: "Lab" (2nd floor) 😀', 'Room 101: "Lab" (2nd floor) 😀'],
    ['empty text', '', ''],
  ])('%s', (_name, input, expected) => {
    expect(escapeIcsText(input)).toBe(expected);
  });

  it('drops a carriage return that stands alone', () => {
    expect(escapeIcsText('old\rmac')).toBe('oldmac');
  });

  it('keeps a typed backslash apart from the escapes it adds', () => {
    // C:\new must not turn into "C:" + line break + "ew" when a calendar reads it back.
    expect(escapeIcsText('C:\\new')).toBe('C:\\\\new');
    expect(escapeIcsText('a\\,b')).toBe('a\\\\\\,b');
    expect(escapeIcsText('a\\\nb')).toBe('a\\\\\\nb');
  });

  it('drops the control characters a calendar file must not contain, but keeps tabs', () => {
    expect(escapeIcsText('a\u0000b\u0007c\u000bd\u000ce\u001ff\u007fg')).toBe('abcdefg');
    expect(escapeIcsText('a\tb')).toBe('a\tb');
  });
});

// ───────────────────────────── foldIcsLine ─────────────────────────────

describe('foldIcsLine', () => {
  it('leaves a line of at most 75 octets alone', () => {
    const ascii = 'A'.repeat(75);
    // 37 Hebrew letters (two octets each) + 1 = 75 octets in only 38 characters.
    const hebrew = `${'ש'.repeat(37)}!`;
    expect(octets(hebrew)).toBe(75);
    expect(foldIcsLine('')).toBe('');
    expect(foldIcsLine('SUMMARY:Lesson')).toBe('SUMMARY:Lesson');
    expect(foldIcsLine(ascii)).toBe(ascii);
    expect(foldIcsLine(hebrew)).toBe(hebrew);
  });

  it('breaks after the 75th octet and starts the continuation with one space', () => {
    expect(foldIcsLine('A'.repeat(76))).toBe(`${'A'.repeat(75)}\r\n A`);
  });

  it('counts the leading space as part of a continuation line', () => {
    const pieces = foldIcsLine('x'.repeat(75 + 74 + 74 + 1)).split('\r\n');
    expect(pieces).toEqual(['x'.repeat(75), ` ${'x'.repeat(74)}`, ` ${'x'.repeat(74)}`, ' x']);
  });

  it('does not add an empty continuation when the text ends exactly at the limit', () => {
    expect(foldIcsLine('x'.repeat(75 + 74)).split('\r\n')).toEqual(['x'.repeat(75), ` ${'x'.repeat(74)}`]);
  });

  it('counts octets, not characters', () => {
    // 38 Hebrew letters are 38 characters but 76 octets.
    expect(foldIcsLine('א'.repeat(38))).toBe(`${'א'.repeat(37)}\r\n א`);
    // 19 emoji are 38 UTF-16 units but 76 octets.
    expect(foldIcsLine('😀'.repeat(19))).toBe(`${'😀'.repeat(18)}\r\n 😀`);
  });

  it('moves a character that no longer fits to the next line as a whole', () => {
    // Two-octet letter after 74 octets, three-octet sign after 73, four-octet emoji after 72.
    expect(foldIcsLine(`${'A'.repeat(74)}ש`)).toBe(`${'A'.repeat(74)}\r\n ש`);
    expect(foldIcsLine(`${'A'.repeat(73)}€`)).toBe(`${'A'.repeat(73)}\r\n €`);
    expect(foldIcsLine(`${'A'.repeat(72)}😀`)).toBe(`${'A'.repeat(72)}\r\n 😀`);
  });

  it('fills a line completely when the last character ends exactly on octet 75', () => {
    for (const line of [`${'A'.repeat(73)}ש`, `${'A'.repeat(72)}€`, `${'A'.repeat(71)}😀`]) {
      expect(octets(line)).toBe(75);
      expect(foldIcsLine(line)).toBe(line);
    }
  });

  it('keeps every line within 75 octets, splits no character and loses nothing, at every alignment', () => {
    const samples = [
      'שיעור מבוא לרשתות תקשורת: שכבות, כתובות, ניתוב ומיתוג; כולל תרגול מעשי במעבדה עם כל הכיתה. '.repeat(3),
      '😀🎉👩‍🏫🧑🏽‍💻🇮🇱✅'.repeat(12),
      'Docker basics – מבוא ל-Docker 🐳, חלק א׳ (“containers”) → images; volumes\\, networks… '.repeat(4),
      'x'.repeat(400),
    ];
    for (const sample of samples) {
      for (let prefix = 0; prefix <= 80; prefix++) {
        const line = 'P'.repeat(prefix) + sample;
        const folded = foldIcsLine(line);
        const pieces = folded.split('\r\n');

        expect(unfold(folded)).toBe(line);
        expect(pieces.length).toBeGreaterThan(1);
        pieces.forEach((piece, index) => {
          expect(octets(piece)).toBeLessThanOrEqual(75);
          // Half of a surrogate pair would come back from UTF-8 as U+FFFD.
          expect(decoder.decode(encoder.encode(piece))).toBe(piece);
          if (index > 0) expect(piece.startsWith(' ')).toBe(true);
          const next = pieces[index + 1];
          // Lines are filled as far as possible: the next character really did not fit.
          if (next !== undefined) expect(octets(piece) + octets([...next.slice(1)][0])).toBeGreaterThan(75);
        });
      }
    }
  });
});

// ───────────────────────────── formatIcsUtc ─────────────────────────────

describe('formatIcsUtc', () => {
  it('writes the instant in UTC as YYYYMMDDTHHMMSSZ', () => {
    expect(formatIcsUtc(new Date('2026-11-22T07:00:00.000Z'))).toBe('20261122T070000Z');
    expect(formatIcsUtc(new Date('2026-11-22T09:00:00+02:00'))).toBe('20261122T070000Z');
    expect(formatIcsUtc(new Date('2026-12-31T23:59:59.000Z'))).toBe('20261231T235959Z');
  });

  it('pads every part and drops milliseconds', () => {
    expect(formatIcsUtc(new Date('2026-01-05T03:04:09.987Z'))).toBe('20260105T030409Z');
  });

  it('refuses an invalid date instead of writing garbage', () => {
    expect(() => formatIcsUtc(new Date(Number.NaN))).toThrow(RangeError);
  });
});

// ───────────────────────────── buildIcs ─────────────────────────────

describe('buildIcs', () => {
  it('writes a complete calendar with Hebrew text exactly as specified', () => {
    const events: IcsEvent[] = [
      {
        uid: 'q1w2e3r4t5-2026-11-22@team-schedule',
        date: '2026-11-22',
        start: 540,
        end: 630,
        summary: 'מבוא ל-Docker',
        location: 'חדר 101',
        description: 'נושא: מעבדה\nמורים: דנה, יוסי\nכיתות: כיתה א׳\nלהביא מחשב נייד; לא לשכוח מטען וכבל רשת',
        categories: ['מעבדה'],
      },
      {
        uid: 'z9y8x7w6v5-2026-11-22@team-schedule',
        date: '2026-11-28',
        start: 1320,
        end: 1440,
        summary: 'Team meeting, weekly',
        location: '',
        description: '',
        categories: [],
      },
    ];

    const ics = buildIcs(events, { calendarName: 'מערכת שעות, צוות DevOps', now: NOW, toInstant: plusTwo });

    const expected = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Team Schedule//Weekly Schedule//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:מערכת שעות\\, צוות DevOps',
      'BEGIN:VEVENT',
      'UID:q1w2e3r4t5-2026-11-22@team-schedule',
      'DTSTAMP:20261121T101500Z',
      'DTSTART:20261122T070000Z',
      'DTEND:20261122T083000Z',
      'SUMMARY:מבוא ל-Docker',
      'LOCATION:חדר 101',
      // Exactly 75 octets: the colon that follows would be the 76th.
      'DESCRIPTION:נושא: מעבדה\\nמורים: דנה\\, יוסי\\nכיתות',
      // 74 octets: the two-octet letter that follows does not fit any more.
      ' : כיתה א׳\\nלהביא מחשב נייד\\; לא לשכוח מטען ',
      ' וכבל רשת',
      'CATEGORIES:מעבדה',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:z9y8x7w6v5-2026-11-22@team-schedule',
      'DTSTAMP:20261121T101500Z',
      // 22:00 at +02:00, and 24:00 = 00:00 of the 29th at +02:00.
      'DTSTART:20261128T200000Z',
      'DTEND:20261128T220000Z',
      'SUMMARY:Team meeting\\, weekly',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ];
    expect(octets(expected[13])).toBe(75);
    expect(octets(expected[14])).toBe(74);
    expect(ics).toBe(expected.join('\r\n'));
  });

  it('writes only the calendar frame when there are no events', () => {
    expect(build([], 'Empty')).toBe(
      'BEGIN:VCALENDAR\r\n' +
        'VERSION:2.0\r\n' +
        'PRODID:-//Team Schedule//Weekly Schedule//EN\r\n' +
        'CALSCALE:GREGORIAN\r\n' +
        'METHOD:PUBLISH\r\n' +
        'X-WR-CALNAME:Empty\r\n' +
        'END:VCALENDAR\r\n',
    );
  });

  it('ends every line with CRLF, the last one included', () => {
    const ics = build([icsEvent({ description: 'first\nsecond\r\nthird', location: 'Room 1' }), icsEvent({ uid: 'e2' })]);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('omits LOCATION, DESCRIPTION and CATEGORIES when they are empty', () => {
    expect(contentLines(build([icsEvent()])).slice(6)).toEqual([
      'BEGIN:VEVENT',
      'UID:e1-2026-11-22@team-schedule',
      'DTSTAMP:20261121T101500Z',
      'DTSTART:20261122T070000Z',
      'DTEND:20261122T080000Z',
      'SUMMARY:Lesson',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
  });

  it('writes LOCATION, DESCRIPTION and CATEGORIES after SUMMARY, in that order, when they are set', () => {
    const lines = contentLines(
      build([icsEvent({ location: 'Room 101', description: 'Teachers: Dana', categories: ['Lab'] })]),
    );
    expect(lines.slice(11, 16)).toEqual([
      'SUMMARY:Lesson',
      'LOCATION:Room 101',
      'DESCRIPTION:Teachers: Dana',
      'CATEGORIES:Lab',
      'END:VEVENT',
    ]);
  });

  it('decides line by line what to omit', () => {
    const names = (event: IcsEvent): string[] => contentLines(build([event])).map((line) => line.split(':')[0]);
    expect(names(icsEvent({ location: 'Room 101' }))).toContain('LOCATION');
    expect(names(icsEvent({ location: 'Room 101' }))).not.toContain('DESCRIPTION');
    expect(names(icsEvent({ description: 'note' }))).toContain('DESCRIPTION');
    expect(names(icsEvent({ description: 'note' }))).not.toContain('LOCATION');
    expect(names(icsEvent({ categories: ['Lab'] }))).toContain('CATEGORIES');
    expect(names(icsEvent({ categories: [''] }))).not.toContain('CATEGORIES');
  });

  it('escapes comma, semicolon, backslash and newlines in every text value', () => {
    const tricky = 'a,b;c\\d\ne\r\nf';
    const escaped = 'a\\,b\\;c\\\\d\\ne\\nf';
    const lines = contentLines(
      buildIcs([icsEvent({ summary: tricky, location: tricky, description: tricky, categories: [tricky] })], {
        calendarName: tricky,
        now: NOW,
        toInstant: plusTwo,
      }),
    );
    expect(lines).toContain(`X-WR-CALNAME:${escaped}`);
    expect(lines).toContain(`SUMMARY:${escaped}`);
    expect(lines).toContain(`LOCATION:${escaped}`);
    expect(lines).toContain(`DESCRIPTION:${escaped}`);
    expect(lines).toContain(`CATEGORIES:${escaped}`);
  });

  it('separates categories with a plain comma and escapes commas inside a category', () => {
    const lines = contentLines(build([icsEvent({ categories: ['Lab, advanced', 'Exam; final', 'מעבדה'] })]));
    expect(lines).toContain('CATEGORIES:Lab\\, advanced,Exam\\; final,מעבדה');
  });

  it('keeps a strange id from breaking the file', () => {
    const lines = contentLines(build([icsEvent({ uid: 'a,b;c\nBEGIN:VEVENT-2026-11-22@team-schedule' })]));
    expect(lines).toContain('UID:a\\,b\\;c\\nBEGIN:VEVENT-2026-11-22@team-schedule');
    expect(lines.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1);
  });

  it('writes the events in the order they are given', () => {
    const lines = contentLines(
      build([
        icsEvent({ uid: 'late', date: '2026-11-25', summary: 'Late' }),
        icsEvent({ uid: 'early', date: '2026-11-22', summary: 'Early' }),
      ]),
    );
    expect(lines.filter((line) => line.startsWith('UID:'))).toEqual(['UID:late', 'UID:early']);
    expect(lines.filter((line) => line.startsWith('DTSTART:'))).toEqual([
      'DTSTART:20261125T070000Z',
      'DTSTART:20261122T070000Z',
    ]);
  });

  it('stamps every event with the given "now"', () => {
    const lines = contentLines(build([icsEvent({ uid: 'a' }), icsEvent({ uid: 'b' })]));
    expect(lines.filter((line) => line.startsWith('DTSTAMP:'))).toEqual([
      'DTSTAMP:20261121T101500Z',
      'DTSTAMP:20261121T101500Z',
    ]);
  });

  it('turns an end of 24:00 into 00:00 of the next day, also across a year end', () => {
    const toInstant = vi.fn(zulu);
    const lines = contentLines(
      buildIcs([icsEvent({ date: '2026-12-31', start: 1380, end: 1440 })], { calendarName: 'T', now: NOW, toInstant }),
    );
    expect(lines).toContain('DTSTART:20261231T230000Z');
    expect(lines).toContain('DTEND:20270101T000000Z');
    // The converter is asked for 00:00 of 1 January, never for minute 1440 of 31 December.
    expect(toInstant.mock.calls).toHaveLength(2);
    expect(toInstant.mock.calls).toContainEqual(['2026-12-31', 1380]);
    expect(toInstant.mock.calls).toContainEqual(['2027-01-01', 0]);
  });

  it('only ever asks the converter for a minute from 0 to 1439', () => {
    const toInstant = vi.fn(zulu);
    buildIcs(
      [
        icsEvent({ uid: 'whole-day', date: '2026-11-22', start: 0, end: 1440 }),
        icsEvent({ uid: 'last-minute', date: '2026-11-28', start: 1439, end: 1440 }),
        icsEvent({ uid: 'first-minute', date: '2026-11-29', start: 0, end: 1 }),
        icsEvent({ uid: 'leap-day', date: '2028-02-28', start: 1200, end: 1440 }),
      ],
      { calendarName: 'T', now: NOW, toInstant },
    );
    expect(toInstant.mock.calls).toHaveLength(8);
    for (const [, minutes] of toInstant.mock.calls) {
      expect(minutes).toBeGreaterThanOrEqual(0);
      expect(minutes).toBeLessThanOrEqual(1439);
    }
    expect(toInstant.mock.calls).toContainEqual(['2026-11-23', 0]);
    expect(toInstant.mock.calls).toContainEqual(['2026-11-29', 0]);
    expect(toInstant.mock.calls).toContainEqual(['2028-02-29', 0]);
  });

  it('converts every event with the offset that applies on its own date', () => {
    // A zone that switches from +03:00 to +02:00 on 25 October, like Israel in 2026.
    const seasonal = (date: IsoDate, minutes: Minutes): Date => utc(date, minutes, date < '2026-10-25' ? 3 : 2);
    const lines = contentLines(
      buildIcs(
        [
          icsEvent({ uid: 'summer', date: '2026-10-24', start: 540, end: 600 }),
          icsEvent({ uid: 'winter', date: '2026-10-25', start: 540, end: 600 }),
          // Ends at the midnight on which the clocks change: the end belongs to the new offset.
          icsEvent({ uid: 'night', date: '2026-10-24', start: 1380, end: 1440 }),
        ],
        { calendarName: 'T', now: NOW, toInstant: seasonal },
      ),
    );
    expect(lines.filter((line) => /^DT(START|END):/.test(line))).toEqual([
      'DTSTART:20261024T060000Z',
      'DTEND:20261024T070000Z',
      'DTSTART:20261025T070000Z',
      'DTEND:20261025T080000Z',
      'DTSTART:20261024T200000Z',
      'DTEND:20261024T220000Z',
    ]);
  });

  it("uses this computer's time zone when no converter is given", () => {
    const lines = contentLines(
      buildIcs([icsEvent({ date: '2026-07-14', start: 615, end: 1440 })], { calendarName: 'T', now: NOW }),
    );
    expect(lines).toContain(`DTSTART:${formatIcsUtc(localDateTime('2026-07-14', 615))}`);
    expect(lines).toContain(`DTEND:${formatIcsUtc(localDateTime('2026-07-15', 0))}`);
  });

  it('folds long lines so that no physical line is longer than 75 octets', () => {
    const description = 'סיכום השיעור: התקנה, הגדרות ראשוניות, בדיקות; שאלות ותשובות 🙂\n'.repeat(6);
    const ics = build([icsEvent({ summary: 'ש'.repeat(60), description })], 'לוח '.repeat(30));
    const physical = ics.split('\r\n');
    expect(physical.length).toBeGreaterThan(contentLines(ics).length + 1);
    for (const line of physical) expect(octets(line)).toBeLessThanOrEqual(75);
    expect(contentLines(ics)).toContain(`DESCRIPTION:${escapeIcsText(description)}`);
    expect(contentLines(ics)).toContain(`SUMMARY:${'ש'.repeat(60)}`);
  });

  it('does not modify the events it is given', () => {
    const events = deepFreeze([icsEvent({ categories: ['Lab'], end: 1440 })]);
    expect(() => build(events)).not.toThrow();
  });
});

// ───────────────────────────── collectIcsEvents ─────────────────────────────

const WEEK_A = '2026-11-22';
const WEEK_B = '2026-11-29';

const LABELS: IcsLabels = { teachers: 'Teachers', classes: 'Classes', subject: 'Subject', untitled: 'Event' };

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

/** A schedule whose lists are deliberately NOT in id order. */
function datasetWith(weeks: Record<IsoDate, ScheduleEvent[]>): Dataset {
  return deepFreeze({
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
        { id: 't-zed', name: 'Dana' },
        { id: 't-abe', name: 'יוסי' },
        { id: 't-mid', name: 'Noa' },
      ],
      classes: [
        { id: 'c-9', name: 'Class 1' },
        { id: 'c-1', name: 'Class 2' },
      ],
    },
    weeks: Object.fromEntries(
      Object.entries(weeks).map(([weekStart, events]) => [weekStart, { weekStart, title: '', events }]),
    ),
  });
}

function collect(dataset: Dataset, weekStarts: readonly IsoDate[] = [WEEK_A]): IcsEvent[] {
  return collectIcsEvents({ dataset, weekStarts, labels: LABELS });
}

function collectOne(event: ScheduleEvent): IcsEvent {
  const collected = collect(datasetWith({ [WEEK_A]: [event] }));
  expect(collected).toHaveLength(1);
  return collected[0];
}

describe('collectIcsEvents', () => {
  it('turns a full event into a calendar entry', () => {
    const entry = collectOne(
      scheduleEvent({
        id: 'q1w2e3r4t5',
        day: 3,
        start: 555,
        end: 645,
        title: 'Docker basics',
        subjectId: 's-lab',
        locationId: 'l-101',
        teacherIds: ['t-abe', 't-zed'],
        classIds: ['c-1'],
        notes: 'Bring a laptop',
      }),
    );
    expect(entry).toEqual({
      uid: 'q1w2e3r4t5-2026-11-22@team-schedule',
      date: '2026-11-25',
      start: 555,
      end: 645,
      summary: 'Docker basics',
      location: 'Room 101',
      description: 'Subject: Lab\nTeachers: Dana, יוסי\nClasses: Class 2\nBring a laptop',
      categories: ['Lab'],
    });
  });

  it('builds the uid from the event id and the week, so the same event keeps its uid', () => {
    const dataset = datasetWith({ [WEEK_A]: [scheduleEvent({ id: 'abc' })], [WEEK_B]: [scheduleEvent({ id: 'abc' })] });
    expect(collect(dataset, [WEEK_A, WEEK_B]).map((entry) => entry.uid)).toEqual([
      'abc-2026-11-22@team-schedule',
      'abc-2026-11-29@team-schedule',
    ]);
    expect(collect(dataset, [WEEK_A])[0].uid).toBe(collect(dataset, [WEEK_A])[0].uid);
  });

  it('puts each event on weekStart + day, across month and year ends', () => {
    const days = [0, 1, 2, 3, 4, 5, 6] as const;
    const dataset = datasetWith({
      [WEEK_B]: days.map((day) => scheduleEvent({ id: `e${day}`, day })),
      '2026-12-27': [scheduleEvent({ id: 'newyear', day: 5 })],
    });
    expect(collect(dataset, [WEEK_B]).map((entry) => entry.date)).toEqual([
      '2026-11-29',
      '2026-11-30',
      '2026-12-01',
      '2026-12-02',
      '2026-12-03',
      '2026-12-04',
      '2026-12-05',
    ]);
    expect(collect(dataset, ['2026-12-27'])[0].date).toBe('2027-01-01');
  });

  it('passes start and end through, 24:00 included', () => {
    const entry = collectOne(scheduleEvent({ id: 'e', start: 1325, end: 1440 }));
    expect([entry.start, entry.end]).toEqual([1325, 1440]);
  });

  describe('summary', () => {
    it('is the title when there is one', () => {
      expect(collectOne(scheduleEvent({ id: 'e', title: 'Docker basics', subjectId: 's-lab' })).summary).toBe(
        'Docker basics',
      );
    });

    it('falls back to the subject name', () => {
      expect(collectOne(scheduleEvent({ id: 'e', subjectId: 's-lecture' })).summary).toBe('הרצאה');
      expect(collectOne(scheduleEvent({ id: 'e', title: '   ', subjectId: 's-lab' })).summary).toBe('Lab');
    });

    it('falls back to the "untitled" label when there is no usable subject either', () => {
      expect(collectOne(scheduleEvent({ id: 'e' })).summary).toBe('Event');
      expect(collectOne(scheduleEvent({ id: 'e', subjectId: 'deleted' })).summary).toBe('Event');
    });
  });

  describe('description', () => {
    it('lists subject, teachers, classes and notes in that order, one per line', () => {
      const entry = collectOne(
        scheduleEvent({
          id: 'e',
          title: 'Review',
          subjectId: 's-lecture',
          teacherIds: ['t-mid'],
          classIds: ['c-1', 'c-9'],
          notes: 'line one\nline two',
        }),
      );
      expect(entry.description.split('\n')).toEqual([
        'Subject: הרצאה',
        'Teachers: Noa',
        'Classes: Class 1, Class 2',
        'line one',
        'line two',
      ]);
    });

    it('leaves out the subject line when the subject already is the summary', () => {
      const entry = collectOne(scheduleEvent({ id: 'e', subjectId: 's-lab', teacherIds: ['t-zed'] }));
      expect(entry.summary).toBe('Lab');
      expect(entry.description).toBe('Teachers: Dana');
    });

    it('contains only the lines that apply', () => {
      expect(collectOne(scheduleEvent({ id: 'e', title: 'Solo' })).description).toBe('');
      expect(collectOne(scheduleEvent({ id: 'e', title: 'Solo', subjectId: 's-lab' })).description).toBe(
        'Subject: Lab',
      );
      expect(collectOne(scheduleEvent({ id: 'e', title: 'Solo', classIds: ['c-9'] })).description).toBe(
        'Classes: Class 1',
      );
      expect(collectOne(scheduleEvent({ id: 'e', title: 'Solo', notes: 'just notes' })).description).toBe(
        'just notes',
      );
      expect(collectOne(scheduleEvent({ id: 'e', title: 'Solo', teacherIds: ['t-abe'], notes: 'n' })).description).toBe(
        'Teachers: יוסי\nn',
      );
    });

    it('names teachers and classes in the order of the schedule lists, not in id order', () => {
      const entry = collectOne(
        scheduleEvent({ id: 'e', title: 'All', teacherIds: ['t-abe', 't-mid', 't-zed'], classIds: ['c-1', 'c-9'] }),
      );
      expect(entry.description).toBe('Teachers: Dana, יוסי, Noa\nClasses: Class 1, Class 2');
    });

    it('uses the given labels', () => {
      const dataset = datasetWith({
        [WEEK_A]: [
          scheduleEvent({ id: 'e', title: 'מבוא', subjectId: 's-lecture', teacherIds: ['t-abe'], classIds: ['c-9'] }),
          scheduleEvent({ id: 'f', start: 600, end: 660 }),
        ],
      });
      const labels: IcsLabels = { teachers: 'מורים', classes: 'כיתות', subject: 'נושא', untitled: 'אירוע' };
      const [first, second] = collectIcsEvents({ dataset, weekStarts: [WEEK_A], labels });
      expect(first.description).toBe('נושא: הרצאה\nמורים: יוסי\nכיתות: Class 1');
      expect(second.summary).toBe('אירוע');
    });
  });

  it('silently skips references to entries that were deleted', () => {
    const entry = collectOne(
      scheduleEvent({
        id: 'e',
        title: 'Orphan',
        subjectId: 'gone-subject',
        locationId: 'gone-location',
        teacherIds: ['gone-teacher', 't-zed'],
        classIds: ['gone-class'],
      }),
    );
    expect(entry).toMatchObject({
      summary: 'Orphan',
      location: '',
      description: 'Teachers: Dana',
      categories: [],
    });
  });

  it('gives the location name, or an empty text when there is none', () => {
    expect(collectOne(scheduleEvent({ id: 'e', locationId: 'l-lab' })).location).toBe('מעבדה 2');
    expect(collectOne(scheduleEvent({ id: 'e' })).location).toBe('');
  });

  it('puts the subject name into the categories', () => {
    expect(collectOne(scheduleEvent({ id: 'e', title: 'T', subjectId: 's-lecture' })).categories).toEqual(['הרצאה']);
    expect(collectOne(scheduleEvent({ id: 'e', subjectId: 's-lab' })).categories).toEqual(['Lab']);
    expect(collectOne(scheduleEvent({ id: 'e', title: 'T' })).categories).toEqual([]);
  });

  it('exports only the events the filter lets through', () => {
    const dataset = datasetWith({
      [WEEK_A]: [
        scheduleEvent({ id: 'a1', locationId: 'l-101' }),
        scheduleEvent({ id: 'a2', start: 600, end: 660, locationId: 'l-lab' }),
      ],
      [WEEK_B]: [scheduleEvent({ id: 'b1', locationId: 'l-101' })],
    });
    const include = vi.fn((event: ScheduleEvent, weekStart: IsoDate) => event.locationId === 'l-101' && weekStart === WEEK_A);

    const collected = collectIcsEvents({ dataset, weekStarts: [WEEK_A, WEEK_B], include, labels: LABELS });

    expect(collected.map((entry) => entry.uid)).toEqual(['a1-2026-11-22@team-schedule']);
    expect(include.mock.calls.map(([event, weekStart]) => [event.id, weekStart])).toEqual([
      ['a1', WEEK_A],
      ['a2', WEEK_A],
      ['b1', WEEK_B],
    ]);
  });

  it('orders by date, then by start time, whatever order the weeks and events come in', () => {
    const dataset = datasetWith({
      [WEEK_A]: [
        scheduleEvent({ id: 'a-tue-late', day: 2, start: 900, end: 960 }),
        scheduleEvent({ id: 'a-tue-early', day: 2, start: 480, end: 540 }),
        scheduleEvent({ id: 'a-sun', day: 0, start: 1200, end: 1260 }),
      ],
      [WEEK_B]: [
        scheduleEvent({ id: 'b-mon', day: 1, start: 480, end: 540 }),
        scheduleEvent({ id: 'b-sun', day: 0, start: 600, end: 660 }),
      ],
    });
    const ids = collect(dataset, [WEEK_B, WEEK_A]).map((entry) => entry.uid.split('-2026')[0]);
    expect(ids).toEqual(['a-sun', 'a-tue-early', 'a-tue-late', 'b-sun', 'b-mon']);
  });

  it('keeps the week order of events that share date and start time', () => {
    const dataset = datasetWith({
      [WEEK_A]: [
        scheduleEvent({ id: 'short', start: 540, end: 570 }),
        scheduleEvent({ id: 'long', start: 540, end: 720 }),
        scheduleEvent({ id: 'another', start: 540, end: 720 }),
      ],
    });
    expect(collect(dataset).map((entry) => entry.uid.split('-2026')[0])).toEqual(['short', 'long', 'another']);
  });

  it('ignores weeks that are not in the dataset', () => {
    const dataset = datasetWith({ [WEEK_A]: [scheduleEvent({ id: 'only' })] });
    expect(collect(dataset, ['2026-11-15', WEEK_A, '2027-01-03']).map((entry) => entry.uid)).toEqual([
      'only-2026-11-22@team-schedule',
    ]);
    expect(collect(dataset, ['2027-01-03'])).toEqual([]);
    expect(collect(dataset, [])).toEqual([]);
  });

  it('exports a week once even when it is listed twice', () => {
    const dataset = datasetWith({ [WEEK_A]: [scheduleEvent({ id: 'only' })] });
    expect(collect(dataset, [WEEK_A, WEEK_A])).toHaveLength(1);
  });

  it('feeds buildIcs: a Hebrew week becomes a valid calendar file', () => {
    const dataset = datasetWith({
      [WEEK_A]: [
        scheduleEvent({
          id: 'q1w2e3r4t5',
          day: 1,
          start: 600,
          end: 690,
          title: 'מבוא, חלק א׳',
          subjectId: 's-lecture',
          locationId: 'l-lab',
          teacherIds: ['t-abe'],
          classIds: ['c-9', 'c-1'],
          notes: 'להביא מחשב',
        }),
      ],
    });
    const labels: IcsLabels = { teachers: 'מורים', classes: 'כיתות', subject: 'נושא', untitled: 'אירוע' };
    const ics = buildIcs(collectIcsEvents({ dataset, weekStarts: [WEEK_A], labels }), {
      calendarName: 'DevOps 2026',
      now: NOW,
      toInstant: plusTwo,
    });
    expect(ics).toBe(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Team Schedule//Weekly Schedule//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:DevOps 2026',
        'BEGIN:VEVENT',
        'UID:q1w2e3r4t5-2026-11-22@team-schedule',
        'DTSTAMP:20261121T101500Z',
        'DTSTART:20261123T080000Z',
        'DTEND:20261123T093000Z',
        'SUMMARY:מבוא\\, חלק א׳',
        'LOCATION:מעבדה 2',
        // Exactly 75 octets, so the escaped comma starts the continuation line.
        'DESCRIPTION:נושא: הרצאה\\nמורים: יוסי\\nכיתות: Class 1',
        ' \\, Class 2\\nלהביא מחשב',
        'CATEGORIES:הרצאה',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    );
  });
});
