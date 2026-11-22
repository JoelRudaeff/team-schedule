/**
 * Pure operations on a Dataset (edit, query, filter, clash detection).
 *
 * Every function is pure: inputs are never mutated, a new Dataset is returned and
 * unchanged parts are shared by reference (so React can compare cheaply). When an edit
 * changes nothing, the SAME dataset object is returned.
 */
import { nextPaletteColor, normalizeHex } from './colors';
import { isValidIsoDate } from './dates';
import {
  SLOT_OPTIONS,
  type CourseInfo,
  type Dataset,
  type EntityKind,
  type Filters,
  type IsoDate,
  type Minutes,
  type NamedItem,
  type ScheduleConfig,
  type ScheduleEvent,
  type Subject,
  type TimeGrid,
  type WeekData,
} from './types';

/** Which ScheduleConfig list holds each kind. */
export const ENTITY_LIST_KEY = {
  subject: 'subjects',
  location: 'locations',
  teacher: 'teachers',
  class: 'classes',
} as const satisfies Record<EntityKind, keyof ScheduleConfig>;

/** The config list for `kind` (subjects are returned as NamedItem too; use findSubject when the colour is needed). */
export function entityList(config: ScheduleConfig, kind: EntityKind): NamedItem[] {
  return config[ENTITY_LIST_KEY[kind]];
}

export function findEntity(config: ScheduleConfig, kind: EntityKind, id: string | null): NamedItem | undefined {
  if (!id) return undefined;
  return entityList(config, kind).find((item) => item.id === id);
}

export function findSubject(config: ScheduleConfig, id: string | null): Subject | undefined {
  if (!id) return undefined;
  return config.subjects.find((item) => item.id === id);
}

// ───────────────────────────── generic helpers ─────────────────────────────

/** Deep structural equality for plain JSON values. A property set to `undefined` counts as absent. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) if (!deepEqual(aa[i], bb[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    // Own properties only: a bare `bo[k]` also finds what every object inherits, so a key
    // named "__proto__" on one side was compared with Object.prototype on the other.
    if (!Object.hasOwn(bo, k) || !deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function uniqueSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

// ───────────────────────────── events ─────────────────────────────

/**
 * Canonical form of an event: title and notes trimmed of surrounding whitespace,
 * teacherIds / classIds de-duplicated and sorted ascending, empty-string subjectId /
 * locationId turned into null, start / end rounded to whole minutes.
 * Does not validate (see {@link validateEvent}).
 */
export function normalizeEvent(event: ScheduleEvent): ScheduleEvent {
  return {
    id: event.id,
    day: event.day,
    start: Math.round(event.start),
    end: Math.round(event.end),
    title: event.title.trim(),
    subjectId: event.subjectId ? event.subjectId : null,
    locationId: event.locationId ? event.locationId : null,
    teacherIds: uniqueSorted(event.teacherIds),
    classIds: uniqueSorted(event.classIds),
    notes: event.notes.trim(),
  };
}

/** Sort order inside a week: day, then start, then end, then id. */
export function compareEvents(a: ScheduleEvent, b: ScheduleEvent): number {
  if (a.day !== b.day) return a.day - b.day;
  if (a.start !== b.start) return a.start - b.start;
  if (a.end !== b.end) return a.end - b.end;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** New sorted array (input untouched). */
export function sortEvents(events: readonly ScheduleEvent[]): ScheduleEvent[] {
  return [...events].sort(compareEvents);
}

export type EventIssue = 'bad-day' | 'bad-time-range' | 'missing-id';

/**
 * `bad-day`: day is not an integer 0–6. `bad-time-range`: not (0 <= start < end <= 1440)
 * or not integers. `missing-id`: empty id. Empty array = valid.
 */
export function validateEvent(event: ScheduleEvent): EventIssue[] {
  const issues: EventIssue[] = [];
  if (typeof event.id !== 'string' || event.id === '') issues.push('missing-id');
  if (!Number.isInteger(event.day) || event.day < 0 || event.day > 6) issues.push('bad-day');
  const timesOk =
    Number.isInteger(event.start) &&
    Number.isInteger(event.end) &&
    event.start >= 0 &&
    event.end <= 1440 &&
    event.start < event.end;
  if (!timesOk) issues.push('bad-time-range');
  return issues;
}

/** The stored week, or a new empty `{ weekStart, title: '', events: [] }` (not inserted) when absent. */
export function getWeek(dataset: Dataset, weekStart: IsoDate): WeekData {
  return dataset.weeks[weekStart] ?? { weekStart, title: '', events: [] };
}

export function findEvent(dataset: Dataset, weekStart: IsoDate, eventId: string): ScheduleEvent | undefined {
  return dataset.weeks[weekStart]?.events.find((e) => e.id === eventId);
}

export function isWeekEmpty(week: WeekData): boolean {
  return week.title === '' && week.events.length === 0;
}

/** Stores the week, or removes it when it is empty. */
function withWeek(dataset: Dataset, week: WeekData): Dataset {
  if (isWeekEmpty(week)) {
    if (!(week.weekStart in dataset.weeks)) return dataset;
    const weeks = { ...dataset.weeks };
    delete weeks[week.weekStart];
    return { ...dataset, weeks };
  }
  return { ...dataset, weeks: { ...dataset.weeks, [week.weekStart]: week } };
}

/**
 * Adds the event to the week, or replaces the event with the same id. The event is
 * normalized and the week's events stay sorted. Creates the week when needed.
 * Returns the same dataset when the stored event is already identical.
 */
export function upsertEvent(dataset: Dataset, weekStart: IsoDate, event: ScheduleEvent): Dataset {
  const next = normalizeEvent(event);
  const week = getWeek(dataset, weekStart);
  const index = week.events.findIndex((e) => e.id === next.id);
  if (index >= 0 && deepEqual(week.events[index], next)) return dataset;
  const events = index >= 0 ? week.events.map((e, i) => (i === index ? next : e)) : [...week.events, next];
  return withWeek(dataset, { ...week, events: sortEvents(events) });
}

/** Removes the event; drops the week entirely when it becomes empty (no title, no events). */
export function removeEvent(dataset: Dataset, weekStart: IsoDate, eventId: string): Dataset {
  const week = dataset.weeks[weekStart];
  if (!week || !week.events.some((e) => e.id === eventId)) return dataset;
  return withWeek(dataset, { ...week, events: week.events.filter((e) => e.id !== eventId) });
}

/** Sets the week's title (trimmed). Creates the week when needed, drops it when it becomes empty. */
export function setWeekTitle(dataset: Dataset, weekStart: IsoDate, title: string): Dataset {
  const week = getWeek(dataset, weekStart);
  const trimmed = title.trim();
  if (week.title === trimmed) return dataset;
  return withWeek(dataset, { ...week, title: trimmed });
}

/** Replaces all events of a week (normalized + sorted); keeps the title. Drops the week when it becomes empty. */
export function setWeekEvents(dataset: Dataset, weekStart: IsoDate, events: readonly ScheduleEvent[]): Dataset {
  const week = getWeek(dataset, weekStart);
  const next = sortEvents(events.map(normalizeEvent));
  if (deepEqual(week.events, next)) return dataset;
  return withWeek(dataset, { ...week, events: next });
}

/** Removes every week that has neither a title nor events. */
export function pruneEmptyWeeks(dataset: Dataset): Dataset {
  const entries = Object.entries(dataset.weeks);
  const kept = entries.filter(([, week]) => !isWeekEmpty(week));
  if (kept.length === entries.length) return dataset;
  return { ...dataset, weeks: Object.fromEntries(kept) };
}

// ───────────────────────────── shared settings ─────────────────────────────

/**
 * Changes course fields. A date that is neither null nor a real calendar date (see
 * isValidIsoDate) is ignored: it must never reach schedule.json, where it would make the
 * file unreadable for the whole team.
 */
export function updateCourse(dataset: Dataset, patch: Partial<CourseInfo>): Dataset {
  const current = dataset.config.course;
  const usable = (date: IsoDate | null | undefined, fallback: IsoDate | null): IsoDate | null =>
    date === undefined || (date !== null && !isValidIsoDate(date)) ? fallback : date;
  let next: CourseInfo = {
    name: (patch.name ?? current.name).trim(),
    startDate: usable(patch.startDate, current.startDate),
    endDate: usable(patch.endDate, current.endDate),
  };
  // A course that ends before it starts has no weeks at all. Such a pair is never stored:
  // the dates stay as they were (the name may still change).
  if (isCourseInverted(next)) next = { ...next, startDate: current.startDate, endDate: current.endDate };
  if (deepEqual(current, next)) return dataset;
  return { ...dataset, config: { ...dataset.config, course: next } };
}

/** True when both dates are set and the course would end before it starts. */
export function isCourseInverted(course: Pick<CourseInfo, 'startDate' | 'endDate'>): boolean {
  return course.startDate !== null && course.endDate !== null && course.startDate > course.endDate;
}

export function isValidTimeGrid(grid: TimeGrid): boolean {
  return (
    Number.isInteger(grid.dayStart) &&
    Number.isInteger(grid.dayEnd) &&
    grid.dayStart % 15 === 0 &&
    grid.dayEnd % 15 === 0 &&
    grid.dayStart >= 0 &&
    grid.dayEnd <= 1440 &&
    grid.dayStart < grid.dayEnd &&
    SLOT_OPTIONS.includes(grid.slotMinutes)
  );
}

/**
 * Applies the patch only when the result is a valid grid (0 <= dayStart < dayEnd <= 1440,
 * both multiples of 15, slotMinutes one of 15/30/45/60); otherwise returns the same dataset.
 */
export function updateTimeGrid(dataset: Dataset, patch: Partial<TimeGrid>): Dataset {
  const current = dataset.config.timeGrid;
  const next: TimeGrid = {
    dayStart: patch.dayStart ?? current.dayStart,
    dayEnd: patch.dayEnd ?? current.dayEnd,
    slotMinutes: patch.slotMinutes ?? current.slotMinutes,
  };
  if (!isValidTimeGrid(next) || deepEqual(current, next)) return dataset;
  return { ...dataset, config: { ...dataset.config, timeGrid: next } };
}

function withList(dataset: Dataset, kind: EntityKind, list: NamedItem[]): Dataset {
  return { ...dataset, config: { ...dataset.config, [ENTITY_LIST_KEY[kind]]: list } };
}

/**
 * Appends an entry to the list of `kind`. The name is trimmed. Subjects get a colour:
 * the given one when valid, otherwise the next free palette colour.
 * Returns the same dataset when the id is already used in that list or the name is empty.
 */
export function addEntity(dataset: Dataset, kind: EntityKind, item: NamedItem | Subject): Dataset {
  const list = entityList(dataset.config, kind);
  const name = item.name.trim();
  if (item.id === '' || name === '' || list.some((e) => e.id === item.id)) return dataset;
  if (kind === 'subject') {
    // `in` alone is not enough: a caller that hands on an optional colour unset passes a
    // `color` key that holds undefined, which the parameter type accepts.
    const given = 'color' in item && typeof item.color === 'string' ? normalizeHex(item.color) : null;
    const color = given ?? nextPaletteColor(dataset.config.subjects.map((s) => s.color));
    const subject: Subject = { id: item.id, name, color };
    return withList(dataset, kind, [...list, subject]);
  }
  return withList(dataset, kind, [...list, { id: item.id, name }]);
}

/**
 * Renames an entry and/or (subjects only) changes its colour. An empty name or an invalid
 * colour in the patch is ignored. Unknown id or no effective change → same dataset.
 */
export function updateEntity(
  dataset: Dataset,
  kind: EntityKind,
  id: string,
  patch: { name?: string; color?: string },
): Dataset {
  const list = entityList(dataset.config, kind);
  const current = list.find((e) => e.id === id);
  if (!current) return dataset;
  const next: NamedItem | Subject = { ...current };
  const name = patch.name?.trim();
  if (name) next.name = name;
  if (kind === 'subject' && patch.color !== undefined) {
    const color = normalizeHex(patch.color);
    if (color) (next as Subject).color = color;
  }
  if (deepEqual(current, next)) return dataset;
  return withList(
    dataset,
    kind,
    list.map((e) => (e.id === id ? next : e)),
  );
}

/** The event without its reference to the entry (the same object when it has none). */
export function stripReference(event: ScheduleEvent, kind: EntityKind, id: string): ScheduleEvent {
  switch (kind) {
    case 'subject':
      return event.subjectId === id ? { ...event, subjectId: null } : event;
    case 'location':
      return event.locationId === id ? { ...event, locationId: null } : event;
    case 'teacher':
      return event.teacherIds.includes(id) ? { ...event, teacherIds: event.teacherIds.filter((t) => t !== id) } : event;
    case 'class':
      return event.classIds.includes(id) ? { ...event, classIds: event.classIds.filter((c) => c !== id) } : event;
  }
}

/**
 * The event pointing to the entry as well. A subject / location is only filled in where the
 * event has none: an event has one of each, and another choice is never overwritten.
 */
export function addReference(event: ScheduleEvent, kind: EntityKind, id: string): ScheduleEvent {
  switch (kind) {
    case 'subject':
      return event.subjectId === null ? { ...event, subjectId: id } : event;
    case 'location':
      return event.locationId === null ? { ...event, locationId: id } : event;
    case 'teacher':
      return event.teacherIds.includes(id) ? event : { ...event, teacherIds: uniqueSorted([...event.teacherIds, id]) };
    case 'class':
      return event.classIds.includes(id) ? event : { ...event, classIds: uniqueSorted([...event.classIds, id]) };
  }
}

/** The event with every reference to `from` pointing to `to` instead (the same object when it has none). */
export function replaceReference(event: ScheduleEvent, kind: EntityKind, from: string, to: string): ScheduleEvent {
  if (!eventReferences(event, kind, from)) return event;
  switch (kind) {
    case 'subject':
      return { ...event, subjectId: to };
    case 'location':
      return { ...event, locationId: to };
    case 'teacher':
      return { ...event, teacherIds: uniqueSorted(event.teacherIds.map((t) => (t === from ? to : t))) };
    case 'class':
      return { ...event, classIds: uniqueSorted(event.classIds.map((c) => (c === from ? to : c))) };
  }
}

/** The ids of `kind` the event points to. */
export function referencedIds(event: ScheduleEvent, kind: EntityKind): string[] {
  switch (kind) {
    case 'subject':
      return event.subjectId ? [event.subjectId] : [];
    case 'location':
      return event.locationId ? [event.locationId] : [];
    case 'teacher':
      return event.teacherIds;
    case 'class':
      return event.classIds;
  }
}

/** Every event of every week passed through `change`; the same dataset when no event changed. */
export function mapEvents(dataset: Dataset, change: (event: ScheduleEvent, weekStart: IsoDate) => ScheduleEvent): Dataset {
  let weeksChanged = false;
  const weeks: Record<IsoDate, WeekData> = {};
  for (const [weekStart, week] of Object.entries(dataset.weeks)) {
    let changed = false;
    const events = week.events.map((event) => {
      const next = change(event, weekStart);
      if (next !== event) changed = true;
      return next;
    });
    weeks[weekStart] = changed ? { ...week, events } : week;
    if (changed) weeksChanged = true;
  }
  return weeksChanged ? { ...dataset, weeks } : dataset;
}

export function eventReferences(event: ScheduleEvent, kind: EntityKind, id: string): boolean {
  switch (kind) {
    case 'subject':
      return event.subjectId === id;
    case 'location':
      return event.locationId === id;
    case 'teacher':
      return event.teacherIds.includes(id);
    case 'class':
      return event.classIds.includes(id);
  }
}

/**
 * Deletes an entry AND removes every reference to it from every event in every week
 * (subjectId / locationId become null; the id is removed from teacherIds / classIds).
 */
export function removeEntity(dataset: Dataset, kind: EntityKind, id: string): Dataset {
  const list = entityList(dataset.config, kind);
  const inList = list.some((e) => e.id === id);
  let weeksChanged = false;
  const weeks: Record<IsoDate, WeekData> = {};
  for (const [weekStart, week] of Object.entries(dataset.weeks)) {
    let changed = false;
    const events = week.events.map((event) => {
      const stripped = stripReference(event, kind, id);
      if (stripped !== event) changed = true;
      return stripped;
    });
    weeks[weekStart] = changed ? { ...week, events } : week;
    if (changed) weeksChanged = true;
  }
  if (!inList && !weeksChanged) return dataset;
  const config = inList
    ? { ...dataset.config, [ENTITY_LIST_KEY[kind]]: list.filter((e) => e.id !== id) }
    : dataset.config;
  return { config, weeks: weeksChanged ? weeks : dataset.weeks };
}

/** How many events (all weeks) reference the entry. */
export function countEntityUsage(dataset: Dataset, kind: EntityKind, id: string): number {
  let count = 0;
  for (const week of Object.values(dataset.weeks)) {
    for (const event of week.events) if (eventReferences(event, kind, id)) count++;
  }
  return count;
}

/** What makes two names "the same name": surrounding blanks and upper / lower case do not count. */
export function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** Case-insensitive, whitespace-trimmed name lookup; used to prevent duplicate names. */
export function findEntityByName(config: ScheduleConfig, kind: EntityKind, name: string): NamedItem | undefined {
  const wanted = nameKey(name);
  if (wanted === '') return undefined;
  return entityList(config, kind).find((e) => nameKey(e.name) === wanted);
}

// ───────────────────────────── view helpers ─────────────────────────────

export function hasActiveFilters(filters: Filters): boolean {
  return (
    filters.locationIds.length > 0 ||
    filters.classIds.length > 0 ||
    filters.teacherIds.length > 0 ||
    filters.subjectIds.length > 0
  );
}

/**
 * True when the event passes every non-empty filter list: its locationId is in
 * `locationIds`, at least one of its classIds is in `classIds`, at least one of its
 * teacherIds is in `teacherIds`, its subjectId is in `subjectIds`.
 */
export function matchesFilters(event: ScheduleEvent, filters: Filters): boolean {
  if (filters.locationIds.length > 0) {
    if (!event.locationId || !filters.locationIds.includes(event.locationId)) return false;
  }
  if (filters.subjectIds.length > 0) {
    if (!event.subjectId || !filters.subjectIds.includes(event.subjectId)) return false;
  }
  if (filters.classIds.length > 0 && !event.classIds.some((id) => filters.classIds.includes(id))) return false;
  if (filters.teacherIds.length > 0 && !event.teacherIds.some((id) => filters.teacherIds.includes(id))) return false;
  return true;
}

/** Same day and the half-open ranges [start, end) intersect. */
export function eventsOverlap(a: ScheduleEvent, b: ScheduleEvent): boolean {
  return a.day === b.day && a.start < b.end && b.start < a.end;
}

/** A double booking: this event overlaps `otherId` and both use the same location / a common teacher / a common class. */
export interface Clash {
  otherId: string;
  reason: 'location' | 'teacher' | 'class';
  /** The shared location / teacher / class id. */
  sharedId: string;
}

/**
 * Double bookings among the given events (normally: all events of one week, unfiltered).
 * Result maps event id → its clashes; events without clashes are absent. The result has no
 * prototype, so `result[id]` is undefined for every event without clashes, whatever its id.
 */
export function findClashes(events: readonly ScheduleEvent[]): Record<string, Clash[]> {
  // An id is any text from a week file that people can edit by hand. In a plain object an
  // id such as "constructor" would find an inherited member, here and in the caller's lookup.
  const result: Record<string, Clash[]> = Object.create(null);
  const add = (id: string, clash: Clash): void => {
    (result[id] ??= []).push(clash);
  };
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      if (!eventsOverlap(a, b)) continue;
      if (a.locationId && a.locationId === b.locationId) {
        add(a.id, { otherId: b.id, reason: 'location', sharedId: a.locationId });
        add(b.id, { otherId: a.id, reason: 'location', sharedId: a.locationId });
      }
      for (const teacherId of a.teacherIds) {
        if (b.teacherIds.includes(teacherId)) {
          add(a.id, { otherId: b.id, reason: 'teacher', sharedId: teacherId });
          add(b.id, { otherId: a.id, reason: 'teacher', sharedId: teacherId });
        }
      }
      for (const classId of a.classIds) {
        if (b.classIds.includes(classId)) {
          add(a.id, { otherId: b.id, reason: 'class', sharedId: classId });
          add(b.id, { otherId: a.id, reason: 'class', sharedId: classId });
        }
      }
    }
  }
  return result;
}

/**
 * The time range the grid must show: the configured [dayStart, dayEnd) widened — in whole
 * slots counted from dayStart — until it contains every given event, clamped to 0…1440.
 */
export function visibleRange(grid: TimeGrid, events: readonly ScheduleEvent[]): { start: Minutes; end: Minutes } {
  let start = grid.dayStart;
  let end = grid.dayEnd;
  if (events.length === 0) return { start, end };
  const slot = grid.slotMinutes;
  const earliest = Math.min(...events.map((e) => e.start));
  const latest = Math.max(...events.map((e) => e.end));
  if (earliest < start) start = Math.max(0, start - Math.ceil((start - earliest) / slot) * slot);
  if (latest > end) end = Math.min(1440, end + Math.ceil((latest - end) / slot) * slot);
  return { start, end };
}

/** Deep structural equality of two datasets (key order and object identity do not matter; empty weeks are ignored). */
export function datasetsEqual(a: Dataset, b: Dataset): boolean {
  if (a === b) return true;
  if (!deepEqual(a.config, b.config)) return false;
  const keys = new Set([...Object.keys(a.weeks), ...Object.keys(b.weeks)]);
  for (const weekStart of keys) {
    if (!deepEqual(getWeek(a, weekStart), getWeek(b, weekStart))) return false;
  }
  return true;
}
