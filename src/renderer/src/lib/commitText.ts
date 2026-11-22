import type { Filters, ScheduleEvent } from '@shared/types';
import type { Translator } from '../i18n';

/** First lines the app writes by itself: see summarizeDiff() in @shared/merge and the store's "create" message. */
const AUTO_UPDATE = /^Update schedule(?:: (.*))?$/;
const AUTO_CREATE = /^Create schedule$/;

function countAfter(sign: '+' | '~' | '-', text: string): number {
  const match = new RegExp(`\\${sign}(\\d+)`).exec(text);
  return match ? Number(match[1]) : 0;
}

/**
 * What to show for a teammate's commit. Their own note is shown as it is; the terse English
 * summary the app writes when no note was typed ("Update schedule: events +2 ~1; lists")
 * is put into words in the interface language.
 */
export function readableCommitSubject(subject: string, tr: Translator): string {
  const { t } = tr;
  if (AUTO_CREATE.test(subject)) return t('toolbar.commitCreated');
  const match = AUTO_UPDATE.exec(subject);
  if (!match) return subject;

  const detail = match[1] ?? '';
  const parts: string[] = [];
  const events = /events((?: [+~-]\d+)+)/.exec(detail);
  if (events) {
    const bits: string[] = [];
    const added = countAfter('+', events[1]);
    const changed = countAfter('~', events[1]);
    const removed = countAfter('-', events[1]);
    if (added > 0) bits.push(t('toolbar.commitAdded', { count: added }));
    if (changed > 0) bits.push(t('toolbar.commitChanged', { count: changed }));
    if (removed > 0) bits.push(t('toolbar.commitRemoved', { count: removed }));
    parts.push(`${t('toolbar.commitEvents')}: ${bits.join(', ')}`);
  }
  if (/week title/.test(detail)) parts.push(t('toolbar.commitWeekNames'));
  if (/\blists\b/.test(detail)) parts.push(t('toolbar.commitLists'));
  if (/\bsettings\b/.test(detail)) parts.push(t('toolbar.commitSettings'));
  return parts.length > 0 ? parts.join(' · ') : t('toolbar.commitChanges');
}

/**
 * Fields for a new event taken from the active filter, so that an event created while
 * looking at "Room 101" is in Room 101 and does not vanish behind the filter. Only a filter
 * with exactly one choice says something definite.
 */
export function prefillFromFilters(filters: Filters): Partial<ScheduleEvent> {
  const patch: Partial<ScheduleEvent> = {};
  if (filters.locationIds.length === 1) patch.locationId = filters.locationIds[0];
  if (filters.subjectIds.length === 1) patch.subjectId = filters.subjectIds[0];
  if (filters.teacherIds.length === 1) patch.teacherIds = [filters.teacherIds[0]];
  if (filters.classIds.length === 1) patch.classIds = [filters.classIds[0]];
  return patch;
}
