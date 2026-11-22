/**
 * What the app remembers on this computer only (never in the repository):
 *
 *   <userData>/settings.json           LocalSettings plus the window position
 *   <userData>/aside/<repoKey>.json    the versions kept aside, one list per repository
 *   <userData>/repos/<repoKey>/        the working folder (a git clone) of each repository
 *
 * Plain fs and no Electron imports, so everything here is unit-tested with temp folders
 * (tests/unit/localStore.test.ts).
 *
 * Reading never fails: a missing or damaged file gives defaults, field by field. Writing
 * is atomic (a temp file is renamed over the old one) and strictly ordered, so neither a
 * crash nor two writes in quick succession can leave half a file or an older version behind.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_POLL_SECONDS, MAX_POLL_SECONDS, MIN_POLL_SECONDS, type LocalSettings } from '@shared/api';
import type { AsideItem } from '@shared/merge';
import { checkRepoUrl, repoDisplayName } from '@shared/repoUrl';
import { SerialQueue } from './serialQueue';
import {
  MAX_ASIDE_ITEMS,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
  MAX_REPO_URL_LENGTH,
  MAX_TEXT_BYTES,
  cleanLine,
  hasControlChars,
  isAsideItem,
  isPlainObject,
  isValidBranchName,
} from './validate';

/** Where the window was when it was last closed (its normal, un-maximized rectangle). */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_SETTINGS: Readonly<LocalSettings> = Object.freeze({
  language: 'en',
  repoUrl: null,
  branch: null,
  userName: '',
  userEmail: '',
  gitPath: null,
  pollSeconds: DEFAULT_POLL_SECONDS,
  notifications: true,
});

const KEY_NAME_MAX_LENGTH = 40;
const KEY_HASH_LENGTH = 10;

/**
 * Folder / file name for one repository address: `<name>-<hash>`, where name is the
 * repository's display name reduced to [A-Za-z0-9._-] (at most 40 characters, `repo` when
 * nothing is left) and hash is the first 10 hex characters of the address's SHA-1.
 * The hash covers the exact address, so two repositories that merely share a name never
 * share a folder — and the key must never change, or existing clones would be orphaned.
 */
export function repoKey(repoUrl: string): string {
  const name = repoDisplayName(repoUrl)
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, KEY_NAME_MAX_LENGTH);
  const hash = createHash('sha1').update(repoUrl, 'utf8').digest('hex').slice(0, KEY_HASH_LENGTH);
  return `${name === '' ? 'repo' : name}-${hash}`;
}

export function clampPollSeconds(seconds: number): number {
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(seconds)));
}

function storedLine(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const line = cleanLine(value);
  return line.length <= maxLength ? line : fallback;
}

/** The address is handed to git, so a stored one is checked exactly like a typed one. */
function storedRepoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_REPO_URL_LENGTH) return null;
  const check = checkRepoUrl(value);
  return check.ok ? check.url : null;
}

function storedGitPath(value: unknown): string | null {
  const usable = typeof value === 'string' && value.trim() !== '' && value.length <= MAX_PATH_LENGTH && !hasControlChars(value);
  return usable ? value : null;
}

/**
 * Complete, valid settings from whatever was stored (or patched): every field that is
 * missing, of the wrong type or out of range gets its default; pollSeconds is clamped.
 */
export function normalizeSettings(raw: unknown): LocalSettings {
  const input = isPlainObject(raw) ? raw : {};
  return {
    language: input.language === 'he' || input.language === 'en' ? input.language : DEFAULT_SETTINGS.language,
    repoUrl: storedRepoUrl(input.repoUrl),
    branch: typeof input.branch === 'string' && isValidBranchName(input.branch) ? input.branch : null,
    userName: storedLine(input.userName, MAX_NAME_LENGTH, DEFAULT_SETTINGS.userName),
    userEmail: storedLine(input.userEmail, MAX_EMAIL_LENGTH, DEFAULT_SETTINGS.userEmail),
    gitPath: storedGitPath(input.gitPath),
    pollSeconds:
      typeof input.pollSeconds === 'number' && Number.isFinite(input.pollSeconds)
        ? clampPollSeconds(input.pollSeconds)
        : DEFAULT_SETTINGS.pollSeconds,
    notifications: typeof input.notifications === 'boolean' ? input.notifications : DEFAULT_SETTINGS.notifications,
  };
}

/** null unless all four numbers are there; whether the rectangle is still on a display is decided when it is used. */
export function normalizeWindowState(raw: unknown): WindowState | null {
  if (!isPlainObject(raw)) return null;
  const numbers = [raw.x, raw.y, raw.width, raw.height];
  if (!numbers.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) return null;
  const [x, y, width, height] = numbers.map(Math.round);
  if (width < 1 || height < 1) return null;
  return { x, y, width, height, maximized: raw.maximized === true };
}

// ───────────────────────────── files ─────────────────────────────

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** How Windows answers when another program (antivirus, search indexer, an editor) has the file open right now. */
const SHARING_ERRORS: ReadonlySet<string | undefined> = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_DELAYS_MS: readonly number[] = [20, 50, 100, 200, 400];

/**
 * Runs `action`, and again after each of the given pauses while it fails because the file
 * is in use. Such locks last milliseconds; any other error is passed on at once.
 */
export async function retryWhileInUse<T>(action: () => Promise<T>, delaysMs: readonly number[] = RETRY_DELAYS_MS): Promise<T> {
  for (const delay of delaysMs) {
    try {
      return await action();
    } catch (error) {
      if (!SHARING_ERRORS.has(errorCode(error))) throw error;
      await sleep(delay);
    }
  }
  return action();
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // One fixed name is enough (writes are queued, the app is single-instance) and a leftover from a crash is simply overwritten.
  const temp = `${path}.tmp`;
  try {
    // flush: the content has to be on the disk before the rename makes it the real file.
    await writeFile(temp, text, { encoding: 'utf8', flush: true });
    await retryWhileInUse(() => rename(temp, path));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The parsed content of a JSON file, never an error: `value` is undefined when the file
 * is missing, unreadable, oversized or not JSON. `exists` is false only when there is no
 * such file at all.
 */
async function readJson(path: string): Promise<{ exists: boolean; value: unknown }> {
  try {
    const info = await stat(path);
    // Nothing this app writes is larger; a file beyond the limit is damaged and not worth the memory.
    if (!info.isFile() || info.size > MAX_TEXT_BYTES) return { exists: true, value: undefined };
    const text = await readFile(path, 'utf8');
    // Editors such as Notepad may add a byte-order mark, which JSON.parse refuses.
    const value: unknown = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
    return { exists: true, value };
  } catch (error) {
    return { exists: errorCode(error) !== 'ENOENT', value: undefined };
  }
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function withoutUndefined(patch: Partial<LocalSettings>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

// ───────────────────────────── the store ─────────────────────────────

interface StoredState {
  settings: LocalSettings;
  windowState: WindowState | null;
}

export class LocalStore {
  /** `<userData>/settings.json` */
  readonly settingsPath: string;
  private readonly reposDir: string;
  private readonly asideDir: string;
  /** Every write (and every read that must not overtake one) goes through here. */
  private readonly queue = new SerialQueue();
  /** What settings.json holds: read once, then replaced after every successful write. */
  private state: Promise<StoredState> | null = null;
  private settingsFileExists = false;

  /** `userDataDir` is Electron's `app.getPath('userData')`; nothing outside it is ever touched. */
  constructor(userDataDir: string) {
    this.settingsPath = join(userDataDir, 'settings.json');
    this.reposDir = join(userDataDir, 'repos');
    this.asideDir = join(userDataDir, 'aside');
  }

  /** The working folder (git clone) for a repository address. */
  repoDir(repoUrl: string): string {
    return join(this.reposDir, repoKey(repoUrl));
  }

  /** The aside file of a repository address. */
  asidePath(repoUrl: string): string {
    return join(this.asideDir, `${repoKey(repoUrl)}.json`);
  }

  /**
   * The settings, and whether this is the first start on this computer: true as long as
   * no settings file was found and none has been written.
   */
  async load(): Promise<{ settings: LocalSettings; firstRun: boolean }> {
    const { settings } = await this.current();
    return { settings, firstRun: !this.settingsFileExists };
  }

  async getSettings(): Promise<LocalSettings> {
    return (await this.current()).settings;
  }

  /**
   * Stores a partial update and returns the complete settings. The result goes through
   * normalizeSettings(), so an invalid value falls back to its default and pollSeconds is
   * clamped. Rejects when the file cannot be written; the settings then stay as they were.
   */
  async updateSettings(patch: Partial<LocalSettings>): Promise<LocalSettings> {
    const next = await this.change((state) => ({
      ...state,
      settings: normalizeSettings({ ...state.settings, ...withoutUndefined(patch) }),
    }));
    return next.settings;
  }

  /** The window position of the last run; null when there is none (or it was unreadable). */
  async getWindowState(): Promise<WindowState | null> {
    return (await this.current()).windowState;
  }

  async setWindowState(windowState: WindowState): Promise<void> {
    await this.change((state) => ({ ...state, windowState }));
  }

  /** The versions kept aside for a repository; [] when there are none or the file is garbage. */
  readAside(repoUrl: string): Promise<AsideItem[]> {
    // Queued like a write, so that a read never overtakes a write that was asked for before it.
    return this.queue.run(async () => {
      const { value } = await readJson(this.asidePath(repoUrl));
      if (!Array.isArray(value)) return [];
      const entries: readonly unknown[] = value;
      return entries.filter(isAsideItem).slice(0, MAX_ASIDE_ITEMS);
    });
  }

  writeAside(repoUrl: string, items: readonly AsideItem[]): Promise<void> {
    return this.queue.run(async () => {
      const text = toJson(items);
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new RangeError('The aside list is larger than 20 MB');
      await writeTextAtomic(this.asidePath(repoUrl), text);
    });
  }

  /** Resolves when every write asked for so far has reached the disk (or failed). Never rejects. */
  idle(): Promise<void> {
    return this.queue.idle();
  }

  private current(): Promise<StoredState> {
    this.state ??= this.readSettingsFile();
    return this.state;
  }

  private async readSettingsFile(): Promise<StoredState> {
    const file = await readJson(this.settingsPath);
    this.settingsFileExists = file.exists;
    const stored = isPlainObject(file.value) ? file.value : {};
    return { settings: normalizeSettings(stored), windowState: normalizeWindowState(stored.window) };
  }

  private change(apply: (state: StoredState) => StoredState): Promise<StoredState> {
    return this.queue.run(async () => {
      const next = apply(await this.current());
      await writeTextAtomic(this.settingsPath, toJson({ ...next.settings, window: next.windowState ?? undefined }));
      // Only now: what is remembered here is always what the file really holds.
      this.state = Promise.resolve(next);
      this.settingsFileExists = true;
      return next;
    });
  }
}
