import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { addDays, dayOfWeek, isDateInCourse, maxWeekNumber, todayIso, weekNumberOf } from '@shared/dates';
import { getWeek, hasActiveFilters } from '@shared/model';
import type { IsoDate } from '@shared/types';
import { useT } from '../../i18n/useT';
import { prefillFromFilters } from '../../lib/commitText';
import { formatWeekRange } from '../../lib/format';
import { actions, getState, useApp } from '../../store';
import { LanguageSwitch } from '../common/LanguageSwitch';
import { Badge, Button, DateInput, Icon, IconButton, MenuButton, MultiSelect, NumberInput, Popover, textDirection, type MenuItem } from '../ui';
import { SyncStatusBar } from './SyncStatusBar';
import './toolbar.css';

/** "Week 12 of 20" / "Week 47 · 2026", plus a hint when the week lies outside the course. */
function WeekLabel(): ReactNode {
  const { t, lang } = useT();
  const weekStart = useApp((s) => s.weekStart);
  const course = useApp((s) => s.working.config.course);
  const number = weekNumberOf(weekStart, course);

  let text: string;
  let outside = false;
  if (number.kind === 'calendar') {
    text = t('toolbar.weekOfYear', { number: number.number, year: number.year });
  } else if (number.number < 1) {
    text = t('toolbar.beforeCourse');
    outside = true;
  } else if (number.total !== null && number.number > number.total) {
    text = t('toolbar.afterCourse');
    outside = true;
  } else {
    text =
      number.total !== null
        ? t('toolbar.weekOfCourseTotal', { number: number.number, total: number.total })
        : t('toolbar.weekOfCourse', { number: number.number });
  }
  // A week that only partly overlaps the course is still a course week; flag only fully outside weeks.
  const fullyOutside = !isDateInCourse(weekStart, course) && !isDateInCourse(addDays(weekStart, 6), course);

  return (
    <div className="tb-week__label" data-testid="week-label">
      <span className="tb-week__number">{text}</span>
      <span className="tb-week__range">{formatWeekRange(weekStart, lang)}</span>
      {outside || fullyOutside ? (
        <Badge tone="warning" testId="week-outside-course">
          {t('toolbar.outsideCourse')}
        </Badge>
      ) : null}
    </div>
  );
}

/** Jump by week number (typed + Enter) or by date. */
function GoTo(): ReactNode {
  const { t } = useT();
  const weekStart = useApp((s) => s.weekStart);
  const course = useApp((s) => s.working.config.course);
  const [value, setValue] = useState<number | null>(null);
  /** What is in the box, usable or not. */
  const [entry, setEntry] = useState('');
  /** The entry that led nowhere, as it was typed. */
  const [failed, setFailed] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const max = maxWeekNumber(course, weekStart);

  // Once another week is on screen, an old "no such week" message — or a number left in the
  // box, which would read like the number of the week now shown — only confuses.
  useEffect(() => {
    setFailed(null);
    setValue(null);
    setEntry('');
  }, [weekStart]);

  const go = (): void => {
    const typed = entry.trim();
    if (typed === '') return;
    // Anything that is not the number of a week gets the same answer: 0, -3, 1.5 or 99.
    if (value !== null && actions.goToWeekNumber(value)) {
      setFailed(null);
      setValue(null);
      setEntry('');
    } else {
      setFailed(typed);
    }
  };

  const problem =
    failed === null
      ? null
      : max !== null
        ? t('toolbar.weekNumberInvalid', { number: failed, max })
        : t('toolbar.weekNumberInvalidOpen', { number: failed });

  return (
    <div className="tb-goto" title={t('toolbar.weekNumberHint')}>
      <NumberInput
        id="tb-week-number"
        value={value}
        onChange={setValue}
        // The text is kept here, so the box can be emptied after a jump and still be the same
        // box: the next week number can be typed right away.
        text={entry}
        onTextChange={(text) => {
          setEntry(text);
          setFailed(null);
        }}
        placeholder={t('toolbar.weekNumber')}
        invalid={failed !== null}
        ariaLabel={t('toolbar.weekNumberHint')}
        onEnter={go}
        className="tb-goto__input"
        testId="week-number-input"
      />
      <IconButton ref={setAnchor} icon="calendar" size="sm" label={t('toolbar.goToDate')} active={open} onClick={() => setOpen((v) => !v)} testId="week-goto-date" />
      {problem ? (
        <span className="tb-goto__error" role="alert" data-testid="week-number-error">
          {problem}
        </span>
      ) : null}
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} ariaLabel={t('toolbar.goToDate')}>
        <div className="tb-goto__date">
          <span>{t('toolbar.goToDate')}</span>
          <DateInput
            value={null}
            onChange={(date) => {
              if (date) {
                actions.goToWeek(date);
                setOpen(false);
              }
            }}
            ariaLabel={t('toolbar.goToDate')}
            testId="week-date-input"
          />
        </div>
      </Popover>
    </div>
  );
}

/** The week's free-text name, edited in place. */
function WeekTitle(): ReactNode {
  const { t } = useT();
  const weekStart = useApp((s) => s.weekStart);
  const stored = useApp((s) => getWeek(s.working, s.weekStart).title);
  const readOnly = useApp((s) => s.readOnlyWeeks.includes(s.weekStart));
  const [draft, setDraft] = useState(stored);

  useEffect(() => setDraft(stored), [stored, weekStart]);

  const commit = (): void => {
    if (draft.trim() !== stored) actions.setWeekTitle(weekStart, draft);
  };

  return (
    <input
      className="tb-week__title"
      dir={textDirection(draft)}
      value={draft}
      placeholder={t('toolbar.weekTitlePlaceholder')}
      aria-label={t('toolbar.weekTitleLabel')}
      maxLength={120}
      disabled={readOnly}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        else if (event.key === 'Escape') {
          setDraft(stored);
          event.stopPropagation();
        }
      }}
      data-testid="week-title-input"
    />
  );
}

function Filters(): ReactNode {
  const { t } = useT();
  const filters = useApp((s) => s.filters);
  const config = useApp((s) => s.working.config);
  return (
    <div className="tb-filters" data-testid="filters">
      <MultiSelect
        label={t('toolbar.filterLocation')}
        icon="location"
        options={config.locations}
        selected={filters.locationIds}
        onChange={(locationIds) => actions.setFilters({ locationIds })}
        emptyText={t('toolbar.noLocations')}
        testId="filter-location"
      />
      <MultiSelect
        label={t('toolbar.filterClass')}
        icon="users"
        options={config.classes}
        selected={filters.classIds}
        onChange={(classIds) => actions.setFilters({ classIds })}
        emptyText={t('toolbar.noClasses')}
        testId="filter-class"
      />
      <MultiSelect
        label={t('toolbar.filterTeacher')}
        icon="user"
        options={config.teachers}
        selected={filters.teacherIds}
        onChange={(teacherIds) => actions.setFilters({ teacherIds })}
        emptyText={t('toolbar.noTeachers')}
        testId="filter-teacher"
      />
      <MultiSelect
        label={t('toolbar.filterSubject')}
        icon="tag"
        options={config.subjects}
        selected={filters.subjectIds}
        onChange={(subjectIds) => actions.setFilters({ subjectIds })}
        emptyText={t('toolbar.noSubjects')}
        testId="filter-subject"
      />
      {hasActiveFilters(filters) ? (
        <IconButton icon="close" size="sm" label={t('toolbar.clearFilters')} onClick={() => actions.clearFilters()} testId="filters-clear" />
      ) : null}
    </div>
  );
}

/** Opens the editor for a new event on today's column (or Sunday when another week is shown). */
function openNewEvent(): void {
  const state = getState();
  const { dayStart } = state.working.config.timeGrid;
  const today = todayIso();
  const inThisWeek = today >= state.weekStart && today <= addDays(state.weekStart, 6);
  actions.openDialog({
    type: 'event',
    weekStart: state.weekStart,
    eventId: null,
    initial: {
      day: inThisWeek ? dayOfWeek(today) : 0,
      start: dayStart,
      end: Math.min(1440, dayStart + 60),
      ...prefillFromFilters(state.filters),
    },
  });
}

function MainMenu(): ReactNode {
  const { t, tn } = useT();
  const canUndo = useApp((s) => s.canUndo);
  const canRedo = useApp((s) => s.canRedo);
  const diffCount = useApp((s) => s.diff.length);
  // A file damaged on this computer is repaired the same way: by going back to the team's version.
  const damaged = useApp((s) => s.damagedFiles.length > 0);
  const weekStart = useApp((s) => s.weekStart);

  const items = useMemo((): MenuItem[] => {
    const discard = (): void => {
      actions.openDialog({
        type: 'confirm',
        title: t('toolbar.discardTitle'),
        message: diffCount === 0 ? t('common.restoreDamagedText') : tn('toolbar.discardMessage', diffCount),
        confirmLabel: t('toolbar.discardConfirm'),
        danger: true,
        onConfirm: () => actions.discardLocalChanges(),
      });
    };
    return [
      { id: 'export-ics', label: t('toolbar.exportOutlook'), icon: 'calendar', onSelect: () => actions.openDialog({ type: 'export-ics' }) },
      {
        id: 'save-week',
        label: t('toolbar.saveWeekFile'),
        icon: 'download',
        // Always the whole week, whatever filter is on: a week file is loaded again "for repeating",
        // and half a week would later look like lost lessons.
        onSelect: () => void actions.exportWeekFile(weekStart, { filteredOnly: false }),
      },
      { id: 'load-week', label: t('toolbar.loadWeekFile'), icon: 'upload', onSelect: () => void actions.pickWeekFile() },
      { id: 'repeat-week', label: t('toolbar.repeatWeek'), icon: 'repeat', onSelect: () => actions.openDialog({ type: 'repeat-week' }) },
      { id: 'undo', label: t('toolbar.undo'), icon: 'undo', hint: 'Ctrl+Z', disabled: !canUndo, separatorBefore: true, onSelect: () => actions.undo() },
      { id: 'redo', label: t('toolbar.redo'), icon: 'redo', hint: 'Ctrl+Y', disabled: !canRedo, onSelect: () => actions.redo() },
      { id: 'discard', label: t('toolbar.discardChanges'), icon: 'trash', danger: true, disabled: diffCount === 0 && !damaged, separatorBefore: true, onSelect: discard },
      { id: 'settings', label: `${t('toolbar.settings')}…`, icon: 'settings', separatorBefore: true, onSelect: () => actions.openDialog({ type: 'settings' }) },
    ];
  }, [t, tn, canUndo, canRedo, diffCount, damaged, weekStart]);

  return <MenuButton label={t('toolbar.menu')} icon="more" iconOnly variant="ghost" items={items} align="end" testId="main-menu" />;
}

export function Toolbar(): ReactNode {
  const { t } = useT();
  const courseName = useApp((s) => s.working.config.course.name);
  const readOnly = useApp((s) => s.readOnlyWeeks.includes(s.weekStart));
  const weekStart: IsoDate = useApp((s) => s.weekStart);
  const isCurrentWeek = todayIso() >= weekStart && todayIso() <= addDays(weekStart, 6);

  return (
    <header className="tb" data-testid="toolbar">
      <div className="tb-top">
        <div className="tb-brand">
          <span className="tb-brand__logo">
            <Icon name="calendar" size={16} />
          </span>
          <span className="tb-brand__name">{t('common.appName')}</span>
          {courseName ? (
            <span className="tb-brand__course truncate user-text" title={courseName} data-testid="course-name">
              {courseName}
            </span>
          ) : null}
        </div>
        <div className="grow" />
        <SyncStatusBar />
        <span className="tb-divider" />
        <MainMenu />
        <IconButton icon="settings" label={t('toolbar.settings')} onClick={() => actions.openDialog({ type: 'settings' })} testId="open-settings" />
        <LanguageSwitch compact />
      </div>

      <div className="tb-week">
        <div className="tb-week__nav">
          <IconButton icon="chevron-start" flipRtl label={t('toolbar.prevWeek')} variant="secondary" onClick={() => actions.goToRelativeWeek(-1)} testId="week-prev" />
          <Button onClick={() => actions.goToToday()} disabled={isCurrentWeek} testId="week-today">
            {t('toolbar.today')}
          </Button>
          <IconButton icon="chevron-end" flipRtl label={t('toolbar.nextWeek')} variant="secondary" onClick={() => actions.goToRelativeWeek(1)} testId="week-next" />
        </div>
        <WeekLabel />
        <GoTo />
        <WeekTitle />
        <div className="tb-week__end">
          <Filters />
          <Button variant="primary" icon="plus" disabled={readOnly} onClick={openNewEvent} testId="new-event">
            {t('toolbar.newEvent')}
          </Button>
        </div>
      </div>
    </header>
  );
}
