import { useMemo, type ReactNode } from 'react';
import type { BlameInfo } from '@shared/api';
import { eventKey, type AsideItem } from '@shared/merge';
import type { Clash } from '@shared/model';
import type { IsoDate, ScheduleConfig, ScheduleEvent } from '@shared/types';
import type { MessageKey } from '../../i18n';
import { useT } from '../../i18n/useT';
import { describeClashes } from '../../lib/clashText';
import { formatDateTime, formatRelative } from '../../lib/format';
import { eventColor, eventHeadline } from '../../lib/lookup';
import { actions, useApp } from '../../store';
import { EventFacts } from '../common/EventFacts';
import { Badge, Button, ColorDot, Icon, Popover } from '../ui';

export function BlameLine({ info, prefix }: { info: BlameInfo; prefix: MessageKey }): ReactNode {
  const { t, lang } = useT();
  return (
    <div className="wg-pop__blame" data-testid="blame-line">
      <Icon name="history" size={14} />
      <div>
        <div>
          <span>{t(prefix, { name: info.authorName })}</span>
          <span className="faint" title={formatDateTime(info.time, lang)}>
            {' · '}
            {formatRelative(info.time, lang)}
          </span>
        </div>
        <div className="faint">{formatDateTime(info.time, lang)}</div>
      </div>
    </div>
  );
}

interface EventPopoverProps {
  anchor: HTMLElement | null;
  weekStart: IsoDate;
  event: ScheduleEvent;
  /** All events of the week (to name the other side of a double booking). */
  weekEvents: readonly ScheduleEvent[];
  clashes: readonly Clash[];
  readOnly: boolean;
  onClose: () => void;
}

/** Details of one event: the facts, who last edited it, warnings, and the actions. */
export function EventPopover({ anchor, weekStart, event, weekEvents, clashes, readOnly, onClose }: EventPopoverProps): ReactNode {
  const { t } = useT();
  const config = useApp((s) => s.working.config);
  const key = eventKey(weekStart, event.id);
  const change = useApp((s) => s.diffByKey.get(key)?.change);
  const blame = useApp((s) => s.blame[weekStart]?.events[event.id]);
  // "I deleted it, the team changed it": my deletion is the version kept aside.
  const deletion = useApp((s) => s.aside.find((item) => item.key === key && item.mine === undefined));

  const clashLines = useMemo(() => describeClashes(clashes, weekEvents, config, t), [clashes, weekEvents, config, t]);

  const edit = (): void => {
    onClose();
    actions.openDialog({ type: 'event', weekStart, eventId: event.id });
  };
  const duplicate = (): void => {
    onClose();
    actions.duplicateEvent(weekStart, event.id);
  };
  const remove = (): void => {
    onClose();
    actions.deleteEvent(weekStart, event.id);
  };

  return (
    <Popover anchor={anchor} open onClose={onClose} placement="side-end" ariaLabel={t('grid.eventDetails')} testId="event-popover">
      <div
        className="wg-pop"
        // The details now hold the keyboard focus, so the Delete key is answered here as it is on the event itself.
        onKeyDown={(e) => {
          if (e.key !== 'Delete' || readOnly) return;
          e.preventDefault();
          remove();
        }}
      >
        <div className="wg-pop__head">
          <ColorDot color={eventColor(event, config)} size={12} />
          <h3 className="user-text">{eventHeadline(event, config, t('common.untitledEvent'))}</h3>
        </div>

        <EventFacts event={event} config={config} weekStart={weekStart} />

        {change === 'added' || change === 'modified' ? (
          <Badge tone="mine" icon="cloud-up" testId="event-unpublished">
            {change === 'added' ? t('grid.unpublishedAdded') : t('grid.unpublishedModified')}
          </Badge>
        ) : null}

        {clashLines.length > 0 ? (
          <div className="wg-pop__clashes" data-testid="event-clashes">
            <strong>
              <Icon name="warning" size={14} /> {t('grid.clashTitle')}
            </strong>
            {clashLines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        ) : null}

        {blame ? <BlameLine info={blame} prefix={change === 'modified' ? 'grid.publishedEditedBy' : 'grid.lastEditedBy'} /> : null}

        {deletion ? (
          <div className="wg-pop__aside">
            <span>{t('grid.asideIDeleted')}</span>
            <div className="wg-pop__actions">
              <Button size="sm" variant="danger" onClick={() => { onClose(); actions.applyAside(deletion.key); }}>
                {t('grid.asideDeleteAnyway')}
              </Button>
              <Button size="sm" onClick={() => actions.discardAside(deletion.key)}>
                {t('grid.asideKeepTheirs')}
              </Button>
            </div>
          </div>
        ) : null}

        {readOnly ? null : (
          <div className="wg-pop__actions">
            <Button size="sm" variant="primary" icon="edit" onClick={edit} testId="event-edit" data-autofocus>
              {t('grid.edit')}
            </Button>
            <Button size="sm" icon="copy" onClick={duplicate} testId="event-duplicate">
              {t('grid.duplicate')}
            </Button>
            <div className="grow" />
            <Button size="sm" variant="ghost" icon="trash" className="wg-pop__delete" onClick={remove} testId="event-delete">
              {t('grid.delete')}
            </Button>
          </div>
        )}
      </div>
    </Popover>
  );
}

interface AsidePopoverProps {
  anchor: HTMLElement | null;
  item: AsideItem;
  mine: ScheduleEvent;
  config: ScheduleConfig;
  onClose: () => void;
}

/** A version of mine that was kept aside: what it is, and the decision. */
export function AsidePopover({ anchor, item, mine, config, onClose }: AsidePopoverProps): ReactNode {
  const { t } = useT();
  return (
    <Popover anchor={anchor} open onClose={onClose} placement="side-end" ariaLabel={t('grid.asideTitle')} testId="aside-popover">
      <div className="wg-pop">
        <div className="wg-pop__head">
          <Icon name="inbox" size={16} className="wg-pop__aside-icon" />
          <h3>{t('grid.asideTitle')}</h3>
        </div>
        <p className="muted">{item.theirs === undefined ? t('grid.asideTeamDeleted') : t('grid.asideChanged')}</p>
        <strong className="user-text">{eventHeadline(mine, config, t('common.untitledEvent'))}</strong>
        <EventFacts event={mine} config={config} weekStart={item.weekStart} />
        <div className="wg-pop__actions">
          <Button size="sm" variant="primary" onClick={() => { onClose(); actions.applyAside(item.key); }} testId="aside-use-mine">
            {t('grid.asideUseMine')}
          </Button>
          <Button size="sm" onClick={() => { onClose(); actions.discardAside(item.key); }} testId="aside-discard-mine">
            {t('grid.asideDiscardMine')}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
