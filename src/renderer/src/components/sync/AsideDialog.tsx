import { useMemo, type ReactNode } from 'react';
import { getItemValue, type AsideItem, type ItemValue } from '@shared/merge';
import type { ScheduleConfig } from '@shared/types';
import { useT } from '../../i18n/useT';
import { describeItem, isEvent, isNamed, lookupConfig, scalarText } from '../../lib/describe';
import { formatRelative } from '../../lib/format';
import { eventHeadline } from '../../lib/lookup';
import { actions, useApp } from '../../store';
import { EventFacts } from '../common/EventFacts';
import { Badge, Button, ColorDot, EmptyState, Modal } from '../ui';
import './sync.css';

function Value({ item, value, config, absent }: { item: AsideItem; value: ItemValue | undefined; config: ScheduleConfig; absent: string }): ReactNode {
  const tr = useT();
  if (value === undefined) return <Badge tone="neutral">{absent}</Badge>;
  if (isEvent(value)) {
    return (
      <>
        <strong className="user-text">{eventHeadline(value, config, tr.t('common.untitledEvent'))}</strong>
        <EventFacts event={value} config={config} weekStart={item.weekStart} />
      </>
    );
  }
  if (isNamed(value)) {
    return (
      <span className="sy-version__named">
        {'color' in value && typeof value.color === 'string' ? <ColorDot color={value.color} size={12} /> : null}
        <strong className="user-text">{value.name}</strong>
      </span>
    );
  }
  return <strong className="user-text">{scalarText(item, value, tr)}</strong>;
}

/** Everything of mine that lost a merge but was kept: use it after all, or let it go. */
export function AsideDialog(): ReactNode {
  const tr = useT();
  const { t, lang } = tr;
  const aside = useApp((s) => s.aside);
  const working = useApp((s) => s.working);
  const base = useApp((s) => s.base);
  const config = useMemo(() => lookupConfig(working.config, base.config), [working.config, base.config]);

  const show = (item: AsideItem): void => {
    if (!item.weekStart) return;
    actions.goToWeek(item.weekStart);
    actions.closeDialog();
  };

  return (
    <Modal
      title={t('sync.asideTitle')}
      icon="inbox"
      tone="warning"
      size="lg"
      onClose={() => actions.closeDialog()}
      closeOnBackdrop
      testId="aside-dialog"
      footer={
        <Button onClick={() => actions.closeDialog()} testId="aside-close">
          {t('common.close')}
        </Button>
      }
    >
      {aside.length === 0 ? (
        <EmptyState icon="inbox" title={t('sync.asideEmpty')} />
      ) : (
        <>
          <p className="muted">{t('sync.asideIntro')}</p>
          <div className="sy-conflicts">
            {aside.map((item) => (
              <article key={item.key} className="sy-conflict sy-conflict--aside" data-testid="aside-item" data-key={item.key}>
                <header className="sy-conflict__head">
                  <bdi className="sy-conflict__title">{describeItem(item, item.mine ?? item.theirs, config, tr).title}</bdi>
                  <span className="sy-conflict__reason">{t('sync.asideKeptOn', { time: formatRelative(Date.parse(item.createdAt), lang) })}</span>
                </header>
                <div className="sy-conflict__versions">
                  <div className="sy-version sy-version--mine">
                    <div className="sy-version__label">{t('sync.asideMine')}</div>
                    <Value item={item} value={item.mine} config={config} absent={t('sync.deleted')} />
                  </div>
                  <div className="sy-version sy-version--theirs">
                    <div className="sy-version__label">{t('sync.asideCurrent')}</div>
                    <Value item={item} value={getItemValue(working, item)} config={config} absent={t('sync.asideNotInSchedule')} />
                  </div>
                </div>
                <div className="sy-conflict__choice sy-conflict__choice--buttons">
                  <Button size="sm" variant="primary" onClick={() => actions.applyAside(item.key)} testId="aside-use">
                    {t('sync.asideUse')}
                  </Button>
                  <Button size="sm" onClick={() => actions.discardAside(item.key)} testId="aside-discard">
                    {t('sync.asideDiscard')}
                  </Button>
                  {item.kind === 'event' && item.weekStart ? (
                    <Button size="sm" variant="ghost" icon="calendar" onClick={() => show(item)}>
                      {t('sync.asideShow')}
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
