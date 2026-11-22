/** Pure layout maths of the week grid (no React, unit-testable). */
import type { Minutes, SlotMinutes } from '@shared/types';

/** Height of one grid row per slot size, in CSS pixels. */
export const SLOT_HEIGHT: Record<SlotMinutes, number> = { 15: 20, 30: 28, 45: 36, 60: 48 };

export function pixelsPerMinute(slotMinutes: SlotMinutes): number {
  return SLOT_HEIGHT[slotMinutes] / slotMinutes;
}

export interface Span {
  id: string;
  start: Minutes;
  end: Minutes;
}

export interface Placement {
  /** 0-based column inside the group of overlapping events. */
  column: number;
  /** How many columns that group needs. */
  columns: number;
}

/**
 * Places the events of one day side by side where they overlap in time: events that
 * (transitively) overlap form a group, every event takes the first free column of its
 * group, and all events of a group share the group's column count.
 */
export function layoutDay(spans: readonly Span[]): Map<string, Placement> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end || (a.id < b.id ? -1 : 1));
  const result = new Map<string, Placement>();

  let group: { span: Span; column: number }[] = [];
  let groupEnd = -1;
  /** End time of the last event in each column of the current group. */
  let columnEnds: number[] = [];

  const closeGroup = (): void => {
    for (const member of group) result.set(member.span.id, { column: member.column, columns: columnEnds.length });
    group = [];
    columnEnds = [];
    groupEnd = -1;
  };

  for (const span of sorted) {
    if (group.length > 0 && span.start >= groupEnd) closeGroup();
    let column = columnEnds.findIndex((end) => end <= span.start);
    if (column < 0) {
      column = columnEnds.length;
      columnEnds.push(span.end);
    } else {
      columnEnds[column] = span.end;
    }
    group.push({ span, column });
    groupEnd = Math.max(groupEnd, span.end);
  }
  closeGroup();
  return result;
}

/** The minute marks at which grid rows start, from `start` up to (not including) `end`. */
export function slotStarts(start: Minutes, end: Minutes, slotMinutes: SlotMinutes): Minutes[] {
  const marks: Minutes[] = [];
  for (let minute = start; minute < end; minute += slotMinutes) marks.push(minute);
  return marks;
}

/** Whether a row gets a time label: every row, except that 15-minute grids label only :00 and :30. */
export function hasTimeLabel(minute: Minutes, slotMinutes: SlotMinutes): boolean {
  return slotMinutes !== 15 || minute % 30 === 0;
}
