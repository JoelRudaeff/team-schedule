/**
 * Core data model of Team Schedule.
 *
 * Pure types + a few constants. Imported by the main process, the preload bridge
 * and the renderer, so this file must stay free of Node and DOM APIs.
 */

/** ISO calendar date `YYYY-MM-DD` (no time, no time zone). */
export type IsoDate = string;

/**
 * Minutes after midnight, 0 … 1440. Values created by the app are always multiples of 15,
 * but files edited by hand may contain any minute, so display code must not assume it.
 */
export type Minutes = number;

/** 0 = Sunday … 6 = Saturday. The week always runs Sunday → Saturday. */
export type DayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Lang = 'en' | 'he';

/** The smallest time step the app creates (minutes). */
export const TIME_STEP = 15;
export const MINUTES_PER_DAY = 1440;

// ───────────────────────────── shared schedule settings ─────────────────────────────

export interface NamedItem {
  /** Stable random id; never shown to the user, never reused. */
  id: string;
  /** Display name typed by the user (Hebrew or English, may be mixed). */
  name: string;
}

/** A colour that the team has given a meaning ("subject"). */
export interface Subject extends NamedItem {
  /** `#RRGGBB`, upper-case. */
  color: string;
}

/** The four user-managed lists. */
export type EntityKind = 'subject' | 'location' | 'teacher' | 'class';

export interface CourseInfo {
  name: string;
  /** First day of the course, or null when not set. */
  startDate: IsoDate | null;
  /** Last day of the course, or null when not set. */
  endDate: IsoDate | null;
}

/** Height of one grid row. */
export type SlotMinutes = 15 | 30 | 45 | 60;
export const SLOT_OPTIONS: readonly SlotMinutes[] = [15, 30, 45, 60];

export interface TimeGrid {
  /** First visible minute of the day; multiple of 15; `dayStart < dayEnd`. */
  dayStart: Minutes;
  /** Last visible minute of the day (exclusive); multiple of 15; max 1440. */
  dayEnd: Minutes;
  slotMinutes: SlotMinutes;
}

/** Everything in `schedule.json`: settings shared by the whole team. */
export interface ScheduleConfig {
  course: CourseInfo;
  timeGrid: TimeGrid;
  subjects: Subject[];
  locations: NamedItem[];
  teachers: NamedItem[];
  classes: NamedItem[];
}

// ───────────────────────────── weeks and events ─────────────────────────────

export interface ScheduleEvent {
  /** Stable random id, unique within its week. */
  id: string;
  day: DayIndex;
  start: Minutes;
  /** Exclusive end; `start < end <= 1440`. */
  end: Minutes;
  title: string;
  /** Subject (= colour) id, or null. May point to a subject that no longer exists. */
  subjectId: string | null;
  /** Location id, or null. May point to a location that no longer exists. */
  locationId: string | null;
  /** Unique, sorted ascending (plain string comparison). */
  teacherIds: string[];
  /** Unique, sorted ascending (plain string comparison). */
  classIds: string[];
  notes: string;
}

export interface WeekData {
  /** The Sunday that starts this week. */
  weekStart: IsoDate;
  /** Free-text name of the week, '' when not named. */
  title: string;
  /** Sorted by (day, start, end, id). */
  events: ScheduleEvent[];
}

export interface Dataset {
  config: ScheduleConfig;
  /**
   * Weeks keyed by `weekStart`. Only weeks that have a title or at least one event are
   * present; a missing key means "empty week".
   */
  weeks: Record<IsoDate, WeekData>;
}

// ───────────────────────────── files in the repository ─────────────────────────────

/** Repo-relative path (forward slashes) → UTF-8 text. */
export type FileMap = Record<string, string>;

export const CONFIG_PATH = 'schedule.json';
export const WEEKS_DIR = 'weeks';
/** Highest on-disk format this build can read and write. */
export const FORMAT_VERSION = 1;

export interface FileProblem {
  path: string;
  /**
   * - `missing-config`: there is no `schedule.json` at all.
   * - `invalid`: the file is not valid JSON or breaks the schema.
   * - `newer-version`: written by a newer app version (`formatVersion` too high).
   */
  code: 'missing-config' | 'invalid' | 'newer-version';
  /** Technical, English, for the details box. */
  message: string;
}

/** Thrown by the parsers in `serialize.ts` / `weekTemplate.ts`. */
export class DataFormatError extends Error {
  readonly code: 'invalid' | 'newer-version';
  constructor(code: 'invalid' | 'newer-version', message: string) {
    super(message);
    this.name = 'DataFormatError';
    this.code = code;
  }
}

// ───────────────────────────── view filters ─────────────────────────────

/**
 * Week-view filter. Inside one list the ids are OR-ed, the lists are AND-ed.
 * An empty list means "no restriction on this dimension".
 */
export interface Filters {
  locationIds: string[];
  classIds: string[];
  teacherIds: string[];
  subjectIds: string[];
}

export const EMPTY_FILTERS: Filters = { locationIds: [], classIds: [], teacherIds: [], subjectIds: [] };
