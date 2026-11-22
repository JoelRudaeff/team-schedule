/**
 * iCalendar (.ics) export for Outlook (also readable by Google Calendar, Apple Calendar …).
 *
 * CONTRACT FILE — the exported names and signatures are fixed; the bodies are implemented
 * by the "dates / export" build task. Pure code (no Node, no DOM).
 *
 * Output rules (RFC 5545):
 *  - CRLF ("\r\n") line ends, including after the final END:VCALENDAR.
 *  - Content lines are folded so that no line is longer than 75 OCTETS of UTF-8; a
 *    continuation line starts with one space. A multi-byte character (Hebrew!) is never
 *    split across two lines, and neither is a surrogate pair (emoji).
 *  - TEXT values (SUMMARY, LOCATION, DESCRIPTION, CATEGORIES, X-WR-CALNAME) escape
 *    backslash → `\\`, `;` → `\;`, `,` → `\,`, newline → `\n`; "\r" is dropped, and so is
 *    every other control character the RFC forbids inside a value (all of them except TAB).
 *    In CATEGORIES the comma between two categories is NOT escaped.
 *    UID is a TEXT value as well and is escaped the same way, which changes nothing for
 *    the ids the app generates.
 *  - Times are written in UTC (`YYYYMMDDTHHMMSSZ`), converted from the wall-clock time on
 *    the event's own date with `toInstant` (so daylight saving is right per event).
 *    An end of 24:00 is converted as 00:00 on the following date.
 *
 * Document shape:
 *   BEGIN:VCALENDAR
 *   VERSION:2.0
 *   PRODID:-//Team Schedule//Weekly Schedule//EN
 *   CALSCALE:GREGORIAN
 *   METHOD:PUBLISH
 *   X-WR-CALNAME:<calendarName>
 *   (one VEVENT per input event, in the given order)
 *   END:VCALENDAR
 * and each event:
 *   BEGIN:VEVENT
 *   UID:<uid>
 *   DTSTAMP:<now in UTC>
 *   DTSTART:<utc>
 *   DTEND:<utc>
 *   SUMMARY:<summary>
 *   LOCATION:<location>          (line omitted when empty)
 *   DESCRIPTION:<description>    (line omitted when empty)
 *   CATEGORIES:<a>,<b>           (line omitted when there are none)
 *   END:VEVENT
 */
import { addDays, compareDates, localDateTime } from './dates';
import { entityList, findEntity, findSubject, getWeek } from './model';
import {
  MINUTES_PER_DAY,
  type Dataset,
  type EntityKind,
  type IsoDate,
  type Minutes,
  type ScheduleConfig,
  type ScheduleEvent,
} from './types';

export interface IcsEvent {
  /** Globally unique and stable for the same schedule event, e.g. `<eventId>-<weekStart>@team-schedule`. */
  uid: string;
  /** Calendar date of the event. */
  date: IsoDate;
  start: Minutes;
  /** May be 1440 (= 00:00 of the next day). */
  end: Minutes;
  summary: string;
  location: string;
  description: string;
  categories: string[];
}

export interface IcsOptions {
  calendarName: string;
  /** Used for DTSTAMP. */
  now: Date;
  /**
   * Converts a wall-clock time on a date to an instant. Defaults to this computer's time
   * zone (`localDateTime` from dates.ts). Tests inject a fixed-offset version.
   * It is only ever asked for minutes 0 … 1439.
   */
  toInstant?: (date: IsoDate, minutes: Minutes) => Date;
}

const MAX_LINE_OCTETS = 75;

/**
 * Control characters must not appear inside a value (RFC 5545 allows only TAB), and a raw
 * "\r" would even end the content line early. The newline is not listed: it gets escaped.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Escapes one TEXT value. */
export function escapeIcsText(text: string): string {
  return text
    .replace(FORBIDDEN_CONTROL_CHARS, '')
    .replace(/[\\;,\n]/g, (char) => (char === '\n' ? '\\n' : `\\${char}`));
}

/** UTF-8 size of one step of string iteration (a single UTF-16 unit or a surrogate pair). */
function utf8Octets(char: string): number {
  if (char.length > 1) return 4;
  const unit = char.charCodeAt(0);
  if (unit < 0x80) return 1;
  if (unit < 0x800) return 2;
  // Also right for a lone surrogate: encoders write U+FFFD in its place, three octets too.
  return 3;
}

/** Folds one content line (without line break) into ≤75-octet pieces joined by "\r\n ". */
export function foldIcsLine(line: string): string {
  let folded = '';
  let octets = 0;
  // Iterating a string yields whole code points, so a surrogate pair always stays together.
  for (const char of line) {
    const size = utf8Octets(char);
    if (octets + size > MAX_LINE_OCTETS) {
      folded += '\r\n ';
      // The space that marks a continuation line counts towards that line's 75 octets.
      octets = 1;
    }
    folded += char;
    octets += size;
  }
  return folded;
}

/** `20261122T070000Z` */
export function formatIcsUtc(instant: Date): string {
  // Fail loudly: an invalid Date would be written as "NaNNaNNaNT…" and silently break the file.
  if (Number.isNaN(instant.getTime())) throw new RangeError('Invalid date');
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    pad(instant.getUTCFullYear(), 4) +
    pad(instant.getUTCMonth() + 1) +
    pad(instant.getUTCDate()) +
    'T' +
    pad(instant.getUTCHours()) +
    pad(instant.getUTCMinutes()) +
    pad(instant.getUTCSeconds()) +
    'Z'
  );
}

export function buildIcs(events: readonly IcsEvent[], options: IcsOptions): string {
  const toInstant = options.toInstant ?? localDateTime;
  const stamp = formatIcsUtc(options.now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Team Schedule//Weekly Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(options.calendarName)}`,
  ];
  for (const event of events) {
    const start = toInstant(event.date, event.start);
    // 24:00 is not a time of day; asking for 00:00 of the next date keeps `toInstant` simple
    // and lets it apply the offset that is valid on that date.
    const end =
      event.end === MINUTES_PER_DAY ? toInstant(addDays(event.date, 1), 0) : toInstant(event.date, event.end);
    const location = escapeIcsText(event.location);
    const description = escapeIcsText(event.description);
    const categories = event.categories.map((category) => escapeIcsText(category)).filter((text) => text !== '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeIcsText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatIcsUtc(start)}`,
      `DTEND:${formatIcsUtc(end)}`,
      `SUMMARY:${escapeIcsText(event.summary)}`,
    );
    if (location !== '') lines.push(`LOCATION:${location}`);
    if (description !== '') lines.push(`DESCRIPTION:${description}`);
    if (categories.length > 0) lines.push(`CATEGORIES:${categories.join(',')}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map((line) => `${foldIcsLine(line)}\r\n`).join('');
}

/** Localized words used inside event descriptions. */
export interface IcsLabels {
  /** e.g. "Teachers" / "מורים" */
  teachers: string;
  classes: string;
  subject: string;
  /** Summary used when an event has neither a title nor a subject. e.g. "Event" / "אירוע" */
  untitled: string;
}

export interface CollectIcsInput {
  dataset: Dataset;
  /** Weeks to export (Sundays). Weeks missing from the dataset contribute nothing. */
  weekStarts: readonly IsoDate[];
  /** Optional filter, e.g. the active week-view filter. */
  include?: (event: ScheduleEvent, weekStart: IsoDate) => boolean;
  labels: IcsLabels;
}

/** Names of the referenced entries that still exist, in the order of the schedule's own list. */
function namesInListOrder(config: ScheduleConfig, kind: EntityKind, ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return entityList(config, kind)
    .filter((item) => wanted.has(item.id))
    .map((item) => item.name.trim())
    .filter((name) => name !== '');
}

function toIcsEvent(event: ScheduleEvent, weekStart: IsoDate, config: ScheduleConfig, labels: IcsLabels): IcsEvent {
  const title = event.title.trim();
  const subject = findSubject(config, event.subjectId)?.name.trim() ?? '';
  const teachers = namesInListOrder(config, 'teacher', event.teacherIds);
  const classes = namesInListOrder(config, 'class', event.classIds);
  const notes = event.notes.trim();

  const description: string[] = [];
  // Without a title the subject already is the summary; repeating it below would be noise.
  if (title !== '' && subject !== '') description.push(`${labels.subject}: ${subject}`);
  if (teachers.length > 0) description.push(`${labels.teachers}: ${teachers.join(', ')}`);
  if (classes.length > 0) description.push(`${labels.classes}: ${classes.join(', ')}`);
  if (notes !== '') description.push(notes);

  return {
    uid: `${event.id}-${weekStart}@team-schedule`,
    date: addDays(weekStart, event.day),
    start: event.start,
    end: event.end,
    summary: title || subject || labels.untitled,
    location: findEntity(config, 'location', event.locationId)?.name.trim() ?? '',
    description: description.join('\n'),
    categories: subject === '' ? [] : [subject],
  };
}

/**
 * Turns schedule events into IcsEvents, ordered by date then start time (events that
 * share both keep their order inside the week).
 *  - uid: `<event.id>-<weekStart>@team-schedule`
 *  - date: weekStart + event.day
 *  - summary: the title; when empty, the subject name; when that is missing too, labels.untitled
 *  - location: the location name ('' when none or deleted)
 *  - description: the lines that apply, joined with "\n":
 *        `<labels.subject>: <subject name>`      (only when the event has a title AND a subject)
 *        `<labels.teachers>: <name>, <name>`     (names in schedule.json list order)
 *        `<labels.classes>: <name>, <name>`
 *        the notes text
 *  - categories: [subject name] or []
 * References to deleted entries are skipped silently, and so are entries whose name is blank.
 * A week listed twice is exported once (a calendar must not hold the same UID twice).
 */
export function collectIcsEvents(input: CollectIcsInput): IcsEvent[] {
  const { dataset, include, labels } = input;
  const collected: IcsEvent[] = [];
  for (const weekStart of new Set(input.weekStarts)) {
    for (const event of getWeek(dataset, weekStart).events) {
      if (include && !include(event, weekStart)) continue;
      collected.push(toIcsEvent(event, weekStart, dataset.config, labels));
    }
  }
  // Array.prototype.sort is stable, so ties keep the week's own (day, start, end, id) order.
  return collected.sort((a, b) => compareDates(a.date, b.date) || a.start - b.start);
}
