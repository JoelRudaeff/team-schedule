import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { nextPaletteColor } from '@shared/colors';
import { addDays } from '@shared/dates';
import { newId } from '@shared/ids';
import { deepEqual, findClashes, findEvent, getWeek, hasActiveFilters, matchesFilters, normalizeEvent } from '@shared/model';
import type { DayIndex, ScheduleEvent } from '@shared/types';
import { useT } from '../../i18n/useT';
import { describeClashes } from '../../lib/clashText';
import { dayName, formatDayMonth, formatDuration } from '../../lib/format';
import { actions, getState, useApp } from '../../store';
import type { DialogState } from '../../store/types';
import { BlameLine } from '../grid/EventPopover';
import {
  Button,
  Callout,
  ColorDot,
  ColorPicker,
  Field,
  IconButton,
  Modal,
  MultiSelect,
  Popover,
  Select,
  TextArea,
  TextInput,
  TimeSelect,
} from '../ui';
import './event.css';

const DAYS: readonly DayIndex[] = [0, 1, 2, 3, 4, 5, 6];
const NO_LOCATION = '';

/** Chips for choosing the event's subject (= its colour), plus a quick way to add one. */
function SubjectChooser({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }): ReactNode {
  const { t } = useT();
  const subjects = useApp((s) => s.working.config.subjects);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2563EB');

  const openAdd = (): void => {
    setName('');
    setColor(nextPaletteColor(subjects.map((subject) => subject.color)));
    setAdding(true);
  };
  const add = (): void => {
    const id = actions.addEntity('subject', name, color);
    if (id === '') return;
    onChange(id);
    setAdding(false);
  };

  return (
    <div className="ev-subjects" role="radiogroup" aria-label={t('event.subjectLabel')} data-testid="event-subject">
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        className={`ev-subject${value === null ? ' is-selected' : ''}`}
        onClick={() => onChange(null)}
        data-testid="event-subject-none"
      >
        <span className="ev-subject__none" />
        {t('event.subjectNone')}
      </button>
      {subjects.map((subject) => (
        <button
          key={subject.id}
          type="button"
          role="radio"
          aria-checked={value === subject.id}
          className={`ev-subject${value === subject.id ? ' is-selected' : ''}`}
          onClick={() => onChange(subject.id)}
          data-testid={`event-subject-${subject.id}`}
        >
          <ColorDot color={subject.color} size={12} />
          <span className="user-text">{subject.name}</span>
        </button>
      ))}
      <IconButton ref={setAnchor} icon="plus" size="sm" variant="secondary" label={t('event.newSubject')} active={adding} onClick={openAdd} testId="event-subject-add" />
      <Popover anchor={anchor} open={adding} onClose={() => setAdding(false)} ariaLabel={t('event.newSubject')}>
        <div className="ev-new-subject">
          <Field label={t('event.newSubjectName')} htmlFor="ev-new-subject-name">
            <TextInput id="ev-new-subject-name" value={name} onChange={setName} onEnter={add} data-autofocus autoFocus testId="event-subject-new-name" />
          </Field>
          <ColorPicker value={color} onChange={setColor} />
          <Button variant="primary" block disabled={name.trim() === ''} onClick={add} testId="event-subject-new-add">
            {t('event.addSubject')}
          </Button>
        </div>
      </Popover>
    </div>
  );
}

/** Dropdown of locations with an inline "add a new one". */
function LocationChooser({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }): ReactNode {
  const { t } = useT();
  const locations = useApp((s) => s.working.config.locations);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const options = [
    { value: NO_LOCATION, label: t('event.locationNone') },
    ...locations.map((location) => ({ value: location.id, label: location.name })),
  ];
  // An event may still point to a location that has been deleted since: keep that visible.
  if (value !== null && !locations.some((location) => location.id === value)) {
    options.push({ value, label: t('common.deletedItem') });
  }

  const add = (): void => {
    const id = actions.addEntity('location', name);
    if (id === '') return;
    onChange(id);
    setName('');
    setAdding(false);
  };

  return (
    <div className="ev-location">
      <div className="ev-location__row">
        <Select id="ev-location" value={value ?? NO_LOCATION} onChange={(next) => onChange(next === NO_LOCATION ? null : next)} options={options} testId="event-location" />
        <IconButton icon="plus" variant="secondary" label={t('event.addLocation')} active={adding} onClick={() => setAdding((v) => !v)} testId="event-location-add" />
      </div>
      {adding ? (
        <div className="ev-location__row">
          <TextInput value={name} onChange={setName} onEnter={add} placeholder={t('event.newLocationPlaceholder')} autoFocus testId="event-location-new-name" />
          <Button variant="primary" disabled={name.trim() === ''} onClick={add} testId="event-location-new-add">
            {t('common.add')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function EventDialog({ dialog }: { dialog: Extract<DialogState, { type: 'event' }> }): ReactNode {
  const { t, lang } = useT();
  const { weekStart, eventId } = dialog;
  // Select the dataset itself and derive from it: a selector must return a stable reference,
  // and getWeek() creates a fresh object for a week that has no events yet.
  const working = useApp((s) => s.working);
  const config = working.config;
  const weekEvents = useMemo(() => getWeek(working, weekStart).events, [working, weekStart]);
  const existing = eventId ? findEvent(working, weekStart, eventId) : undefined;
  const blame = useApp((s) => (eventId ? s.blame[weekStart]?.events[eventId] : undefined));
  const isNew = eventId === null;

  const [draft, setDraft] = useState<ScheduleEvent>(() => {
    if (existing) return existing;
    const start = dialog.initial?.start ?? config.timeGrid.dayStart;
    return {
      id: newId(),
      day: 0,
      start,
      end: Math.min(1440, start + 60),
      title: '',
      subjectId: null,
      locationId: null,
      teacherIds: [],
      classIds: [],
      notes: '',
      ...dialog.initial,
    };
  });
  const patch = (change: Partial<ScheduleEvent>): void => setDraft((current) => ({ ...current, ...change }));

  // What the dialog started with: as long as the draft equals it, closing loses nothing.
  const [opened] = useState(draft);
  const dirty = useMemo(() => !deepEqual(normalizeEvent(draft), normalizeEvent(opened)), [draft, opened]);
  const [asking, setAsking] = useState(false);
  const keepEditing = useRef<HTMLButtonElement>(null);
  // The store asks before the window closes over a half-written event.
  useEffect(() => {
    actions.setDraftDirty(dirty);
    return () => actions.setDraftDirty(false);
  }, [dirty]);
  useEffect(() => {
    if (asking) keepEditing.current?.focus();
  }, [asking]);
  /** Escape and the corner X: a changed draft is not thrown away without a question. */
  const dismiss = (): void => {
    if (asking) setAsking(false);
    else if (dirty) setAsking(true);
    else actions.closeDialog();
  };

  // The event was removed underneath the dialog (an update from the team, an undo): nothing left to edit.
  useEffect(() => {
    if (!isNew && !existing) actions.closeDialog();
  }, [isNew, existing]);

  const clashLines = useMemo(() => {
    const others = weekEvents.filter((event) => event.id !== draft.id);
    const candidate = normalizeEvent(draft);
    return describeClashes(findClashes([...others, candidate])[candidate.id] ?? [], others, config, t);
  }, [weekEvents, draft, config, t]);

  const save = (): void => {
    actions.saveEvent(weekStart, draft);
    actions.closeDialog();
    // Saved, but not on screen: say so, or the user adds it a second time.
    const { filters } = getState();
    if (hasActiveFilters(filters) && !matchesFilters(normalizeEvent(draft), filters)) {
      actions.toast({
        kind: 'warning',
        message: t('event.hiddenByFilter'),
        action: { label: t('toolbar.clearFilters'), run: () => actions.clearFilters() },
      });
    }
  };
  const remove = (): void => {
    // The store offers the undo itself, tied to this very deletion.
    actions.deleteEvent(weekStart, draft.id);
    actions.closeDialog();
  };

  const setStart = (start: number): void => {
    // Moving the start keeps the length, so an hour-long lesson stays an hour long.
    const length = draft.end - draft.start;
    patch({ start, end: Math.min(1440, start + length) });
  };

  return (
    <Modal
      title={isNew ? t('event.newTitle') : t('event.editTitle')}
      subtitle={`${dayName(draft.day, lang)} · ${formatDayMonth(addDays(weekStart, draft.day), lang)}`}
      icon="calendar"
      size="lg"
      onClose={dismiss}
      testId="event-dialog"
      footer={
        asking ? (
          <>
            <span className="ev-discard-ask" role="alert" data-testid="event-discard-ask">
              {t('event.discardAsk')}
            </span>
            <Button ref={keepEditing} onClick={() => setAsking(false)} testId="event-keep-editing">
              {t('event.keepEditing')}
            </Button>
            <Button variant="danger" onClick={() => actions.closeDialog()} testId="event-discard">
              {t('event.discard')}
            </Button>
          </>
        ) : (
          <>
            {isNew ? null : (
              <Button variant="ghost" icon="trash" className="ev-delete" onClick={remove} testId="event-dialog-delete">
                {t('event.delete')}
              </Button>
            )}
            <Button onClick={() => actions.closeDialog()} testId="event-cancel">
              {t('common.cancel')}
            </Button>
            <Button variant="primary" icon="check" onClick={save} testId="event-save">
              {isNew ? t('event.add') : t('event.save')}
            </Button>
          </>
        )
      }
    >
      <div
        className="ev-form"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      >
        <Field label={t('event.titleLabel')} htmlFor="ev-title">
          <TextInput
            id="ev-title"
            value={draft.title}
            onChange={(title) => patch({ title })}
            onEnter={save}
            placeholder={t('event.titlePlaceholder')}
            maxLength={200}
            data-autofocus
            testId="event-title"
          />
        </Field>

        <div className="ev-when">
          <Field label={t('event.dayLabel')} htmlFor="ev-day">
            <Select
              id="ev-day"
              value={String(draft.day)}
              onChange={(day) => patch({ day: Number(day) as DayIndex })}
              options={DAYS.map((day) => ({
                value: String(day),
                label: `${dayName(day, lang)} · ${formatDayMonth(addDays(weekStart, day), lang)}`,
              }))}
              testId="event-day"
            />
          </Field>
          <Field label={t('event.startLabel')} htmlFor="ev-start">
            <TimeSelect id="ev-start" value={draft.start} onChange={setStart} min={0} max={1425} testId="event-start" />
          </Field>
          <Field label={t('event.endLabel')} htmlFor="ev-end">
            <TimeSelect id="ev-end" value={draft.end} onChange={(end) => patch({ end })} min={draft.start + 15} max={1440} testId="event-end" />
          </Field>
          <div className="ev-when__length muted">{t('event.duration', { duration: formatDuration(draft.end - draft.start) })}</div>
        </div>

        <Field label={t('event.subjectLabel')}>
          <SubjectChooser value={draft.subjectId} onChange={(subjectId) => patch({ subjectId })} />
        </Field>

        <div className="ev-columns">
          <Field label={t('event.locationLabel')} htmlFor="ev-location">
            <LocationChooser value={draft.locationId} onChange={(locationId) => patch({ locationId })} />
          </Field>
          <Field label={t('event.teachersLabel')}>
            <MultiSelect
              appearance="field"
              label={t('event.teachersLabel')}
              placeholder={t('event.teachersPlaceholder')}
              options={config.teachers}
              selected={draft.teacherIds}
              onChange={(teacherIds) => patch({ teacherIds })}
              onCreate={(name) => actions.addEntity('teacher', name)}
              createLabel={t('event.addTeacher')}
              testId="event-teachers"
            />
          </Field>
          <Field label={t('event.classesLabel')}>
            <MultiSelect
              appearance="field"
              label={t('event.classesLabel')}
              placeholder={t('event.classesPlaceholder')}
              options={config.classes}
              selected={draft.classIds}
              onChange={(classIds) => patch({ classIds })}
              onCreate={(name) => actions.addEntity('class', name)}
              createLabel={t('event.addClass')}
              testId="event-classes"
            />
          </Field>
        </div>

        <Field label={t('event.notesLabel')} htmlFor="ev-notes">
          <TextArea id="ev-notes" value={draft.notes} onChange={(notes) => patch({ notes })} placeholder={t('event.notesPlaceholder')} maxLength={2000} testId="event-notes" />
        </Field>

        {clashLines.length > 0 ? (
          <Callout tone="warning" title={t('event.clashTitle')} testId="event-clash-warning">
            {/* A sentence of the interface: the names inside it are isolated by the translator. */}
            {clashLines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </Callout>
        ) : null}

        {blame && !isNew ? <BlameLine info={blame} prefix="grid.lastEditedBy" /> : null}
        <p className="faint ev-hint">{t('event.localHint')}</p>
      </div>
    </Modal>
  );
}
