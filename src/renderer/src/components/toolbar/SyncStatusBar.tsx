import { useState, type ReactNode } from 'react';
import { maskRepoUrl, repoDisplayName } from '@shared/repoUrl';
import { useT } from '../../i18n/useT';
import { readableCommitSubject } from '../../lib/commitText';
import { formatRelative } from '../../lib/format';
import { SYNC_ERROR_TEXT } from '../../lib/syncErrors';
import { actions, useApp } from '../../store';
import { Badge, Button, DetailsBox, Icon, IconButton, Popover, Spinner, type IconName } from '../ui';

/**
 * What the status chip says:
 *  clean     nothing to do
 *  dirty     I have changes the team cannot see → Save
 *  behind    the team has changes I do not have → Update
 *  diverged  both
 *  error     the repository could not be reached
 *  checking  looking right now
 */
export type SyncVisual = 'clean' | 'dirty' | 'behind' | 'diverged' | 'error' | 'checking';

const VISUAL_ICON: Record<SyncVisual, IconName> = {
  clean: 'cloud-check',
  dirty: 'cloud-up',
  behind: 'cloud-down',
  diverged: 'git-merge',
  error: 'cloud-off',
  checking: 'refresh',
};

/** The "status bar" of the toolbar: where the local copy stands relative to the team, plus Update and Save. */
export function SyncStatusBar(): ReactNode {
  const tr = useT();
  const { t, tn, lang } = tr;
  const sync = useApp((s) => s.sync);
  const busy = useApp((s) => s.busy);
  const diffCount = useApp((s) => s.diff.length);
  const asideCount = useApp((s) => s.aside.length);
  const repo = useApp((s) => s.repo);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const behind = sync?.behind ?? 0;
  // Local commits the team never received (after a crash) count as unpublished work too.
  const mine = diffCount > 0 ? diffCount : (sync?.ahead ?? 0) > 0 ? 1 : 0;
  const error = sync?.fetchError ?? null;
  const checking = busy === 'checking';

  let visual: SyncVisual;
  let label: string;
  if (checking && !error && behind === 0 && mine === 0) {
    visual = 'checking';
    label = t('toolbar.statusChecking');
  } else if (error) {
    visual = 'error';
    label = error.code === 'offline' || error.code === 'timeout' ? t('toolbar.statusOffline') : error.code === 'auth' ? t('toolbar.statusAuth') : t('toolbar.statusError');
  } else if (behind > 0 && mine > 0) {
    visual = 'diverged';
    label = t('toolbar.statusBoth', { mine });
  } else if (behind > 0) {
    visual = 'behind';
    label = tn('toolbar.statusBehind', behind);
  } else if (mine > 0) {
    visual = 'dirty';
    label = tn('toolbar.statusUnpublished', mine);
  } else {
    visual = 'clean';
    label = t('toolbar.statusUpToDate');
  }

  const operating = busy !== null && busy !== 'checking';

  return (
    <div className="tb-sync" data-testid="sync-bar">
      <button
        ref={setAnchor}
        type="button"
        className={`tb-sync__status tb-sync__status--${visual}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('toolbar.syncDetails')}
        onClick={() => setOpen((value) => !value)}
        data-testid="sync-status"
        data-state={visual}
        data-behind={behind}
        data-unpublished={mine}
      >
        {visual === 'checking' ? <Spinner size={14} /> : <Icon name={VISUAL_ICON[visual]} />}
        <span>{label}</span>
      </button>

      <IconButton
        icon="refresh"
        size="sm"
        label={t('toolbar.checkNow')}
        className={checking ? 'tb-sync__spin' : undefined}
        disabled={busy !== null}
        onClick={() => void actions.checkForUpdates({ interactive: true })}
        testId="sync-check"
      />

      <Button
        size="sm"
        icon="cloud-down"
        className={behind > 0 ? 'tb-sync__update is-due' : 'tb-sync__update'}
        title={t('toolbar.updateTooltip')}
        disabled={operating}
        onClick={() => void actions.requestUpdate()}
        testId="sync-update"
      >
        {t('toolbar.update')}
        {behind > 0 ? <span className="tb-sync__count">{behind}</span> : null}
      </Button>

      <Button
        size="sm"
        icon="cloud-up"
        variant={mine > 0 ? 'primary' : 'secondary'}
        title={t('toolbar.saveTooltip')}
        disabled={operating || mine === 0}
        onClick={() => actions.requestPublish()}
        testId="sync-publish"
      >
        {t('toolbar.save')}
        {mine > 0 ? <span className="tb-sync__count">{mine}</span> : null}
      </Button>

      {asideCount > 0 ? (
        <button
          type="button"
          className="tb-sync__aside"
          title={t('toolbar.asideTooltip')}
          onClick={() => actions.openDialog({ type: 'aside' })}
          data-testid="aside-badge"
        >
          <Badge tone="aside" icon="inbox">
            {tn('toolbar.asideBadge', asideCount)}
          </Badge>
        </button>
      ) : null}

      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" ariaLabel={t('toolbar.syncDetails')} testId="sync-details">
        <div className="tb-sync__details">
          <div className="tb-sync__details-head">
            <strong>{t('toolbar.syncDetails')}</strong>
            <span className="faint">
              {sync?.lastFetchAt ? t('toolbar.lastChecked', { time: formatRelative(sync.lastFetchAt, lang) }) : t('toolbar.neverChecked')}
            </span>
          </div>

          {repo ? (
            <div className="tb-sync__repo">
              <Icon name="git-branch" size={14} />
              <span className="ltr truncate selectable" title={maskRepoUrl(repo.url)}>
                {repoDisplayName(repo.url)} · {repo.branch}
              </span>
            </div>
          ) : null}

          {error ? (
            <div className="tb-sync__problem">
              <strong>{t('toolbar.problemTitle')}</strong>
              <span>{t(SYNC_ERROR_TEXT[error.code])}</span>
              {error.detail ? <DetailsBox text={error.detail} /> : null}
            </div>
          ) : null}

          <section>
            <h3>{t('toolbar.incomingTitle')}</h3>
            {sync && sync.incoming.length > 0 ? (
              <ul className="tb-sync__commits">
                {sync.incoming.slice(0, 8).map((commit) => (
                  <li key={commit.sha}>
                    <span className="tb-sync__author user-text">{commit.authorName}</span>
                    <span className="faint">{formatRelative(commit.time, lang)}</span>
                    <span className="tb-sync__subject user-text">{readableCommitSubject(commit.subject, tr)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t('toolbar.incomingNone')}</p>
            )}
          </section>

          <section>
            <p className="muted">{mine > 0 ? tn('toolbar.mineSummary', mine) : t('toolbar.mineNone')}</p>
          </section>
        </div>
      </Popover>
    </div>
  );
}
