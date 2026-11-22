/** Calendar, week-number and time-of-day helpers. */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarWeeksInYear,
  ceilToStep,
  clamp,
  compareDates,
  courseWeekCount,
  dayOfWeek,
  diffDays,
  floorToStep,
  isDateInCourse,
  isValidIsoDate,
  isWeekStart,
  isoToLocalNoon,
  localDateTime,
  maxWeekNumber,
  minutesToHHMM,
  parseHHMM,
  roundToStep,
  timeOptions,
  toIsoDate,
  todayIso,
  weekDates,
  weekNumberOf,
  weekStartForNumber,
  weekStartOf,
  yearOf,
} from '@shared/dates';
import type { CourseInfo } from '@shared/types';

const NO_COURSE: CourseInfo = { name: '', startDate: null, endDate: null };

function course(startDate: string | null, endDate: string | null): CourseInfo {
  return { name: 'DevOps', startDate, endDate };
}

describe('isValidIsoDate', () => {
  it.each(['2026-11-22', '2024-02-29', '2000-02-29', '1900-01-01', '2999-12-31', '2026-01-31', '2026-12-31'])(
    'accepts %s',
    (value) => {
      expect(isValidIsoDate(value)).toBe(true);
    },
  );

  it.each([
    '2026-02-30',
    '2023-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-01-32',
    '2026-1-1',
    '26-01-01',
    '2026/01/01',
    ' 2026-01-01',
    '2026-01-01 ',
    '2026-01-01T00:00',
    '2026-01-01\n',
    '1899-12-31',
    '3000-01-01',
    '0000-01-01',
    '',
    'today',
  ])('rejects %j', (value) => {
    expect(isValidIsoDate(value)).toBe(false);
  });

  it('rejects everything that is not a string', () => {
    for (const value of [20260101, null, undefined, {}, [], ['2026-11-22'], new Date(0), true]) {
      expect(isValidIsoDate(value)).toBe(false);
    }
  });
});

describe('addDays / diffDays', () => {
  it('crosses month boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-04-30', 1)).toBe('2026-05-01');
    expect(addDays('2026-11-22', 0)).toBe('2026-11-22');
  });

  it('crosses year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2026-12-27', 6)).toBe('2027-01-02');
    expect(addDays('2026-06-15', 365)).toBe('2027-06-15');
  });

  it('knows leap days', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
    expect(addDays('2024-02-29', 365)).toBe('2025-02-28');
    expect(addDays('2024-02-29', 366)).toBe('2025-03-01');
    // 1900 and 2100 are not leap years, 2000 is.
    expect(addDays('2100-02-28', 1)).toBe('2100-03-01');
    expect(addDays('2000-02-28', 1)).toBe('2000-02-29');
  });

  it('is not disturbed by daylight-saving switches (Israel: 27 Mar and 25 Oct 2026)', () => {
    expect(addDays('2026-03-26', 1)).toBe('2026-03-27');
    expect(addDays('2026-03-27', 1)).toBe('2026-03-28');
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(diffDays('2026-03-20', '2026-04-03')).toBe(14);
    expect(diffDays('2026-10-18', '2026-11-01')).toBe(14);
  });

  it('diffDays is b - a', () => {
    expect(diffDays('2026-11-22', '2026-11-22')).toBe(0);
    expect(diffDays('2026-11-22', '2026-11-29')).toBe(7);
    expect(diffDays('2026-11-29', '2026-11-22')).toBe(-7);
    expect(diffDays('2026-12-31', '2027-01-01')).toBe(1);
    expect(diffDays('2024-01-01', '2025-01-01')).toBe(366);
    expect(diffDays('2025-01-01', '2026-01-01')).toBe(365);
    expect(diffDays('2024-02-28', '2024-03-01')).toBe(2);
    expect(diffDays('2023-02-28', '2023-03-01')).toBe(1);
  });

  it('addDays and diffDays are inverse over a long range', () => {
    let date = '2023-12-25';
    for (let i = 0; i < 1200; i++) {
      const next = addDays(date, 1);
      expect(diffDays(date, next)).toBe(1);
      expect(addDays(next, -1)).toBe(date);
      expect(isValidIsoDate(next)).toBe(true);
      expect(next > date).toBe(true);
      date = next;
    }
    expect(diffDays('2023-12-25', date)).toBe(1200);
    expect(addDays('2023-12-25', 1200)).toBe(date);
  });

  it('throws a RangeError for text that is not a date', () => {
    expect(() => addDays('nonsense', 1)).toThrow(RangeError);
    expect(() => diffDays('2026-11-22', '22/11/2026')).toThrow(RangeError);
    expect(() => weekStartOf('')).toThrow(RangeError);
  });
});

describe('small date helpers', () => {
  it('toIsoDate pads and normalises overflow', () => {
    expect(toIsoDate(2026, 1, 5)).toBe('2026-01-05');
    expect(toIsoDate(2026, 12, 31)).toBe('2026-12-31');
    expect(toIsoDate(2026, 13, 1)).toBe('2027-01-01');
    expect(toIsoDate(2026, 2, 29)).toBe('2026-03-01');
  });

  it('compareDates', () => {
    expect(compareDates('2026-11-22', '2026-11-23')).toBe(-1);
    expect(compareDates('2026-11-23', '2026-11-22')).toBe(1);
    expect(compareDates('2026-11-22', '2026-11-22')).toBe(0);
    expect(compareDates('2026-12-31', '2027-01-01')).toBe(-1);
  });

  it('dayOfWeek is Sunday-based', () => {
    expect(dayOfWeek('2026-11-22')).toBe(0);
    expect(dayOfWeek('2026-11-23')).toBe(1);
    expect(dayOfWeek('2026-11-28')).toBe(6);
    expect(dayOfWeek('2024-02-29')).toBe(4);
    expect(dayOfWeek('2027-01-01')).toBe(5);
    expect(dayOfWeek('2000-01-01')).toBe(6);
  });

  it('isWeekStart', () => {
    expect(isWeekStart('2026-11-22')).toBe(true);
    expect(isWeekStart('2026-11-23')).toBe(false);
    expect(isWeekStart('2026-11-21')).toBe(false);
    expect(isWeekStart('not a date')).toBe(false);
    expect(isWeekStart('2026-02-30')).toBe(false);
  });

  it('weekDates lists Sunday … Saturday', () => {
    expect(weekDates('2026-11-22')).toEqual([
      '2026-11-22',
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
    ]);
    expect(weekDates('2026-12-27')).toEqual([
      '2026-12-27',
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    expect(weekDates('2024-02-25')[4]).toBe('2024-02-29');
  });

  it('yearOf', () => {
    expect(yearOf('2026-11-22')).toBe(2026);
    expect(yearOf('2027-01-01')).toBe(2027);
  });

  it('clamp', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe('weekStartOf', () => {
  it('returns the Sunday on or before the date', () => {
    expect(weekStartOf('2026-11-22')).toBe('2026-11-22');
    expect(weekStartOf('2026-11-23')).toBe('2026-11-22');
    expect(weekStartOf('2026-11-28')).toBe('2026-11-22');
    expect(weekStartOf('2026-11-29')).toBe('2026-11-29');
  });

  it('goes back across a month boundary', () => {
    expect(weekStartOf('2026-12-02')).toBe('2026-11-29');
    expect(weekStartOf('2026-02-28')).toBe('2026-02-22');
    expect(weekStartOf('2026-03-04')).toBe('2026-03-01');
  });

  it('goes back across a year boundary', () => {
    expect(weekStartOf('2027-01-01')).toBe('2026-12-27');
    expect(weekStartOf('2027-01-02')).toBe('2026-12-27');
    expect(weekStartOf('2027-01-03')).toBe('2027-01-03');
    expect(weekStartOf('2026-01-01')).toBe('2025-12-28');
    expect(weekStartOf('2023-01-01')).toBe('2023-01-01');
  });

  it('handles the leap day', () => {
    expect(weekStartOf('2024-02-29')).toBe('2024-02-25');
    expect(weekStartOf('2024-03-02')).toBe('2024-02-25');
    expect(weekStartOf('2024-03-03')).toBe('2024-03-03');
  });

  it('is idempotent and never more than six days back, for every day of 2024-2030', () => {
    for (let date = '2024-01-01'; date <= '2030-12-31'; date = addDays(date, 1)) {
      const start = weekStartOf(date);
      expect(dayOfWeek(start)).toBe(0);
      expect(weekStartOf(start)).toBe(start);
      const back = diffDays(start, date);
      expect(back).toBeGreaterThanOrEqual(0);
      expect(back).toBeLessThanOrEqual(6);
      expect(back).toBe(dayOfWeek(date));
    }
  });
});

describe('todayIso', () => {
  it('uses the local calendar date of the injected clock', () => {
    expect(todayIso(new Date(2026, 10, 22, 12, 0))).toBe('2026-11-22');
    expect(todayIso(new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05');
    expect(todayIso(new Date(2026, 0, 5, 23, 59, 59, 999))).toBe('2026-01-05');
    expect(todayIso(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
    expect(todayIso(new Date(2027, 0, 1, 0, 0))).toBe('2027-01-01');
    expect(todayIso(new Date(2024, 1, 29, 8, 0))).toBe('2024-02-29');
  });

  it('defaults to now and returns a valid date', () => {
    const today = todayIso();
    expect(isValidIsoDate(today)).toBe(true);
    const now = new Date();
    // Around midnight the two readings may differ by a day.
    expect(Math.abs(diffDays(today, todayIso(now)))).toBeLessThanOrEqual(1);
  });
});

describe('isoToLocalNoon / localDateTime', () => {
  it('isoToLocalNoon is noon of that local day', () => {
    const d = isoToLocalNoon('2026-03-27');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 2, 27, 12, 0]);
    expect(() => isoToLocalNoon('27.3.2026')).toThrow(RangeError);
  });

  it('localDateTime puts the wall-clock time on the given day', () => {
    const d = localDateTime('2026-11-22', 570);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([
      2026, 10, 22, 9, 30, 0,
    ]);
    const midnight = localDateTime('2026-11-22', 0);
    expect([midnight.getDate(), midnight.getHours(), midnight.getMinutes()]).toEqual([22, 0, 0]);
    const late = localDateTime('2026-11-22', 1439);
    expect([late.getDate(), late.getHours(), late.getMinutes()]).toEqual([22, 23, 59]);
  });

  it('1440 minutes is 00:00 of the next day, also across month and year ends', () => {
    const a = localDateTime('2026-11-22', 1440);
    expect([a.getFullYear(), a.getMonth(), a.getDate(), a.getHours(), a.getMinutes()]).toEqual([2026, 10, 23, 0, 0]);
    const b = localDateTime('2026-12-31', 1440);
    expect([b.getFullYear(), b.getMonth(), b.getDate(), b.getHours(), b.getMinutes()]).toEqual([2027, 0, 1, 0, 0]);
    const c = localDateTime('2024-02-28', 1440);
    expect([c.getMonth(), c.getDate()]).toEqual([1, 29]);
  });

  it('orders start before end and keeps the duration on ordinary days', () => {
    const start = localDateTime('2026-11-22', 540);
    const end = localDateTime('2026-11-22', 630);
    expect(end.getTime() - start.getTime()).toBe(90 * 60_000);
  });

  it('throws for a malformed date', () => {
    expect(() => localDateTime('2026-11-2', 0)).toThrow(RangeError);
  });
});

describe('course week numbering', () => {
  // 4 Nov 2026 is a Wednesday, 31 Dec 2026 a Thursday.
  const MID_WEEK = course('2026-11-04', '2026-12-31');
  const OPEN_END = course('2026-11-04', null);
  const REVERSED = course('2026-12-31', '2026-11-04');

  it('week 1 is the week that contains the start date, even when the course starts mid-week', () => {
    expect(weekNumberOf('2026-11-01', MID_WEEK)).toEqual({ kind: 'course', number: 1, total: 9 });
    expect(weekNumberOf('2026-11-08', MID_WEEK)).toEqual({ kind: 'course', number: 2, total: 9 });
    expect(weekNumberOf('2026-12-27', MID_WEEK)).toEqual({ kind: 'course', number: 9, total: 9 });
  });

  it('weeks before the course get 0 and negative numbers', () => {
    expect(weekNumberOf('2026-10-25', MID_WEEK).number).toBe(0);
    expect(weekNumberOf('2026-10-18', MID_WEEK).number).toBe(-1);
    expect(weekNumberOf('2025-11-02', MID_WEEK).number).toBe(-51);
  });

  it('weeks after the course keep counting', () => {
    expect(weekNumberOf('2027-01-03', MID_WEEK)).toEqual({ kind: 'course', number: 10, total: 9 });
  });

  it('total is null without an end date and with reversed dates', () => {
    expect(weekNumberOf('2026-11-08', OPEN_END)).toEqual({ kind: 'course', number: 2, total: null });
    expect(weekNumberOf('2026-12-27', REVERSED)).toEqual({ kind: 'course', number: 1, total: null });
  });

  it('courseWeekCount', () => {
    expect(courseWeekCount(MID_WEEK)).toBe(9);
    expect(courseWeekCount(OPEN_END)).toBeNull();
    expect(courseWeekCount(REVERSED)).toBeNull();
    expect(courseWeekCount(NO_COURSE)).toBeNull();
    expect(courseWeekCount(course(null, '2026-12-31'))).toBeNull();
    // one day, one week (Sunday..Saturday), Saturday..Sunday = two weeks
    expect(courseWeekCount(course('2026-11-25', '2026-11-25'))).toBe(1);
    expect(courseWeekCount(course('2026-11-22', '2026-11-28'))).toBe(1);
    expect(courseWeekCount(course('2026-11-28', '2026-11-29'))).toBe(2);
    expect(courseWeekCount(course('2026-11-22', '2026-11-29'))).toBe(2);
    // across a year end and a leap day
    expect(courseWeekCount(course('2023-12-31', '2024-03-02'))).toBe(9);
    expect(courseWeekCount(course('2026-12-30', '2027-01-05'))).toBe(2);
  });

  it('weekStartForNumber resolves 1 … total', () => {
    const ref = '2026-06-07';
    expect(weekStartForNumber(1, MID_WEEK, ref)).toBe('2026-11-01');
    expect(weekStartForNumber(2, MID_WEEK, ref)).toBe('2026-11-08');
    expect(weekStartForNumber(9, MID_WEEK, ref)).toBe('2026-12-27');
    expect(weekStartForNumber(10, MID_WEEK, ref)).toBeNull();
    expect(weekStartForNumber(0, MID_WEEK, ref)).toBeNull();
    expect(weekStartForNumber(-1, MID_WEEK, ref)).toBeNull();
  });

  it('weekStartForNumber rejects numbers that are not whole', () => {
    for (const n of [1.5, NaN, Infinity, -Infinity, 0.999]) {
      expect(weekStartForNumber(n, MID_WEEK, '2026-11-01')).toBeNull();
      expect(weekStartForNumber(n, OPEN_END, '2026-11-01')).toBeNull();
      expect(weekStartForNumber(n, NO_COURSE, '2026-11-01')).toBeNull();
    }
  });

  it('weekStartForNumber is open-ended (within reason) without a usable end date', () => {
    expect(weekStartForNumber(1, OPEN_END, '2026-11-01')).toBe('2026-11-01');
    expect(weekStartForNumber(60, OPEN_END, '2026-11-01')).toBe(addDays('2026-11-01', 59 * 7));
    expect(weekStartForNumber(5200, OPEN_END, '2026-11-01')).toBe(addDays('2026-11-01', 5199 * 7));
    expect(weekStartForNumber(5201, OPEN_END, '2026-11-01')).toBeNull();
    expect(weekStartForNumber(3, REVERSED, '2026-11-01')).toBe('2027-01-10');
  });

  it('round trip for every week of the course', () => {
    for (let n = 1; n <= 9; n++) {
      const start = weekStartForNumber(n, MID_WEEK, '2020-01-05');
      expect(start).not.toBeNull();
      expect(isWeekStart(start as string)).toBe(true);
      expect(weekNumberOf(start as string, MID_WEEK).number).toBe(n);
    }
  });

  it('maxWeekNumber', () => {
    expect(maxWeekNumber(MID_WEEK, '2026-11-01')).toBe(9);
    expect(maxWeekNumber(OPEN_END, '2026-11-01')).toBeNull();
    expect(maxWeekNumber(REVERSED, '2026-11-01')).toBeNull();
  });

  it('a start date on a Sunday or a Saturday still makes that week number 1', () => {
    expect(weekNumberOf('2026-11-22', course('2026-11-22', null)).number).toBe(1);
    expect(weekNumberOf('2026-11-22', course('2026-11-28', null)).number).toBe(1);
    expect(weekNumberOf('2026-11-29', course('2026-11-28', null)).number).toBe(2);
  });

  it('an end date alone does not switch to course numbering', () => {
    expect(weekNumberOf('2026-11-22', course(null, '2026-12-31')).kind).toBe('calendar');
  });
});

describe('calendar week numbering', () => {
  /** Independent count: a week belongs to the year of its Saturday. */
  function saturdaysIn(year: number): number {
    let count = 0;
    const d = new Date(Date.UTC(year, 0, 1));
    while (d.getUTCFullYear() === year) {
      if (d.getUTCDay() === 6) count++;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return count;
  }

  it('the week 2026-12-27 … 2027-01-02 is week 1 of 2027', () => {
    expect(weekNumberOf('2026-12-27', NO_COURSE)).toEqual({ kind: 'calendar', number: 1, year: 2027 });
    expect(weekNumberOf('2026-12-20', NO_COURSE)).toEqual({ kind: 'calendar', number: 52, year: 2026 });
    expect(weekNumberOf('2027-01-03', NO_COURSE)).toEqual({ kind: 'calendar', number: 2, year: 2027 });
  });

  it('known weeks', () => {
    expect(weekNumberOf('2025-12-28', NO_COURSE)).toEqual({ kind: 'calendar', number: 1, year: 2026 });
    expect(weekNumberOf('2026-11-22', NO_COURSE)).toEqual({ kind: 'calendar', number: 48, year: 2026 });
    // 1 Jan 2023 was a Sunday: the year starts exactly on a week start.
    expect(weekNumberOf('2023-01-01', NO_COURSE)).toEqual({ kind: 'calendar', number: 1, year: 2023 });
    expect(weekNumberOf('2022-12-25', NO_COURSE)).toEqual({ kind: 'calendar', number: 53, year: 2022 });
    // 1 Jan 2028 is a Saturday: the week 26 Dec 2027 … 1 Jan 2028 is week 1 of 2028.
    expect(weekNumberOf('2027-12-26', NO_COURSE)).toEqual({ kind: 'calendar', number: 1, year: 2028 });
    expect(weekNumberOf('2028-12-24', NO_COURSE)).toEqual({ kind: 'calendar', number: 53, year: 2028 });
    expect(weekNumberOf('2028-12-31', NO_COURSE)).toEqual({ kind: 'calendar', number: 1, year: 2029 });
  });

  it('calendarWeeksInYear for several years', () => {
    expect(calendarWeeksInYear(2022)).toBe(53);
    expect(calendarWeeksInYear(2023)).toBe(52);
    expect(calendarWeeksInYear(2024)).toBe(52);
    expect(calendarWeeksInYear(2025)).toBe(52);
    expect(calendarWeeksInYear(2026)).toBe(52);
    expect(calendarWeeksInYear(2027)).toBe(52);
    expect(calendarWeeksInYear(2028)).toBe(53);
    expect(calendarWeeksInYear(2029)).toBe(52);
    expect(calendarWeeksInYear(2030)).toBe(52);
  });

  it('calendarWeeksInYear equals the number of Saturdays, 1990-2100', () => {
    for (let year = 1990; year <= 2100; year++) {
      expect([year, calendarWeeksInYear(year)]).toEqual([year, saturdaysIn(year)]);
    }
  });

  it('round trip weekNumberOf <-> weekStartForNumber for every week of 2024-2030', () => {
    let previous: { number: number; year: number } | null = null;
    let weeks = 0;
    for (let start = weekStartOf('2024-01-01'); start <= '2030-12-31'; start = addDays(start, 7)) {
      const wn = weekNumberOf(start, NO_COURSE);
      if (wn.kind !== 'calendar') throw new Error('expected calendar numbering');
      expect(wn.year).toBe(yearOf(addDays(start, 6)));
      expect(wn.number).toBeGreaterThanOrEqual(1);
      expect(wn.number).toBeLessThanOrEqual(calendarWeeksInYear(wn.year));
      expect(maxWeekNumber(NO_COURSE, start)).toBe(calendarWeeksInYear(wn.year));
      // the typed number leads back to the same week …
      expect(weekStartForNumber(wn.number, NO_COURSE, start)).toBe(start);
      // … also when another week of the same year is on screen
      const otherWeekSameYear = weekStartOf(toIsoDate(wn.year, 6, 15));
      expect(weekStartForNumber(wn.number, NO_COURSE, otherWeekSameYear)).toBe(start);
      // numbers are consecutive and restart at 1 with a new year
      if (previous) {
        if (previous.year === wn.year) expect(wn.number).toBe(previous.number + 1);
        else {
          expect(wn.year).toBe(previous.year + 1);
          expect(wn.number).toBe(1);
          expect(previous.number).toBe(calendarWeeksInYear(previous.year));
        }
      }
      previous = { number: wn.number, year: wn.year };
      weeks++;
    }
    expect(weeks).toBeGreaterThan(360);
  });

  it('weekStartForNumber takes the year from the week on screen and checks the range', () => {
    expect(weekStartForNumber(1, NO_COURSE, '2026-11-22')).toBe('2025-12-28');
    expect(weekStartForNumber(52, NO_COURSE, '2026-11-22')).toBe('2026-12-20');
    expect(weekStartForNumber(53, NO_COURSE, '2026-11-22')).toBeNull();
    expect(weekStartForNumber(0, NO_COURSE, '2026-11-22')).toBeNull();
    // the week on screen already belongs to 2027
    expect(weekStartForNumber(1, NO_COURSE, '2026-12-27')).toBe('2026-12-27');
    expect(weekStartForNumber(2, NO_COURSE, '2026-12-27')).toBe('2027-01-03');
    // 2028 has 53 weeks
    expect(weekStartForNumber(53, NO_COURSE, '2028-06-04')).toBe('2028-12-24');
    expect(weekStartForNumber(54, NO_COURSE, '2028-06-04')).toBeNull();
  });

  it('maxWeekNumber follows the year of the week on screen', () => {
    expect(maxWeekNumber(NO_COURSE, '2026-11-22')).toBe(52);
    expect(maxWeekNumber(NO_COURSE, '2028-06-04')).toBe(53);
    expect(maxWeekNumber(NO_COURSE, '2027-12-26')).toBe(53);
    expect(maxWeekNumber(NO_COURSE, '2028-12-31')).toBe(52);
  });
});

describe('isDateInCourse', () => {
  const c = course('2026-11-04', '2026-12-31');

  it('bounds are inclusive', () => {
    expect(isDateInCourse('2026-11-03', c)).toBe(false);
    expect(isDateInCourse('2026-11-04', c)).toBe(true);
    expect(isDateInCourse('2026-12-01', c)).toBe(true);
    expect(isDateInCourse('2026-12-31', c)).toBe(true);
    expect(isDateInCourse('2027-01-01', c)).toBe(false);
  });

  it('unset bounds are open', () => {
    expect(isDateInCourse('1999-01-01', NO_COURSE)).toBe(true);
    expect(isDateInCourse('2020-01-01', course(null, '2026-12-31'))).toBe(true);
    expect(isDateInCourse('2027-01-01', course(null, '2026-12-31'))).toBe(false);
    expect(isDateInCourse('2030-01-01', course('2026-11-04', null))).toBe(true);
    expect(isDateInCourse('2026-11-03', course('2026-11-04', null))).toBe(false);
  });

  it('nothing is inside a reversed range', () => {
    const reversed = course('2026-12-31', '2026-11-04');
    for (const date of ['2026-11-03', '2026-11-04', '2026-12-01', '2026-12-31', '2027-01-01']) {
      expect(isDateInCourse(date, reversed)).toBe(false);
    }
  });
});

describe('parseHHMM', () => {
  it.each([
    ['9:30', 570],
    ['09:30', 570],
    ['0:00', 0],
    ['00:00', 0],
    ['00:01', 1],
    ['12:00', 720],
    ['23:59', 1439],
    ['24:00', 1440],
    [' 09:30 ', 570],
    ['7:05', 425],
  ])('%j -> %i', (text, minutes) => {
    expect(parseHHMM(text)).toBe(minutes);
  });

  it.each([
    '24:01',
    '24:15',
    '25:00',
    '99:00',
    '12:60',
    '12:99',
    '9:5',
    '1:2',
    '930',
    '0930',
    '009:30',
    '9:300',
    '9:30:00',
    '-1:00',
    '9.30',
    '9:3O',
    'ab:cd',
    '9 :30',
    '9: 30',
    '١٢:٠٠',
    '',
    ' ',
    ':',
    ':30',
    '9:',
    'noon',
  ])('rejects %j', (text) => {
    expect(parseHHMM(text)).toBeNull();
  });

  it('rejects everything that is not a string', () => {
    for (const value of [570, null, undefined, {}, ['09:30'], true]) expect(parseHHMM(value)).toBeNull();
  });
});

describe('minutesToHHMM', () => {
  it('formats with two digits, including 24:00', () => {
    expect(minutesToHHMM(0)).toBe('00:00');
    expect(minutesToHHMM(5)).toBe('00:05');
    expect(minutesToHHMM(570)).toBe('09:30');
    expect(minutesToHHMM(720)).toBe('12:00');
    expect(minutesToHHMM(1439)).toBe('23:59');
    expect(minutesToHHMM(1440)).toBe('24:00');
  });

  it('clamps and rounds values a hand-edited file could contain', () => {
    expect(minutesToHHMM(-5)).toBe('00:00');
    expect(minutesToHHMM(2000)).toBe('24:00');
    expect(minutesToHHMM(569.6)).toBe('09:30');
    expect(minutesToHHMM(570.4)).toBe('09:30');
  });

  it('round trips with parseHHMM for every minute of the day', () => {
    for (let m = 0; m <= 1440; m++) {
      const text = minutesToHHMM(m);
      expect(text).toMatch(/^\d{2}:\d{2}$/);
      expect(parseHHMM(text)).toBe(m);
    }
  });
});

describe('timeOptions', () => {
  it('lists every step, both ends inclusive', () => {
    expect(timeOptions(480, 540)).toEqual([480, 495, 510, 525, 540]);
    expect(timeOptions(480, 600, 30)).toEqual([480, 510, 540, 570, 600]);
    expect(timeOptions(480, 660, 45)).toEqual([480, 525, 570, 615, 660]);
    expect(timeOptions(480, 480)).toEqual([480]);
  });

  it('covers the whole day', () => {
    const all = timeOptions(0, 1440);
    expect(all).toHaveLength(97);
    expect(all[0]).toBe(0);
    expect(all[96]).toBe(1440);
    expect(timeOptions(0, 1440, 60)).toHaveLength(25);
  });

  it('stops before `to` when the range is not a multiple of the step', () => {
    expect(timeOptions(480, 500)).toEqual([480, 495]);
    expect(timeOptions(0, 100, 60)).toEqual([0, 60]);
  });

  it('is empty when from is after to', () => {
    expect(timeOptions(600, 480)).toEqual([]);
  });
});

describe('rounding helpers', () => {
  it('roundToStep', () => {
    expect(roundToStep(0)).toBe(0);
    expect(roundToStep(7)).toBe(0);
    expect(roundToStep(8)).toBe(15);
    expect(roundToStep(15)).toBe(15);
    expect(roundToStep(22)).toBe(15);
    expect(roundToStep(22.5)).toBe(30);
    expect(roundToStep(37)).toBe(30);
    expect(roundToStep(38)).toBe(45);
    expect(roundToStep(1436)).toBe(1440);
    expect(roundToStep(44, 30)).toBe(30);
    expect(roundToStep(45, 30)).toBe(60);
    expect(roundToStep(89, 60)).toBe(60);
    expect(roundToStep(90, 60)).toBe(120);
  });

  it('floorToStep', () => {
    expect(floorToStep(0)).toBe(0);
    expect(floorToStep(14)).toBe(0);
    expect(floorToStep(15)).toBe(15);
    expect(floorToStep(29)).toBe(15);
    expect(floorToStep(29.9)).toBe(15);
    expect(floorToStep(-1)).toBe(-15);
    expect(floorToStep(59, 30)).toBe(30);
    expect(floorToStep(119, 60)).toBe(60);
    expect(floorToStep(89, 45)).toBe(45);
  });

  it('ceilToStep', () => {
    expect(ceilToStep(0)).toBe(0);
    expect(ceilToStep(1)).toBe(15);
    expect(ceilToStep(15)).toBe(15);
    expect(ceilToStep(16)).toBe(30);
    expect(ceilToStep(15.1)).toBe(30);
    expect(ceilToStep(1430)).toBe(1440);
    expect(ceilToStep(31, 30)).toBe(60);
    expect(ceilToStep(61, 60)).toBe(120);
    expect(ceilToStep(46, 45)).toBe(90);
  });

  it('floor <= value <= ceil, round is one of them, multiples stay unchanged', () => {
    for (const step of [15, 30, 45, 60]) {
      for (let m = 0; m <= 1440; m++) {
        const lo = floorToStep(m, step);
        const hi = ceilToStep(m, step);
        const mid = roundToStep(m, step);
        expect(lo % step).toBe(0);
        expect(hi % step).toBe(0);
        expect(lo).toBeLessThanOrEqual(m);
        expect(hi).toBeGreaterThanOrEqual(m);
        expect(hi - lo).toBe(m % step === 0 ? 0 : step);
        expect(mid === lo || mid === hi).toBe(true);
        expect(Math.abs(mid - m)).toBeLessThanOrEqual(step / 2);
      }
    }
  });
});
