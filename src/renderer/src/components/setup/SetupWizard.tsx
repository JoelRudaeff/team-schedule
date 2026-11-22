import { useEffect, useState, type ReactNode } from 'react';
import type { SyncError } from '@shared/api';
import { checkRepoUrl, repoDisplayName } from '@shared/repoUrl';
import type { IsoDate } from '@shared/types';
import type { MessageKey } from '../../i18n';
import { useT } from '../../i18n/useT';
import { actions, useApp } from '../../store';
import { LanguageSwitch } from '../common/LanguageSwitch';
import { SyncProblem } from '../common/SyncProblem';
import { Button, Callout, DateInput, Field, Icon, TextInput } from '../ui';
import './setup.css';

const GIT_DOWNLOAD_URL = 'https://git-scm.com/download/win';
const EMAIL = /^[^\s@]+@[^\s@]+$/;

const URL_PROBLEM: Record<'empty' | 'unsupported' | 'unsafe', MessageKey> = {
  empty: 'setup.repoUrlEmpty',
  unsupported: 'setup.repoUrlUnsupported',
  unsafe: 'setup.repoUrlUnsafe',
};

/** Git is required: says so, and offers the three ways forward. */
function GitCheck(): ReactNode {
  const { t } = useT();
  const git = useApp((s) => s.git);
  const [checking, setChecking] = useState(false);
  const [notGit, setNotGit] = useState(false);

  if (git.found) {
    return (
      <div className="setup__git-ok" data-testid="setup-git-ok">
        <Icon name="success" />
        <span>{t('setup.gitFound', { version: git.version ?? '' })}</span>
      </div>
    );
  }

  const recheck = async (): Promise<void> => {
    setChecking(true);
    setNotGit(false);
    await actions.redetectGit();
    setChecking(false);
  };
  const locate = async (): Promise<void> => {
    const chosen = await actions.chooseGitExecutable();
    setNotGit(chosen !== null && !chosen.found);
  };

  return (
    <Callout tone="danger" title={t('setup.gitMissingTitle')} testId="setup-git-missing">
      <span>{t('setup.gitMissingText')}</span>
      {notGit ? <span className="setup__inline-error">{t('setup.gitNotValid')}</span> : null}
      <div className="setup__git-actions">
        <Button size="sm" variant="primary" icon="external" onClick={() => void window.api.openExternal(GIT_DOWNLOAD_URL)}>
          {t('setup.gitDownload')}
        </Button>
        <Button size="sm" icon="refresh" busy={checking} onClick={() => void recheck()} testId="setup-git-recheck">
          {t('setup.gitRecheck')}
        </Button>
        <Button size="sm" icon="folder" onClick={() => void locate()}>
          {t('setup.gitLocate')}
        </Button>
      </div>
    </Callout>
  );
}

function ConnectForm(): ReactNode {
  const { t } = useT();
  const git = useApp((s) => s.git);
  const settings = useApp((s) => s.settings);
  const boot = useApp((s) => s.boot);
  const busy = useApp((s) => s.busy);

  const [url, setUrl] = useState(settings.repoUrl ?? '');
  const [userName, setUserName] = useState(settings.userName || boot?.suggestedIdentity.name || '');
  const [userEmail, setUserEmail] = useState(settings.userEmail || boot?.suggestedIdentity.email || '');
  const [branch, setBranch] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<SyncError | null>(null);

  const urlCheck = checkRepoUrl(url);
  const urlError = urlCheck.ok ? null : t(URL_PROBLEM[urlCheck.reason]);
  const nameError = userName.trim() === '' ? t('setup.userNameRequired') : null;
  const emailError = EMAIL.test(userEmail.trim()) ? null : t('setup.userEmailInvalid');
  const valid = urlError === null && nameError === null && emailError === null;

  const connect = async (createBranch = false): Promise<void> => {
    setSubmitted(true);
    if (!valid || !urlCheck.ok || !git.found) return;
    setError(null);
    const result = await actions.connectRepo({
      url: urlCheck.url,
      branch: branch.trim() === '' ? null : branch.trim(),
      userName: userName.trim(),
      userEmail: userEmail.trim(),
      ...(createBranch ? { createBranch: true } : {}),
    });
    if (!result.ok) setError(result.error);
  };

  const trustAndRetry = async (path: string): Promise<void> => {
    await actions.trustRepoPath(path);
    await connect();
  };

  return (
    <form
      className="setup__form"
      onSubmit={(event) => {
        event.preventDefault();
        void connect();
      }}
      noValidate
    >
      <h2 className="setup__heading">{t('setup.connectTitle')}</h2>
      <GitCheck />

      <Field label={t('setup.repoUrl')} htmlFor="setup-url" hint={t('setup.repoUrlHint')} error={submitted ? urlError : null} required>
        <TextInput
          id="setup-url"
          dir="ltr"
          value={url}
          onChange={setUrl}
          invalid={submitted && urlError !== null}
          placeholder="https://github.com/team/schedule.git"
          spellCheck={false}
          autoFocus
          testId="setup-repo-url"
        />
      </Field>

      <div className="setup__row">
        <Field label={t('setup.userName')} htmlFor="setup-name" hint={t('setup.userNameHint')} error={submitted ? nameError : null} required>
          <TextInput id="setup-name" value={userName} onChange={setUserName} invalid={submitted && nameError !== null} testId="setup-user-name" />
        </Field>
        <Field label={t('setup.userEmail')} htmlFor="setup-email" error={submitted ? emailError : null} required>
          <TextInput
            id="setup-email"
            dir="ltr"
            type="email"
            value={userEmail}
            onChange={setUserEmail}
            invalid={submitted && emailError !== null}
            spellCheck={false}
            testId="setup-user-email"
          />
        </Field>
      </div>

      <details className="setup__advanced">
        <summary>{t('setup.advanced')}</summary>
        <Field label={t('setup.branch')} htmlFor="setup-branch" hint={t('setup.branchHint')}>
          <TextInput id="setup-branch" dir="ltr" value={branch} onChange={setBranch} spellCheck={false} placeholder="main" testId="setup-branch" />
        </Field>
      </details>

      {error ? (
        <SyncProblem
          title={t('setup.connectFailed')}
          error={error}
          onTrust={(path) => void trustAndRetry(path)}
          onCreateBranch={() => void connect(true)}
          testId="setup-error"
        />
      ) : null}

      <Callout tone="info" title={t('setup.howItWorks')}>
        {t('setup.howItWorksText')}
      </Callout>

      <div className="setup__actions">
        <Button type="submit" variant="primary" icon="git-branch" disabled={!git.found || busy !== null} testId="setup-connect">
          {t('setup.connect')}
        </Button>
      </div>
    </form>
  );
}

function CreateForm({ onOtherRepo }: { onOtherRepo: () => void }): ReactNode {
  const { t } = useT();
  const repo = useApp((s) => s.repo);
  const busy = useApp((s) => s.busy);
  const [courseName, setCourseName] = useState('');
  const [startDate, setStartDate] = useState<IsoDate | null>(null);
  const [endDate, setEndDate] = useState<IsoDate | null>(null);
  const datesInvalid = startDate !== null && endDate !== null && endDate < startDate;

  return (
    <form
      className="setup__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!datesInvalid) void actions.createSchedule({ courseName, startDate, endDate });
      }}
    >
      <h2 className="setup__heading">{t('setup.createTitle')}</h2>
      <p className="muted">{t('setup.createText', { name: repo ? repoDisplayName(repo.url) : '' })}</p>

      <Field label={t('setup.courseName')} htmlFor="setup-course">
        <TextInput
          id="setup-course"
          value={courseName}
          onChange={setCourseName}
          placeholder={t('setup.courseNamePlaceholder')}
          autoFocus
          testId="setup-course-name"
        />
      </Field>
      <div className="setup__row">
        <Field label={t('setup.courseStart')} htmlFor="setup-start" hint={t('setup.courseDatesHint')}>
          <DateInput id="setup-start" value={startDate} onChange={setStartDate} testId="setup-course-start" />
        </Field>
        <Field label={t('setup.courseEnd')} htmlFor="setup-end" error={datesInvalid ? t('setup.courseDatesInvalid') : null}>
          <DateInput id="setup-end" value={endDate} onChange={setEndDate} min={startDate ?? undefined} invalid={datesInvalid} testId="setup-course-end" />
        </Field>
      </div>

      <Callout tone="info">{t('setup.createInfo')}</Callout>

      <div className="setup__actions">
        <Button variant="ghost" onClick={onOtherRepo} testId="setup-other-repo">
          {t('setup.otherRepo')}
        </Button>
        <Button type="submit" variant="primary" icon="cloud-up" disabled={datesInvalid || busy !== null} testId="setup-create">
          {t('setup.create')}
        </Button>
      </div>
    </form>
  );
}

/** First-run screen: connect to the team's repository, then (for an empty one) create the schedule. */
export function SetupWizard(): ReactNode {
  const { t } = useT();
  const phase = useApp((s) => s.phase);
  const [view, setView] = useState<'connect' | 'create'>(phase === 'needs-init' ? 'create' : 'connect');

  useEffect(() => {
    setView(phase === 'needs-init' ? 'create' : 'connect');
  }, [phase]);

  return (
    <div className="setup" data-testid="setup-wizard">
      <div className="setup__card">
        <header className="setup__header">
          <div className="setup__brand">
            <span className="setup__logo">
              <Icon name="calendar" size={22} />
            </span>
            <div>
              <h1 className="setup__title">{t('setup.welcomeTitle')}</h1>
              <p className="muted">{t('setup.welcomeText')}</p>
            </div>
          </div>
          <LanguageSwitch />
        </header>
        {view === 'create' ? <CreateForm onOtherRepo={() => setView('connect')} /> : <ConnectForm />}
      </div>
    </div>
  );
}
