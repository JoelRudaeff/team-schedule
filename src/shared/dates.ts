/**
 * Calendar and time-of-day helpers.
 *
 * Dates are plain `YYYY-MM-DD` strings and all arithmetic is done in UTC, so results never
 * depend on the computer's time zone or on daylight-saving changes.
 */
import type { CourseInfo, DayIndex, IsoDate, Minutes } from './types';

const DAY_MS = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toUtcMs(date: IsoDate): number {
  const m = ISO_RE.exec(date);
  if (!m) throw new RangeError(`Invalid date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtcMs(ms: number): IsoDate {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** True for a real calendar date written as `YYYY-MM-DD` (rejects 2026-02-30). */
export function isValidIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2999) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function toIsoDate(year: number, month1to12: number, day: number): IsoDate {
  return fromUtcMs(Date.UTC(year, month1to12 - 1, day));
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** `b - a` in whole days. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/** -1 / 0 / 1 — ISO dates also compare correctly as plain strings. */
export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function dayOfWeek(date: IsoDate): DayIndex {
  return new Date(toUtcMs(date)).getUTCDay() as DayIndex;
}

/** The Sunday on or before `date`. */
export function weekStartOf(date: IsoDate): IsoDate {
  return addDays(date, -dayOfWeek(date));
}

export function isWeekStart(date: IsoDate): boolean {
  return isValidIsoDate(date) && dayOfWeek(date) === 0;
}

/** The seven dates Sunday … Saturday of the week that starts at `weekStart`. */
export function weekDates(weekStart: IsoDate): IsoDate[] {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i));
}

/** Today's calendar date on this computer (local time zone). */
export function todayIso(now: Date = new Date()): IsoDate {
  return `${String(now.getFullYear()).padStart(4, '0')}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function yearOf(date: IsoDate): number {
  return Number(date.slice(0, 4));
}

/**
 * A local `Date` at noon of the given day — for `Intl.DateTimeFormat` only
 * (noon keeps the calendar day stable across daylight-saving switches).
 */
export function isoToLocalNoon(date: IsoDate): Date {
  const m = ISO_RE.exec(date);
  if (!m) throw new RangeError(`Invalid date: ${date}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

/**
 * The instant at which wall-clock time `minutes` occurs on `date` in this computer's
 * time zone (used for the Outlook export). `minutes` may be 1440 (= next day 00:00).
 */
export function localDateTime(date: IsoDate, minutes: Minutes): Date {
  const m = ISO_RE.exec(date);
  if (!m) throw new RangeError(`Invalid date: ${date}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, minutes, 0, 0);
}

// ───────────────────────────── week numbers ─────────────────────────────

/**
 * How a week is numbered in the UI.
 * - `course`: the course has a start date → week 1 is the week that contains it.
 *   `number` can be 0 or negative for weeks before the course. `total` is the number of
 *   course weeks, or null while the end date is not set.
 * - `calendar`: no course start date → Sunday-based week of the year. Week 1 is the week
 *   that contains 1 January, so a week belongs to the year of its Saturday.
 */
export type WeekNumber =
  | { kind: 'course'; number: number; total: number | null }
  | { kind: 'calendar'; number: number; year: number };

/** Number of weeks the course spans, or null when a date is missing or the range is reversed. */
export function courseWeekCount(course: CourseInfo): number | null {
  if (!course.startDate || !course.endDate) return null;
  if (course.endDate < course.startDate) return null;
  return diffDays(weekStartOf(course.startDate), weekStartOf(course.endDate)) / 7 + 1;
}

function firstCalendarWeekStart(year: number): IsoDate {
  return weekStartOf(toIsoDate(year, 1, 1));
}

/** Number of Sunday-based weeks that belong to `year`. */
export function calendarWeeksInYear(year: number): number {
  return diffDays(firstCalendarWeekStart(year), firstCalendarWeekStart(year + 1)) / 7;
}

export function weekNumberOf(weekStart: IsoDate, course: CourseInfo): WeekNumber {
  if (course.startDate) {
    const number = diffDays(weekStartOf(course.startDate), weekStart) / 7 + 1;
    return { kind: 'course', number, total: courseWeekCount(course) };
  }
  const year = yearOf(addDays(weekStart, 6));
  const number = diffDays(firstCalendarWeekStart(year), weekStart) / 7 + 1;
  return { kind: 'calendar', number, year };
}

/**
 * Resolves a week number typed by the user to the Sunday of that week.
 * Uses the same numbering as {@link weekNumberOf}; for calendar weeks the year is taken
 * from `referenceWeekStart` (the week currently on screen).
 * Returns null when `n` is not a whole number or is out of range
 * (course: 1 … total, or any n ≥ 1 while the course has no end date; calendar: 1 … weeks in year).
 */
export function weekStartForNumber(n: number, course: CourseInfo, referenceWeekStart: IsoDate): IsoDate | null {
  if (!Number.isInteger(n) || n < 1) return null;
  if (course.startDate) {
    const total = courseWeekCount(course);
    if (total !== null && n > total) return null;
    if (n > 5200) return null;
    return addDays(weekStartOf(course.startDate), (n - 1) * 7);
  }
  const year = yearOf(addDays(referenceWeekStart, 6));
  if (n > calendarWeeksInYear(year)) return null;
  return addDays(firstCalendarWeekStart(year), (n - 1) * 7);
}

/** Largest week number the user may type right now, or null when unbounded. */
export function maxWeekNumber(course: CourseInfo, referenceWeekStart: IsoDate): number | null {
  if (course.startDate) return courseWeekCount(course);
  return calendarWeeksInYear(yearOf(addDays(referenceWeekStart, 6)));
}

/** False when `date` is before the course start or after the course end (unset bounds are open). */
export function isDateInCourse(date: IsoDate, course: CourseInfo): boolean {
  if (course.startDate && date < course.startDate) return false;
  if (course.endDate && date > course.endDate) return false;
  return true;
}

// ───────────────────────────── time of day ─────────────────────────────

/** 570 → "09:30"; 1440 → "24:00". */
export function minutesToHHMM(minutes: Minutes): string {
  const m = Math.max(0, Math.min(1440, Math.round(minutes)));
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** "9:30" / "09:30" → 570; "24:00" → 1440. Returns null for anything else. */
export function parseHHMM(text: unknown): Minutes | null {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  const total = h * 60 + min;
  if (total > 1440) return null;
  return total;
}

/** Every `step` minutes from `from` to `to`, both inclusive. */
export function timeOptions(from: Minutes, to: Minutes, step = 15): Minutes[] {
  const out: Minutes[] = [];
  for (let m = from; m <= to; m += step) out.push(m);
  return out;
}

export function roundToStep(minutes: number, step = 15): Minutes {
  return Math.round(minutes / step) * step;
}

export function floorToStep(minutes: number, step = 15): Minutes {
  return Math.floor(minutes / step) * step;
}

export function ceilToStep(minutes: number, step = 15): Minutes {
  return Math.ceil(minutes / step) * step;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
