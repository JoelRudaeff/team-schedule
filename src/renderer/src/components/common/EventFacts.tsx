import type { ReactNode } from 'react';
import { addDays } from '@shared/dates';
import { findSubject } from '@shared/model';
import type { IsoDate, ScheduleConfig, ScheduleEvent } from '@shared/types';
import { useT } from '../../i18n/useT';
import { dayName, formatDayMonth, formatDuration, formatTimeRange } from '../../lib/format';
import { entityName, entityNames } from '../../lib/lookup';
import { ColorDot, Icon } from '../ui';
import './common.css';

interface EventFactsProps {
  event: ScheduleEvent;
  config: ScheduleConfig;
  /** When given, the calendar date is shown next to the day name. */
  weekStart?: IsoDate;
  /** Names of event fields to highlight (e.g. the ones that differ between two versions). */
  highlight?: readonly string[];
}

/** The facts of one event as icon rows: when, where, who, what. Used by the details popover and the comparisons. */
export function EventFacts({ event, config, weekStart, highlight = [] }: EventFactsProps): ReactNode {
  const { t, lang } = useT();
  const marked = (...fields: string[]): string => (fields.some((f) => highlight.includes(f)) ? ' is-highlight' : '');
  const subject = findSubject(config, event.subjectId);
  const location = entityName(config, 'location', event.locationId, event.locationId ? t('common.deletedItem') : '');
  const teachers = entityNames(config, 'teacher', event.teacherIds);
  const classes = entityNames(config, 'class', event.classIds);

  return (
    <div className="facts">
      <div className={`facts__row${marked('day', 'start', 'end', 'time')}`}>
        <Icon name="clock" size={14} />
        <span>
          {dayName(event.day, lang, 'long')}
          {weekStart ? `, ${formatDayMonth(addDays(weekStart, event.day), lang)}` : ''}
          {' · '}
          <bdi dir="ltr">{formatTimeRange(event.start, event.end)}</bdi>
          <span className="faint"> ({formatDuration(event.end - event.start)})</span>
        </span>
      </div>
      {event.subjectId ? (
        <div className={`facts__row${marked('subjectId')}`}>
          <Icon name="tag" size={14} />
          <span className="facts__inline">
            {subject ? <ColorDot color={subject.color} /> : null}
            <span className="user-text">{subject?.name ?? t('common.deletedItem')}</span>
          </span>
        </div>
      ) : null}
      {location ? (
        <div className={`facts__row${marked('locationId')}`}>
          <Icon name="location" size={14} />
          <span className="user-text">{location}</span>
        </div>
      ) : null}
      {teachers.length > 0 ? (
        <div className={`facts__row${marked('teacherIds')}`}>
          <Icon name="user" size={14} />
          <span className="user-text">{teachers.join(', ')}</span>
        </div>
      ) : null}
      {classes.length > 0 ? (
        <div className={`facts__row${marked('classIds')}`}>
          <Icon name="users" size={14} />
          <span className="user-text">{classes.join(', ')}</span>
        </div>
      ) : null}
      {event.notes ? (
        <div className={`facts__row${marked('notes')}`}>
          <Icon name="notes" size={14} />
          <span className="facts__notes user-text selectable">{event.notes}</span>
        </div>
      ) : null}
    </div>
  );
}
