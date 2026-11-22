/**
 * Semantic diff and three-way merge of schedule datasets.
 *
 * CONTRACT FILE — the exported names, types and signatures are fixed; the function bodies
 * are implemented by the "merge engine" build task. Pure code (no Node, no DOM).
 *
 * The app never lets git merge text. When the team's copy and the local copy have both
 * changed, the three datasets (base = last shared version, mine = local working copy,
 * theirs = the team's newest version) are compared item by item.
 *
 * ── Items ──────────────────────────────────────────────────────────────────────────────
 * A dataset is viewed as a flat set of independently mergeable "items":
 *
 *   key                              kind         value
 *   course.name                      course       string
 *   course.startDate                 course       IsoDate | null
 *   course.endDate                   course       IsoDate | null
 *   timeGrid.dayStart                timeGrid     number (minutes)
 *   timeGrid.dayEnd                  timeGrid     number (minutes)
 *   timeGrid.slotMinutes             timeGrid     number
 *   subject:<id>                     subject      Subject
 *   location:<id>                    location     NamedItem
 *   teacher:<id>                     teacher      NamedItem
 *   class:<id>                       class        NamedItem
 *   weekTitle:<weekStart>            weekTitle    string ('' when the week has no title / does not exist)
 *   event:<weekStart>:<id>           event        ScheduleEvent
 *
 * Scalar items (course.*, timeGrid.*, weekTitle:*) always exist, so they can only be
 * "modified". Entity and event items can be added, modified or deleted; a missing item
 * has the value `undefined`.
 *
 * ── Fields and field groups ────────────────────────────────────────────────────────────
 * Entities and events are compared field by field (deep equality for the id arrays):
 *   NamedItem: name            Subject: name, color
 *   ScheduleEvent: day, start, end, title, subjectId, locationId, teacherIds, classIds, notes
 * For conflict detection the three time fields of an event form ONE group called `time`
 * (moving an event and changing its hours at the same moment must not be auto-combined).
 * `changedFields` (diff) lists real field names; `conflictFields` (merge) lists groups:
 * `time` | `title` | `subjectId` | `locationId` | `teacherIds` | `classIds` | `notes`
 * for events, `name` | `color` for entities and `value` for scalar items.
 *
 * ── Three-way rule for one item ────────────────────────────────────────────────────────
 *   mine == theirs                      → status `same`    (also when neither changed: such
 *                                         items are simply not listed)
 *   mine == base (only they changed)    → status `theirs`,  merged = theirs
 *   theirs == base (only I changed)     → status `mine`,    merged = mine
 *   both changed, both still exist, and no field group was changed by both sides to
 *   different values                    → status `combined`, merged = base with my changed
 *                                         groups and their changed groups applied
 *   anything else                       → status `conflict`:
 *        • both modified and at least one group collides (conflictFields = those groups)
 *        • one side deleted what the other modified (conflictFields = [])
 *        • both added the same key with different content (conflictFields = differing groups)
 *        • a scalar changed to two different values (conflictFields = ['value'])
 * A conflict is always resolved wholesale: the whole value of one side wins
 * (never a field-by-field mix), so what the user sees in the comparison is what they get.
 *
 * ── Ordering (deterministic, used for lists in the UI) ─────────────────────────────────
 * course fields (name, startDate, endDate), timeGrid fields (dayStart, dayEnd,
 * slotMinutes), subjects, locations, teachers, classes, then week by week ascending:
 * the week title first, then events ordered by compareEvents() on the newest available
 * version (mine ?? theirs ?? base for merges, after ?? before for diffs).
 * Inside one list the entries keep the list order of the newest version, followed by the
 * entries that only an older version has (merges: my order, then entries only the team
 * has, then entries only base has; diffs: the new order, then deleted entries).
 */
import { addDays, isValidIsoDate, minutesToHHMM } from './dates';
import {
  ENTITY_LIST_KEY,
  addReference,
  compareEvents,
  countEntityUsage,
  deepEqual,
  entityList,
  eventReferences,
  findEntity,
  findEntityByName,
  isCourseInverted,
  isWeekEmpty,
  mapEvents,
  nameKey,
  pruneEmptyWeeks,
  referencedIds,
  removeEntity,
  replaceReference,
  sortEvents,
  stripReference,
} from './model';
import {
  SLOT_OPTIONS,
  type CourseInfo,
  type Dataset,
  type EntityKind,
  type IsoDate,
  type NamedItem,
  type ScheduleEvent,
  type Subject,
  type TimeGrid,
  type WeekData,
} from './types';

export type ItemKind = 'course' | 'timeGrid' | EntityKind | 'weekTitle' | 'event';

export type ItemValue = string | number | null | NamedItem | Subject | ScheduleEvent;

/** Identifies one mergeable item. */
export interface ItemRef {
  /** See the key table in the file comment. */
  key: string;
  kind: ItemKind;
  /** course / timeGrid items: the field name, e.g. `startDate`. */
  field?: string;
  /** Entity and event items: the id. */
  id?: string;
  /** weekTitle and event items: the week. */
  weekStart?: IsoDate;
}

export type ChangeType = 'none' | 'added' | 'modified' | 'deleted';

// ───────────────────────────── item model ─────────────────────────────

const COURSE_FIELDS = ['name', 'startDate', 'endDate'] as const satisfies readonly (keyof CourseInfo)[];
const TIME_GRID_FIELDS = ['dayStart', 'dayEnd', 'slotMinutes'] as const satisfies readonly (keyof TimeGrid)[];
const ENTITY_KINDS = ['subject', 'location', 'teacher', 'class'] as const satisfies readonly EntityKind[];

type CourseField = (typeof COURSE_FIELDS)[number];
type TimeGridField = (typeof TIME_GRID_FIELDS)[number];
type ScalarValue = string | number | null;
type CompositeValue = NamedItem | Subject | ScheduleEvent;

/** Fields of an entity / event that are merged as one unit. */
interface FieldGroup<T> {
  /** What `conflictFields` calls the group. */
  name: string;
  fields: readonly (keyof T & string)[];
}

const NAMED_GROUPS: readonly FieldGroup<NamedItem>[] = [{ name: 'name', fields: ['name'] }];

const SUBJECT_GROUPS: readonly FieldGroup<Subject>[] = [
  { name: 'name', fields: ['name'] },
  { name: 'color', fields: ['color'] },
];

/** `word` is the group in plain words, for commit messages. */
const EVENT_GROUPS: readonly (FieldGroup<ScheduleEvent> & { word: string })[] = [
  { name: 'time', word: 'time', fields: ['day', 'start', 'end'] },
  { name: 'title', word: 'title', fields: ['title'] },
  { name: 'subjectId', word: 'subject', fields: ['subjectId'] },
  { name: 'locationId', word: 'location', fields: ['locationId'] },
  { name: 'teacherIds', word: 'teachers', fields: ['teacherIds'] },
  { name: 'classIds', word: 'classes', fields: ['classIds'] },
  { name: 'notes', word: 'notes', fields: ['notes'] },
];

function isOneOf<T extends string>(options: readonly T[], value: string | undefined): value is T {
  return options.some((option) => option === value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNamedItem(value: unknown): value is NamedItem {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string';
}

function isSubject(value: unknown): value is Subject {
  return isNamedItem(value) && 'color' in value && typeof value.color === 'string';
}

function isEntityValue(kind: EntityKind, value: unknown): value is NamedItem {
  return kind === 'subject' ? isSubject(value) : isNamedItem(value);
}

function isScheduleEvent(value: unknown): value is ScheduleEvent {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.day === 'number' &&
    typeof value.start === 'number' &&
    typeof value.end === 'number' &&
    typeof value.title === 'string' &&
    (value.subjectId === null || typeof value.subjectId === 'string') &&
    (value.locationId === null || typeof value.locationId === 'string') &&
    isStringArray(value.teacherIds) &&
    isStringArray(value.classIds) &&
    typeof value.notes === 'string'
  );
}

function isCourseValue(field: CourseField, value: ItemValue | undefined): value is string | null {
  return typeof value === 'string' || (value === null && field !== 'name');
}

function isTimeGridValue(field: TimeGridField, value: ItemValue | undefined): value is number {
  return typeof value === 'number' && (field !== 'slotMinutes' || SLOT_OPTIONS.some((option) => option === value));
}

/** The merge can leave a grid like this behind, and no parser accepts it. */
function isInverted(grid: TimeGrid): boolean {
  return grid.dayStart >= grid.dayEnd;
}

/**
 * Like getWeek() in the model, but looks only at the dataset's own keys: refs can come from
 * the aside file on disk, and a damaged `weekStart` such as "constructor" must read as an
 * empty week, not as something inherited from Object.prototype.
 */
function weekOf(dataset: Dataset, weekStart: IsoDate): WeekData {
  return Object.hasOwn(dataset.weeks, weekStart) ? dataset.weeks[weekStart] : { weekStart, title: '', events: [] };
}

/** Stores the week under `weekStart`, or removes it when it has neither a title nor events. */
function storeWeek(dataset: Dataset, weekStart: IsoDate, week: WeekData): Dataset {
  if (!isWeekEmpty(week)) return { ...dataset, weeks: { ...dataset.weeks, [weekStart]: week } };
  const weeks = { ...dataset.weeks };
  delete weeks[weekStart];
  return { ...dataset, weeks };
}

/** id → entry; the first entry wins, like every lookup by id in the model. */
function indexById<T extends { id: string }>(entries: readonly T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  return byId;
}

function groupDiffers<T>(group: FieldGroup<T>, a: T, b: T): boolean {
  return group.fields.some((field) => !deepEqual(a[field], b[field]));
}

function changeType(from: ItemValue | undefined, to: ItemValue | undefined): ChangeType {
  if (deepEqual(from, to)) return 'none';
  if (from === undefined) return 'added';
  if (to === undefined) return 'deleted';
  return 'modified';
}

// ───────────────────────────── key helpers ─────────────────────────────

export function eventKey(weekStart: IsoDate, eventId: string): string {
  return `event:${weekStart}:${eventId}`;
}

export function weekTitleKey(weekStart: IsoDate): string {
  return `weekTitle:${weekStart}`;
}

export function entityKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

function scalarRef(kind: 'course' | 'timeGrid', field: string): ItemRef {
  return { key: `${kind}.${field}`, kind, field };
}

function entityRef(kind: EntityKind, id: string): ItemRef {
  return { key: entityKey(kind, id), kind, id };
}

function weekTitleRef(weekStart: IsoDate): ItemRef {
  return { key: weekTitleKey(weekStart), kind: 'weekTitle', weekStart };
}

function eventRef(weekStart: IsoDate, id: string): ItemRef {
  return { key: eventKey(weekStart, id), kind: 'event', id, weekStart };
}

/** Just the identifying part of a diff / merge / aside item. */
function refOf(item: ItemRef): ItemRef {
  const ref: ItemRef = { key: item.key, kind: item.kind };
  if (item.field !== undefined) ref.field = item.field;
  if (item.id !== undefined) ref.id = item.id;
  if (item.weekStart !== undefined) ref.weekStart = item.weekStart;
  return ref;
}

const WEEK_START_LENGTH = 10;

/**
 * Parses any key from the table back into an ItemRef; null when the key is malformed
 * (unknown prefix or field, empty id, or a week that is not a real `YYYY-MM-DD` date).
 */
export function parseItemKey(key: string): ItemRef | null {
  if (key.startsWith('course.')) {
    const field = key.slice('course.'.length);
    return isOneOf(COURSE_FIELDS, field) ? scalarRef('course', field) : null;
  }
  if (key.startsWith('timeGrid.')) {
    const field = key.slice('timeGrid.'.length);
    return isOneOf(TIME_GRID_FIELDS, field) ? scalarRef('timeGrid', field) : null;
  }
  const colon = key.indexOf(':');
  if (colon < 0) return null;
  const prefix = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (prefix === 'weekTitle') return isValidIsoDate(rest) ? weekTitleRef(rest) : null;
  if (prefix === 'event') {
    // The week has a fixed width, so the id is everything after it — even when the id
    // itself contains ':'.
    const weekStart = rest.slice(0, WEEK_START_LENGTH);
    const id = rest.slice(WEEK_START_LENGTH + 1);
    const wellFormed = rest.charAt(WEEK_START_LENGTH) === ':' && isValidIsoDate(weekStart) && id !== '';
    return wellFormed ? eventRef(weekStart, id) : null;
  }
  return isOneOf(ENTITY_KINDS, prefix) && rest !== '' ? entityRef(prefix, rest) : null;
}

/**
 * Current value of the item in the dataset (undefined = entity/event does not exist).
 * A ref that names no item (unknown kind or field, missing id or week) also gives undefined.
 */
export function getItemValue(dataset: Dataset, ref: ItemRef): ItemValue | undefined {
  switch (ref.kind) {
    case 'course':
      return isOneOf(COURSE_FIELDS, ref.field) ? dataset.config.course[ref.field] : undefined;
    case 'timeGrid':
      return isOneOf(TIME_GRID_FIELDS, ref.field) ? dataset.config.timeGrid[ref.field] : undefined;
    case 'weekTitle':
      return ref.weekStart === undefined ? undefined : weekOf(dataset, ref.weekStart).title;
    case 'event': {
      const { id, weekStart } = ref;
      if (id === undefined || weekStart === undefined) return undefined;
      return weekOf(dataset, weekStart).events.find((event) => event.id === id);
    }
    default:
      // The compiler knows only the four lists here, but a ref read from a damaged aside file
      // can carry any kind, and looking up the list of an unknown kind would throw.
      return isOneOf(ENTITY_KINDS, ref.kind) ? findEntity(dataset.config, ref.kind, ref.id ?? null) : undefined;
  }
}

function withCourseField(dataset: Dataset, field: CourseField, value: ItemValue | undefined): Dataset {
  const course = dataset.config.course;
  if (!isCourseValue(field, value) || course[field] === value) return dataset;
  return { ...dataset, config: { ...dataset.config, course: { ...course, [field]: value } } };
}

function withTimeGridField(dataset: Dataset, field: TimeGridField, value: ItemValue | undefined): Dataset {
  const timeGrid = dataset.config.timeGrid;
  if (!isTimeGridValue(field, value) || timeGrid[field] === value) return dataset;
  return { ...dataset, config: { ...dataset.config, timeGrid: { ...timeGrid, [field]: value } } };
}

function withEntity(dataset: Dataset, kind: EntityKind, id: string, value: ItemValue | undefined): Dataset {
  const list = entityList(dataset.config, kind);
  const current = list.find((entry) => entry.id === id);
  let next: NamedItem[];
  if (value === undefined) {
    if (!current) return dataset;
    next = list.filter((entry) => entry.id !== id);
  } else {
    if (!isEntityValue(kind, value) || value.id !== id || deepEqual(current, value)) return dataset;
    next = current ? list.map((entry) => (entry.id === id ? value : entry)) : [...list, value];
  }
  return { ...dataset, config: { ...dataset.config, [ENTITY_LIST_KEY[kind]]: next } };
}

function withWeekTitle(dataset: Dataset, weekStart: IsoDate, value: ItemValue | undefined): Dataset {
  const week = weekOf(dataset, weekStart);
  if (typeof value !== 'string' || week.title === value) return dataset;
  return storeWeek(dataset, weekStart, { ...week, title: value });
}

function withEvent(dataset: Dataset, weekStart: IsoDate, id: string, value: ItemValue | undefined): Dataset {
  const week = weekOf(dataset, weekStart);
  const current = week.events.find((event) => event.id === id);
  const others = week.events.filter((event) => event.id !== id);
  if (value === undefined) return current ? storeWeek(dataset, weekStart, { ...week, events: others }) : dataset;
  if (!isScheduleEvent(value) || value.id !== id || deepEqual(current, value)) return dataset;
  return storeWeek(dataset, weekStart, { ...week, events: sortEvents([...others, value]) });
}

/**
 * Returns a dataset in which the item has the given value.
 * - entity/event with `undefined` → removed (removing an entity here does NOT strip
 *   references from events; the merge treats those as separate items)
 * - entity that does not exist yet → appended to the end of its list
 * - event → inserted/replaced, week kept sorted, week created or dropped as needed
 * - weekTitle → title set ('' allowed; week created or dropped as needed)
 * - course.* / timeGrid.* → field set (no validation)
 * The value is stored exactly as given (nothing is trimmed or normalized).
 * Pure; returns the same dataset when nothing changes. That is also the answer to a call
 * that cannot be honoured: a ref that names no item (as for getItemValue), a value of the
 * wrong type for the item (`undefined` for a scalar included), or an entity / event whose
 * id is not the ref's.
 */
export function setItemValue(dataset: Dataset, ref: ItemRef, value: ItemValue | undefined): Dataset {
  switch (ref.kind) {
    case 'course':
      return isOneOf(COURSE_FIELDS, ref.field) ? withCourseField(dataset, ref.field, value) : dataset;
    case 'timeGrid':
      return isOneOf(TIME_GRID_FIELDS, ref.field) ? withTimeGridField(dataset, ref.field, value) : dataset;
    case 'weekTitle':
      return ref.weekStart === undefined ? dataset : withWeekTitle(dataset, ref.weekStart, value);
    case 'event':
      if (ref.id === undefined || ref.weekStart === undefined) return dataset;
      return withEvent(dataset, ref.weekStart, ref.id, value);
    default:
      // Same guard as in getItemValue: an unknown kind (damaged aside file) has no list to change.
      if (!isOneOf(ENTITY_KINDS, ref.kind) || ref.id === undefined) return dataset;
      return withEntity(dataset, ref.kind, ref.id, value);
  }
}

// ───────────────────────────── walking the items ─────────────────────────────

/**
 * Receives every item of a set of datasets in the documented order. `values[i]` is the
 * item's value in the i-th dataset; the datasets are given newest first.
 */
interface ItemVisitor {
  scalar(ref: ItemRef, values: readonly ScalarValue[]): void;
  composite<T extends CompositeValue>(
    ref: ItemRef,
    values: readonly (T | undefined)[],
    groups: readonly FieldGroup<T>[],
  ): void;
}

function walkList<T extends NamedItem>(
  kind: EntityKind,
  lists: readonly (readonly T[])[],
  groups: readonly FieldGroup<T>[],
  visitor: ItemVisitor,
): void {
  const byId = lists.map((list) => indexById(list));
  // Map keys keep insertion order: the newest list's order, then what only older lists have.
  for (const id of indexById(lists.flat()).keys()) {
    visitor.composite(
      entityRef(kind, id),
      byId.map((entries) => entries.get(id)),
      groups,
    );
  }
}

function walkItems(versions: readonly Dataset[], visitor: ItemVisitor): void {
  for (const field of COURSE_FIELDS) {
    visitor.scalar(
      scalarRef('course', field),
      versions.map((dataset) => dataset.config.course[field]),
    );
  }
  for (const field of TIME_GRID_FIELDS) {
    visitor.scalar(
      scalarRef('timeGrid', field),
      versions.map((dataset) => dataset.config.timeGrid[field]),
    );
  }
  for (const kind of ENTITY_KINDS) {
    if (kind === 'subject') {
      walkList(
        kind,
        versions.map((dataset) => dataset.config.subjects),
        SUBJECT_GROUPS,
        visitor,
      );
    } else {
      walkList(
        kind,
        versions.map((dataset) => entityList(dataset.config, kind)),
        NAMED_GROUPS,
        visitor,
      );
    }
  }
  const weekStarts = [...new Set(versions.flatMap((dataset) => Object.keys(dataset.weeks)))].sort();
  for (const weekStart of weekStarts) {
    const weeks = versions.map((dataset) => weekOf(dataset, weekStart));
    visitor.scalar(
      weekTitleRef(weekStart),
      weeks.map((week) => week.title),
    );
    const byId = weeks.map((week) => indexById(week.events));
    const newest = indexById(weeks.flatMap((week) => week.events));
    for (const event of sortEvents([...newest.values()])) {
      visitor.composite(
        eventRef(weekStart, event.id),
        byId.map((events) => events.get(event.id)),
        EVENT_GROUPS,
      );
    }
  }
}

// ───────────────────────────── two-way diff ─────────────────────────────

export interface DiffItem extends ItemRef {
  change: 'added' | 'modified' | 'deleted';
  /** undefined when added. */
  before: ItemValue | undefined;
  /** undefined when deleted. */
  after: ItemValue | undefined;
  /** For modified entities/events: the real field names that differ. Empty otherwise. */
  changedFields: string[];
}

/** Everything that differs between two datasets, in the documented order. */
export function diffDatasets(before: Dataset, after: Dataset): DiffItem[] {
  const items: DiffItem[] = [];
  walkItems([after, before], {
    scalar(ref, [newer, older]) {
      if (newer !== older) items.push({ ...ref, change: 'modified', before: older, after: newer, changedFields: [] });
    },
    composite(ref, [newer, older], groups) {
      const change = changeType(older, newer);
      if (change === 'none') return;
      const changedFields =
        older && newer
          ? groups.flatMap((group) => group.fields).filter((field) => !deepEqual(older[field], newer[field]))
          : [];
      items.push({ ...ref, change, before: older, after: newer, changedFields });
    },
  });
  return items;
}

const CHANGE_SIGNS = { added: '+', modified: '~', deleted: '-' } as const;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const SUBJECT_MAX_LENGTH = 100;
const BODY_MAX_LINES = 30;

/** A name as the user typed it; only line breaks are flattened, so every item stays on one line. */
function quoted(text: string): string {
  return `"${text.replace(/[\r\n]+/g, ' ')}"`;
}

/** `+2 ~1 -3`, zero counts left out. */
function countsByChange(items: readonly DiffItem[]): string {
  const parts: string[] = [];
  for (const change of ['added', 'modified', 'deleted'] as const) {
    const count = items.filter((item) => item.change === change).length;
    if (count > 0) parts.push(`${CHANGE_SIGNS[change]}${count}`);
  }
  return parts.join(' ');
}

function touchedWeeks(events: readonly DiffItem[], byName: boolean): string {
  const weeks = [...new Set(events.flatMap((item) => item.weekStart ?? []))].sort();
  if (weeks.length === 0) return '';
  if (byName && weeks.length === 1) return ` (week ${weeks[0]})`;
  if (byName && weeks.length <= 3) return ` (weeks ${weeks.join(', ')})`;
  return ` (${weeks.length} ${weeks.length === 1 ? 'week' : 'weeks'})`;
}

function subjectLine(diff: readonly DiffItem[], weeksByName: boolean): string {
  const events = diff.filter((item) => item.kind === 'event');
  const titles = diff.filter((item) => item.kind === 'weekTitle').length;
  const lists = diff.filter((item) => isOneOf(ENTITY_KINDS, item.kind));
  const parts: string[] = [];
  if (events.length > 0) parts.push(`events ${countsByChange(events)}${touchedWeeks(events, weeksByName)}`);
  if (titles > 0) parts.push(`${titles} week ${titles === 1 ? 'title' : 'titles'}`);
  if (lists.length > 0) parts.push(`lists ${countsByChange(lists)}`);
  if (diff.some((item) => item.kind === 'course' || item.kind === 'timeGrid')) parts.push('settings');
  return parts.length > 0 ? `Update schedule: ${parts.join('; ')}` : 'Update schedule';
}

function formatScalar(item: DiffItem, value: ItemValue | undefined): string {
  if (typeof value === 'number') return item.field === 'slotMinutes' ? String(value) : minutesToHHMM(value);
  if (typeof value === 'string') return item.field === 'startDate' || item.field === 'endDate' ? value : quoted(value);
  return 'none';
}

function describeChange(item: DiffItem): string {
  const sign = CHANGE_SIGNS[item.change];
  switch (item.kind) {
    case 'course':
    case 'timeGrid':
      return `${sign} ${item.kind} ${item.field}: ${formatScalar(item, item.before)} -> ${formatScalar(item, item.after)}`;
    case 'weekTitle':
      return `${sign} ${item.weekStart} title: ${formatScalar(item, item.before)} -> ${formatScalar(item, item.after)}`;
    case 'event': {
      const event = item.after ?? item.before;
      if (!isScheduleEvent(event)) return `${sign} ${item.key}`;
      // The message must never fail on an odd week key, so the date is only computed for real dates.
      const date = isValidIsoDate(item.weekStart) ? addDays(item.weekStart, event.day) : item.weekStart;
      const hours = `${minutesToHHMM(event.start)}-${minutesToHHMM(event.end)}`;
      const words = EVENT_GROUPS.filter((group) =>
        group.fields.some((field) => item.changedFields.includes(field)),
      ).map((group) => group.word);
      const changed = words.length > 0 ? ` (${words.join(', ')})` : '';
      return `${sign} ${date} ${DAY_NAMES[event.day]} ${hours} ${quoted(event.title)}${changed}`;
    }
    default: {
      const entry = item.before ?? item.after;
      if (!isNamedItem(entry)) return `${sign} ${item.key}`;
      const renamed =
        item.changedFields.includes('name') && isNamedItem(item.after) ? ` -> ${quoted(item.after.name)}` : '';
      const recolored = item.changedFields.includes('color') ? ' (color)' : '';
      return `${sign} ${item.kind} ${quoted(entry.name)}${renamed}${recolored}`;
    }
  }
}

/**
 * Commit message parts for a set of unpublished changes (always English, ASCII punctuation;
 * names typed by the user are included as they are).
 *
 * subject — one line, never longer than 100 characters:
 *   `Update schedule: ` + the non-empty parts joined with `; `, in this order:
 *     `events +A ~M -D` (zero counts omitted) followed by ` (week 2026-11-22)` for one
 *        touched week, ` (weeks 2026-11-22, 2026-11-29)` for 2–3, ` (N weeks)` for more
 *     `N week title(s)`          — weekTitle items (`1 week title`, `2 week titles`)
 *     `lists +A ~M -D`           — subject / location / teacher / class items
 *     `settings`                 — any course.* or timeGrid.* item
 *   An empty diff gives exactly `Update schedule`.
 *   When the line would be too long, the week list is shortened to ` (1 week)` /
 *   ` (N weeks)`; if that is not enough (thousands of changes) the line is cut and ends in `...`.
 * body — one line per item in the given order, at most 30 lines, then `... and N more`:
 *   `+ 2026-11-22 Sun 09:00-10:30 "Docker basics"`     added event (the date is the event's
 *        own day, not the week's Sunday)
 *   `~ 2026-11-22 Sun 09:00-10:30 "Docker basics" (time, location)`   modified event (its new
 *        version), with the changed parts in plain words: time, title, subject, location,
 *        teachers, classes, notes
 *   `- 2026-11-22 Sun 09:00-10:30 "Docker basics"`     deleted event (its last version)
 *   `~ 2026-11-22 title: "old" -> "new"`               week title
 *   `+ location "Room 101"` / `~ teacher "Dana" -> "Dana L."` / `- class "Class 2"` /
 *   `~ subject "Lab" (color)`                           list entries
 *   `~ course name: "A" -> "B"` / `~ course startDate: none -> 2026-09-06` /
 *   `~ timeGrid dayStart: 08:00 -> 07:30` / `~ timeGrid slotMinutes: 30 -> 45`   settings
 */
export function summarizeDiff(diff: readonly DiffItem[]): { subject: string; body: string } {
  let subject = subjectLine(diff, true);
  if (subject.length > SUBJECT_MAX_LENGTH) subject = subjectLine(diff, false);
  if (subject.length > SUBJECT_MAX_LENGTH) subject = `${subject.slice(0, SUBJECT_MAX_LENGTH - 3)}...`;
  const lines = diff.slice(0, BODY_MAX_LINES).map(describeChange);
  if (diff.length > BODY_MAX_LINES) lines.push(`... and ${diff.length - BODY_MAX_LINES} more`);
  return { subject, body: lines.join('\n') };
}

// ───────────────────────────── three-way merge ─────────────────────────────

export type MergeStatus = 'mine' | 'theirs' | 'same' | 'combined' | 'conflict';

export interface MergeItem extends ItemRef {
  base: ItemValue | undefined;
  mine: ItemValue | undefined;
  theirs: ItemValue | undefined;
  /** What I did to the item relative to base. */
  mineChange: ChangeType;
  /** What the team did to the item relative to base. */
  theirsChange: ChangeType;
  status: MergeStatus;
  /**
   * The automatic result (undefined = the item is absent from the result).
   * For a `conflict` this is the team's value — what you get unless "mine" is chosen.
   */
  merged: ItemValue | undefined;
  /** Colliding field groups; see the file comment. Empty unless status is `conflict`. */
  conflictFields: string[];
}

export interface MergeResult {
  /** Every item that differs from base on at least one side, in the documented order. */
  items: MergeItem[];
  conflictCount: number;
  /** Items with mineChange !== 'none'. */
  mineCount: number;
  /** Items with theirsChange !== 'none'. */
  theirsCount: number;
}

type MergeOutcome = Pick<MergeItem, 'status' | 'merged' | 'conflictFields'>;

function conflict(theirs: ItemValue | undefined, conflictFields: string[]): MergeOutcome {
  return { status: 'conflict', merged: theirs, conflictFields };
}

/** The three-way rule; `whenBothChanged` decides the one case that depends on the item's fields. */
function threeWay(
  ref: ItemRef,
  base: ItemValue | undefined,
  mine: ItemValue | undefined,
  theirs: ItemValue | undefined,
  whenBothChanged: () => MergeOutcome,
): MergeItem | null {
  const mineChange = changeType(base, mine);
  const theirsChange = changeType(base, theirs);
  if (mineChange === 'none' && theirsChange === 'none') return null;
  let outcome: MergeOutcome;
  if (deepEqual(mine, theirs)) outcome = { status: 'same', merged: theirs, conflictFields: [] };
  else if (mineChange === 'none') outcome = { status: 'theirs', merged: theirs, conflictFields: [] };
  else if (theirsChange === 'none') outcome = { status: 'mine', merged: mine, conflictFields: [] };
  else outcome = whenBothChanged();
  return { ...ref, base, mine, theirs, mineChange, theirsChange, ...outcome };
}

/** Base with every group taken from the side that changed it. Only valid when no group collides. */
function combine<T extends CompositeValue>(groups: readonly FieldGroup<T>[], base: T, mine: T, theirs: T): T {
  const merged = { ...base };
  for (const group of groups) {
    // A group I left alone holds either the team's change or the unchanged base value on their side.
    const source = groupDiffers(group, base, mine) ? mine : theirs;
    for (const field of group.fields) merged[field] = source[field];
  }
  return merged;
}

/** Both sides changed an entity / event, and not to the same value. */
function mergeBothChanged<T extends CompositeValue>(
  groups: readonly FieldGroup<T>[],
  base: T | undefined,
  mine: T | undefined,
  theirs: T | undefined,
): MergeOutcome {
  // One side deleted what the other modified: there is no field to blame.
  if (mine === undefined || theirs === undefined) return conflict(theirs, []);
  const collides = (group: FieldGroup<T>): boolean =>
    base === undefined
      ? groupDiffers(group, mine, theirs)
      : groupDiffers(group, base, mine) && groupDiffers(group, base, theirs) && groupDiffers(group, mine, theirs);
  const colliding = groups.filter(collides).map((group) => group.name);
  // Two different additions under one key cannot be combined either: there is no base to start from.
  if (base === undefined || colliding.length > 0) return conflict(theirs, colliding);
  return { status: 'combined', merged: combine(groups, base, mine, theirs), conflictFields: [] };
}

export function mergeDatasets(base: Dataset, mine: Dataset, theirs: Dataset): MergeResult {
  const items: MergeItem[] = [];
  walkItems([mine, theirs, base], {
    scalar(ref, [my, their, original]) {
      const item = threeWay(ref, original, my, their, () => conflict(their, ['value']));
      if (item) items.push(item);
    },
    composite(ref, [my, their, original], groups) {
      const item = threeWay(ref, original, my, their, () => mergeBothChanged(groups, original, my, their));
      if (item) items.push(item);
    },
  });
  return {
    items,
    conflictCount: items.filter((item) => item.status === 'conflict').length,
    mineCount: items.filter((item) => item.mineChange !== 'none').length,
    theirsCount: items.filter((item) => item.theirsChange !== 'none').length,
  };
}

/**
 * How one conflict is settled:
 * - `mine`:   my version wins.
 * - `theirs`: the team's version wins; my version is dropped.
 * - `aside`:  the team's version wins in the schedule, and my version is kept in the
 *             local "aside" list so I can decide later.
 */
export type Resolution = 'mine' | 'theirs' | 'aside';

/** A list entry as my version of an event knew it, kept with the aside item so it can be brought back. */
export interface AsideEntity {
  kind: EntityKind;
  value: NamedItem | Subject;
}

/** A version of mine that lost a conflict but was kept for a later decision. Stored locally, never in git. */
export interface AsideItem extends ItemRef {
  /** My version. undefined = I had deleted the item. */
  mine: ItemValue | undefined;
  /** The team's version that was kept instead. undefined = the team had deleted the item. */
  theirs: ItemValue | undefined;
  /** ISO-8601 timestamp of the merge. */
  createdAt: string;
  /**
   * Event items only: the subject, location, teachers and classes my version points to, as
   * they were when it was put aside. Should one of them be gone by the time the version is
   * used, it is restored from here instead of leaving the event pointing at nothing.
   */
  entities?: AsideEntity[];
}

export type MergeNote =
  /** An entry deleted on one side is still used by an event from the other side, so it was kept. */
  | { code: 'entity-restored'; kind: EntityKind; id: string; name: string }
  /** The combined time grid was invalid (start not before end); the team's grid was used. */
  | { code: 'time-grid-reset' }
  /** The combined course dates were impossible (start after end); the team's dates were used. */
  | { code: 'course-dates-reset' }
  /** Two entries of the same name were folded into one (`id` is the entry that stays). */
  | { code: 'entity-merged'; kind: EntityKind; id: string; name: string }
  /** Two entries that both sides have ended up with the same name; nothing was folded. */
  | { code: 'entity-duplicate'; kind: EntityKind; name: string };

export interface AppliedMerge {
  dataset: Dataset;
  /** One entry per conflict resolved as `aside`. */
  aside: AsideItem[];
  notes: MergeNote[];
}

export interface ApplyMergeInput {
  mine: Dataset;
  theirs: Dataset;
  result: MergeResult;
  /** Conflict key → choice. */
  resolutions: Readonly<Record<string, Resolution>>;
  /** Used for conflicts that have no entry in `resolutions`. */
  defaultResolution: Resolution;
  /** ISO-8601 timestamp stamped on aside items. */
  now: string;
}

function isSorted(events: readonly ScheduleEvent[]): boolean {
  return events.every((event, index) => index === 0 || compareEvents(events[index - 1], event) <= 0);
}

function sortAllWeeks(dataset: Dataset): Dataset {
  let changed = false;
  const entries = Object.entries(dataset.weeks).map(([weekStart, week]): [IsoDate, WeekData] => {
    if (isSorted(week.events)) return [weekStart, week];
    changed = true;
    return [weekStart, { ...week, events: sortEvents(week.events) }];
  });
  return changed ? { ...dataset, weeks: Object.fromEntries(entries) } : dataset;
}

/** The list entries the event points to, each from the first of `configs` that has it. */
function entitiesUsedBy(configs: readonly Dataset['config'][], event: ScheduleEvent): AsideEntity[] {
  const used: AsideEntity[] = [];
  for (const kind of ENTITY_KINDS) {
    for (const id of referencedIds(event, kind)) {
      for (const config of configs) {
        const value = findEntity(config, kind, id);
        if (!value) continue;
        used.push({ kind, value });
        break;
      }
    }
  }
  return used;
}

/**
 * True when the deleting side took nothing out of that field of the event but entries it
 * deleted altogether — which is what deleting entries does to an event. It may have deleted
 * several that share the lesson (Dana AND Vered), so the comparison is with the base event
 * minus EVERY entry that side no longer has (`deleter` is its settings), not minus the one
 * entry in question. An event that was moved to somebody else on purpose (Dana → Uri) is
 * not that.
 */
function onlyStripped(base: ScheduleEvent, changed: ScheduleEvent, kind: EntityKind, id: string, deleter: Dataset['config']): boolean {
  if (!eventReferences(base, kind, id)) return false;
  const left = referencedIds(base, kind).filter((ref) => findEntity(deleter, kind, ref) !== undefined);
  return deepEqual(referencedIds(changed, kind), left);
}

/**
 * Builds the merged dataset.
 *
 * Start from `theirs` and apply every item whose final value differs from the team's:
 * non-conflicts get `merged`; conflicts get `mine` for resolution `mine`, otherwise stay
 * as the team has them (and produce an AsideItem for `aside`).
 * List order: the team's order, then entries only I added (in my order) at the end.
 * Afterwards:
 *  1. when one side deleted a list entry that the other side changed and the entry stays in
 *     the result, the events keep their references to it. Deleting an entry also takes it out
 *     of every event, and those removals belong to the deletion that did not happen. Only
 *     they are taken back: an event from which the deleting side removed nothing in that
 *     field but entries it deleted, and in which the keeping side still has the entry.
 *     The same goes for my version of such an event when it is kept aside;
 *  2. every week's events are sorted and empty weeks are dropped;
 *  3. references are repaired: when an event in the result points to a subject / location /
 *     teacher / class that is missing from the result but exists in `mine` or `theirs`,
 *     that entry is appended back to its list (the team's version when both have it) and
 *     an `entity-restored` note is added (once per entry);
 *  4. a name that this merge would leave in a list twice is folded into one entry: an entry
 *     that only one side has is folded into the entry both sides have, else mine into the
 *     team's (the events of the folded entry point to the one that stays), with an
 *     `entity-merged` note. Two entries that both sides know are different things that merely
 *     got the same name: nothing is decided there, an `entity-duplicate` note says so. A
 *     name the team's own list already has twice is not this merge's business;
 *  5. when the resulting timeGrid has dayStart >= dayEnd, the team's whole timeGrid is
 *     used instead and a `time-grid-reset` note is added; likewise the team's course dates
 *     with a `course-dates-reset` note when the course would end before it starts.
 * Every event that is kept aside remembers the list entries it points to (`AsideItem.entities`).
 * Entries in `resolutions` for keys that are not conflicts are ignored. `result` must be
 * mergeDatasets(base, mine, theirs) for these same `mine` and `theirs`.
 */
export function applyMerge(input: ApplyMergeInput): AppliedMerge {
  const { mine, theirs, result, resolutions, defaultResolution, now } = input;
  let dataset = theirs;
  let aside: AsideItem[] = [];
  for (const item of result.items) {
    if (item.status !== 'conflict') {
      dataset = setItemValue(dataset, item, item.merged);
      continue;
    }
    const resolution = resolutions[item.key] ?? defaultResolution;
    if (resolution === 'mine') dataset = setItemValue(dataset, item, item.mine);
    else if (resolution === 'aside') aside.push({ ...refOf(item), mine: item.mine, theirs: item.theirs, createdAt: now });
  }

  for (const entry of result.items) {
    if (entry.status !== 'conflict' || !isOneOf(ENTITY_KINDS, entry.kind) || entry.id === undefined) continue;
    const deletedByMe = entry.mine === undefined && entry.theirs !== undefined;
    const deletedByThem = entry.theirs === undefined && entry.mine !== undefined;
    if ((!deletedByMe && !deletedByThem) || !findEntity(dataset.config, entry.kind, entry.id)) continue;
    const kind = entry.kind;
    const id = entry.id;
    for (const item of result.items) {
      if (item.kind !== 'event') continue;
      const deleter = deletedByMe ? item.mine : item.theirs;
      const keeper = deletedByMe ? item.theirs : item.mine;
      if (!isScheduleEvent(item.base) || !isScheduleEvent(deleter) || !isScheduleEvent(keeper)) continue;
      const deleterConfig = (deletedByMe ? mine : theirs).config;
      if (!onlyStripped(item.base, deleter, kind, id, deleterConfig) || !eventReferences(keeper, kind, id)) continue;
      const current = getItemValue(dataset, item);
      if (isScheduleEvent(current)) dataset = setItemValue(dataset, item, addReference(current, kind, id));
      // My version of the event, kept aside, lost the reference through my deletion as well.
      if (deletedByMe) {
        aside = aside.map((kept) =>
          kept.key === item.key && isScheduleEvent(kept.mine) ? { ...kept, mine: addReference(kept.mine, kind, id) } : kept,
        );
      }
    }
  }
  dataset = pruneEmptyWeeks(sortAllWeeks(dataset));

  const notes: MergeNote[] = [];
  for (const kind of ENTITY_KINDS) {
    // The team's list comes first, so their version wins when both sides still have the entry.
    for (const entry of [...entityList(theirs.config, kind), ...entityList(mine.config, kind)]) {
      if (findEntity(dataset.config, kind, entry.id) || countEntityUsage(dataset, kind, entry.id) === 0) continue;
      dataset = setItemValue(dataset, entityRef(kind, entry.id), entry);
      notes.push({ code: 'entity-restored', kind, id: entry.id, name: entry.name });
    }
  }

  for (const kind of ENTITY_KINDS) {
    const teamList = entityList(theirs.config, kind);
    const teamIds = new Set(teamList.map((entry) => entry.id));
    const myIds = new Set(entityList(mine.config, kind).map((entry) => entry.id));
    const teamNames = teamList.map((entry) => nameKey(entry.name));
    const groups = new Map<string, NamedItem[]>();
    for (const entry of entityList(dataset.config, kind)) {
      const key = nameKey(entry.name);
      if (key === '') continue;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const [key, group] of groups) {
      // A name the team's own list already holds twice was not made double by this merge.
      if (group.length < 2 || teamNames.filter((name) => name === key).length > 1) continue;
      const shared = group.filter((entry) => teamIds.has(entry.id) && myIds.has(entry.id));
      const oneSided = [
        ...group.filter((entry) => teamIds.has(entry.id) && !myIds.has(entry.id)),
        ...group.filter((entry) => !teamIds.has(entry.id)),
      ];
      const survivor = shared[0] ?? oneSided[0];
      for (const entry of oneSided) {
        if (entry === survivor) continue;
        const from = entry.id;
        dataset = mapEvents(setItemValue(dataset, entityRef(kind, from), undefined), (event) =>
          replaceReference(event, kind, from, survivor.id),
        );
        // A version of mine that is kept aside must not bring the folded entry back later.
        aside = aside.map((kept) => {
          if (!isScheduleEvent(kept.mine)) return kept;
          const event = replaceReference(kept.mine, kind, from, survivor.id);
          return event === kept.mine ? kept : { ...kept, mine: event };
        });
        notes.push({ code: 'entity-merged', kind, id: survivor.id, name: survivor.name });
      }
      if (shared.length > 1) notes.push({ code: 'entity-duplicate', kind, name: shared[0].name });
    }
  }

  if (isInverted(dataset.config.timeGrid)) {
    dataset = { ...dataset, config: { ...dataset.config, timeGrid: theirs.config.timeGrid } };
    notes.push({ code: 'time-grid-reset' });
  }
  if (isCourseInverted(dataset.config.course)) {
    const { startDate, endDate } = theirs.config.course;
    dataset = { ...dataset, config: { ...dataset.config, course: { ...dataset.config.course, startDate, endDate } } };
    notes.push({ code: 'course-dates-reset' });
  }

  // Last, when every event has its final references: what a kept-aside event needs to come back whole.
  aside = aside.map((kept) => {
    if (!isScheduleEvent(kept.mine)) return kept;
    const entities = entitiesUsedBy([dataset.config, mine.config], kept.mine);
    return entities.length > 0 ? { ...kept, entities } : kept;
  });
  return { dataset, aside, notes };
}

/**
 * My version of an event, fit for `dataset`: a subject / location / teacher / class it points
 * to that the dataset no longer has is brought back from the entries stored with the aside
 * item (or pointed at the entry that now carries that name), and where nothing is known about
 * it the reference is dropped. Returns the dataset with the restored entries and the event.
 */
function eventFitFor(dataset: Dataset, item: AsideItem, mine: ScheduleEvent): { dataset: Dataset; event: ScheduleEvent } {
  let next = dataset;
  let event = mine;
  for (const kind of ENTITY_KINDS) {
    for (const id of referencedIds(mine, kind)) {
      if (findEntity(next.config, kind, id)) continue;
      // The aside list is read from a file: whatever in it is not a usable entry is simply not there.
      const kept: readonly unknown[] = Array.isArray(item.entities) ? item.entities : [];
      const stored = kept.find(
        (used): used is AsideEntity => isRecord(used) && used.kind === kind && isEntityValue(kind, used.value) && used.value.id === id,
      );
      const twin = stored ? findEntityByName(next.config, kind, stored.value.name) : undefined;
      if (twin) {
        event = replaceReference(event, kind, id, twin.id);
      } else if (stored) {
        next = setItemValue(next, entityRef(kind, id), stored.value);
      } else {
        event = stripReference(event, kind, id);
      }
    }
  }
  return { dataset: next, event };
}

/**
 * Puts an aside item's `mine` back into the dataset (add, replace or delete) without ever
 * leaving an event that points at nothing:
 *  - my deletion of a list entry also takes the entry out of every event that uses it
 *    (exactly what removing it in Settings does);
 *  - my version of an event gets the list entries it points to back when they are gone
 *    (see `AsideItem.entities`); a reference nothing is known about is dropped.
 * Refused, i.e. the dataset is returned unchanged (the same object): a timeGrid value that
 * would leave dayStart >= dayEnd, and a course date that would make the course end before
 * it starts. No such schedule may reach the files.
 */
export function applyAsideItem(dataset: Dataset, item: AsideItem): Dataset {
  if (isOneOf(ENTITY_KINDS, item.kind) && item.mine === undefined) {
    return item.id === undefined ? dataset : removeEntity(dataset, item.kind, item.id);
  }
  if (item.kind === 'event' && isScheduleEvent(item.mine)) {
    const fit = eventFitFor(dataset, item, item.mine);
    return setItemValue(fit.dataset, item, fit.event);
  }
  const next = setItemValue(dataset, item, item.mine);
  if (item.kind === 'timeGrid' && isInverted(next.config.timeGrid)) return dataset;
  if (item.kind === 'course' && isCourseInverted(next.config.course)) return dataset;
  return next;
}

/**
 * New aside list: `existing` with entries of the same key replaced by the ones in `added`
 * (newest wins), other new entries appended.
 */
export function addAsideItems(existing: readonly AsideItem[], added: readonly AsideItem[]): AsideItem[] {
  // A Map keeps each key at the position where it first appeared and lets later entries replace it there.
  const byKey = new Map<string, AsideItem>();
  for (const item of [...existing, ...added]) byKey.set(item.key, item);
  return [...byKey.values()];
}

/**
 * Drops aside items that no longer need a decision: those whose `mine` already equals the
 * item's current value in `working`.
 */
export function pruneAside(aside: readonly AsideItem[], working: Dataset): AsideItem[] {
  return aside.filter((item) => !deepEqual(item.mine, getItemValue(working, item)));
}
