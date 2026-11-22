import type { ReactNode } from 'react';
import { useT } from '../../i18n/useT';
import { Icon, type IconName } from '../ui';

export interface ChangeRow {
  key: string;
  change: 'added' | 'modified' | 'deleted';
  title: string;
  detail: string;
}

const CHANGE_ICON: Record<ChangeRow['change'], IconName> = { added: 'plus', modified: 'edit', deleted: 'minus' };

/** A scrollable list of changes, each marked as added / changed / removed. `tone` colours the markers. */
export function ChangeList({ rows, tone, testId }: { rows: readonly ChangeRow[]; tone: 'mine' | 'theirs'; testId?: string }): ReactNode {
  const { t } = useT();
  const label = { added: t('sync.changeAdded'), modified: t('sync.changeModified'), deleted: t('sync.changeDeleted') };
  return (
    <ul className={`sy-changes sy-changes--${tone}`} data-testid={testId}>
      {rows.map((row) => (
        <li key={row.key} className={`sy-change sy-change--${row.change}`}>
          <span className="sy-change__mark" title={label[row.change]}>
            <Icon name={CHANGE_ICON[row.change]} size={12} title={label[row.change]} />
          </span>
          <span className="sy-change__text">
            <bdi className="sy-change__title">{row.title}</bdi>
            {row.detail ? <bdi className="sy-change__detail">{row.detail}</bdi> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
