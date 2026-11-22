/** Turns merge / diff items into words a person can read (used by the save, merge and aside dialogs). */
import { addDays, isValidIsoDate, minutesToHHMM } from '@shared/dates';
import type { DiffItem, ItemRef, ItemValue } from '@shared/merge';
import type { IsoDate, NamedItem, ScheduleConfig, ScheduleEvent } from '@shared/types';
import { isolate, ltr, type MessageKey, type Translator } from '../i18n';
import { dayName, formatDate, formatDayMonth, formatTimeRange, formatWeekRange } from './format';
import { entityName, eventHeadline } from './lookup';

export function isEvent(value: ItemValue | undefined): value is ScheduleEvent {
  return typeof value === 'object' && value !== null && 'day' in value && 'start' in value;
}

export function isNamed(value: ItemValue | undefined): value is NamedItem {
  return typeof value === 'object' && value !== null && 'name' in value && !('day' in value);
}

/**
 * A config that knows every list entry of all the given ones (first wins), so names can
 * still be shown for entries that one side deleted.
 */
export function lookupConfig(...configs: readonly ScheduleConfig[]): ScheduleConfig {
  const [first, ...rest] = configs;
  const union = <T extends NamedItem>(pick: (config: ScheduleConfig) => T[]): T[] => {
    const seen = new Map<string, T>();
    for (const config of [first, ...rest]) for (const item of pick(config)) if (!seen.has(item.id)) seen.set(item.id, item);
    return [...seen.values()];
  };
  return {
    course: first.course,
    timeGrid: first.timeGrid,
    subjects: union((c) => c.subjects),
    locations: union((c) => c.locations),
    teachers: union((c) => c.teachers),
    classes: union((c) => c.classes),
  };
}

const FIELD_LABEL: Record<string, MessageKey> = {
  time: 'sync.fieldTime',
  day: 'sync.fieldTime',
  start: 'sync.fieldTime',
  end: 'sync.fieldTime',
  title: 'sync.fieldTitle',
  subjectId: 'sync.fieldSubject',
  locationId: 'sync.fieldLocation',
  teacherIds: 'sync.fieldTeachers',
  classIds: 'sync.fieldClasses',
  notes: 'sync.fieldNotes',
  name: 'sync.fieldName',
  color: 'sync.fieldColor',
};

/** "time, location" for a list of field (or field group) names; unknown names are skipped. */
export function fieldList(fields: readonly string[], t: Translator['t']): string {
  // hasOwn: a field called "toString" must not find the method of that name on the table.
  const labels = fields
    .map((field) => (Object.hasOwn(FIELD_LABEL, field) ? FIELD_LABEL[field] : undefined))
    .filter((key): key is MessageKey => key !== undefined);
  return [...new Set(labels.map((key) => t(key)))].join(', ');
}

const SCALAR_TITLE: Record<string, MessageKey> = {
  'course.name': 'sync.itemCourseName',
  'course.startDate': 'sync.itemCourseStart',
  'course.endDate': 'sync.itemCourseEnd',
  'timeGrid.dayStart': 'sync.itemDayStart',
  'timeGrid.dayEnd': 'sync.itemDayEnd',
  'timeGrid.slotMinutes': 'sync.itemSlot',
};

const KIND_TITLE = {
  subject: 'common.subject',
  location: 'common.location',
  teacher: 'common.teacher',
  class: 'common.class',
} as const satisfies Record<string, MessageKey>;

/** How a scalar value (course field, grid field, week title) reads. */
export function scalarText(ref: ItemRef, value: ItemValue | undefined, tr: Translator): string {
  if (value === undefined || value === null) return tr.t('sync.notSet');
  if (ref.kind === 'timeGrid') {
    return ref.field === 'slotMinutes' ? tr.t('sync.minutes', { count: Number(value) }) : minutesToHHMM(Number(value));
  }
  const text = String(value);
  if (ref.kind === 'course' && ref.field !== 'name' && isValidIsoDate(text)) return formatDate(text, tr.lang);
  return text === '' ? tr.t('sync.emptyValue') : text;
}

/** "Sun 22 Nov · 09:00–10:30 · Room 101" */
export function eventLine(event: ScheduleEvent, weekStart: IsoDate | undefined, config: ScheduleConfig, tr: Translator): string {
  const day = dayName(event.day, tr.lang, 'short');
  const date = weekStart ? ` ${formatDayMonth(addDays(weekStart, event.day), tr.lang)}` : '';
  const location = entityName(config, 'location', event.locationId);
  // The hours read left to right as in the grid, and a room's name keeps its own direction:
  // neither may re-order the line they stand in.
  return `${day}${date} · ${ltr(formatTimeRange(event.start, event.end))}${location ? ` · ${isolate(location)}` : ''}`;
}

export interface ItemText {
  /** What the item is, e.g. the event's headline or "Location: Room 101". */
  title: string;
  /** Specifics, e.g. when and where; may be ''. */
  detail: string;
}

/** Words for one item in a given version of it. `config` should know all names (see lookupConfig). */
export function describeItem(ref: ItemRef, value: ItemValue | undefined, config: ScheduleConfig, tr: Translator): ItemText {
  const { t } = tr;
  if (ref.kind === 'event') {
    if (!isEvent(value)) return { title: t('common.untitledEvent'), detail: '' };
    return { title: eventHeadline(value, config, t('common.untitledEvent')), detail: eventLine(value, ref.weekStart, config, tr) };
  }
  if (ref.kind === 'weekTitle') {
    return {
      title: t('sync.itemWeekTitle', { week: ref.weekStart ? formatWeekRange(ref.weekStart, tr.lang) : '' }),
      detail: scalarText(ref, value, tr),
    };
  }
  if (ref.kind === 'course' || ref.kind === 'timeGrid') {
    const key = Object.hasOwn(SCALAR_TITLE, ref.key) ? SCALAR_TITLE[ref.key] : undefined;
    return { title: key ? t(key) : ref.key, detail: scalarText(ref, value, tr) };
  }
  const name = isNamed(value) ? value.name : t('common.unknown');
  return { title: `${t(KIND_TITLE[ref.kind])}: ${name}`, detail: '' };
}

/** One changed thing for a list: what it is and what happened to it. */
export function describeDiff(item: DiffItem, config: ScheduleConfig, tr: Translator): ItemText {
  const { t } = tr;
  const scalar = item.kind === 'course' || item.kind === 'timeGrid' || item.kind === 'weekTitle';
  if (scalar) {
    const now = describeItem(item, item.after, config, tr);
    // "old → new" in reading direction: in Hebrew the old value stands on the right, so the
    // arrow has to point left. Each value is isolated, or a Latin name would turn the line around.
    const arrow = tr.dir === 'rtl' ? '←' : '→';
    return { title: now.title, detail: `${isolate(scalarText(item, item.before, tr))} ${arrow} ${isolate(scalarText(item, item.after, tr))}` };
  }
  const shown = describeItem(item, item.after ?? item.before, config, tr);
  if (item.change !== 'modified') return shown;
  const fields = fieldList(item.changedFields, t);
  const changed = fields === '' ? '' : t('sync.changedFields', { fields });
  return { title: shown.title, detail: [shown.detail, changed].filter((part) => part !== '').join(' · ') };
}
