import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { contrastText } from '@shared/colors';
import { addDays, clamp, isDateInCourse, roundToStep, todayIso } from '@shared/dates';
import { eventKey, type AsideItem } from '@shared/merge';
import { findClashes, getWeek, hasActiveFilters, matchesFilters, visibleRange } from '@shared/model';
import type { DayIndex, Minutes, ScheduleEvent } from '@shared/types';
import { useT } from '../../i18n/useT';
import { prefillFromFilters } from '../../lib/commitText';
import { dayName, formatDayMonth, formatTime, formatTimeRange } from '../../lib/format';
import { entityName, entityNames, eventColor, eventHeadline } from '../../lib/lookup';
import { actions, getState, useApp } from '../../store';
import { Button, Callout, Icon } from '../ui';
import { AsidePopover, EventPopover } from './EventPopover';
import { hasTimeLabel, layoutDay, pixelsPerMinute, slotStarts, type Placement } from './layout';
import './grid.css';

const DAYS: readonly DayIndex[] = [0, 1, 2, 3, 4, 5, 6];
/** Events snap to quarter hours while dragging, whatever the row height. */
const STEP = 15;
const DRAG_THRESHOLD_PX = 4;
const DOUBLE_CLICK_MS = 350;

type Gesture =
  | { kind: 'create'; day: DayIndex; anchor: Minutes; current: Minutes; moved: boolean; x: number; y: number }
  | {
      kind: 'move';
      event: ScheduleEvent;
      element: HTMLElement;
      grabOffset: number;
      day: DayIndex;
      start: Minutes;
      moved: boolean;
      x: number;
      y: number;
    }
  | { kind: 'resize'; event: ScheduleEvent; end: Minutes; moved: boolean; x: number; y: number };

type Selection = { kind: 'event'; id: string; anchor: HTMLElement } | { kind: 'aside'; key: string; anchor: HTMLElement };

/** An aside item of this week that carries my version of an event (shown as a ghost on the grid). */
function ghostEvent(item: AsideItem): ScheduleEvent | null {
  const mine = item.mine;
  return item.kind === 'event' && typeof mine === 'object' && mine !== null && 'day' in mine ? mine : null;
}

function nowMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

interface EventCardProps {
  event: ScheduleEvent;
  top: number;
  height: number;
  placement: Placement;
  color: string;
  headline: string;
  location: string;
  people: string;
  change: 'added' | 'modified' | undefined;
  clashing: boolean;
  asideMark: boolean;
  dimmed: boolean;
  selected: boolean;
  resizable: boolean;
  unpublishedLabel: string;
  clashLabel: string;
  resizeLabel: string;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

function EventCard(props: EventCardProps): ReactNode {
  const { event, top, height, placement, color } = props;
  const size = height < 30 ? ' is-tiny' : height < 52 ? ' is-small' : '';
  return (
    <div
      className={`wg-event${size}${props.dimmed ? ' is-dimmed' : ''}${props.selected ? ' is-selected' : ''}`}
      style={{
        top,
        height,
        insetInlineStart: `calc(${(placement.column / placement.columns) * 100}% + 2px)`,
        width: `calc(${100 / placement.columns}% - 4px)`,
        background: color,
        color: contrastText(color),
      }}
      role="button"
      tabIndex={0}
      aria-label={`${props.headline}, ${formatTimeRange(event.start, event.end)}`}
      onPointerDown={props.onPointerDown}
      onKeyDown={props.onKeyDown}
      data-testid={`event-${event.id}`}
      data-event-id={event.id}
      data-day={event.day}
      data-start={event.start}
      data-end={event.end}
      data-change={props.change ?? ''}
    >
      {/* <bdi>: the text keeps its own direction (see grid.css), but stays aligned with the interface and clear of the marks. */}
      <div className="wg-event__title">
        <bdi>{props.headline}</bdi>
      </div>
      <div className="wg-event__time">
        <bdi dir="ltr">{formatTimeRange(event.start, event.end)}</bdi>
      </div>
      {props.location ? (
        <div className="wg-event__line">
          <bdi>{props.location}</bdi>
        </div>
      ) : null}
      {props.people ? (
        <div className="wg-event__line">
          <bdi>{props.people}</bdi>
        </div>
      ) : null}
      <div className="wg-event__marks">
        {props.asideMark ? <Icon name="inbox" size={12} /> : null}
        {props.clashing ? <Icon name="warning" size={12} title={props.clashLabel} /> : null}
        {props.change ? <span className="wg-event__dot" title={props.unpublishedLabel} data-testid={`event-${event.id}-unpublished`} /> : null}
      </div>
      {props.resizable ? <div className="wg-event__resize" title={props.resizeLabel} onPointerDown={props.onResizeDown} /> : null}
    </div>
  );
}

export function WeekGrid(): ReactNode {
  const { t, lang } = useT();
  const weekStart = useApp((s) => s.weekStart);
  const working = useApp((s) => s.working);
  const filters = useApp((s) => s.filters);
  const diffByKey = useApp((s) => s.diffByKey);
  const aside = useApp((s) => s.aside);
  const readOnly = useApp((s) => s.readOnlyWeeks.includes(s.weekStart));
  // A week whose file is damaged on this computer is still shown — as the team has it — when the team has it.
  const teamCopyShown = useApp((s) => s.readOnlyWeeks.includes(s.weekStart) && s.base.weeks[s.weekStart] !== undefined);
  const headSha = useApp((s) => s.sync?.headSha ?? null);

  const config = working.config;
  const grid = config.timeGrid;
  const week = getWeek(working, weekStart);
  const filtering = hasActiveFilters(filters);

  const ghosts = useMemo(
    () =>
      aside.flatMap((item) => {
        const mine = item.weekStart === weekStart ? ghostEvent(item) : null;
        return mine ? [{ item, mine }] : [];
      }),
    [aside, weekStart],
  );
  const asideDeletions = useMemo(
    () => new Set(aside.filter((item) => item.kind === 'event' && item.weekStart === weekStart && item.mine === undefined).map((item) => item.id)),
    [aside, weekStart],
  );

  const shown = useMemo(
    () => (filtering ? week.events.filter((event) => matchesFilters(event, filters)) : week.events),
    [week.events, filters, filtering],
  );
  const clashes = useMemo(() => findClashes(week.events), [week.events]);
  // The visible hours follow ALL events of the week, so filtering never makes the grid jump.
  const range = useMemo(
    () => visibleRange(grid, [...week.events, ...ghosts.map((ghost) => ghost.mine)]),
    [grid, week.events, ghosts],
  );
  const placements = useMemo(() => {
    const byDay = new Map<DayIndex, Map<string, Placement>>();
    for (const day of DAYS) byDay.set(day, layoutDay(shown.filter((event) => event.day === day)));
    return byDay;
  }, [shown]);

  const ppm = pixelsPerMinute(grid.slotMinutes);
  const bodyHeight = (range.end - range.start) * ppm;
  const rows = slotStarts(range.start, range.end, grid.slotMinutes);
  const today = todayIso();
  const todayIndex = today >= weekStart && today <= addDays(weekStart, 6) ? (DAYS.find((d) => addDays(weekStart, d) === today) ?? null) : null;

  const columnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const lastClick = useRef<{ id: string; time: number } | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [minuteNow, setMinuteNow] = useState(nowMinutes);

  const setGesture = (next: Gesture | null): void => {
    gestureRef.current = next;
    setGestureState(next);
  };

  useEffect(() => {
    actions.ensureBlame(weekStart);
  }, [weekStart, headSha]);

  useEffect(() => {
    setSelection(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [weekStart]);

  useEffect(() => {
    const timer = setInterval(() => setMinuteNow(nowMinutes()), 30_000);
    return () => clearInterval(timer);
  }, []);

  /** Which day column and minute of the day lie under a screen position. */
  const locate = (x: number, y: number): { day: DayIndex; minutes: number } | null => {
    for (const day of DAYS) {
      const rect = columnRefs.current[day]?.getBoundingClientRect();
      // Works for both directions: the columns are found by where they really are on screen.
      if (rect && x >= rect.left && x < rect.right) return { day, minutes: range.start + (y - rect.top) / ppm };
    }
    return null;
  };

  const openEvent = (event: ScheduleEvent, element: HTMLElement): void => {
    const previous = lastClick.current;
    const nowMs = Date.now();
    lastClick.current = { id: event.id, time: nowMs };
    if (!readOnly && previous && previous.id === event.id && nowMs - previous.time < DOUBLE_CLICK_MS) {
      setSelection(null);
      actions.openDialog({ type: 'event', weekStart, eventId: event.id });
      return;
    }
    setSelection({ kind: 'event', id: event.id, anchor: element });
  };

  // While a gesture is in progress the whole window is listened to, so the pointer may leave the grid.
  const gestureActive = gesture !== null;
  useEffect(() => {
    if (!gestureActive) return;
    const onMove = (e: PointerEvent): void => {
      const g = gestureRef.current;
      if (!g) return;
      const moved = g.moved || Math.hypot(e.clientX - g.x, e.clientY - g.y) > DRAG_THRESHOLD_PX;
      if (!moved) return;
      const at = locate(e.clientX, e.clientY);
      if (g.kind === 'create') {
        const current = at ? clamp(roundToStep(at.minutes, STEP), 0, 1440) : g.current;
        setGesture({ ...g, moved, current });
      } else if (readOnly) {
        return;
      } else if (g.kind === 'move') {
        const duration = g.event.end - g.event.start;
        const start = at ? clamp(roundToStep(at.minutes - g.grabOffset, STEP), 0, 1440 - duration) : g.start;
        setGesture({ ...g, moved, day: at?.day ?? g.day, start });
      } else {
        const end = at ? clamp(roundToStep(at.minutes, STEP), g.event.start + STEP, 1440) : g.end;
        setGesture({ ...g, moved, end });
      }
    };
    const onUp = (): void => {
      const g = gestureRef.current;
      setGesture(null);
      if (!g) return;
      if (g.kind === 'create') {
        let start: number;
        let end: number;
        if (g.moved) {
          start = Math.min(g.anchor, g.current);
          end = Math.max(g.anchor, g.current, start + STEP);
        } else {
          // A plain click: the row that was clicked, with a sensible default length.
          const slot = grid.slotMinutes;
          start = range.start + Math.floor((g.anchor - range.start) / slot) * slot;
          end = start + (slot >= 45 ? slot : 60);
        }
        actions.openDialog({
          type: 'event',
          weekStart,
          eventId: null,
          // A new event starts out matching the active filter, so it does not vanish behind it.
          initial: { day: g.day, start, end: Math.min(1440, end), ...prefillFromFilters(getState().filters) },
        });
      } else if (g.kind === 'move') {
        if (!g.moved) openEvent(g.event, g.element);
        else if (g.day !== g.event.day || g.start !== g.event.start) {
          actions.saveEvent(weekStart, { ...g.event, day: g.day, start: g.start, end: g.start + (g.event.end - g.event.start) });
        }
      } else if (g.moved && g.end !== g.event.end) {
        actions.saveEvent(weekStart, { ...g.event, end: g.end });
      }
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setGesture(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey);
    };
    // The handlers read everything through refs and fresh closures of this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gestureActive, readOnly, weekStart, range.start, ppm, grid.slotMinutes]);

  const onColumnDown = (day: DayIndex) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || readOnly) return;
    if (e.target instanceof Element && e.target.closest('.wg-event, .wg-ghost')) return;
    const at = locate(e.clientX, e.clientY);
    if (!at) return;
    setSelection(null);
    const anchor = clamp(Math.floor(at.minutes / STEP) * STEP, 0, 1440 - STEP);
    setGesture({ kind: 'create', day, anchor, current: anchor, moved: false, x: e.clientX, y: e.clientY });
  };

  const onEventDown = (event: ScheduleEvent) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const at = locate(e.clientX, e.clientY);
    setGesture({
      kind: 'move',
      event,
      element: e.currentTarget,
      grabOffset: at ? at.minutes - event.start : 0,
      day: event.day,
      start: event.start,
      moved: false,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const onResizeDown = (event: ScheduleEvent) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelection(null);
    setGesture({ kind: 'resize', event, end: event.end, moved: false, x: e.clientX, y: e.clientY });
  };

  const onEventKey = (event: ScheduleEvent) => (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSelection({ kind: 'event', id: event.id, anchor: e.currentTarget });
    } else if (e.key === 'Delete' && !readOnly) {
      e.preventDefault();
      actions.deleteEvent(weekStart, event.id);
      actions.toast({ kind: 'info', message: t('grid.deleted'), action: { label: t('grid.undo'), run: () => actions.undo() } });
    }
  };

  const selectedEvent = selection?.kind === 'event' ? week.events.find((event) => event.id === selection.id) : undefined;
  const selectedGhost = selection?.kind === 'aside' ? ghosts.find((ghost) => ghost.item.key === selection.key) : undefined;

  const position = (start: Minutes, end: Minutes): { top: number; height: number } => ({
    top: (start - range.start) * ppm,
    height: Math.max(16, (end - start) * ppm - 2),
  });

  if (readOnly && !teamCopyShown) {
    return (
      <div className="wg wg--message" data-testid="week-grid">
        <Callout tone="danger" testId="week-read-only">
          {t('grid.readOnlyWeek')}
        </Callout>
      </div>
    );
  }

  return (
    <div className="wg" data-testid="week-grid" data-week={weekStart} aria-label={t('grid.weekGrid')}>
      {readOnly ? (
        <div className="wg-notice" role="status" data-testid="week-read-only">
          <Icon name="warning" size={14} />
          <span>{t('grid.readOnlyTeamCopy')}</span>
        </div>
      ) : null}
      <div className="wg-head">
        <div className="wg-corner" />
        {DAYS.map((day) => {
          const date = addDays(weekStart, day);
          const outside = !isDateInCourse(date, config.course);
          return (
            <div
              key={day}
              className={`wg-day-head${day === todayIndex ? ' is-today' : ''}${outside ? ' is-outside' : ''}`}
              title={outside ? t('grid.outsideCourse') : undefined}
              data-testid={`day-head-${day}`}
            >
              <span className="wg-day-head__name">{dayName(day, lang, 'long')}</span>
              <span className="wg-day-head__date">{formatDayMonth(date, lang)}</span>
            </div>
          );
        })}
      </div>

      <div className="wg-scroll" ref={scrollRef}>
        <div className="wg-body" style={{ height: bodyHeight }}>
          <div className="wg-gutter">
            {rows.map((minute) =>
              hasTimeLabel(minute, grid.slotMinutes) ? (
                <span key={minute} className="wg-gutter__label ltr" style={{ top: (minute - range.start) * ppm }}>
                  {formatTime(minute)}
                </span>
              ) : null,
            )}
          </div>

          <div className="wg-lines" aria-hidden="true">
            {rows.map((minute) => (
              <div key={minute} className={`wg-line${minute % 60 === 0 ? ' is-hour' : ''}`} style={{ top: (minute - range.start) * ppm }} />
            ))}
          </div>

          {DAYS.map((day) => {
            const date = addDays(weekStart, day);
            const outside = !isDateInCourse(date, config.course);
            const dayPlacements = placements.get(day);
            return (
              <div
                key={day}
                ref={(element) => {
                  columnRefs.current[day] = element;
                }}
                className={`wg-col${day === todayIndex ? ' is-today' : ''}${outside ? ' is-outside' : ''}`}
                onPointerDown={onColumnDown(day)}
                data-testid={`day-column-${day}`}
                data-day={day}
              >
                {shown
                  .filter((event) => event.day === day)
                  .map((event) => {
                    const resizing = gesture?.kind === 'resize' && gesture.event.id === event.id;
                    const moving = gesture?.kind === 'move' && gesture.moved && gesture.event.id === event.id;
                    const end = resizing ? gesture.end : event.end;
                    return (
                      <EventCard
                        key={event.id}
                        event={event}
                        {...position(event.start, end)}
                        placement={dayPlacements?.get(event.id) ?? { column: 0, columns: 1 }}
                        color={eventColor(event, config)}
                        headline={eventHeadline(event, config, t('common.untitledEvent'))}
                        location={entityName(config, 'location', event.locationId)}
                        people={[...entityNames(config, 'teacher', event.teacherIds), ...entityNames(config, 'class', event.classIds)].join(' · ')}
                        change={(() => {
                          const change = diffByKey.get(eventKey(weekStart, event.id))?.change;
                          return change === 'added' || change === 'modified' ? change : undefined;
                        })()}
                        clashing={clashes[event.id] !== undefined}
                        asideMark={asideDeletions.has(event.id)}
                        dimmed={moving}
                        selected={selection?.kind === 'event' && selection.id === event.id}
                        resizable
                        unpublishedLabel={t('grid.unpublishedModified')}
                        clashLabel={t('grid.clashTitle')}
                        resizeLabel={t('grid.resizeHint')}
                        onPointerDown={onEventDown(event)}
                        onResizeDown={onResizeDown(event)}
                        onKeyDown={onEventKey(event)}
                      />
                    );
                  })}

                {ghosts
                  .filter((ghost) => ghost.mine.day === day)
                  .map(({ item, mine }) => (
                    <button
                      key={item.key}
                      type="button"
                      className="wg-ghost"
                      style={position(mine.start, mine.end)}
                      onClick={(e) => setSelection({ kind: 'aside', key: item.key, anchor: e.currentTarget })}
                      data-testid={`ghost-${mine.id}`}
                    >
                      <span className="wg-ghost__tag">
                        <Icon name="inbox" size={12} /> {t('grid.asideGhost')}
                      </span>
                      <span className="wg-ghost__title">
                        <bdi>{eventHeadline(mine, config, t('common.untitledEvent'))}</bdi>
                      </span>
                      <bdi dir="ltr">{formatTimeRange(mine.start, mine.end)}</bdi>
                    </button>
                  ))}

                {gesture?.kind === 'create' && gesture.moved && gesture.day === day ? (
                  <div
                    className="wg-selection"
                    style={position(Math.min(gesture.anchor, gesture.current), Math.max(gesture.anchor, gesture.current, Math.min(gesture.anchor, gesture.current) + STEP))}
                  >
                    <bdi dir="ltr">
                      {formatTimeRange(Math.min(gesture.anchor, gesture.current), Math.max(gesture.anchor, gesture.current, Math.min(gesture.anchor, gesture.current) + STEP))}
                    </bdi>
                  </div>
                ) : null}

                {gesture?.kind === 'move' && gesture.moved && gesture.day === day ? (
                  <div
                    className="wg-event wg-event--preview"
                    style={{
                      ...position(gesture.start, gesture.start + (gesture.event.end - gesture.event.start)),
                      insetInlineStart: 2,
                      width: 'calc(100% - 4px)',
                      background: eventColor(gesture.event, config),
                      color: contrastText(eventColor(gesture.event, config)),
                    }}
                  >
                    <div className="wg-event__title">
                      <bdi>{eventHeadline(gesture.event, config, t('common.untitledEvent'))}</bdi>
                    </div>
                    <div className="wg-event__time">
                      <bdi dir="ltr">{formatTimeRange(gesture.start, gesture.start + (gesture.event.end - gesture.event.start))}</bdi>
                    </div>
                  </div>
                ) : null}

                {day === todayIndex && minuteNow >= range.start && minuteNow < range.end ? (
                  <div className="wg-now" style={{ top: (minuteNow - range.start) * ppm }} aria-label={t('grid.today')} />
                ) : null}
              </div>
            );
          })}
        </div>

        {week.events.length === 0 && ghosts.length === 0 ? (
          <div className="wg-hint" data-testid="week-empty">
            <Icon name="calendar" size={26} />
            <strong>{t('grid.emptyWeek')}</strong>
            <span>{t('grid.emptyWeekHint')}</span>
          </div>
        ) : shown.length === 0 && filtering ? (
          <div className="wg-hint wg-hint--action" data-testid="week-no-matches">
            <Icon name="filter" size={26} />
            <strong>{t('grid.noMatches')}</strong>
            <Button size="sm" onClick={() => actions.clearFilters()}>
              {t('toolbar.clearFilters')}
            </Button>
          </div>
        ) : null}
      </div>

      {selection?.kind === 'event' && selectedEvent ? (
        <EventPopover
          anchor={selection.anchor}
          weekStart={weekStart}
          event={selectedEvent}
          weekEvents={week.events}
          clashes={clashes[selectedEvent.id] ?? []}
          readOnly={readOnly}
          onClose={() => setSelection(null)}
        />
      ) : null}
      {selection?.kind === 'aside' && selectedGhost ? (
        <AsidePopover anchor={selection.anchor} item={selectedGhost.item} mine={selectedGhost.mine} config={config} onClose={() => setSelection(null)} />
      ) : null}
    </div>
  );
}
