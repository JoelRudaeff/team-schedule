/**
 * Week files: the program's "output". One week's meetings, locations and times saved to a
 * stand-alone file that can be loaded again (into any week, even in another team's
 * schedule) to repeat it — plus the in-memory "repeat week" copy.
 *
 * CONTRACT FILE — the exported names and signatures are fixed; the bodies are implemented
 * by the "dates / export" build task. Pure code (no Node, no DOM).
 *
 * The file is pretty-printed JSON (2-space indent, "\n" line ends, final newline) and
 * carries the NAMES of everything it references, so it stays meaningful outside the
 * schedule it came from:
 *
 *   {
 *     "type": "team-schedule-week",
 *     "formatVersion": 1,
 *     "exportedAt": "2026-11-21T10:15:00.000Z",
 *     "sourceWeek": "2026-11-22",
 *     "title": "Week 12 - Docker",
 *     "events": [
 *       {
 *         "day": 0, "start": "09:00", "end": "10:30",
 *         "title": "Docker basics", "notes": "",
 *         "subject": { "id": "k3x9p2aqz1", "name": "Lab", "color": "#16A34A" },
 *         "location": { "id": "a1b2c3d4e5", "name": "Room 101" },
 *         "teachers": [ { "id": "t1", "name": "Dana" } ],
 *         "classes": [ { "id": "c1", "name": "Class 1" } ]
 *       }
 *     ]
 *   }
 *
 * (The keys are always written in this order; the line breaks are those of
 * JSON.stringify(…, null, 2), i.e. one key per line.)
 */
import { normalizeHex } from './colors';
import { isValidIsoDate, minutesToHHMM, parseHHMM, weekStartOf } from './dates';
import {
  ENTITY_LIST_KEY,
  addEntity,
  entityList,
  findEntity,
  findEntityByName,
  findSubject,
  getWeek,
  setWeekEvents,
  setWeekTitle,
  upsertEvent,
} from './model';
import {
  DataFormatError,
  type Dataset,
  type DayIndex,
  type EntityKind,
  type IsoDate,
  type Minutes,
  type ScheduleConfig,
  type ScheduleEvent,
} from './types';

export const WEEK_TEMPLATE_TYPE = 'team-schedule-week';
export const WEEK_TEMPLATE_EXTENSION = 'week.json';

const TEMPLATE_VERSION = 1;

export interface TemplateRef {
  id: string;
  name: string;
}

export interface TemplateEvent {
  day: DayIndex;
  /** "HH:MM" */
  start: string;
  /** "HH:MM" */
  end: string;
  title: string;
  notes: string;
  subject: (TemplateRef & { color: string }) | null;
  location: TemplateRef | null;
  teachers: TemplateRef[];
  classes: TemplateRef[];
}

export interface WeekTemplate {
  type: typeof WEEK_TEMPLATE_TYPE;
  formatVersion: 1;
  exportedAt: string;
  sourceWeek: IsoDate;
  title: string;
  events: TemplateEvent[];
}

type TemplateSubject = TemplateRef & { color: string };

// ───────────────────────────── export ─────────────────────────────

/** Exactly `{ id, name }` in the file's key order, whatever else the given object carries. */
function toRef(item: TemplateRef): TemplateRef {
  return { id: item.id, name: item.name };
}

function toSubjectRef(subject: TemplateSubject): TemplateSubject {
  return { id: subject.id, name: subject.name, color: subject.color };
}

function toTemplateEvent(event: ScheduleEvent, config: ScheduleConfig): TemplateEvent {
  const subject = findSubject(config, event.subjectId);
  const location = findEntity(config, 'location', event.locationId);
  const existingRefs = (kind: EntityKind, ids: readonly string[]): TemplateRef[] =>
    ids.flatMap((id) => {
      const item = findEntity(config, kind, id);
      return item ? [toRef(item)] : [];
    });
  return {
    day: event.day,
    start: minutesToHHMM(event.start),
    end: minutesToHHMM(event.end),
    title: event.title,
    notes: event.notes,
    subject: subject ? toSubjectRef(subject) : null,
    location: location ? toRef(location) : null,
    teachers: existingRefs('teacher', event.teacherIds),
    classes: existingRefs('class', event.classIds),
  };
}

/**
 * Snapshot of one week. Events keep their week order. References to entries that no
 * longer exist are exported as null / left out of the arrays.
 * @param include optional filter (e.g. the active week-view filter)
 */
export function exportWeekTemplate(
  dataset: Dataset,
  weekStart: IsoDate,
  exportedAt: string,
  include?: (event: ScheduleEvent) => boolean,
): WeekTemplate {
  const week = getWeek(dataset, weekStart);
  const events = include ? week.events.filter((event) => include(event)) : week.events;
  return {
    type: WEEK_TEMPLATE_TYPE,
    formatVersion: TEMPLATE_VERSION,
    exportedAt,
    sourceWeek: weekStart,
    title: week.title,
    events: events.map((event) => toTemplateEvent(event, dataset.config)),
  };
}

/**
 * The file text. Every object is rebuilt key by key, so the layout is the documented one
 * for any template object, and keys the format does not know are never written.
 */
export function serializeWeekTemplate(template: WeekTemplate): string {
  const ordered: WeekTemplate = {
    type: WEEK_TEMPLATE_TYPE,
    formatVersion: TEMPLATE_VERSION,
    exportedAt: template.exportedAt,
    sourceWeek: template.sourceWeek,
    title: template.title,
    events: template.events.map(
      (event): TemplateEvent => ({
        day: event.day,
        start: event.start,
        end: event.end,
        title: event.title,
        notes: event.notes,
        subject: event.subject ? toSubjectRef(event.subject) : null,
        location: event.location ? toRef(event.location) : null,
        teachers: event.teachers.map(toRef),
        classes: event.classes.map(toRef),
      }),
    ),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ───────────────────────────── parse ─────────────────────────────

function invalid(message: string): never {
  throw new DataFormatError('invalid', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${where}: expected an object`);
  return value;
}

/** A string that may be left out of the file (→ ''). */
function optionalText(value: unknown, where: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') invalid(`${where}: expected a string`);
  return value;
}

/** Both times in minutes; rejects anything that is not "HH:MM" with 0 <= start < end <= 1440. */
function timeRange(startText: unknown, endText: unknown, where: string): { start: Minutes; end: Minutes } {
  const start = parseHHMM(startText);
  const end = parseHHMM(endText);
  if (start === null) invalid(`${where}.start: expected a time like "09:00"`);
  if (end === null) invalid(`${where}.end: expected a time like "10:30"`);
  if (start >= end) invalid(`${where}: "start" must be earlier than "end"`);
  return { start, end };
}

function isDayIndex(value: unknown): value is DayIndex {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

function refFields(source: Record<string, unknown>, where: string): TemplateRef {
  const { id, name } = source;
  if (typeof id !== 'string' || typeof name !== 'string') {
    invalid(`${where}: expected a string "id" and a string "name"`);
  }
  return { id, name };
}

function parseRef(value: unknown, where: string): TemplateRef {
  return refFields(asRecord(value, where), where);
}

function parseRefs(value: unknown, where: string): TemplateRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(`${where}: expected a list`);
  return value.map((item: unknown, index: number) => parseRef(item, `${where}[${index}]`));
}

function parseSubject(value: unknown, where: string): TemplateSubject | null {
  if (value === undefined || value === null) return null;
  const source = asRecord(value, where);
  const ref = refFields(source, where);
  const color = typeof source.color === 'string' ? normalizeHex(source.color) : null;
  if (color === null) invalid(`${where}.color: expected a colour like "#16A34A"`);
  return { ...ref, color };
}

function parseTemplateEvent(value: unknown, where: string): TemplateEvent {
  const source = asRecord(value, where);
  const { day, location } = source;
  if (!isDayIndex(day)) invalid(`${where}.day: expected a whole number from 0 (Sunday) to 6 (Saturday)`);
  const { start, end } = timeRange(source.start, source.end, where);
  return {
    day,
    // Re-formatted so the template always holds "HH:MM", also when the file said "9:00".
    start: minutesToHHMM(start),
    end: minutesToHHMM(end),
    title: optionalText(source.title, `${where}.title`),
    notes: optionalText(source.notes, `${where}.notes`),
    subject: parseSubject(source.subject, `${where}.subject`),
    location: location === undefined || location === null ? null : parseRef(location, `${where}.location`),
    teachers: parseRefs(source.teachers, `${where}.teachers`),
    classes: parseRefs(source.classes, `${where}.classes`),
  };
}

/**
 * Parses and validates a week file. Throws DataFormatError:
 *  - 'invalid' when it is not JSON, `type` is not WEEK_TEMPLATE_TYPE, or an event breaks
 *    the same rules as week files (day 0–6, "HH:MM" times with 0 <= start < end <= 1440,
 *    refs with string id + name, subject colour that normalizeHex() accepts);
 *  - 'newer-version' when formatVersion > 1.
 * Tolerant like the other parsers: BOM, CRLF, unknown keys, missing title/notes ('').
 *
 * Details the list above leaves open:
 *  - also 'invalid': `sourceWeek` that is not a real `YYYY-MM-DD` date (so the result is
 *    always safe to pass to the date helpers); `events` / `teachers` / `classes` that are
 *    present but not lists; `exportedAt` / `title` / `notes` that are present but not
 *    strings; a `formatVersion` that is present but not a number >= 1;
 *  - also tolerated: missing `formatVersion` (1), missing `exportedAt` (''), missing
 *    `events` / `teachers` / `classes` ([]), missing or null `subject` / `location` (null),
 *    "9:00" for "09:00", a `sourceWeek` that is not a Sunday (it means the week it lies in),
 *    and a ref with an empty id (such an entry gets a new id if the import has to create it).
 * The result holds only the documented keys, times as "HH:MM", colours as `#RRGGBB` and
 * `sourceWeek` as the Sunday that starts the week.
 * `exportedAt` is only information for the reader and is NOT checked to be a timestamp.
 */
export function parseWeekTemplate(text: string): WeekTemplate {
  let parsed: unknown;
  try {
    // Windows editors like to put a byte order mark first, which JSON.parse refuses.
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    invalid(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed.type !== WEEK_TEMPLATE_TYPE) {
    invalid(`Not a week file: "type" must be "${WEEK_TEMPLATE_TYPE}"`);
  }
  // The version comes before the content: a newer format may lay out everything else differently.
  const version = parsed.formatVersion === undefined ? TEMPLATE_VERSION : parsed.formatVersion;
  if (typeof version !== 'number' || version < TEMPLATE_VERSION) invalid('formatVersion: expected 1');
  if (version > TEMPLATE_VERSION) {
    throw new DataFormatError(
      'newer-version',
      `Week file format ${version} is newer than this version of the app can read (${TEMPLATE_VERSION})`,
    );
  }
  const { sourceWeek, events } = parsed;
  if (!isValidIsoDate(sourceWeek)) invalid('sourceWeek: expected a date like "2026-11-22"');
  if (events !== undefined && !Array.isArray(events)) invalid('events: expected a list');
  return {
    type: WEEK_TEMPLATE_TYPE,
    formatVersion: TEMPLATE_VERSION,
    exportedAt: optionalText(parsed.exportedAt, 'exportedAt'),
    // A week is named by its Sunday everywhere in the app; a date typed by hand may be any of its days.
    sourceWeek: weekStartOf(sourceWeek),
    title: optionalText(parsed.title, 'title'),
    events: (events ?? []).map((item: unknown, index: number) => parseTemplateEvent(item, `events[${index}]`)),
  };
}

// ───────────────────────────── import and repeat ─────────────────────────────

/**
 * An id from `newId` that is not in `taken`. A generator that never repeats itself needs at
 * most `taken.size + 1` draws, so running out means it is broken: failing then is better
 * than looping forever, and better than overwriting the event that already has the id.
 */
function freshId(newId: () => string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt <= taken.size; attempt++) {
    const id = newId();
    if (!taken.has(id)) return id;
  }
  throw new Error('The id generator keeps returning ids that are already in use');
}

/** The events with fresh ids that clash neither with each other nor with what the week holds now. */
function withFreshIds(
  events: readonly Omit<ScheduleEvent, 'id'>[],
  dataset: Dataset,
  weekStart: IsoDate,
  newId: () => string,
): ScheduleEvent[] {
  // Ids of events that `replace` is about to remove stay reserved as well: a new event must
  // never look like an edit of an old one to the change list, the merge or `git blame`.
  const taken = new Set(getWeek(dataset, weekStart).events.map((event) => event.id));
  return events.map((event) => {
    const id = freshId(newId, taken);
    taken.add(id);
    return { ...event, id };
  });
}

function placeEvents(
  dataset: Dataset,
  weekStart: IsoDate,
  events: readonly ScheduleEvent[],
  mode: 'replace' | 'add',
): Dataset {
  if (mode === 'replace') return setWeekEvents(dataset, weekStart, events);
  // One by one, so the events that are already there stay the very same objects.
  return events.reduce((result, event) => upsertEvent(result, weekStart, event), dataset);
}

export interface ImportWeekOptions {
  targetWeek: IsoDate;
  /** `replace`: the target week's existing events are removed first. `add`: they are kept. */
  mode: 'replace' | 'add';
  /** Also set the target week's title from the template (only when the template title is not empty). */
  applyTitle: boolean;
}

export interface ImportWeekResult {
  dataset: Dataset;
  /** Number of events that were added. */
  eventCount: number;
  /** List entries that had to be created because the schedule did not have them. */
  created: { subjects: number; locations: number; teachers: number; classes: number };
}

/**
 * Loads a week file into the dataset.
 * Every imported event gets a fresh id from `newId`.
 * Each reference is resolved in this order:
 *   1. an entry with the same id exists in the schedule → use it;
 *   2. an entry with the same name (trimmed, case-insensitive) exists → use it;
 *   3. otherwise create the entry (name and colour from the file; the file's id is kept
 *      when no entry of that kind uses it, else a fresh id) and count it in `created`.
 * An entry created for one event counts as existing for the following ones. A reference
 * that matches nothing and has a blank name cannot become a list entry and is dropped.
 * Pure: the input dataset is not modified. When nothing changes (no events in `add` mode,
 * no title to apply) the result holds the very same dataset object.
 * Throws DataFormatError('invalid') for a template whose times are not "HH:MM" with
 * start < end; that cannot happen with a template that came from parseWeekTemplate.
 */
export function importWeekTemplate(
  dataset: Dataset,
  template: WeekTemplate,
  options: ImportWeekOptions,
  newId: () => string,
): ImportWeekResult {
  const created: ImportWeekResult['created'] = { subjects: 0, locations: 0, teachers: 0, classes: 0 };
  let next = dataset;

  const resolve = (kind: EntityKind, ref: TemplateRef | TemplateSubject): string | null => {
    const known = findEntity(next.config, kind, ref.id) ?? findEntityByName(next.config, kind, ref.name);
    if (known) return known.id;
    // A list entry needs a name (addEntity refuses a blank one): nothing to point to.
    if (ref.name.trim() === '') return null;
    // Step 1 found no entry of this kind with the file's id, so that id is free to keep —
    // unless the file left it empty, which is not an id a list can hold.
    const id =
      ref.id !== '' ? ref.id : freshId(newId, new Set(entityList(next.config, kind).map((item) => item.id)));
    next = addEntity(next, kind, { ...ref, id });
    created[ENTITY_LIST_KEY[kind]] += 1;
    return id;
  };
  const resolveAll = (kind: EntityKind, refs: readonly TemplateRef[]): string[] =>
    refs.flatMap((ref) => resolve(kind, ref) ?? []);

  const events = template.events.map((item, index): Omit<ScheduleEvent, 'id'> => {
    const { start, end } = timeRange(item.start, item.end, `events[${index}]`);
    return {
      day: item.day,
      start,
      end,
      title: item.title,
      subjectId: item.subject ? resolve('subject', item.subject) : null,
      locationId: item.location ? resolve('location', item.location) : null,
      teacherIds: resolveAll('teacher', item.teachers),
      classIds: resolveAll('class', item.classes),
      notes: item.notes,
    };
  });

  next = placeEvents(next, options.targetWeek, withFreshIds(events, next, options.targetWeek, newId), options.mode);
  if (options.applyTitle && template.title.trim() !== '') {
    next = setWeekTitle(next, options.targetWeek, template.title);
  }
  return { dataset: next, eventCount: events.length, created };
}

export interface CopyWeekOptions {
  sourceWeek: IsoDate;
  /** Sundays to copy into. The source week itself is skipped when it appears here. */
  targetWeeks: readonly IsoDate[];
  mode: 'replace' | 'add';
  /** Also copy the source week's title (only when it is not empty). */
  copyTitle: boolean;
}

/**
 * "Repeat week": copies the source week's events (same day and time, fresh ids) into each
 * target week. Returns the same dataset when there is nothing to do.
 *
 * A source week without events has nothing to repeat, so it never removes events from a
 * target — not in `replace` mode either; only its title is copied, when asked for.
 * A target that is listed twice is written once.
 */
export function copyWeek(dataset: Dataset, options: CopyWeekOptions, newId: () => string): Dataset {
  const source = getWeek(dataset, options.sourceWeek);
  const title = options.copyTitle ? source.title.trim() : '';
  let next = dataset;
  for (const target of new Set(options.targetWeeks)) {
    if (target === options.sourceWeek) continue;
    if (source.events.length > 0) {
      next = placeEvents(next, target, withFreshIds(source.events, next, target, newId), options.mode);
    }
    if (title !== '') next = setWeekTitle(next, target, title);
  }
  return next;
}
