/**
 * The renderer's single application store: state shape and the actions every component uses.
 *
 * CONTRACT FILE — components are written against these types; the store build task
 * implements them in `store/createStore.ts`. Do not change without updating both sides.
 *
 * How the pieces relate
 * ─────────────────────
 *   base     = the schedule as the team last shared it with this computer
 *   working  = base + this user's unpublished edits (what the grid shows and edits)
 *   diff     = diffDatasets(base, working)  → "N unpublished changes"
 *   sync     = where the local copy stands relative to the team's copy (behind > 0 → update available)
 *   aside    = my versions that lost a merge but were kept for a later decision (local only)
 */
import type {
  BootState,
  CommitInfo,
  ConnectRequest,
  ConnectResult,
  GitInfo,
  LocalSettings,
  RepoInfo,
  SyncError,
  SyncStatus,
  WeekBlame,
} from '@shared/api';
import type { AsideItem, DiffItem, MergeNote, MergeResult, Resolution } from '@shared/merge';
import type {
  CourseInfo,
  Dataset,
  EntityKind,
  FileMap,
  FileProblem,
  Filters,
  IsoDate,
  Lang,
  ScheduleEvent,
  TimeGrid,
} from '@shared/types';
import type { CopyWeekOptions, ImportWeekOptions, ImportWeekResult, WeekTemplate } from '@shared/weekTemplate';

// ───────────────────────────── state ─────────────────────────────

/**
 * - `loading`: starting up.
 * - `setup`: no repository connected → the set-up screen (connect form).
 * - `needs-init`: connected, but the repository has no schedule → the set-up screen offers to create one.
 * - `ready`: the schedule is loaded → toolbar + week grid.
 * - `fatal`: start-up failed (see `fatalError`).
 */
export type AppPhase = 'loading' | 'setup' | 'needs-init' | 'ready' | 'fatal';

/**
 * The one long-running operation in progress, if any.
 * `checking` (looking for team updates) never blocks the UI; all others show a blocking overlay.
 */
export type BusyKind = 'connecting' | 'creating' | 'checking' | 'updating' | 'publishing' | 'discarding';

export interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  /** Already localized. */
  message: string;
  /** Optional technical details (collapsed by default). */
  detail?: string;
  /** Optional button. */
  action?: { label: string; run: () => void };
  /** Sticky toasts stay until dismissed; others disappear after a few seconds. */
  sticky?: boolean;
}

export type SettingsTab = 'general' | 'repository' | 'course' | 'subjects' | 'locations' | 'teachers' | 'classes';

/** Everything the merge overview needs. Created by the store when the team's copy and the local copy both changed. */
export interface MergeSession {
  /** `publish`: the user pressed Save. `update`: the user pressed Update. */
  mode: 'publish' | 'update';
  /** Note typed in the publish dialog ('' in update mode). */
  note: string;
  /** The team tip this merge was computed against. */
  remoteSha: string;
  /** The team's newest version. */
  theirs: Dataset;
  /** Team files this app version cannot read (kept untouched; shown as a warning). */
  theirProblems: FileProblem[];
  /** Raw content of those files. */
  theirPassthrough: FileMap;
  /** All data files of the team's version, as they are in the repository. */
  theirFiles: FileMap;
  /** mergeDatasets(base, working, theirs). */
  result: MergeResult;
  /** The team's new commits (who changed what, when), newest first. */
  incoming: CommitInfo[];
  /** True when the dialog was rebuilt because the team's copy changed again while it was open. */
  changedAgain: boolean;
}

/** What the user decided in the merge overview. */
export interface MergeChoice {
  /** Conflict key → choice (conflicts without an entry use `defaultResolution`). */
  resolutions: Record<string, Resolution>;
  defaultResolution: Resolution;
  /**
   * `publish`: combine and publish the result now.
   * `keep-local`: combine into my copy only; my surviving edits stay unpublished.
   * (In `update` mode only `keep-local` is allowed.)
   */
  then: 'publish' | 'keep-local';
}

/** The one modal dialog that is open, if any. */
export type DialogState =
  /** Create (eventId null) or edit an event. `initial` pre-fills a new event (day / start / end from the clicked slot). */
  | { type: 'event'; weekStart: IsoDate; eventId: string | null; initial?: Partial<ScheduleEvent> }
  | { type: 'settings'; tab?: SettingsTab }
  /** Confirmation before saving to the team repository. */
  | { type: 'publish' }
  /** Graphic merge overview. */
  | { type: 'merge'; session: MergeSession }
  /** List of versions kept aside. */
  | { type: 'aside' }
  | { type: 'export-ics' }
  | { type: 'import-week'; template: WeekTemplate; fileName: string }
  | { type: 'repeat-week' }
  /** Shown when the window is closed while there are unpublished changes. */
  | { type: 'close-guard' }
  | {
      type: 'confirm';
      title: string;
      message: string;
      detail?: string;
      confirmLabel: string;
      cancelLabel?: string;
      danger?: boolean;
      onConfirm: () => void | Promise<void>;
    }
  | {
      type: 'error';
      title: string;
      message: string;
      detail?: string;
      /** Extra buttons, e.g. "Trust this folder" / "Retry". The dialog closes after `run`. */
      actions?: { label: string; primary?: boolean; run: () => void | Promise<void> }[];
    };

export interface AppState {
  phase: AppPhase;
  fatalError: { message: string; detail?: string } | null;

  /** Result of the start-up probe; null while `phase === 'loading'`. */
  boot: BootState | null;
  settings: LocalSettings;
  /** UI language (= settings.language). The document direction follows it (he → rtl). */
  lang: Lang;
  git: GitInfo;
  /** The connected repository; null until connected. */
  repo: RepoInfo | null;

  base: Dataset;
  working: Dataset;
  /** Files in the working folder that this app version cannot read (left untouched on disk). */
  problems: FileProblem[];
  /** Weeks whose file is unreadable: the grid shows an error for them and they cannot be edited. */
  readOnlyWeeks: IsoDate[];
  /**
   * Paths of the unreadable files that were damaged on this computer: they differ from the
   * last shared version, so restoring that version repairs them. (A file the team itself
   * holds in an unreadable form — saved by a newer app — is not in this list.)
   */
  damagedFiles: string[];
  /** Unpublished changes: diffDatasets(base, working). Same array instance while nothing changes. */
  diff: DiffItem[];
  /** `diff` keyed by item key, e.g. `event:2026-11-22:q1w2e3r4t5` → its DiffItem. */
  diffByKey: ReadonlyMap<string, DiffItem>;
  aside: AsideItem[];

  /** null until the first status arrived. */
  sync: SyncStatus | null;
  busy: BusyKind | null;

  /** The Sunday of the week on screen. */
  weekStart: IsoDate;
  filters: Filters;
  /** `git blame` per week, loaded lazily via `actions.ensureBlame`. */
  blame: Readonly<Record<IsoDate, WeekBlame | undefined>>;

  dialog: DialogState | null;
  toasts: ToastItem[];
  canUndo: boolean;
  canRedo: boolean;
}

// ───────────────────────────── actions ─────────────────────────────

export interface ExportIcsOptions {
  /** Sundays of the weeks to export. */
  weekStarts: IsoDate[];
  /** First and last calendar day to export (inclusive). Without them the whole weeks are exported. */
  dateFrom?: IsoDate | null;
  dateTo?: IsoDate | null;
  /** Apply the active week-view filter. */
  filteredOnly: boolean;
  calendarName: string;
  /** Open the saved file with the default calendar program (Outlook) afterwards. */
  openAfter: boolean;
}

export interface CreateScheduleInput {
  courseName: string;
  startDate: IsoDate | null;
  endDate: IsoDate | null;
}

/**
 * Every action is safe to call from an event handler: none of them throws or rejects.
 * Failures are reported to the user by the store itself (toast or error dialog); async
 * actions resolve when the operation — including its user feedback — is finished.
 */
export interface AppActions {
  /** Called once at start-up: boot probe, load the schedule, start background update checks, hook window close. */
  init(): Promise<void>;

  // ── language ──
  /** Switches the UI language, updates `<html lang dir>` and remembers the choice. */
  setLanguage(lang: Lang): void;

  // ── week navigation ──
  /** Shows the week that contains `date` (any day of the week may be passed). */
  goToWeek(date: IsoDate): void;
  /** -1 = previous week, +1 = next week. */
  goToRelativeWeek(delta: number): void;
  goToToday(): void;
  /** Jumps to a week by its number (see weekNumberOf in @shared/dates). False when the number is out of range. */
  goToWeekNumber(n: number): boolean;

  // ── filters ──
  setFilters(patch: Partial<Filters>): void;
  clearFilters(): void;

  // ── editing (each call is one undo step; ignored for read-only weeks) ──
  /** Adds the event or replaces the one with the same id. */
  saveEvent(weekStart: IsoDate, event: ScheduleEvent): void;
  deleteEvent(weekStart: IsoDate, eventId: string): void;
  /** Copies an event into the same week (same day and time, new id). Returns the new id, or null. */
  duplicateEvent(weekStart: IsoDate, eventId: string): string | null;
  setWeekTitle(weekStart: IsoDate, title: string): void;
  updateCourse(patch: Partial<CourseInfo>): void;
  updateTimeGrid(patch: Partial<TimeGrid>): void;
  /**
   * Adds a subject / location / teacher / class. When an entry with the same name
   * (case-insensitive) already exists, nothing is added and its id is returned.
   * `color` is only used for subjects (default: the next free palette colour).
   * Returns '' when the name is empty.
   */
  addEntity(kind: EntityKind, name: string, color?: string): string;
  updateEntity(kind: EntityKind, id: string, patch: { name?: string; color?: string }): void;
  /** Deletes the entry and removes it from every event that uses it. (Callers ask for confirmation first.) */
  removeEntity(kind: EntityKind, id: string): void;
  undo(): void;
  redo(): void;

  // ── dialogs and toasts ──
  openDialog(dialog: DialogState): void;
  closeDialog(): void;
  toast(toast: Omit<ToastItem, 'id'>): void;
  dismissToast(id: number): void;

  // ── team sync ──
  /**
   * Looks for team updates. Background checks call it with `{ interactive: false, silent: true }`;
   * the toolbar's refresh button with `{ interactive: true }` (may show a sign-in window,
   * reports problems and "already up to date").
   */
  checkForUpdates(opts?: { interactive?: boolean; silent?: boolean }): Promise<void>;
  /**
   * Toolbar "Update": fetches and applies the team's changes. Without local edits it just
   * updates. With local edits it merges; when nothing collides the merge is applied
   * automatically (local edits stay unpublished), otherwise the merge dialog opens.
   */
  requestUpdate(): Promise<void>;
  /** Toolbar "Save": opens the publish confirmation (or says that there is nothing to publish). */
  requestPublish(): void;
  /**
   * Called by the publish dialog. Fetches first; when the team's copy did not change, the
   * local changes are committed and pushed. When it did change, the merge dialog opens
   * (mode `publish`) — also when nothing collides, so the user sees what is coming in.
   */
  confirmPublish(note: string): Promise<void>;
  /** Called by the merge dialog with the user's decision. */
  resolveMerge(choice: MergeChoice): Promise<void>;
  /**
   * Throws away all unpublished edits: every schedule file on this computer becomes the
   * last shared version again, which also repairs `damagedFiles`. (Callers ask for confirmation first.)
   */
  discardLocalChanges(): Promise<void>;
  /** Makes my kept-aside version current again (it becomes a normal unpublished edit) and removes it from the list. */
  applyAside(key: string): void;
  /** Forgets my kept-aside version. */
  discardAside(key: string): void;
  /** Loads `git blame` for the week unless it is already cached for the current published version. */
  ensureBlame(weekStart: IsoDate): void;

  // ── set-up and local settings ──
  /** Connects to a repository. On success the phase becomes `ready` or `needs-init` and the schedule is loaded. */
  connectRepo(req: ConnectRequest): Promise<ConnectResult>;
  /** Creates and publishes the first schedule in an empty repository. True on success (phase becomes `ready`). */
  createSchedule(input: CreateScheduleInput): Promise<boolean>;
  saveLocalSettings(patch: Partial<LocalSettings>): Promise<void>;
  redetectGit(): Promise<GitInfo>;
  chooseGitExecutable(): Promise<GitInfo | null>;
  /** After the user agreed: trust a shared folder that git reported as "dubious ownership". */
  trustRepoPath(path: string): Promise<void>;
  openRepoFolder(): void;

  // ── output: Outlook, week files, repeat ──
  /** Asks where to save, writes the .ics file. Returns the path and number of exported events, or null when cancelled / failed. */
  exportIcs(options: ExportIcsOptions): Promise<{ path: string; count: number } | null>;
  /** Saves one week as a week file. Returns the path, or null when cancelled / failed. */
  exportWeekFile(weekStart: IsoDate, options: { filteredOnly: boolean }): Promise<string | null>;
  /** Lets the user pick a week file, validates it and opens the import dialog (or reports why it cannot be read). */
  pickWeekFile(): Promise<void>;
  /** Loads a week file into a week (one undo step). */
  importWeek(template: WeekTemplate, options: ImportWeekOptions): ImportWeekResult | null;
  /** Copies a week into other weeks (one undo step). Returns the number of weeks written. */
  repeatWeek(options: CopyWeekOptions): number;

  // ── window ──
  /** Close the window now (used by the close-guard dialog). */
  closeWindowNow(): void;
}

/** Texts the store needs for merge notes shown after an update (re-exported for components). */
export type { MergeNote, SyncError };

// ───────────────────────────── store handle ─────────────────────────────

export interface AppStore {
  getState(): AppState;
  /** Subscribes to every state change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  actions: AppActions;
}
