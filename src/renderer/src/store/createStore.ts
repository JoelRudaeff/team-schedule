/**
 * The application store: all state of the renderer, every user action and the team-sync
 * flows (update, publish, merge, keep aside). The screens only render this state and call
 * these actions. See ./types for the documented behaviour of each action.
 *
 * With `options.background === false` nothing here touches `window` / `document`, so the
 * store runs under Vitest in Node with a fake ScheduleApi.
 */
import type {
  CommitInfo,
  ConnectRequest,
  ConnectResult,
  GitInfo,
  LocalSettings,
  RepoSnapshot,
  ScheduleApi,
  SyncError,
  SyncStatus,
} from '@shared/api';
import { DEFAULT_POLL_SECONDS } from '@shared/api';
import { nextPaletteColor } from '@shared/colors';
import { addDays, isValidIsoDate, todayIso, weekStartForNumber, weekStartOf } from '@shared/dates';
import { buildIcs, collectIcsEvents } from '@shared/ics';
import { newId as defaultNewId } from '@shared/ids';
import {
  addAsideItems,
  applyAsideItem,
  applyMerge,
  diffDatasets,
  mergeDatasets,
  pruneAside,
  summarizeDiff,
  type AsideItem,
  type DiffItem,
  type MergeNote,
} from '@shared/merge';
import {
  addEntity,
  countEntityUsage,
  datasetsEqual,
  entityList,
  findEntity,
  findEntityByName,
  findEvent,
  matchesFilters,
  referencedIds,
  removeEntity,
  removeEvent,
  setWeekTitle,
  updateCourse,
  updateEntity,
  updateTimeGrid,
  upsertEvent,
} from '@shared/model';
import { weekStartFromPath } from '@shared/paths';
import { buildFileMap, createDefaultConfig, emptyDataset, filesToDataset, type ParsedFiles } from '@shared/serialize';
import {
  CONFIG_PATH,
  DataFormatError,
  EMPTY_FILTERS,
  type Dataset,
  type EntityKind,
  type FileMap,
  type Filters,
  type IsoDate,
  type Lang,
  type ScheduleConfig,
} from '@shared/types';
import {
  WEEK_TEMPLATE_EXTENSION,
  copyWeek,
  exportWeekTemplate,
  importWeekTemplate,
  parseWeekTemplate,
  serializeWeekTemplate,
} from '@shared/weekTemplate';
import {
  dirOf,
  languageForLocale,
  translate,
  translatePlural,
  type MessageKey,
  type MessageParams,
  type PluralKey,
} from '../i18n';
import type {
  AppActions,
  AppState,
  AppStore,
  BusyKind,
  DialogState,
  MergeChoice,
  MergeSession,
  ToastItem,
} from './types';

export interface StoreOptions {
  /** Clock. Default: () => new Date(). */
  now?: () => Date;
  /** Id generator for events and list entries. Default: newId from @shared/ids. */
  newId?: () => string;
  /** Delay before unpublished edits are written to the working folder, ms. Default 400. */
  persistDelayMs?: number;
  /**
   * Default true: start the periodic update check, listen to window focus / close, and
   * keep `<html lang dir>` in sync. Tests pass false and drive everything explicitly.
   */
  background?: boolean;
}

/** The store plus a hook for tests: resolves when no edit is waiting to be written to disk. */
export type AppStoreHandle = AppStore & { whenIdle(): Promise<void> };

const UNDO_LIMIT = 100;
const MAX_TOASTS = 5;
const MAX_FLOW_ROUNDS = 5;
/** Coming back to the window triggers a check only when the last one is older than this. */
const FOCUS_CHECK_MIN_AGE_MS = 15_000;
/** How long to wait before trying again to write edits that could not be written to disk. */
const PERSIST_RETRY_MS = 5_000;

const DEFAULT_SETTINGS: LocalSettings = {
  language: 'en',
  repoUrl: null,
  branch: null,
  userName: '',
  userEmail: '',
  gitPath: null,
  pollSeconds: DEFAULT_POLL_SECONDS,
  notifications: true,
};

const KIND_LABEL: Record<EntityKind, MessageKey> = {
  subject: 'store.kindSubject',
  location: 'store.kindLocation',
  teacher: 'store.kindTeacher',
  class: 'store.kindClass',
};

const ERROR_TEXT: Record<SyncError['code'], MessageKey> = {
  offline: 'store.errOffline',
  auth: 'store.errAuth',
  'not-found': 'store.errNotFound',
  'dubious-ownership': 'store.errDubious',
  'branch-missing': 'store.errBranchMissing',
  timeout: 'store.errTimeout',
  'git-missing': 'store.errGitMissing',
  'invalid-url': 'store.errInvalidUrl',
  unknown: 'store.errUnknown',
};

const ENTITY_KINDS: readonly EntityKind[] = ['subject', 'location', 'teacher', 'class'];

function isEntityKind(kind: string): kind is EntityKind {
  return ENTITY_KINDS.some((known) => known === kind);
}

const FILTER_KIND = {
  locationIds: 'location',
  classIds: 'class',
  teacherIds: 'teacher',
  subjectIds: 'subject',
} as const satisfies Record<keyof Filters, EntityKind>;

/** `filters` without the ids of entries the lists no longer have; the same object when nothing had to go. */
function prunedFilters(filters: Filters, config: ScheduleConfig): Filters {
  let next = filters;
  for (const key of Object.keys(FILTER_KIND) as (keyof Filters)[]) {
    const known = new Set(entityList(config, FILTER_KIND[key]).map((entry) => entry.id));
    if (filters[key].every((id) => known.has(id))) continue;
    next = { ...next, [key]: filters[key].filter((id) => known.has(id)) };
  }
  return next;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keeps only characters that are safe in a Windows file name. */
function safeFileName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return cleaned === '' ? fallback : cleaned.slice(0, 80);
}

interface UndoStep {
  working: Dataset;
  aside: AsideItem[];
}

/** What the team's version of the data files looks like once parsed. */
interface TeamVersion {
  sha: string;
  files: FileMap;
  parsed: ParsedFiles;
}

export function createAppStore(api: ScheduleApi, options: StoreOptions = {}): AppStoreHandle {
  const now = options.now ?? (() => new Date());
  const makeId = options.newId ?? defaultNewId;
  const persistDelayMs = options.persistDelayMs ?? 400;
  const background = options.background ?? true;

  const empty = emptyDataset();
  let state: AppState = {
    phase: 'loading',
    fatalError: null,
    boot: null,
    settings: DEFAULT_SETTINGS,
    lang: 'en',
    git: { found: false, path: null, version: null },
    repo: null,
    base: empty,
    working: empty,
    problems: [],
    readOnlyWeeks: [],
    damagedFiles: [],
    diff: [],
    diffByKey: new Map(),
    aside: [],
    sync: null,
    busy: null,
    weekStart: weekStartOf(todayIso(now())),
    filters: EMPTY_FILTERS,
    blame: {},
    dialog: null,
    toasts: [],
    canUndo: false,
    canRedo: false,
  };

  const listeners = new Set<() => void>();

  // ── private, non-reactive state ──
  /** Raw text of working-folder files this version cannot read; overlaid on every file map sent to main. */
  let passthrough: FileMap = {};
  /** The data files of the last shared version exactly as they are in the repository. */
  let baseRaw: FileMap = {};
  /** Each undo step also remembers the kept-aside list, so undoing "use my version" brings the entry back. */
  let undoStack: UndoStep[] = [];
  let redoStack: UndoStep[] = [];
  let initPromise: Promise<void> | null = null;
  let toastSeq = 0;
  /** The team tip that was already announced with a toast / notification. */
  let announcedRemoteSha: string | null = null;
  let lastCheckAt = 0;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let backgroundStarted = false;
  /** A user-started sync operation is running (update, publish, merge, discard, connect, create). */
  let exclusiveActive = false;
  /** The update check in flight, if any. */
  let checkPromise: Promise<void> | null = null;
  let flowRounds = 0;
  const blameInFlight = new Set<IsoDate>();
  // persistence of unpublished edits
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let persistDirty = false;
  let persistRunning: Promise<boolean> | null = null;
  let persistFailureShown = false;
  /** The open event dialog holds text that is not part of the schedule yet (see setDraftDirty). */
  let draftDirty = false;
  /** The toast that offers to undo a deletion, and the undo step it belongs to. */
  let undoToast: { id: number; step: UndoStep } | null = null;

  // ───────────────────────────── basics ─────────────────────────────

  function set(patch: Partial<AppState>): void {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  const t = (key: MessageKey, params?: MessageParams): string => translate(state.lang, key, params);
  const tn = (key: PluralKey, count: number, params?: MessageParams): string =>
    translatePlural(state.lang, key, count, params);

  /** State fields that depend on base / working. The diff keeps its identity while nothing changes. */
  function dataPatch(next: { base?: Dataset; working?: Dataset }): Partial<AppState> {
    const base = next.base ?? state.base;
    const working = next.working ?? state.working;
    if (base === state.base && working === state.working) return {};
    // A filter must never keep the id of an entry that is gone (removed here, or by the team):
    // it would hide every event while looking switched off, and pre-fill new events with it.
    const filters = prunedFilters(state.filters, working.config);
    const filterPatch = filters === state.filters ? {} : { filters };
    const fresh = diffDatasets(base, working);
    if (fresh.length === 0 && state.diff.length === 0) return { base, working, ...filterPatch };
    return { base, working, diff: fresh, diffByKey: new Map(fresh.map((item) => [item.key, item])), ...filterPatch };
  }

  /** Returns the id of the new toast. */
  function toast(item: Omit<ToastItem, 'id'>): number {
    const id = ++toastSeq;
    const toasts = [...state.toasts, { ...item, id, dir: item.dir ?? dirOf(state.lang) }];
    while (toasts.length > MAX_TOASTS) {
      const droppable = toasts.findIndex((entry) => !entry.sticky);
      toasts.splice(droppable >= 0 ? droppable : 0, 1);
    }
    set({ toasts });
    return id;
  }

  /** Takes the "Event deleted · Undo" toast away once its Undo would undo something else. */
  function retireUndoToast(): void {
    if (undoToast === null) return;
    const { id } = undoToast;
    undoToast = null;
    if (state.toasts.some((entry) => entry.id === id)) set({ toasts: state.toasts.filter((entry) => entry.id !== id) });
  }

  function reportUnexpected(error: unknown): void {
    console.error(error);
    toast({ kind: 'error', message: t('store.unexpected'), detail: errorText(error) });
  }

  function syncErrorText(error: SyncError): string {
    return t(ERROR_TEXT[error.code]);
  }

  function askToTrust(path: string): void {
    set({
      dialog: {
        type: 'confirm',
        title: t('store.trustTitle'),
        message: t('store.trustMessage'),
        detail: path,
        confirmLabel: t('store.actionTrust'),
        onConfirm: () => actions.trustRepoPath(path),
      },
    });
  }

  /** The follow-up a repository problem offers, if any. */
  function remedyFor(error: SyncError): { label: string; run: () => void } | undefined {
    if (error.code === 'auth') {
      return { label: t('store.actionSignIn'), run: () => void actions.checkForUpdates({ interactive: true }) };
    }
    if (error.code === 'dubious-ownership' && error.trustPath) {
      const path = error.trustPath;
      return { label: t('store.actionTrust'), run: () => askToTrust(path) };
    }
    return undefined;
  }

  function toastSyncError(error: SyncError): void {
    toast({ kind: 'error', message: syncErrorText(error), detail: error.detail || undefined, action: remedyFor(error) });
  }

  function showSyncErrorDialog(title: string, error: SyncError): void {
    const remedy = remedyFor(error);
    set({
      dialog: {
        type: 'error',
        title,
        message: syncErrorText(error),
        detail: error.detail || undefined,
        actions: remedy ? [{ label: remedy.label, primary: true, run: remedy.run }] : undefined,
      },
    });
  }

  function setSync(status: SyncStatus): void {
    const headMoved = state.sync?.headSha !== status.headSha;
    set({ sync: status, ...(headMoved ? { blame: {} } : {}) });
  }

  function authorsText(commits: readonly CommitInfo[]): string {
    const names = [...new Set(commits.map((commit) => commit.authorName).filter((name) => name !== ''))];
    if (names.length === 0) return t('common.unknown');
    if (names.length <= 3) return names.join(', ');
    return t('store.andOthers', { names: names.slice(0, 3).join(', ') });
  }

  function applyLanguageToDocument(): void {
    if (!background) return;
    document.documentElement.lang = state.lang;
    document.documentElement.dir = dirOf(state.lang);
    document.title = t('common.appName');
  }

  function clearHistory(): void {
    retireUndoToast();
    undoStack = [];
    redoStack = [];
    set({ canUndo: false, canRedo: false });
  }

  async function saveAside(aside: AsideItem[]): Promise<void> {
    try {
      await api.setAside(aside);
    } catch (error) {
      reportUnexpected(error);
    }
  }

  async function addAside(added: readonly AsideItem[]): Promise<void> {
    if (added.length === 0) return;
    const aside = pruneAside(addAsideItems(state.aside, added), state.working);
    set({ aside });
    await saveAside(aside);
  }

  // ───────────────────────────── persistence of unpublished edits ─────────────────────────────

  /** Writes pending edits to the working folder. False when the write failed (the edits stay pending). */
  function runPersist(): Promise<boolean> {
    if (persistRunning) return persistRunning;
    persistRunning = (async () => {
      try {
        while (persistDirty) {
          persistDirty = false;
          try {
            await api.writeWorking(buildFileMap(state.working, passthrough));
            persistFailureShown = false;
          } catch (error) {
            // Still not on disk: stays pending, so the next edit, the retry or a close attempt tries again.
            persistDirty = true;
            // One message, not one per keystroke.
            if (!persistFailureShown) {
              persistFailureShown = true;
              toast({ kind: 'error', sticky: true, message: t('store.saveLocalFailed'), detail: errorText(error) });
            }
            if (background && persistTimer === undefined) {
              persistTimer = setTimeout(() => {
                persistTimer = undefined;
                void runPersist();
              }, PERSIST_RETRY_MS);
            }
            return false;
          }
        }
        return true;
      } finally {
        persistRunning = null;
      }
    })();
    return persistRunning;
  }

  function schedulePersist(): void {
    // Without a connected repository there is no working folder to write to.
    if (state.repo === null) return;
    persistDirty = true;
    if (persistTimer !== undefined) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      void runPersist();
    }, persistDelayMs);
  }

  /** Tries to bring every edit made so far into the working folder. False when that did not work. */
  async function flush(): Promise<boolean> {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    if (persistRunning) await persistRunning;
    if (persistDirty) await runPersist();
    return !persistDirty;
  }

  /** Closes the window once the edits are on disk; when they cannot be written, the user decides. */
  async function closeWhenSaved(): Promise<void> {
    if (await flush()) {
      await api.closeWindow();
      return;
    }
    set({
      dialog: {
        type: 'error',
        title: t('store.closeUnsavedTitle'),
        message: t('store.closeUnsavedText'),
        actions: [
          { label: t('store.closeAnywayLose'), run: () => api.closeWindow() },
          { label: t('common.retry'), primary: true, run: () => closeWhenSaved() },
        ],
      },
    });
  }

  // ───────────────────────────── loading ─────────────────────────────

  /** Puts a snapshot from the main process on screen. False when the schedule itself is unreadable (fatal). */
  async function applySnapshot(snapshot: RepoSnapshot): Promise<boolean> {
    const baseParsed = filesToDataset(snapshot.baseFiles);
    const workParsed = filesToDataset(snapshot.workingFiles);
    const configProblem = workParsed.problems.find((p) => p.path === CONFIG_PATH && p.code !== 'missing-config');
    if (configProblem) {
      const message = configProblem.code === 'newer-version' ? t('store.fatalNewerVersion') : t('store.fatalDamagedConfig');
      set({
        phase: 'fatal',
        fatalError: { message, detail: `${state.repo?.dir ?? ''}\n${configProblem.message}`.trim() },
      });
      return false;
    }

    let working = workParsed.dataset;
    const workingLostConfig = workParsed.problems.some((p) => p.code === 'missing-config');
    const baseHasConfig = !baseParsed.problems.some((p) => p.path === CONFIG_PATH);
    if (workingLostConfig && baseHasConfig) {
      // schedule.json vanished from the local folder: the shared settings are the team's, not "all deleted".
      working = { config: baseParsed.dataset.config, weeks: working.weeks };
    }

    passthrough = workParsed.passthrough;
    baseRaw = snapshot.baseFiles;
    const readOnlyWeeks = Object.keys(passthrough)
      .map(weekStartFromPath)
      .filter((week): week is IsoDate => week !== null);
    // A week whose local file cannot be read is shown as the team has it — never as
    // "I deleted all its events", which a later Save would then publish.
    for (const week of readOnlyWeeks) {
      const shared = baseParsed.dataset.weeks[week];
      if (shared) working = { ...working, weeks: { ...working.weeks, [week]: shared } };
    }

    let aside: AsideItem[] = [];
    try {
      const stored = await api.getAside();
      aside = pruneAside(stored, working);
      if (aside.length !== stored.length) void saveAside(aside);
    } catch (error) {
      console.warn('The kept-aside list could not be read:', error);
    }

    const headMoved = state.sync?.headSha !== snapshot.status.headSha;
    set({
      ...dataPatch({ base: baseParsed.dataset, working }),
      problems: workParsed.problems.filter((p) => p.code !== 'missing-config'),
      readOnlyWeeks,
      // The same (empty) list while nothing is damaged, so nothing re-renders for it.
      damagedFiles: brokenLocalPaths().length === 0 && state.damagedFiles.length === 0 ? state.damagedFiles : brokenLocalPaths(),
      aside,
      sync: snapshot.status,
      ...(headMoved ? { blame: {} } : {}),
    });
    if (workingLostConfig && baseHasConfig) schedulePersist();
    return true;
  }

  async function reloadSnapshot(): Promise<boolean> {
    return applySnapshot(await api.loadSnapshot());
  }

  /**
   * Unreadable local files that are not simply the team's own (unreadable) version: damage
   * made on this computer. The app never publishes such a file.
   */
  function brokenLocalPaths(): string[] {
    return Object.keys(passthrough).filter((path) => passthrough[path] !== baseRaw[path]);
  }

  /**
   * `files` plus every unreadable local file that the team has not replaced since the last
   * shared version: an update must not delete or overwrite what this version cannot read.
   */
  function keepLocalUnreadable(files: FileMap, teamFiles: FileMap): FileMap {
    const result: FileMap = { ...files };
    for (const [path, text] of Object.entries(passthrough)) {
      if (teamFiles[path] === baseRaw[path]) result[path] = text;
    }
    return result;
  }

  function resetRepositoryView(): void {
    // An offer to undo something in the schedule that is being left makes no sense any more.
    retireUndoToast();
    passthrough = {};
    baseRaw = {};
    undoStack = [];
    redoStack = [];
    announcedRemoteSha = null;
    blameInFlight.clear();
    set({
      ...dataPatch({ base: empty, working: empty }),
      problems: [],
      readOnlyWeeks: [],
      damagedFiles: [],
      aside: [],
      sync: null,
      blame: {},
      filters: EMPTY_FILTERS,
      canUndo: false,
      canRedo: false,
    });
  }

  // ───────────────────────────── background work ─────────────────────────────

  function restartPollTimer(): void {
    if (!background) return;
    if (pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      void actions.checkForUpdates({ interactive: false, silent: true });
    }, Math.max(15, state.settings.pollSeconds) * 1000);
  }

  function startBackground(): void {
    if (!background) return;
    restartPollTimer();
    if (backgroundStarted) return;
    backgroundStarted = true;
    window.addEventListener('focus', () => {
      if (now().getTime() - lastCheckAt > FOCUS_CHECK_MIN_AGE_MS) {
        void actions.checkForUpdates({ interactive: false, silent: true });
      }
    });
  }

  function hookWindowClose(): void {
    if (!background) return;
    api.onCloseRequested(() => {
      void (async () => {
        try {
          await api.ackCloseRequest();
          // While a sync operation runs the window stays; the user can close again afterwards.
          if (exclusiveActive) return;
          // Already asking: a second click on the window's X is not an answer.
          if (state.dialog?.type === 'close-guard') return;
          // A box that is still being typed in (the week's name, the course name) hands its text
          // over when it loses the focus. Closing the window is no reason to lose that text.
          // (It gets the focus straight back, so the keyboard stays where it was.)
          const typingIn = document.activeElement;
          if (typingIn instanceof HTMLElement && typingIn !== document.body) {
            typingIn.blur();
            typingIn.focus();
          }
          const unpublished = state.phase === 'ready' && (state.diff.length > 0 || (state.sync?.ahead ?? 0) > 0);
          const draft = draftDirty && state.dialog?.type === 'event';
          if (unpublished || draft) {
            await flush();
            // The question is laid over whatever dialog is open; that dialog (and what was
            // typed into it) is still there when the answer is "no, stay".
            // Read afresh: the wait above may have seen another dialog open.
            const covered = ((): DialogState | null => state.dialog)();
            set({ dialog: { type: 'close-guard', covered: covered?.type === 'close-guard' ? covered.covered : covered, draft } });
          } else {
            await closeWhenSaved();
          }
        } catch (error) {
          console.error(error);
          void api.closeWindow();
        }
      })();
    });
  }

  /** After the schedule is on screen: background checks plus a first quiet look at the team's copy. */
  function enterReady(): void {
    set({ phase: 'ready', fatalError: null });
    startBackground();
    void actions.checkForUpdates({ interactive: false, silent: true });
  }

  // ───────────────────────────── editing ─────────────────────────────

  /** Puts a working dataset (and, when given, a kept-aside list) on screen and schedules it to be written. */
  function publishWorking(next: Dataset, asideList: AsideItem[] = state.aside): void {
    const aside = pruneAside(asideList, next);
    const asideChanged = aside.length !== state.aside.length || aside.some((item, index) => item !== state.aside[index]);
    set({
      ...dataPatch({ working: next }),
      ...(asideChanged ? { aside } : {}),
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    });
    if (asideChanged) void saveAside(aside);
    schedulePersist();
  }

  /**
   * Makes `next` the working dataset as one undo step. False when nothing changed.
   * `asideAfter` replaces the kept-aside list in the same step (used when a kept-aside version is applied).
   */
  function commit(next: Dataset, asideAfter?: AsideItem[]): boolean {
    if (next === state.working && asideAfter === undefined) return false;
    retireUndoToast();
    undoStack.push({ working: state.working, aside: state.aside });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    publishWorking(next, asideAfter);
    return true;
  }

  function isReadOnly(weekStart: IsoDate): boolean {
    if (!state.readOnlyWeeks.includes(weekStart)) return false;
    toast({ kind: 'warning', message: t('store.readOnlyWeek') });
    return true;
  }

  // ───────────────────────────── sync flows ─────────────────────────────

  /**
   * Runs one user-started sync operation: waits for a running background check, shows the
   * busy overlay, and never lets a failure escape. A second request while one is running
   * is ignored (a double click must not publish twice).
   */
  async function exclusive(kind: BusyKind, job: () => Promise<void>): Promise<void> {
    if (exclusiveActive) return;
    exclusiveActive = true;
    flowRounds = 0;
    try {
      // Shown at once, also while a background check is still on its way: from this moment the
      // dialogs are locked and nothing can be edited, so what the user confirmed is exactly
      // what runs — never something they changed (or cancelled) while it was still waiting.
      set({ busy: kind });
      if (checkPromise) await checkPromise;
      // "An update is available" and the like are stale the moment a sync operation starts.
      const toasts = state.toasts.filter((entry) => entry.sticky || entry.kind !== 'info');
      set({ busy: kind, ...(toasts.length !== state.toasts.length ? { toasts } : {}) });
      await job();
    } catch (error) {
      reportUnexpected(error);
    } finally {
      exclusiveActive = false;
      set({ busy: null });
    }
  }

  /** The team's newest fetched version, parsed. null (after telling the user) when it cannot be used. */
  async function readTeamVersion(failureTitle: string): Promise<TeamVersion | null> {
    const remote = await api.loadRemote();
    if (!remote) return null;
    const parsed = filesToDataset(remote.files);
    const configProblem = parsed.problems.find((p) => p.path === CONFIG_PATH);
    if (configProblem) {
      set({
        dialog: {
          type: 'error',
          title: failureTitle,
          message: configProblem.code === 'newer-version' ? t('store.teamNewer') : t('store.teamUnreadable'),
          detail: configProblem.message,
        },
      });
      return null;
    }
    return { sha: remote.sha, files: remote.files, parsed };
  }

  function commitMessage(note: string, changes: readonly DiffItem[]): string {
    const summary = summarizeDiff(changes);
    const trimmed = note.trim();
    const head = trimmed === '' ? summary.subject : `${trimmed}\n\n${summary.subject}`;
    if (summary.body.trim() === '') return head;
    return trimmed === '' ? `${head}\n\n${summary.body}` : `${head}\n${summary.body}`;
  }

  function sessionFor(
    mode: MergeSession['mode'],
    note: string,
    team: TeamVersion,
    incoming: CommitInfo[],
    changedAgain: boolean,
  ): MergeSession {
    return {
      mode,
      note,
      remoteSha: team.sha,
      base: state.base,
      mine: state.working,
      theirs: team.parsed.dataset,
      theirProblems: team.parsed.problems,
      theirPassthrough: team.parsed.passthrough,
      theirFiles: team.files,
      result: mergeDatasets(state.base, state.working, team.parsed.dataset),
      incoming,
      changedAgain,
    };
  }

  /** False once the schedule on screen is no longer the one the merge overview was computed from. */
  function isCurrent(session: MergeSession): boolean {
    return session.base === state.base && session.mine === state.working;
  }

  /**
   * How many of my changes the team does not have yet. A change both sides made identically
   * (`same`) is not "mine" any more: it is already in the team's copy.
   */
  function ownWorkCount(session: MergeSession): number {
    return session.result.items.filter((item) => item.status !== 'theirs' && item.status !== 'same').length;
  }

  function announceNotes(notes: readonly MergeNote[]): void {
    for (const note of notes) {
      if (note.code === 'entity-restored') {
        toast({ kind: 'info', message: t('store.noteRestored', { kind: t(KIND_LABEL[note.kind]), name: note.name }) });
      } else if (note.code === 'entity-merged') {
        toast({ kind: 'info', message: t('store.noteMerged', { kind: t(KIND_LABEL[note.kind]), name: note.name }) });
      } else if (note.code === 'entity-duplicate') {
        toast({ kind: 'warning', sticky: true, message: t('store.noteDuplicate', { kind: t(KIND_LABEL[note.kind]), name: note.name }) });
      } else if (note.code === 'course-dates-reset') {
        toast({ kind: 'warning', message: t('store.noteCourseDates') });
      } else {
        toast({ kind: 'info', message: t('store.noteTimeGrid') });
      }
    }
  }

  function tooManyRounds(title: string): boolean {
    flowRounds += 1;
    if (flowRounds <= MAX_FLOW_ROUNDS) return false;
    set({ dialog: { type: 'error', title, message: t('store.tooManyRetries') } });
    return true;
  }

  /**
   * Applies a merge decision. `quiet.headline` replaces the default success message (used
   * when the merge was automatic).
   */
  async function finishMerge(session: MergeSession, choice: MergeChoice, headline?: string): Promise<void> {
    const then = session.mode === 'update' ? 'keep-local' : choice.then;
    const stamp = now().toISOString();

    // Weeks the team holds in a form this version cannot read. Nothing of mine can be written
    // into such a week, so my changes there are kept aside instead of vanishing without a word.
    const blocked = new Set(
      Object.keys(session.theirPassthrough)
        .map(weekStartFromPath)
        .filter((week): week is IsoDate => week !== null),
    );
    const resolutions = { ...choice.resolutions };
    const stranded: AsideItem[] = [];
    for (const item of session.result.items) {
      const mineToKeep = item.mineChange !== 'none' && item.status !== 'same';
      if (!item.weekStart || !blocked.has(item.weekStart) || !mineToKeep) continue;
      if (item.status === 'conflict') {
        resolutions[item.key] = 'aside';
      } else {
        stranded.push({
          key: item.key,
          kind: item.kind,
          id: item.id,
          field: item.field,
          weekStart: item.weekStart,
          mine: item.mine,
          theirs: item.theirs,
          createdAt: stamp,
        });
      }
    }

    const merged = applyMerge({
      mine: session.mine,
      theirs: session.theirs,
      result: session.result,
      resolutions,
      defaultResolution: choice.defaultResolution,
      now: stamp,
    });
    let dataset = merged.dataset;
    if (blocked.size > 0) {
      const weeks = { ...dataset.weeks };
      for (const week of blocked) delete weeks[week];
      dataset = { ...dataset, weeks };
    }
    const applied = { dataset, aside: [...merged.aside, ...stranded], notes: merged.notes };
    // The team's unreadable files stay as the team has them; unreadable local files the team
    // did not replace stay as they are on this computer.
    const files = keepLocalUnreadable(buildFileMap(applied.dataset, session.theirPassthrough), session.theirFiles);
    const toPublish = diffDatasets(session.theirs, applied.dataset);
    const failureTitle = session.mode === 'publish' ? t('store.publishFailedTitle') : t('store.updateFailedTitle');

    const succeeded = async (published: boolean): Promise<void> => {
      await reloadSnapshot();
      await addAside(applied.aside);
      clearHistory();
      if (state.dialog?.type === 'merge' || state.dialog?.type === 'publish') set({ dialog: null });
      const parts: string[] = [];
      if (published) parts.push(t('store.published'));
      else if (headline) parts.push(headline);
      else if (toPublish.length > 0) parts.push(tn('store.updatedKept', toPublish.length));
      else parts.push(t('store.updatedPlain'));
      if (applied.aside.length > 0) parts.push(tn('store.keptAside', applied.aside.length));
      toast({ kind: 'success', message: parts.join(' ') });
      if (stranded.length > 0) toast({ kind: 'warning', sticky: true, message: tn('store.strandedAside', stranded.length) });
      announceNotes(applied.notes);
    };

    // Stored BEFORE the working files are replaced, so a crash or a git failure in between
    // cannot lose my versions. Should the merge not happen after all, these entries simply
    // equal the schedule again and the next pruneAside drops them.
    if (applied.aside.length > 0) await saveAside(addAsideItems(state.aside, applied.aside));

    if (then === 'keep-local' || toPublish.length === 0) {
      set({ busy: 'updating' });
      const result = await api.applyUpdate({ files, expectedRemoteSha: session.remoteSha });
      if (result.ok) return succeeded(false);
      // Whatever happened, show what is really on disk now (including the kept-aside list).
      await reloadSnapshot();
      if (result.reason === 'remote-changed') {
        if (tooManyRounds(failureTitle)) return;
        return session.mode === 'publish' ? publishFlow(session.note, true) : updateFlow(true);
      }
      showSyncErrorDialog(failureTitle, result.error);
      return;
    }

    set({ busy: 'publishing' });
    const result = await api.publish({
      files,
      message: commitMessage(session.note, toPublish),
      expectedRemoteSha: session.remoteSha,
    });
    // "Saved" is only said when a commit really went out (the files may have matched the team's already).
    if (result.ok) return succeeded(result.commitSha !== null);

    // The main process may already have applied the update part (it writes the files and
    // moves the local copy to the team's tip before it pushes): look before deciding.
    // The reload also brings back the kept-aside entries stored above, pruned against what
    // is really in the working folder.
    await reloadSnapshot();
    if (datasetsEqual(state.working, applied.dataset)) clearHistory();
    if (result.reason === 'remote-changed') {
      if (tooManyRounds(failureTitle)) return;
      return publishFlow(session.note, true);
    }
    showSyncErrorDialog(failureTitle, result.error);
  }

  async function updateFlow(changedAgain = false): Promise<void> {
    const failureTitle = t('store.updateFailedTitle');
    await flush();
    const status = await api.fetch({ interactive: true });
    lastCheckAt = now().getTime();
    setSync(status);
    if (status.fetchError) {
      if (state.dialog?.type === 'merge') showSyncErrorDialog(failureTitle, status.fetchError);
      else toastSyncError(status.fetchError);
      return;
    }
    announcedRemoteSha = status.remoteSha;
    if (status.remoteSha === null || status.behind === 0) {
      if (state.dialog?.type === 'merge') set({ dialog: null });
      // A branch that was deleted or renamed on the server is not "up to date".
      const branchGone = status.remoteSha === null && status.headSha !== null;
      toast(branchGone ? { kind: 'warning', message: t('store.branchMissing') } : { kind: 'info', message: t('store.upToDate') });
      return;
    }
    const team = await readTeamVersion(failureTitle);
    if (!team) return;
    const authors = authorsText(status.incoming);

    if (state.diff.length === 0 && status.ahead === 0) {
      const result = await api.applyUpdate({
        files: keepLocalUnreadable(team.files, team.files),
        expectedRemoteSha: team.sha,
      });
      if (result.ok) {
        await reloadSnapshot();
        clearHistory();
        if (state.dialog?.type === 'merge') set({ dialog: null });
        toast({ kind: 'success', message: tn('store.updated', status.behind, { authors }) });
        return;
      }
      setSync(result.status);
      if (result.reason === 'remote-changed') {
        if (tooManyRounds(failureTitle)) return;
        return updateFlow(changedAgain);
      }
      toastSyncError(result.error);
      return;
    }

    const session = sessionFor('update', '', team, status.incoming, changedAgain);
    if (session.result.conflictCount === 0) {
      const kept = ownWorkCount(session);
      const headline = kept > 0 ? tn('store.updatedKept', kept) : tn('store.updated', status.behind, { authors });
      return finishMerge(session, { resolutions: {}, defaultResolution: 'theirs', then: 'keep-local' }, headline);
    }
    set({ busy: null, dialog: { type: 'merge', session } });
  }

  /**
   * `askAgain`: the flow is run again because the overview the user decided on went out of
   * date. Should there be nothing of the team's to merge any more, the save is not simply
   * sent: the Save question is put again, with the list of what would go out now.
   */
  async function publishFlow(note: string, changedAgain = false, askAgain = false): Promise<void> {
    const failureTitle = t('store.publishFailedTitle');
    await flush();
    const status = await api.fetch({ interactive: true });
    lastCheckAt = now().getTime();
    setSync(status);
    if (status.fetchError) {
      showSyncErrorDialog(failureTitle, status.fetchError);
      return;
    }
    announcedRemoteSha = status.remoteSha;

    if (state.diff.length === 0 && status.ahead === 0) {
      if (state.dialog?.type === 'publish' || state.dialog?.type === 'merge') set({ dialog: null });
      toast({ kind: 'info', message: t('store.nothingToPublish') });
      return;
    }

    // A file that was damaged on this computer must never be published as if it were an edit.
    const broken = brokenLocalPaths();
    if (broken.length > 0) {
      set({
        dialog: { type: 'error', title: failureTitle, message: t('store.brokenLocalFiles'), detail: broken.join('\n') },
      });
      return;
    }

    if (status.behind === 0) {
      if (askAgain) {
        set({ busy: null, dialog: { type: 'publish' } });
        return;
      }
      const result = await api.publish({
        files: buildFileMap(state.working, passthrough),
        message: commitMessage(note, state.diff),
        expectedRemoteSha: status.remoteSha,
      });
      if (result.ok) {
        await reloadSnapshot();
        if (state.dialog?.type === 'publish' || state.dialog?.type === 'merge') set({ dialog: null });
        toast(
          result.commitSha === null
            ? { kind: 'info', message: t('store.nothingToPublish') }
            : { kind: 'success', message: t('store.published') },
        );
        return;
      }
      await reloadSnapshot();
      if (result.reason === 'remote-changed') {
        if (tooManyRounds(failureTitle)) return;
        return publishFlow(note, true);
      }
      showSyncErrorDialog(failureTitle, result.error);
      return;
    }

    const team = await readTeamVersion(failureTitle);
    if (!team) return;
    const session = sessionFor('publish', note, team, status.incoming, changedAgain);
    if (ownWorkCount(session) === 0) {
      // Everything I changed is already in the team's copy: this is simply an update.
      return finishMerge(
        session,
        { resolutions: {}, defaultResolution: 'theirs', then: 'keep-local' },
        t('store.alreadyIncluded'),
      );
    }
    // Shown even without collisions: the user sees what is coming in before their save goes out.
    set({ busy: null, dialog: { type: 'merge', session } });
  }

  // ───────────────────────────── actions ─────────────────────────────

  const actions: AppActions = {
    init() {
      initPromise ??= (async () => {
        try {
          const boot = await api.boot();
          const lang: Lang = boot.firstRun ? languageForLocale(boot.systemLocale) : boot.settings.language;
          set({ boot, settings: { ...boot.settings, language: lang }, lang, git: boot.git, repo: boot.repo });
          applyLanguageToDocument();
          hookWindowClose();
          if (boot.firstRun) void api.saveSettings({ language: lang }).catch((error: unknown) => console.warn(error));

          if (boot.phase === 'ready') {
            if (await reloadSnapshot()) enterReady();
          } else {
            set({ phase: boot.phase === 'needs-init' ? 'needs-init' : 'setup' });
          }
        } catch (error) {
          console.error(error);
          set({ phase: 'fatal', fatalError: { message: t('store.fatalStart'), detail: errorText(error) } });
        }
      })();
      return initPromise;
    },

    // ── language ──

    setLanguage(lang) {
      if (lang === state.lang) return;
      set({ lang, settings: { ...state.settings, language: lang } });
      applyLanguageToDocument();
      void api.saveSettings({ language: lang }).catch((error: unknown) => console.warn(error));
    },

    // ── week navigation ──

    goToWeek(date) {
      if (!isValidIsoDate(date)) return;
      const weekStart = weekStartOf(date);
      if (weekStart !== state.weekStart) set({ weekStart });
    },

    goToRelativeWeek(delta) {
      if (!Number.isInteger(delta) || delta === 0) return;
      set({ weekStart: addDays(state.weekStart, 7 * delta) });
    },

    goToToday() {
      actions.goToWeek(todayIso(now()));
    },

    goToWeekNumber(n) {
      const weekStart = weekStartForNumber(n, state.working.config.course, state.weekStart);
      if (weekStart === null) return false;
      if (weekStart !== state.weekStart) set({ weekStart });
      return true;
    },

    // ── filters ──

    setFilters(patch) {
      set({ filters: { ...state.filters, ...patch } });
    },

    clearFilters() {
      if (state.filters !== EMPTY_FILTERS) set({ filters: EMPTY_FILTERS });
    },

    // ── editing ──

    saveEvent(weekStart, event) {
      if (isReadOnly(weekStart)) return;
      commit(upsertEvent(state.working, weekStart, event));
    },

    deleteEvent(weekStart, eventId) {
      if (isReadOnly(weekStart)) return;
      if (!commit(removeEvent(state.working, weekStart, eventId))) return;
      // The offer to undo belongs to this very step: it disappears with the next change, so
      // its button can never undo something else instead.
      const step = undoStack[undoStack.length - 1];
      const id = toast({
        kind: 'info',
        message: t('grid.deleted'),
        action: {
          label: t('grid.undo'),
          run: () => {
            if (undoStack[undoStack.length - 1] === step) actions.undo();
          },
        },
      });
      undoToast = { id, step };
    },

    duplicateEvent(weekStart, eventId) {
      if (isReadOnly(weekStart)) return null;
      const original = findEvent(state.working, weekStart, eventId);
      if (!original) return null;
      const id = makeId();
      commit(upsertEvent(state.working, weekStart, { ...original, id }));
      return id;
    },

    setWeekTitle(weekStart, title) {
      if (isReadOnly(weekStart)) return;
      commit(setWeekTitle(state.working, weekStart, title));
    },

    updateCourse(patch) {
      commit(updateCourse(state.working, patch));
    },

    updateTimeGrid(patch) {
      commit(updateTimeGrid(state.working, patch));
    },

    addEntity(kind, name, color) {
      const trimmed = name.trim();
      if (trimmed === '') return '';
      const existing = findEntityByName(state.working.config, kind, trimmed);
      if (existing) return existing.id;
      const id = makeId();
      const item =
        kind === 'subject'
          ? { id, name: trimmed, color: color ?? nextPaletteColor(state.working.config.subjects.map((s) => s.color)) }
          : { id, name: trimmed };
      commit(addEntity(state.working, kind, item));
      return id;
    },

    updateEntity(kind, id, patch) {
      commit(updateEntity(state.working, kind, id, patch));
    },

    removeEntity(kind, id) {
      commit(removeEntity(state.working, kind, id));
    },

    undo() {
      const previous = undoStack.pop();
      if (!previous) return;
      retireUndoToast();
      redoStack.push({ working: state.working, aside: state.aside });
      publishWorking(previous.working, previous.aside);
    },

    redo() {
      const next = redoStack.pop();
      if (!next) return;
      retireUndoToast();
      undoStack.push({ working: state.working, aside: state.aside });
      publishWorking(next.working, next.aside);
    },

    // ── dialogs and toasts ──

    openDialog(dialog: DialogState) {
      set({ dialog });
    },

    closeDialog() {
      if (state.dialog === null) return;
      // A save or merge that is already running cannot be called off by closing its dialog:
      // the dialog stays until the operation has finished and said how it went.
      if (exclusiveActive && (state.dialog.type === 'publish' || state.dialog.type === 'merge')) return;
      // Answering "close the window?" with no brings back the dialog it covered, as it was.
      set({ dialog: state.dialog.type === 'close-guard' ? state.dialog.covered : null });
    },

    setDraftDirty(dirty) {
      draftDirty = dirty;
    },

    toast,

    dismissToast(id) {
      if (state.toasts.some((entry) => entry.id === id)) set({ toasts: state.toasts.filter((entry) => entry.id !== id) });
    },

    // ── team sync ──

    checkForUpdates(opts = {}) {
      const interactive = opts.interactive ?? false;
      const silent = opts.silent ?? false;
      if (state.phase !== 'ready' || exclusiveActive) return Promise.resolve();
      if (checkPromise) return checkPromise;
      checkPromise = (async () => {
        set({ busy: 'checking' });
        try {
          const previous = state.sync;
          const status = await api.fetch({ interactive });
          lastCheckAt = now().getTime();
          setSync(status);
          // Something outside the app moved the local copy: what is on screen may be stale.
          if (previous && (previous.baseSha !== status.baseSha || previous.headSha !== status.headSha)) {
            // The user keeps working during a background check. Should an edit arrive while the
            // files are being read, what was read is already out of date: read again.
            for (let attempt = 0; attempt < 3; attempt++) {
              await flush();
              const before = state.working;
              const snapshot = await api.loadSnapshot();
              if (state.working !== before) continue;
              // Undo steps from before would bring back a schedule that no longer matches the files.
              if (await applySnapshot(snapshot)) clearHistory();
              break;
            }
          }
          if (status.fetchError) {
            if (!silent) toastSyncError(status.fetchError);
            return;
          }
          if (status.behind > 0 && status.remoteSha !== announcedRemoteSha) {
            announcedRemoteSha = status.remoteSha;
            const message = tn('store.updatesAvailable', status.behind, { authors: authorsText(status.incoming) });
            toast({
              kind: 'info',
              message,
              action: { label: t('store.actionUpdate'), run: () => void actions.requestUpdate() },
            });
            void api.notify({ title: t('store.notifyTitle'), body: message }).catch(() => undefined);
          } else if (!silent && status.behind === 0) {
            toast({ kind: 'info', message: t('store.upToDate') });
          }
        } catch (error) {
          if (silent) console.warn(error);
          else reportUnexpected(error);
        } finally {
          checkPromise = null;
          if (state.busy === 'checking') set({ busy: null });
        }
      })();
      return checkPromise;
    },

    requestUpdate() {
      if (state.phase !== 'ready') return Promise.resolve();
      return exclusive('updating', () => updateFlow());
    },

    requestPublish() {
      if (state.phase !== 'ready') return;
      if (state.diff.length === 0 && (state.sync?.ahead ?? 0) === 0) {
        toast({ kind: 'info', message: t('store.nothingToPublish') });
        return;
      }
      set({ dialog: { type: 'publish' } });
    },

    confirmPublish(note) {
      if (state.phase !== 'ready') return Promise.resolve();
      return exclusive('publishing', () => publishFlow(note));
    },

    resolveMerge(choice) {
      const dialog = state.dialog;
      if (state.phase !== 'ready' || dialog?.type !== 'merge') return Promise.resolve();
      const session = dialog.session;
      const publishing = session.mode === 'publish' && choice.then === 'publish';
      return exclusive(publishing ? 'publishing' : 'updating', async () => {
        await flush();
        if (!isCurrent(session)) {
          // The schedule changed after the overview was drawn (an undo, a reload after something
          // outside the app moved the local copy …). A decision made on the old picture is
          // never applied to the new one: the overview is built again and the user decides again.
          toast({ kind: 'warning', message: t('store.mergeOutdated') });
          // Nothing goes out that the user has not seen and confirmed again: "update only" stays
          // an update, and a save comes back with a question before anything is sent.
          if (session.mode === 'update' || choice.then === 'keep-local') return updateFlow(true);
          return publishFlow(session.note, true, true);
        }
        await finishMerge(session, choice);
      });
    },

    discardLocalChanges() {
      if (state.phase !== 'ready') return Promise.resolve();
      return exclusive('discarding', async () => {
        await flush();
        const repaired = state.damagedFiles.length > 0 && state.diff.length === 0;
        const snapshot = await api.discardLocal();
        if (!(await applySnapshot(snapshot))) return;
        clearHistory();
        toast({ kind: 'info', message: t(repaired ? 'store.filesRestored' : 'store.discarded') });
      });
    },

    applyAside(key) {
      const item = state.aside.find((entry) => entry.key === key);
      if (!item) return;
      if (item.weekStart && isReadOnly(item.weekStart)) return;

      const apply = (): void => {
        const before = state.working;
        const next = applyAsideItem(before, item);
        if (next === before) {
          // My version cannot be part of this schedule any more (hours or dates that no longer
          // fit together). It stays in the list; saying "it is back" would not be true.
          toast({ kind: 'warning', message: t('store.asideCannotApply') });
          return;
        }
        // One undo step for both halves: undoing brings back the team's version AND the kept-aside entry.
        commit(
          next,
          state.aside.filter((entry) => entry.key !== key),
        );
        toast({ kind: 'success', message: t('store.asideApplied') });
        for (const kind of ENTITY_KINDS) {
          for (const entry of entityList(next.config, kind)) {
            const restored = !findEntity(before.config, kind, entry.id) && !(item.kind === kind && item.id === entry.id);
            if (restored) toast({ kind: 'info', message: t('store.noteRestored', { kind: t(KIND_LABEL[kind]), name: entry.name }) });
          }
        }
        const event = item.kind === 'event' && item.id && item.weekStart ? findEvent(next, item.weekStart, item.id) : undefined;
        const mine = item.mine;
        if (event && typeof mine === 'object' && mine !== null && 'teacherIds' in mine) {
          const dropped = ENTITY_KINDS.some((kind) => referencedIds(mine, kind).length > referencedIds(event, kind).length);
          if (dropped) toast({ kind: 'info', message: t('store.asideRefsDropped') });
        }
      };

      // My version is "this entry is deleted": using it takes the entry out of every event,
      // exactly like removing it in Settings — and like there, only after the user has seen how many.
      const usage =
        isEntityKind(item.kind) && item.id !== undefined && item.mine === undefined
          ? countEntityUsage(state.working, item.kind, item.id)
          : 0;
      if (usage === 0) {
        apply();
        return;
      }
      const listOpen = state.dialog?.type === 'aside';
      const entry = isEntityKind(item.kind) ? findEntity(state.working.config, item.kind, item.id ?? null) : undefined;
      set({
        dialog: {
          type: 'confirm',
          title: t('settings.removeTitle', { name: entry?.name ?? '' }),
          message: tn('settings.removeText', usage),
          confirmLabel: t('common.remove'),
          danger: true,
          onConfirm: () => {
            apply();
            if (listOpen && state.aside.length > 0) set({ dialog: { type: 'aside' } });
          },
        },
      });
    },

    discardAside(key) {
      if (!state.aside.some((entry) => entry.key === key)) return;
      const aside = state.aside.filter((entry) => entry.key !== key);
      // A discarded version must not come back through undo or redo.
      // The steps themselves stay the same objects: the "event deleted · Undo" message knows
      // its step by identity, and its button must go on working after this.
      for (const step of [...undoStack, ...redoStack]) step.aside = step.aside.filter((entry) => entry.key !== key);
      set({ aside });
      void saveAside(aside);
    },

    ensureBlame(weekStart, retries = 0) {
      if (state.phase !== 'ready' || !state.sync) return;
      let outdated = false;
      const headSha = state.sync.headSha;
      const cached = state.blame[weekStart];
      if ((cached && cached.headSha === headSha) || blameInFlight.has(weekStart)) return;
      blameInFlight.add(weekStart);
      void api
        .blame(weekStart)
        .then((blame) => {
          // An answer for a version that is no longer current is of no use …
          if (blame.headSha === (state.sync?.headSha ?? null)) set({ blame: { ...state.blame, [weekStart]: blame } });
          else outdated = true;
        })
        .catch((error: unknown) => console.warn('git blame failed:', error))
        .finally(() => {
          blameInFlight.delete(weekStart);
          // … so the question is asked again for the version that is current now.
          if (outdated && retries < 2) actions.ensureBlame(weekStart, retries + 1);
        });
    },

    // ── set-up and local settings ──

    async connectRepo(req: ConnectRequest): Promise<ConnectResult> {
      const refused: ConnectResult = {
        ok: false,
        error: { code: 'unknown', message: 'Another operation is still running', detail: '' },
      };
      if (exclusiveActive) return refused;
      let outcome: ConnectResult = refused;
      await exclusive('connecting', async () => {
        await flush();
        try {
          outcome = await api.connectRepo(req);
        } catch (error) {
          outcome = { ok: false, error: { code: 'unknown', message: errorText(error), detail: errorText(error) } };
          return;
        }
        if (!outcome.ok) return;
        resetRepositoryView();
        set({ settings: outcome.settings, repo: outcome.repo, dialog: null });
        if (outcome.phase === 'ready') {
          if (await reloadSnapshot()) enterReady();
        } else {
          set({ phase: 'needs-init' });
        }
      });
      return outcome;
    },

    async createSchedule(input) {
      let created = false;
      await exclusive('creating', async () => {
        const config = createDefaultConfig(state.lang);
        // Only real calendar dates may reach schedule.json (a half-typed year would make it unreadable).
        const usable = (date: IsoDate | null): IsoDate | null => (date !== null && isValidIsoDate(date) ? date : null);
        const dataset: Dataset = {
          config: {
            ...config,
            course: { name: input.courseName.trim(), startDate: usable(input.startDate), endDate: usable(input.endDate) },
          },
          weeks: {},
        };
        const result = await api.createSchedule({ files: buildFileMap(dataset, {}), message: t('store.createMessage') });
        if (result.ok) {
          if (await reloadSnapshot()) enterReady();
          toast({ kind: 'success', message: t('store.scheduleCreated') });
          created = true;
          return;
        }
        if (result.reason === 'remote-changed') {
          // A teammate was faster: connecting again brings their schedule into the local folder.
          const { repoUrl, branch, userName, userEmail } = state.settings;
          if (repoUrl !== null) {
            const again = await api.connectRepo({ url: repoUrl, branch, userName, userEmail });
            if (again.ok && again.phase === 'ready') {
              set({ settings: again.settings, repo: again.repo });
              if (await reloadSnapshot()) enterReady();
              toast({ kind: 'info', message: t('store.scheduleExisted') });
              created = true;
              return;
            }
            if (!again.ok) {
              showSyncErrorDialog(t('store.createFailedTitle'), again.error);
              return;
            }
          }
          set({ dialog: { type: 'error', title: t('store.createFailedTitle'), message: t('store.unexpected') } });
          return;
        }
        showSyncErrorDialog(t('store.createFailedTitle'), result.error);
      });
      return created;
    },

    async saveLocalSettings(patch) {
      try {
        const before = state.settings;
        const settings = await api.saveSettings(patch);
        set({ settings, ...(settings.language !== state.lang ? { lang: settings.language } : {}) });
        if (settings.language !== before.language) applyLanguageToDocument();
        if (settings.pollSeconds !== before.pollSeconds && state.phase === 'ready') restartPollTimer();
      } catch (error) {
        toast({ kind: 'error', message: t('store.settingsFailed'), detail: errorText(error) });
      }
    },

    async redetectGit(): Promise<GitInfo> {
      try {
        const git = await api.detectGit();
        set({ git });
        return git;
      } catch (error) {
        reportUnexpected(error);
        return state.git;
      }
    },

    async chooseGitExecutable() {
      try {
        const git = await api.chooseGitExecutable();
        if (git?.found) set({ git, settings: { ...state.settings, gitPath: git.path } });
        return git;
      } catch (error) {
        reportUnexpected(error);
        return null;
      }
    },

    async trustRepoPath(path) {
      try {
        await api.trustRepoPath(path);
        toast({ kind: 'success', message: t('store.trustDone') });
      } catch (error) {
        reportUnexpected(error);
      }
    },

    openRepoFolder() {
      void api.openRepoFolder().catch(reportUnexpected);
    },

    // ── output ──

    async exportIcs(options) {
      try {
        const filters = state.filters;
        const events = collectIcsEvents({
          dataset: state.working,
          weekStarts: options.weekStarts,
          include: (event, weekStart) => {
            if (options.filteredOnly && !matchesFilters(event, filters)) return false;
            const date = addDays(weekStart, event.day);
            if (options.dateFrom && date < options.dateFrom) return false;
            if (options.dateTo && date > options.dateTo) return false;
            return true;
          },
          labels: {
            teachers: t('store.icsTeachers'),
            classes: t('store.icsClasses'),
            subject: t('store.icsSubject'),
            untitled: t('store.icsUntitled'),
          },
        });
        if (events.length === 0) {
          toast({ kind: 'warning', message: t('store.exportNoEvents') });
          return null;
        }
        const calendarName = options.calendarName.trim() || t('store.icsDefaultName');
        const saved = await api.saveTextFile({
          title: t('store.exportIcsTitle'),
          defaultName: `${safeFileName(calendarName, 'schedule')}.ics`,
          filters: [{ name: t('store.fileFilterIcs'), extensions: ['ics'] }],
          content: buildIcs(events, { calendarName, now: now() }),
        });
        if (!saved) return null;
        const open = (): void => void api.openSavedFile(saved.path).catch(reportUnexpected);
        if (options.openAfter) open();
        toast({
          kind: 'success',
          message: tn('store.exportIcsDone', events.length),
          action: options.openAfter ? undefined : { label: t('store.actionOpen'), run: open },
        });
        return { path: saved.path, count: events.length };
      } catch (error) {
        reportUnexpected(error);
        return null;
      }
    },

    async exportWeekFile(weekStart, { filteredOnly }) {
      try {
        const filters = state.filters;
        const template = exportWeekTemplate(
          state.working,
          weekStart,
          now().toISOString(),
          filteredOnly ? (event) => matchesFilters(event, filters) : undefined,
        );
        if (template.events.length === 0) {
          toast({ kind: 'warning', message: t('store.exportNoEvents') });
          return null;
        }
        const saved = await api.saveTextFile({
          title: t('store.exportWeekTitle'),
          defaultName: `week-${weekStart}.${WEEK_TEMPLATE_EXTENSION}`,
          filters: [{ name: t('store.fileFilterWeek'), extensions: ['json'] }],
          content: serializeWeekTemplate(template),
        });
        if (!saved) return null;
        toast({ kind: 'success', message: tn('store.exportWeekDone', template.events.length) });
        return saved.path;
      } catch (error) {
        reportUnexpected(error);
        return null;
      }
    },

    async pickWeekFile() {
      try {
        const file = await api.openTextFile({
          title: t('store.importWeekTitle'),
          filters: [{ name: t('store.fileFilterWeek'), extensions: ['json'] }],
        });
        if (!file) return;
        try {
          const template = parseWeekTemplate(file.content);
          set({ dialog: { type: 'import-week', template, fileName: file.name } });
        } catch (error) {
          if (!(error instanceof DataFormatError)) throw error;
          toast({
            kind: 'error',
            message: error.code === 'newer-version' ? t('store.importNewer') : t('store.importInvalid'),
            detail: error.message,
          });
        }
      } catch (error) {
        reportUnexpected(error);
      }
    },

    importWeek(template, options) {
      if (isReadOnly(options.targetWeek)) return null;
      const result = importWeekTemplate(state.working, template, options, makeId);
      commit(result.dataset);
      const created: string[] = [];
      if (result.created.subjects > 0) created.push(`${t('common.subjects')} ${result.created.subjects}`);
      if (result.created.locations > 0) created.push(`${t('common.locations')} ${result.created.locations}`);
      if (result.created.teachers > 0) created.push(`${t('common.teachers')} ${result.created.teachers}`);
      if (result.created.classes > 0) created.push(`${t('common.classes')} ${result.created.classes}`);
      const parts = [tn('store.importDone', result.eventCount)];
      if (created.length > 0) parts.push(t('store.importCreated', { list: created.join(', ') }));
      if (result.snapped > 0) parts.push(tn('store.importSnapped', result.snapped));
      if (result.shortened > 0) parts.push(tn('store.importShortened', result.shortened));
      toast({ kind: 'success', message: parts.join(' ') });
      return result;
    },

    repeatWeek(options) {
      const targets = options.targetWeeks.filter(
        (week) => week !== options.sourceWeek && !state.readOnlyWeeks.includes(week),
      );
      if (targets.length === 0) return 0;
      const next = copyWeek(state.working, { ...options, targetWeeks: targets }, makeId);
      return commit(next) ? targets.length : 0;
    },

    // ── window ──

    closeWindowNow() {
      void closeWhenSaved().catch((error: unknown) => {
        console.error(error);
        void api.closeWindow();
      });
    },
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
    async whenIdle() {
      await flush();
      if (checkPromise) await checkPromise;
    },
  };
}
