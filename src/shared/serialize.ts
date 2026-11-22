/**
 * Reading and writing the schedule files that live in the team's git repository.
 *
 * CONTRACT FILE — the exported names and signatures are fixed; the bodies are implemented
 * by the "shared data" build task. Everything here is pure (no Node, no DOM).
 *
 * ── Layout in the repository ───────────────────────────────────────────────────────────
 *   schedule.json            shared settings (ScheduleConfig)
 *   weeks/YYYY-MM-DD.json    one file per week, named after its Sunday
 *
 * ── Canonical text format ──────────────────────────────────────────────────────────────
 * Files are valid JSON written in a fixed, line-oriented layout so that
 *   • `git blame` on a week file attributes every event line to its last editor, and
 *   • diffs in any git tool show exactly one changed line per changed event / list entry.
 * Rules: UTF-8, "\n" line ends, final newline, no indentation, fixed key order,
 * strings via JSON.stringify (Hebrew stays readable, never \u-escaped),
 * one list entry / event per line, an empty list is written as `[]` on the key's line.
 *
 * schedule.json — exactly this shape:
 *
 *   {
 *   "formatVersion": 1,
 *   "course": {"name":"DevOps 2026","startDate":"2026-09-06","endDate":null},
 *   "timeGrid": {"dayStart":"08:00","dayEnd":"20:00","slotMinutes":30},
 *   "subjects": [
 *   {"id":"k3x9p2aqz1","name":"Networking","color":"#2563EB"},
 *   {"id":"p0o9i8u7y6","name":"מעבדה","color":"#16A34A"}
 *   ],
 *   "locations": [
 *   {"id":"a1b2c3d4e5","name":"Room 101"}
 *   ],
 *   "teachers": [],
 *   "classes": []
 *   }
 *
 * weeks/2026-11-22.json — exactly this shape (events sorted by day, start, end, id):
 *
 *   {
 *   "formatVersion": 1,
 *   "weekStart": "2026-11-22",
 *   "title": "שבוע 12 – Docker",
 *   "events": [
 *   {"id":"q1w2e3r4t5","day":0,"start":"09:00","end":"10:30","title":"Docker basics","subject":"k3x9p2aqz1","location":"a1b2c3d4e5","teachers":["t1"],"classes":["c1","c2"],"notes":""},
 *   {"id":"z9y8x7w6v5","day":2,"start":"13:00","end":"14:00","title":"","subject":null,"location":null,"teachers":[],"classes":[],"notes":""}
 *   ]
 *   }
 *
 * Note the on-disk key names of an event: `subject`, `location`, `teachers`, `classes`
 * (ids) map to `subjectId`, `locationId`, `teacherIds`, `classIds` in memory, and
 * `start` / `end` are "HH:MM" strings on disk but minutes in memory. `id` is always the
 * first key of an event line (the blame mapper relies on it).
 *
 * ── Parsing rules (tolerant about layout, strict about meaning) ────────────────────────
 * Any valid JSON layout is accepted (a leading BOM and CRLF line ends too). Unknown keys
 * are ignored. A parser throws `DataFormatError('newer-version', …)` when `formatVersion`
 * is a number greater than FORMAT_VERSION (a missing formatVersion counts as 1), and
 * `DataFormatError('invalid', …)` for everything else that is wrong:
 *   config: root not an object; course.startDate/endDate neither null nor a valid ISO date;
 *           timeGrid times not "HH:MM" multiples of 1 minute within 00:00–24:00, or
 *           dayStart >= dayEnd, or slotMinutes not one of 15/30/45/60; a list that is not
 *           an array, an entry without a non-empty string `id` or without a string `name`,
 *           a duplicate id inside one list, a subject whose colour normalizeHex() rejects.
 *           Missing course → {name:'',startDate:null,endDate:null}; missing course.name → '';
 *           missing timeGrid → the default grid; a missing list → [].
 *   week:   `weekStart` missing / not a valid date / not a Sunday / different from
 *           `expectedWeekStart` when that is given; `events` present but not an array;
 *           an event without a non-empty string id, with a duplicate id, a day that is
 *           not an integer 0–6, start/end not "HH:MM", or not 0 <= start < end <= 1440;
 *           `subject`/`location` neither null/absent nor a string; `teachers`/`classes`
 *           present but not arrays of strings.
 *           Missing title/notes → ''; missing subject/location → null; missing
 *           teachers/classes → []. Id arrays are de-duplicated and sorted on read.
 * Dangling references (an event pointing to a deleted location, …) are NOT an error and
 * are kept as they are.
 *
 * Made precise by the implementation:
 *   • Both files: text that is not JSON, a root that is not an object, or a `formatVersion`
 *     that is present but not a whole number >= 1 is 'invalid'. The version is checked
 *     before anything else, so a file from a newer app is reported as 'newer-version' even
 *     when its shape has changed beyond recognition.
 *   • Only the keys named under "Missing …" may be left out. Inside a `course` that is
 *     present, startDate and endDate are required (null = not set); inside a `timeGrid`
 *     that is present, all three keys are required. A key that is present with the wrong
 *     type (course, timeGrid, course.name, title, notes, an entry that is not an object)
 *     is 'invalid'.
 *   • "HH:MM" is whatever parseHHMM() accepts, so "9:00" is read like "09:00".
 *   • Events come back in canonical form — normalizeEvent(): title / notes trimmed, an
 *     empty subject / location string → null, id arrays de-duplicated and sorted — and
 *     sorted with compareEvents(). The serializer writes the same form, which is what makes
 *     parse → serialize → parse stable. Subject colours come back as `#RRGGBB`.
 *   • Messages start with `settings file: ` or `week file: ` and name the key or the entry,
 *     counted from 1: `week file: event #3 ("q1w2e3r4t5"): end must be after start`.
 */
import { DEFAULT_SUBJECT_COLORS, normalizeHex } from './colors';
import { compareDates, dayOfWeek, isValidIsoDate, minutesToHHMM, parseHHMM } from './dates';
import { newId } from './ids';
import { ENTITY_LIST_KEY, isWeekEmpty, normalizeEvent, sortEvents } from './model';
import { weekPath, weekStartFromPath } from './paths';
import {
  CONFIG_PATH,
  DataFormatError,
  FORMAT_VERSION,
  SLOT_OPTIONS,
  type CourseInfo,
  type Dataset,
  type DayIndex,
  type EntityKind,
  type FileMap,
  type FileProblem,
  type IsoDate,
  type Lang,
  type Minutes,
  type NamedItem,
  type ScheduleConfig,
  type ScheduleEvent,
  type SlotMinutes,
  type Subject,
  type TimeGrid,
  type WeekData,
} from './types';

/**
 * How the main process hands over a data file that is NOT UTF-8 text (saved by another
 * program as UTF-16 or in a Windows code page): this marker followed by the file's bytes in
 * base64. Such a content is never parsed; it is reported as unreadable and kept exactly as
 * it is, so writing it back restores the very same bytes. No JSON file starts like this.
 */
export const RAW_BYTES_PREFIX = `${String.fromCharCode(0)}team-schedule-bytes:`;

/** Grid used for new schedules and when schedule.json has no timeGrid: 08:00–20:00, 30-minute rows. */
export const DEFAULT_TIME_GRID = { dayStart: 480, dayEnd: 1200, slotMinutes: 30 } as const;

// ───────────────────────────── canonical text ─────────────────────────────

/** The fixed layout: one top-level member per line, no indentation, final newline. */
function fileText(members: readonly string[]): string {
  return `{\n${members.join(',\n')}\n}\n`;
}

function member(key: string, json: string): string {
  return `"${key}": ${json}`;
}

/** One entry per line, so that git attributes every entry to its last editor. */
function lineList(entries: readonly string[]): string {
  return entries.length === 0 ? '[]' : `[\n${entries.join(',\n')}\n]`;
}

function namedItemLine(item: NamedItem): string {
  return JSON.stringify({ id: item.id, name: item.name });
}

function subjectLine(subject: Subject): string {
  return JSON.stringify({ id: subject.id, name: subject.name, color: subject.color });
}

/** `id` has to stay the first key: the blame mapper recognizes an event line by it. */
function eventLine(event: ScheduleEvent): string {
  return JSON.stringify({
    id: event.id,
    day: event.day,
    start: minutesToHHMM(event.start),
    end: minutesToHHMM(event.end),
    title: event.title,
    subject: event.subjectId,
    location: event.locationId,
    teachers: event.teacherIds,
    classes: event.classIds,
    notes: event.notes,
  });
}

// ───────────────────────────── reading ─────────────────────────────

/** What the two kinds of file are called in messages (a parser never learns the path). */
const CONFIG_FILE = 'settings file';
const WEEK_FILE = 'week file';

/** Builds the 'invalid' error for one rejected detail; the caller throws it. */
type Fail = (problem: string) => DataFormatError;

function failIn(file: string): Fail {
  return (problem) => new DataFormatError('invalid', `${file}: ${problem}`);
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

const MAX_SHOWN_LENGTH = 60;

/** A text or number from the file, quoted for a message and cut to a readable length. */
function show(value: unknown): string {
  const json = JSON.stringify(value);
  if (json.length <= MAX_SHOWN_LENGTH) return json;
  // A cut in the middle of a surrogate pair would leave half a character in the message.
  return `${json.slice(0, MAX_SHOWN_LENGTH).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/**
 * What the file holds in place of the expected value. Objects and lists are only named:
 * printing them would bury the message.
 */
function found(value: unknown): string {
  if (value === undefined) return 'it is missing';
  if (value === null) return 'found null';
  if (typeof value === 'object') return Array.isArray(value) ? 'found a list' : 'found an object';
  return `found ${show(value)}`;
}

/** Text → root object. The format version is checked here, before any other key is looked at. */
function parseRoot(text: string, file: string): JsonObject {
  const fail = failIn(file);
  let root: unknown;
  try {
    // Notepad and other Windows editors put a byte-order mark in front, which JSON.parse rejects.
    root = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw fail(`not valid JSON (${String(error)})`);
  }
  if (!isJsonObject(root)) throw fail(`the top level must be an object (${found(root)})`);
  const version = root.formatVersion;
  if (version === undefined) return root;
  if (typeof version === 'number' && version > FORMAT_VERSION) {
    throw new DataFormatError(
      'newer-version',
      `${file}: written by a newer version of Team Schedule ` +
        `(formatVersion ${version}; this version reads up to ${FORMAT_VERSION})`,
    );
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw fail(`formatVersion must be a whole number, 1 or higher (${found(version)})`);
  }
  return root;
}

/**
 * Reads a list of objects that each carry a unique, non-empty string `id` — the rule the
 * config lists and the events of a week share. `noun` is what one entry is called in messages.
 */
function parseEntries<T>(
  value: unknown,
  key: string,
  noun: string,
  fail: Fail,
  build: (entry: JsonObject, id: string, failEntry: Fail) => T,
): T[] {
  if (value === undefined) return [];
  if (!isJsonArray(value)) throw fail(`${key} must be a list (${found(value)})`);
  const firstUse = new Map<string, number>();
  return value.map((entry, index) => {
    const position = `${noun} #${index + 1}`;
    if (!isJsonObject(entry)) throw fail(`${position} must be an object (${found(entry)})`);
    const { id } = entry;
    if (typeof id !== 'string' || id === '') throw fail(`${position}: id must be a non-empty string (${found(id)})`);
    const failEntry: Fail = (problem) => fail(`${position} (${show(id)}): ${problem}`);
    const earlier = firstUse.get(id);
    if (earlier !== undefined) throw failEntry(`the id is already used by ${noun} #${earlier}`);
    firstUse.set(id, index + 1);
    return build(entry, id, failEntry);
  });
}

function optionalText(value: unknown, name: string, fail: Fail): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw fail(`${name} must be a string (${found(value)})`);
  return value;
}

function parseTime(value: unknown, name: string, fail: Fail): Minutes {
  const minutes = parseHHMM(value);
  if (minutes === null) {
    throw fail(`${name} must be a time written as "HH:MM" between 00:00 and 24:00 (${found(value)})`);
  }
  return minutes;
}

// ───────────────────────────── schedule.json ─────────────────────────────

export function serializeConfig(config: ScheduleConfig): string {
  const { course, timeGrid } = config;
  return fileText([
    member('formatVersion', String(FORMAT_VERSION)),
    member('course', JSON.stringify({ name: course.name, startDate: course.startDate, endDate: course.endDate })),
    member(
      'timeGrid',
      JSON.stringify({
        dayStart: minutesToHHMM(timeGrid.dayStart),
        dayEnd: minutesToHHMM(timeGrid.dayEnd),
        slotMinutes: timeGrid.slotMinutes,
      }),
    ),
    member('subjects', lineList(config.subjects.map(subjectLine))),
    member('locations', lineList(config.locations.map(namedItemLine))),
    member('teachers', lineList(config.teachers.map(namedItemLine))),
    member('classes', lineList(config.classes.map(namedItemLine))),
  ]);
}

function emptyCourse(): CourseInfo {
  return { name: '', startDate: null, endDate: null };
}

function parseCourse(value: unknown, fail: Fail): CourseInfo {
  if (value === undefined) return emptyCourse();
  if (!isJsonObject(value)) throw fail(`course must be an object (${found(value)})`);
  const date = (key: 'startDate' | 'endDate'): IsoDate | null => {
    const raw = value[key];
    if (raw === null) return null;
    if (!isValidIsoDate(raw)) {
      throw fail(`course.${key} must be null or a valid date written as YYYY-MM-DD (${found(raw)})`);
    }
    return raw;
  };
  return {
    name: optionalText(value.name, 'course.name', fail),
    startDate: date('startDate'),
    endDate: date('endDate'),
  };
}

function isSlotMinutes(value: unknown): value is SlotMinutes {
  return SLOT_OPTIONS.some((option) => option === value);
}

function parseTimeGrid(value: unknown, fail: Fail): TimeGrid {
  // A copy: a dataset must never hand out the module constant itself.
  if (value === undefined) return { ...DEFAULT_TIME_GRID };
  if (!isJsonObject(value)) throw fail(`timeGrid must be an object (${found(value)})`);
  const dayStart = parseTime(value.dayStart, 'timeGrid.dayStart', fail);
  const dayEnd = parseTime(value.dayEnd, 'timeGrid.dayEnd', fail);
  if (dayStart >= dayEnd) throw fail('timeGrid.dayEnd must be after timeGrid.dayStart');
  const { slotMinutes } = value;
  if (!isSlotMinutes(slotMinutes)) {
    throw fail(`timeGrid.slotMinutes must be one of ${SLOT_OPTIONS.join(', ')} (${found(slotMinutes)})`);
  }
  return { dayStart, dayEnd, slotMinutes };
}

function parseNamedItem(entry: JsonObject, id: string, fail: Fail): NamedItem {
  const { name } = entry;
  if (typeof name !== 'string') throw fail(`name must be a string (${found(name)})`);
  return { id, name };
}

function parseSubject(entry: JsonObject, id: string, fail: Fail): Subject {
  const item = parseNamedItem(entry, id, fail);
  const { color } = entry;
  const hex = typeof color === 'string' ? normalizeHex(color) : null;
  if (hex === null) throw fail(`color must be a colour written as #RRGGBB (${found(color)})`);
  return { ...item, color: hex };
}

export function parseConfig(text: string): ScheduleConfig {
  const root = parseRoot(text, CONFIG_FILE);
  const fail = failIn(CONFIG_FILE);
  const list = <T>(kind: EntityKind, build: (entry: JsonObject, id: string, failEntry: Fail) => T): T[] =>
    parseEntries(root[ENTITY_LIST_KEY[kind]], ENTITY_LIST_KEY[kind], kind, fail, build);
  return {
    course: parseCourse(root.course, fail),
    timeGrid: parseTimeGrid(root.timeGrid, fail),
    subjects: list('subject', parseSubject),
    locations: list('location', parseNamedItem),
    teachers: list('teacher', parseNamedItem),
    classes: list('class', parseNamedItem),
  };
}

// ───────────────────────────── weeks/YYYY-MM-DD.json ─────────────────────────────

export function serializeWeek(week: WeekData): string {
  return fileText([
    member('formatVersion', String(FORMAT_VERSION)),
    member('weekStart', JSON.stringify(week.weekStart)),
    member('title', JSON.stringify(week.title)),
    member('events', lineList(sortEvents(week.events.map(normalizeEvent)).map(eventLine))),
  ]);
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function isDayIndex(value: unknown): value is DayIndex {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

function parseOptionalId(value: unknown, name: string, fail: Fail): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw fail(`${name} must be an id (a string) or null (${found(value)})`);
  return value;
}

function parseIdList(value: unknown, name: string, fail: Fail): string[] {
  if (value === undefined) return [];
  if (!isJsonArray(value)) throw fail(`${name} must be a list of ids (${found(value)})`);
  return value.map((id, index) => {
    if (typeof id !== 'string') throw fail(`${name} #${index + 1} must be an id (a string) (${found(id)})`);
    return id;
  });
}

function parseEvent(entry: JsonObject, id: string, fail: Fail): ScheduleEvent {
  const { day } = entry;
  if (!isDayIndex(day)) {
    throw fail(`day must be a whole number from 0 (Sunday) to 6 (Saturday) (${found(day)})`);
  }
  const start = parseTime(entry.start, 'start', fail);
  const end = parseTime(entry.end, 'end', fail);
  if (start >= end) throw fail('end must be after start');
  // Normalized exactly like the serializer normalizes, so that reading a hand-edited file
  // and writing it back settles after one round instead of changing a little every time.
  return normalizeEvent({
    id,
    day,
    start,
    end,
    title: optionalText(entry.title, 'title', fail),
    subjectId: parseOptionalId(entry.subject, 'subject', fail),
    locationId: parseOptionalId(entry.location, 'location', fail),
    teacherIds: parseIdList(entry.teachers, 'teachers', fail),
    classIds: parseIdList(entry.classes, 'classes', fail),
    notes: optionalText(entry.notes, 'notes', fail),
  });
}

/** @param expectedWeekStart when given, the file's weekStart must equal it (it comes from the file name). */
export function parseWeek(text: string, expectedWeekStart?: IsoDate): WeekData {
  const root = parseRoot(text, WEEK_FILE);
  const fail = failIn(WEEK_FILE);
  const { weekStart } = root;
  if (!isValidIsoDate(weekStart)) {
    throw fail(`weekStart must be a valid date written as YYYY-MM-DD (${found(weekStart)})`);
  }
  const weekday = dayOfWeek(weekStart);
  if (weekday !== 0) {
    throw fail(`weekStart ${weekStart} is a ${WEEKDAY_NAMES[weekday]}, but a week must start on a Sunday`);
  }
  if (expectedWeekStart !== undefined && weekStart !== expectedWeekStart) {
    throw fail(
      `weekStart is ${weekStart}, but ${expectedWeekStart} was expected ` +
        '(the date inside the file must match its file name)',
    );
  }
  return {
    weekStart,
    title: optionalText(root.title, 'title', fail),
    events: sortEvents(parseEntries(root.events, 'events', 'event', fail, parseEvent)),
  };
}

// Path and blame-line helpers are already implemented in ./paths and re-exported here.
export { eventIdOfLine, isDataPath, isTitleLine, weekPath, weekStartFromPath } from './paths';

/**
 * All data files for a dataset: always `schedule.json`, plus one file per non-empty week
 * (a week with no title and no events gets no file).
 */
export function datasetToFiles(dataset: Dataset): FileMap {
  const files: FileMap = { [CONFIG_PATH]: serializeConfig(dataset.config) };
  const weeks = Object.values(dataset.weeks).filter((week) => !isWeekEmpty(week));
  // Ascending order only makes the map deterministic; no reader depends on it.
  for (const week of weeks.sort((a, b) => compareDates(a.weekStart, b.weekStart))) {
    files[weekPath(week.weekStart)] = serializeWeek(week);
  }
  return files;
}

export interface ParsedFiles {
  dataset: Dataset;
  /** One entry per file that could not be used. */
  problems: FileProblem[];
  /**
   * Raw text of every data file that could not be parsed. Such files must be written back
   * byte-for-byte whenever the working folder is rewritten, so nothing is ever destroyed
   * by a version of the app that cannot read it.
   */
  passthrough: FileMap;
}

/**
 * Builds a dataset from data files. Paths that are not data paths are ignored.
 * - No `schedule.json` → the default config (createDefaultConfig('en') but with EMPTY lists)
 *   and a `missing-config` problem.
 * - `schedule.json` unparseable → same default config, a problem with the parser's code,
 *   and the raw text in `passthrough`.
 * - A week file that cannot be parsed → that week is left out, a problem is recorded and
 *   the raw text goes to `passthrough`.
 * - Week files that parse to an empty week (no title, no events) are left out silently.
 * Never throws.
 */
export function filesToDataset(files: FileMap): ParsedFiles {
  const problems: FileProblem[] = [];
  const passthrough: FileMap = {};

  /** null = the file cannot be used; it has then been reported and its text kept for writing back. */
  function read<T>(path: string, parse: (text: string) => T): T | null {
    const text = files[path];
    try {
      if (text.startsWith(RAW_BYTES_PREFIX)) {
        const file = path === CONFIG_PATH ? CONFIG_FILE : WEEK_FILE;
        throw new DataFormatError('invalid', `${file}: not a UTF-8 text file (it was saved by another program in another encoding)`);
      }
      return parse(text);
    } catch (error) {
      // Not limited to DataFormatError on purpose: whatever goes wrong while reading one
      // file has to end as "this file is unreadable, its text is kept", never as a failed
      // start-up that hides the whole schedule.
      problems.push(
        error instanceof DataFormatError
          ? { path, code: error.code, message: error.message }
          : { path, code: 'invalid', message: String(error) },
      );
      passthrough[path] = text;
      return null;
    }
  }

  let config: ScheduleConfig | null = null;
  if (files[CONFIG_PATH] === undefined) {
    problems.push({ path: CONFIG_PATH, code: 'missing-config', message: `${CONFIG_PATH} is missing` });
  } else {
    config = read(CONFIG_PATH, parseConfig);
  }

  const weeks: Record<IsoDate, WeekData> = {};
  // Sorted, so that problems and weeks come out in the same order whatever order the files arrived in.
  for (const path of Object.keys(files).sort()) {
    const weekStart = weekStartFromPath(path);
    if (weekStart === null) continue;
    const week = read(path, (text) => parseWeek(text, weekStart));
    if (week !== null && !isWeekEmpty(week)) weeks[weekStart] = week;
  }

  return { dataset: { config: config ?? emptyConfig(), weeks }, problems, passthrough };
}

/**
 * `datasetToFiles(dataset)` overlaid with `passthrough` (passthrough wins on the same path).
 * This is the complete desired content of the data files and is what gets sent to the
 * main process.
 */
export function buildFileMap(dataset: Dataset, passthrough: FileMap): FileMap {
  return { ...datasetToFiles(dataset), ...passthrough };
}

/** Empty course, the default grid and four empty lists. */
function emptyConfig(): ScheduleConfig {
  return {
    course: emptyCourse(),
    timeGrid: { ...DEFAULT_TIME_GRID },
    subjects: [],
    locations: [],
    teachers: [],
    classes: [],
  };
}

const STARTER_SUBJECT_NAMES: Record<Lang, readonly string[]> = {
  en: ['Lecture', 'Lab', 'Workshop', 'Exam', 'Meeting', 'Other'],
  he: ['הרצאה', 'מעבדה', 'סדנה', 'מבחן', 'פגישה', 'אחר'],
};

/**
 * Settings for a brand-new schedule: empty course, DEFAULT_TIME_GRID, six starter subjects
 * using the first six DEFAULT_SUBJECT_COLORS with localized names
 * (en: Lecture, Lab, Workshop, Exam, Meeting, Other /
 *  he: הרצאה, מעבדה, סדנה, מבחן, פגישה, אחר), fresh ids from newId(), and empty
 * locations / teachers / classes.
 */
export function createDefaultConfig(lang: Lang): ScheduleConfig {
  return {
    ...emptyConfig(),
    subjects: STARTER_SUBJECT_NAMES[lang].map((name, index) => ({
      id: newId(),
      name,
      color: DEFAULT_SUBJECT_COLORS[index],
    })),
  };
}

/** A dataset with no weeks. Without an argument: default grid, empty course, all lists empty. */
export function emptyDataset(config?: ScheduleConfig): Dataset {
  return { config: config ?? emptyConfig(), weeks: {} };
}
