import { useEffect, useState, type ReactNode } from 'react';
import type { SyncError } from '@shared/api';
import { courseWeekCount } from '@shared/dates';
import { isCourseInverted } from '@shared/model';
import { checkRepoUrl, maskRepoUrl } from '@shared/repoUrl';
import { SLOT_OPTIONS, type IsoDate, type SlotMinutes } from '@shared/types';
import { useT } from '../../i18n/useT';
import { actions, useApp } from '../../store';
import type { DialogState, SettingsTab } from '../../store/types';
import { LanguageSwitch } from '../common/LanguageSwitch';
import { SyncProblem } from '../common/SyncProblem';
import { Button, Callout, Checkbox, DateInput, Field, Modal, Select, Tabs, TextInput, TimeSelect, type TabItem } from '../ui';
import { EntityListEditor } from './EntityListEditor';
import './settings.css';

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const POLL_CHOICES = [30, 60, 120, 300, 900];

function GeneralPanel(): ReactNode {
  const { t, tn } = useT();
  const settings = useApp((s) => s.settings);
  const [userName, setUserName] = useState(settings.userName);
  const [userEmail, setUserEmail] = useState(settings.userEmail);
  const changed = userName.trim() !== settings.userName || userEmail.trim() !== settings.userEmail;
  const valid = userName.trim() !== '' && EMAIL.test(userEmail.trim());

  const pollLabel = (seconds: number): string =>
    seconds < 60 ? t('settings.pollSeconds', { count: seconds }) : tn('settings.pollMinutes', seconds / 60);
  const pollChoices = POLL_CHOICES.includes(settings.pollSeconds) ? POLL_CHOICES : [...POLL_CHOICES, settings.pollSeconds].sort((a, b) => a - b);

  return (
    <div className="st-panel">
      <Field label={t('settings.language')}>
        <LanguageSwitch />
      </Field>

      <section className="st-group">
        <h3>{t('settings.identityTitle')}</h3>
        <p className="muted">{t('settings.identityHint')}</p>
        <div className="st-grid">
          <Field label={t('settings.userName')} htmlFor="st-name">
            <TextInput id="st-name" value={userName} onChange={setUserName} testId="settings-user-name" />
          </Field>
          <Field label={t('settings.userEmail')} htmlFor="st-email">
            <TextInput id="st-email" dir="ltr" type="email" value={userEmail} onChange={setUserEmail} spellCheck={false} testId="settings-user-email" />
          </Field>
        </div>
        {changed && !valid ? <span className="st-row__error">{t('settings.identityInvalid')}</span> : null}
        <div>
          <Button
            variant="primary"
            disabled={!changed || !valid}
            onClick={() => void actions.saveLocalSettings({ userName: userName.trim(), userEmail: userEmail.trim() })}
            testId="settings-save-identity"
          >
            {t('settings.saveIdentity')}
          </Button>
        </div>
      </section>

      <section className="st-group">
        <Checkbox
          checked={settings.notifications}
          onChange={(notifications) => void actions.saveLocalSettings({ notifications })}
          label={t('settings.notifications')}
          hint={t('settings.notificationsHint')}
          testId="settings-notifications"
        />
        <Field label={t('settings.pollInterval')} htmlFor="st-poll" className="st-narrow">
          <Select
            id="st-poll"
            value={String(settings.pollSeconds)}
            onChange={(value) => void actions.saveLocalSettings({ pollSeconds: Number(value) })}
            options={pollChoices.map((seconds) => ({ value: String(seconds), label: pollLabel(seconds) }))}
            testId="settings-poll"
          />
        </Field>
      </section>
    </div>
  );
}

function RepositoryPanel(): ReactNode {
  const { t, tn } = useT();
  const repo = useApp((s) => s.repo);
  const git = useApp((s) => s.git);
  const settings = useApp((s) => s.settings);
  const diffCount = useApp((s) => s.diff.length);
  // Going back to the team's version is also what repairs a file damaged on this computer.
  const damaged = useApp((s) => s.damagedFiles.length > 0);
  const busy = useApp((s) => s.busy);
  const appVersion = useApp((s) => s.boot?.appVersion ?? '');
  const [url, setUrl] = useState('');
  const [confirming, setConfirming] = useState<'switch' | 'discard' | null>(null);
  const [error, setError] = useState<SyncError | null>(null);
  const check = checkRepoUrl(url);

  const connect = async (): Promise<void> => {
    setConfirming(null);
    if (!check.ok) return;
    setError(null);
    // On success the store closes this dialog and shows the other schedule.
    const result = await actions.connectRepo({ url: check.url, branch: null, userName: settings.userName, userEmail: settings.userEmail });
    if (!result.ok) setError(result.error);
  };

  return (
    <div className="st-panel">
      <dl className="st-facts">
        <dt>{t('settings.repoAddress')}</dt>
        <dd className="ltr selectable" data-testid="settings-repo-url">
          {repo ? maskRepoUrl(repo.url) : '—'}
        </dd>
        <dt>{t('settings.repoBranch')}</dt>
        <dd className="ltr selectable">{repo?.branch ?? '—'}</dd>
        <dt>{t('settings.repoFolder')}</dt>
        <dd>
          <span className="ltr selectable st-facts__path">{repo?.dir ?? '—'}</span>
          <Button size="sm" icon="folder" disabled={!repo} onClick={() => actions.openRepoFolder()}>
            {t('settings.openFolder')}
          </Button>
        </dd>
        <dt>{t('common.appName')}</dt>
        <dd className="ltr selectable" data-testid="settings-app-version">
          {appVersion}
        </dd>
        <dt>{t('settings.git')}</dt>
        <dd>
          <span className="ltr selectable st-facts__path">{git.found ? `${git.version ?? ''} — ${git.path ?? ''}` : t('settings.gitNotFound')}</span>
          <Button size="sm" icon="refresh" onClick={() => void actions.redetectGit()}>
            {t('settings.gitRedetect')}
          </Button>
          <Button size="sm" icon="folder" onClick={() => void actions.chooseGitExecutable()}>
            {t('settings.gitLocate')}
          </Button>
        </dd>
      </dl>

      <div className="st-actions">
        <Button icon="refresh" disabled={busy !== null} onClick={() => void actions.checkForUpdates({ interactive: true })} testId="settings-check-now">
          {t('settings.checkNow')}
        </Button>
        <Button icon="trash" className="st-danger" disabled={diffCount === 0 && !damaged} onClick={() => setConfirming('discard')} testId="settings-discard">
          {t('settings.discardLocal')}
        </Button>
      </div>

      <section className="st-group">
        <h3>{t('settings.switchTitle')}</h3>
        <p className="muted">{t('settings.switchHint')}</p>
        <div className="st-add">
          <div className="st-row__name">
            <TextInput dir="ltr" value={url} onChange={setUrl} placeholder="https://github.com/team/other-schedule.git" spellCheck={false} testId="settings-switch-url" />
          </div>
          <Button disabled={!check.ok || busy !== null} onClick={() => setConfirming('switch')} testId="settings-switch">
            {t('settings.switchButton')}
          </Button>
        </div>
        {error ? (
          <SyncProblem
            title={t('settings.switchFailed')}
            error={error}
            onTrust={(path) => void actions.trustRepoPath(path).then(connect)}
            testId="settings-switch-error"
          />
        ) : null}
      </section>

      {confirming === 'switch' ? (
        <Modal
          title={t('settings.switchConfirmTitle')}
          icon="git-branch"
          tone="warning"
          size="sm"
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button onClick={() => setConfirming(null)}>{t('common.cancel')}</Button>
              <Button variant="primary" onClick={() => void connect()} testId="settings-switch-confirm" data-autofocus>
                {t('settings.switchButton')}
              </Button>
            </>
          }
        >
          <p>{t('settings.switchConfirmText')}</p>
        </Modal>
      ) : null}
      {confirming === 'discard' ? (
        <Modal
          title={t('toolbar.discardTitle')}
          icon="warning"
          tone="danger"
          size="sm"
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button onClick={() => setConfirming(null)}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirming(null);
                  void actions.discardLocalChanges();
                }}
                testId="settings-discard-confirm"
                data-autofocus
              >
                {t('toolbar.discardConfirm')}
              </Button>
            </>
          }
        >
          <p>{diffCount === 0 ? t('common.restoreDamagedText') : tn('toolbar.discardMessage', diffCount)}</p>
        </Modal>
      ) : null}
    </div>
  );
}

function CoursePanel(): ReactNode {
  const { t, tn } = useT();
  const course = useApp((s) => s.working.config.course);
  const grid = useApp((s) => s.working.config.timeGrid);
  const [name, setName] = useState(course.name);
  useEffect(() => setName(course.name), [course.name]);

  // The two dates are a pair. While they contradict each other (the course would end before
  // it starts) they stay here in the form; only a pair that makes sense is put into the schedule.
  const [startDraft, setStartDraft] = useState(course.startDate);
  const [endDraft, setEndDraft] = useState(course.endDate);
  useEffect(() => {
    setStartDraft(course.startDate);
    setEndDraft(course.endDate);
  }, [course.startDate, course.endDate]);
  const datesInvalid = isCourseInverted({ startDate: startDraft, endDate: endDraft });
  const setDates = (startDate: IsoDate | null, endDate: IsoDate | null): void => {
    setStartDraft(startDate);
    setEndDraft(endDate);
    if (!isCourseInverted({ startDate, endDate })) actions.updateCourse({ startDate, endDate });
  };

  const weeks = datesInvalid ? null : courseWeekCount(course);

  return (
    <div className="st-panel">
      <Callout tone="info">{t('settings.sharedNote')}</Callout>

      <section className="st-group">
        <h3>{t('settings.courseTitle')}</h3>
        <Field label={t('settings.courseName')} htmlFor="st-course-name">
          <TextInput
            id="st-course-name"
            value={name}
            onChange={setName}
            onBlur={() => actions.updateCourse({ name })}
            onEnter={() => actions.updateCourse({ name })}
            maxLength={120}
            testId="settings-course-name"
          />
        </Field>
        <div className="st-grid">
          <Field label={t('settings.courseStart')} htmlFor="st-course-start" hint={t('settings.courseDatesHint')}>
            <DateInput
              id="st-course-start"
              value={startDraft}
              onChange={(startDate) => setDates(startDate, endDraft)}
              invalid={datesInvalid}
              testId="settings-course-start"
            />
          </Field>
          <Field label={t('settings.courseEnd')} htmlFor="st-course-end" error={datesInvalid ? t('settings.courseDatesInvalid') : null}>
            <DateInput
              id="st-course-end"
              value={endDraft}
              onChange={(endDate) => setDates(startDraft, endDate)}
              invalid={datesInvalid}
              testId="settings-course-end"
            />
          </Field>
        </div>
        {weeks !== null ? (
          <p className="muted" data-testid="settings-course-weeks">
            {tn('settings.courseWeeks', weeks)}
          </p>
        ) : null}
      </section>

      <section className="st-group">
        <h3>{t('settings.hoursTitle')}</h3>
        <div className="st-hours">
          <Field label={t('settings.dayStart')} htmlFor="st-day-start">
            <TimeSelect id="st-day-start" value={grid.dayStart} onChange={(dayStart) => actions.updateTimeGrid({ dayStart })} min={0} max={grid.dayEnd - 15} testId="settings-day-start" />
          </Field>
          <Field label={t('settings.dayEnd')} htmlFor="st-day-end">
            <TimeSelect id="st-day-end" value={grid.dayEnd} onChange={(dayEnd) => actions.updateTimeGrid({ dayEnd })} min={grid.dayStart + 15} max={1440} testId="settings-day-end" />
          </Field>
          <Field label={t('settings.slot')} htmlFor="st-slot">
            <Select
              id="st-slot"
              value={String(grid.slotMinutes)}
              onChange={(value) => actions.updateTimeGrid({ slotMinutes: Number(value) as SlotMinutes })}
              options={SLOT_OPTIONS.map((minutes) => ({ value: String(minutes), label: t('settings.slotMinutes', { count: minutes }) }))}
              testId="settings-slot"
            />
          </Field>
        </div>
        <p className="muted">{t('settings.hoursHint')}</p>
      </section>
    </div>
  );
}

export function SettingsDialog({ dialog }: { dialog: Extract<DialogState, { type: 'settings' }> }): ReactNode {
  const { t } = useT();
  const config = useApp((s) => s.working.config);
  const [tab, setTab] = useState<SettingsTab>(dialog.tab ?? 'general');

  const localTabs: TabItem<SettingsTab>[] = [
    { id: 'general', label: t('settings.tabGeneral'), icon: 'user', group: t('settings.groupLocal') },
    { id: 'repository', label: t('settings.tabRepository'), icon: 'git-branch' },
  ];
  const sharedTabs: TabItem<SettingsTab>[] = [
    { id: 'course', label: t('settings.tabCourse'), icon: 'clock', group: t('settings.groupShared') },
    { id: 'subjects', label: t('settings.tabSubjects'), icon: 'palette', badge: config.subjects.length },
    { id: 'locations', label: t('settings.tabLocations'), icon: 'location', badge: config.locations.length },
    { id: 'teachers', label: t('settings.tabTeachers'), icon: 'user', badge: config.teachers.length },
    { id: 'classes', label: t('settings.tabClasses'), icon: 'users', badge: config.classes.length },
  ];

  return (
    <Modal
      title={t('settings.title')}
      icon="settings"
      size="xl"
      flush
      onClose={() => actions.closeDialog()}
      closeOnBackdrop
      testId="settings-dialog"
      footer={
        <Button variant="primary" onClick={() => actions.closeDialog()} testId="settings-close">
          {t('common.done')}
        </Button>
      }
    >
      <div className="st">
        <nav className="st-nav">
          {/* ONE list with two captions: with two separate lists the keyboard could only ever reach the one holding the open page. */}
          <Tabs tabs={[...localTabs, ...sharedTabs]} active={tab} onChange={setTab} orientation="vertical" ariaLabel={t('settings.title')} testId="settings-tab" />
        </nav>
        <div className="st-content" role="tabpanel">
          {tab === 'general' ? <GeneralPanel /> : null}
          {tab === 'repository' ? <RepositoryPanel /> : null}
          {tab === 'course' ? <CoursePanel /> : null}
          {tab === 'subjects' ? (
            <div className="st-panel">
              <Callout tone="info">{t('settings.subjectsHint')}</Callout>
              <EntityListEditor kind="subject" />
            </div>
          ) : null}
          {tab === 'locations' ? (
            <div className="st-panel">
              <Callout tone="info">{t('settings.sharedNote')}</Callout>
              <EntityListEditor kind="location" />
            </div>
          ) : null}
          {tab === 'teachers' ? (
            <div className="st-panel">
              <Callout tone="info">{t('settings.sharedNote')}</Callout>
              <EntityListEditor kind="teacher" />
            </div>
          ) : null}
          {tab === 'classes' ? (
            <div className="st-panel">
              <Callout tone="info">{t('settings.sharedNote')}</Callout>
              <EntityListEditor kind="class" />
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
