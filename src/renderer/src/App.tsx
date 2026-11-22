import { Component, useEffect, useState, type ReactNode } from 'react';
import { EventDialog } from './components/event/EventDialog';
import { WeekGrid } from './components/grid/WeekGrid';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { SetupWizard } from './components/setup/SetupWizard';
import { AsideDialog } from './components/sync/AsideDialog';
import { CloseGuardDialog } from './components/sync/CloseGuardDialog';
import { MergeDialog } from './components/sync/MergeDialog';
import { PublishDialog } from './components/sync/PublishDialog';
import { Toolbar } from './components/toolbar/Toolbar';
import { ExportIcsDialog } from './components/transfer/ExportIcsDialog';
import { ImportWeekDialog } from './components/transfer/ImportWeekDialog';
import { RepeatWeekDialog } from './components/transfer/RepeatWeekDialog';
import { BusyOverlay, Button, Callout, ConfirmDialog, DetailsBox, ErrorDialog, Spinner, ToastHost } from './components/ui';
import { translatorFor } from './i18n';
import { useT } from './i18n/useT';
import { actions, getState, useApp } from './store';
import type { DialogState } from './store/types';

/**
 * Renders the one open modal dialog. The question "close the window?" is laid over the
 * dialog that was open when the window was closed: that one stays mounted underneath, so
 * what was typed into it is still there when the answer is "stay".
 */
function DialogHost(): ReactNode {
  const dialog = useApp((s) => s.dialog);
  if (!dialog) return null;
  if (dialog.type !== 'close-guard') return renderDialog(dialog);
  return (
    <>
      {dialog.covered ? renderDialog(dialog.covered) : null}
      <CloseGuardDialog dialog={dialog} />
    </>
  );
}

function renderDialog(dialog: Exclude<DialogState, { type: 'close-guard' }> | DialogState): ReactNode {
  switch (dialog.type) {
    case 'event':
      // The key makes sure a different event never re-uses the previous form state.
      return <EventDialog key={`${dialog.weekStart}:${dialog.eventId ?? 'new'}`} dialog={dialog} />;
    case 'settings':
      return <SettingsDialog dialog={dialog} />;
    case 'publish':
      return <PublishDialog dialog={dialog} />;
    case 'merge':
      return <MergeDialog key={dialog.session.remoteSha} dialog={dialog} />;
    case 'aside':
      return <AsideDialog />;
    case 'export-ics':
      return <ExportIcsDialog />;
    case 'import-week':
      return <ImportWeekDialog dialog={dialog} />;
    case 'repeat-week':
      return <RepeatWeekDialog />;
    case 'close-guard':
      return <CloseGuardDialog dialog={dialog} />;
    case 'confirm':
      return <ConfirmDialog dialog={dialog} />;
    case 'error':
      return <ErrorDialog dialog={dialog} />;
  }
}

/** Warns about schedule files this version of the app cannot read. */
function ProblemBanner(): ReactNode {
  const problems = useApp((s) => s.problems);
  const damaged = useApp((s) => s.damagedFiles.length > 0);
  const { t } = useT();
  const shown = problems.filter((p) => p.code !== 'missing-config');
  if (shown.length === 0) return null;
  const newer = shown.some((p) => p.code === 'newer-version');
  // Files damaged on this computer have a way back that needs no hand-editing: the team's version.
  const restore = (): void => {
    actions.openDialog({
      type: 'confirm',
      title: t('common.restoreDamagedTitle'),
      message: t('common.restoreDamagedText'),
      confirmLabel: t('common.restoreTeamVersion'),
      danger: true,
      onConfirm: () => actions.discardLocalChanges(),
    });
  };
  return (
    <div className="app__banner">
      <Callout
        tone="warning"
        title={t('common.unreadableFilesTitle')}
        actions={
          <>
            {damaged ? (
              <Button size="sm" icon="cloud-down" onClick={restore} testId="problem-restore">
                {t('common.restoreTeamVersion')}
              </Button>
            ) : null}
            <Button size="sm" icon="folder" onClick={() => actions.openRepoFolder()}>
              {t('common.openFolder')}
            </Button>
          </>
        }
        testId="problem-banner"
      >
        <p>{newer ? t('common.newerVersionText') : t('common.unreadableFilesText')}</p>
        <DetailsBox text={shown.map((p) => `${p.path}: ${p.message}`).join('\n')} />
      </Callout>
    </div>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** App-wide keyboard shortcuts (only while the schedule is on screen). */
function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const state = getState();
      if (state.phase !== 'ready') return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 's') {
        // Ctrl+S = save to the team (always goes through the confirmation dialog).
        e.preventDefault();
        // A background check for updates ('checking') never blocks the user.
        if (!state.dialog && (!state.busy || state.busy === 'checking')) actions.requestPublish();
        return;
      }
      if (state.dialog || isTypingTarget(e.target)) return;
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        actions.undo();
      } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        actions.redo();
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        actions.goToRelativeWeek(-1);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        actions.goToRelativeWeek(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

function Splash(): ReactNode {
  const { t } = useT();
  return (
    <div className="splash" data-testid="splash">
      <div className="splash__title">{t('common.appName')}</div>
      <Spinner size={28} />
      <div>{t('common.startingUp')}</div>
    </div>
  );
}

function FatalScreen(): ReactNode {
  const { t } = useT();
  const error = useApp((s) => s.fatalError);
  const connected = useApp((s) => s.repo !== null);
  const [restoring, setRestoring] = useState(false);

  // The way out when a schedule file on this computer is damaged: take the team's files again.
  const restore = async (): Promise<void> => {
    setRestoring(true);
    try {
      await window.api.discardLocal();
    } catch (failure) {
      console.error(failure);
    }
    window.location.reload();
  };

  return (
    <div className="fatal" data-testid="fatal">
      <div className="fatal__card">
        <div className="fatal__title">{t('common.fatalTitle')}</div>
        <p className="selectable">{error?.message ?? t('common.unexpectedError')}</p>
        {error?.detail ? <pre className="fatal__detail mono ltr selectable">{error.detail}</pre> : null}
        {connected ? <p className="muted">{t('common.restoreTeamVersionHint')}</p> : null}
        <div className="row">
          <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>
            {t('common.reload')}
          </Button>
          {connected ? (
            <>
              <Button icon="cloud-down" busy={restoring} onClick={() => void restore()} testId="fatal-restore">
                {t('common.restoreTeamVersion')}
              </Button>
              <Button icon="folder" onClick={() => void window.api.openRepoFolder()}>
                {t('common.openFolder')}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Last line of defence: a programming error while drawing must show a message with a way
 * forward, never an empty window.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    console.error(error);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { t } = translatorFor(getState().lang);
    return (
      <div className="fatal" data-testid="crash">
        <div className="fatal__card">
          <div className="fatal__title">{t('common.errorTitle')}</div>
          <p>{t('common.crashText')}</p>
          <pre className="fatal__detail mono ltr selectable">{error.stack ?? error.message}</pre>
          <div className="row">
            <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>
              {t('common.reload')}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

export function App(): ReactNode {
  const phase = useApp((s) => s.phase);

  useEffect(() => {
    // init() is idempotent (React StrictMode runs effects twice in development).
    void actions.init();
  }, []);
  useGlobalShortcuts();

  if (phase === 'loading') return <Splash />;
  if (phase === 'fatal') return <FatalScreen />;

  return (
    <>
      {phase === 'ready' ? (
        <div className="app" data-testid="app-ready">
          <Toolbar />
          <ProblemBanner />
          <main className="app__main">
            <WeekGrid />
          </main>
        </div>
      ) : (
        <SetupWizard />
      )}
      <DialogHost />
      <ToastHost />
      <BusyOverlay />
    </>
  );
}
