import { useMemo, useState, type ReactNode } from 'react';
import { addDays, weekStartOf } from '@shared/dates';
import { hasActiveFilters, matchesFilters } from '@shared/model';
import type { IsoDate } from '@shared/types';
import { useT } from '../../i18n/useT';
import { formatWeekRange } from '../../lib/format';
import { actions, useApp } from '../../store';
import { Button, Callout, Checkbox, DateInput, Field, Modal, RadioGroup, TextInput } from '../ui';
import './transfer.css';

type Range = 'week' | 'all' | 'custom';

/** Export events to an .ics file that Outlook (and other calendars) can open. */
export function ExportIcsDialog(): ReactNode {
  const { t, tn, lang } = useT();
  const weekStart = useApp((s) => s.weekStart);
  const working = useApp((s) => s.working);
  const filters = useApp((s) => s.filters);
  const filtering = hasActiveFilters(filters);

  const [range, setRange] = useState<Range>('week');
  const [from, setFrom] = useState<IsoDate | null>(weekStart);
  const [to, setTo] = useState<IsoDate | null>(addDays(weekStart, 6));
  const [filteredOnly, setFilteredOnly] = useState(filtering);
  const [calendarName, setCalendarName] = useState(working.config.course.name || t('store.icsDefaultName'));
  const [openAfter, setOpenAfter] = useState(true);
  const [exporting, setExporting] = useState(false);

  const weeksWithEvents = useMemo(
    () =>
      Object.values(working.weeks)
        .filter((week) => week.events.length > 0)
        .map((week) => week.weekStart)
        .sort(),
    [working.weeks],
  );

  const rangeInvalid = range === 'custom' && from !== null && to !== null && to < from;
  const weekStarts = useMemo((): IsoDate[] => {
    if (range === 'week') return [weekStart];
    if (range === 'all') return weeksWithEvents;
    if (!from || !to || to < from) return [];
    const first = weekStartOf(from);
    const last = weekStartOf(to);
    return weeksWithEvents.filter((week) => week >= first && week <= last);
  }, [range, weekStart, weeksWithEvents, from, to]);

  // A range of dates means exactly those days, not the whole weeks around them.
  const dateFrom = range === 'custom' ? from : null;
  const dateTo = range === 'custom' ? to : null;

  const count = useMemo(() => {
    let total = 0;
    for (const week of weekStarts) {
      for (const event of working.weeks[week]?.events ?? []) {
        const date = addDays(week, event.day);
        if (filteredOnly && !matchesFilters(event, filters)) continue;
        if ((dateFrom && date < dateFrom) || (dateTo && date > dateTo)) continue;
        total += 1;
      }
    }
    return total;
  }, [weekStarts, working.weeks, filteredOnly, filters, dateFrom, dateTo]);

  const run = async (): Promise<void> => {
    setExporting(true);
    const result = await actions.exportIcs({ weekStarts, filteredOnly, calendarName, openAfter, dateFrom, dateTo });
    setExporting(false);
    if (result) actions.closeDialog();
  };

  return (
    <Modal
      title={t('transfer.exportTitle')}
      icon="calendar"
      onClose={() => actions.closeDialog()}
      locked={exporting}
      testId="export-ics-dialog"
      footer={
        <>
          <Button onClick={() => actions.closeDialog()} disabled={exporting}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon="download" busy={exporting} disabled={count === 0 || rangeInvalid} onClick={() => void run()} testId="export-ics-confirm">
            {t('transfer.exportButton')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('transfer.exportIntro')}</p>

      <Field label={t('transfer.rangeLabel')}>
        <RadioGroup<Range>
          label={t('transfer.rangeLabel')}
          value={range}
          onChange={setRange}
          options={[
            { value: 'week', label: t('transfer.rangeWeek', { range: formatWeekRange(weekStart, lang) }) },
            { value: 'all', label: tn('transfer.rangeAll', weeksWithEvents.length), disabled: weeksWithEvents.length === 0 },
            { value: 'custom', label: t('transfer.rangeCustom') },
          ]}
          testId="export-range"
        />
      </Field>

      {range === 'custom' ? (
        <div className="tr-dates">
          <Field label={t('transfer.from')} htmlFor="tr-from">
            <DateInput id="tr-from" value={from} onChange={setFrom} testId="export-from" />
          </Field>
          <Field label={t('transfer.to')} htmlFor="tr-to" error={rangeInvalid ? t('transfer.rangeInvalid') : null}>
            <DateInput id="tr-to" value={to} onChange={setTo} invalid={rangeInvalid} testId="export-to" />
          </Field>
        </div>
      ) : null}

      {filtering ? <Checkbox checked={filteredOnly} onChange={setFilteredOnly} label={t('transfer.filteredOnly')} testId="export-filtered" /> : null}

      <Field label={t('transfer.calendarName')} htmlFor="tr-calendar">
        <TextInput id="tr-calendar" value={calendarName} onChange={setCalendarName} maxLength={80} testId="export-calendar-name" />
      </Field>

      <Checkbox checked={openAfter} onChange={setOpenAfter} label={t('transfer.openAfter')} testId="export-open-after" />

      <Callout tone={count === 0 ? 'warning' : 'info'} testId="export-count">
        {count === 0 ? t('transfer.nothingToExport') : tn('transfer.eventCount', count)}
      </Callout>
    </Modal>
  );
}
