/**
 * Run-time checks for everything the renderer sends over the bridge.
 *
 * The renderer is sandboxed and runs only our own bundle, but the main process still
 * treats its messages as untrusted: the arguments of every IPC call go through
 * parseApiArgs() before they reach git, the file system or the shell. Each `parse…`
 * function returns a fresh, correctly typed value or throws InvalidArgumentError (the IPC
 * call is then rejected).
 *
 * Mistakes a user can make in a form (a bad address, an empty name) are NOT rejected
 * here: the controller answers those with an error value, as the bridge contract asks.
 * The helpers in the last section exist for that.
 *
 * No Electron imports, so this file is unit-tested directly (tests/unit/main.validate.test.ts).
 */
import type {
  ApiInvokeMethod,
  ApplyUpdateRequest,
  ConnectRequest,
  FileFilter,
  LocalSettings,
  OpenFileRequest,
  PublishRequest,
  SaveFileRequest,
  ScheduleApi,
} from '@shared/api';
import { isValidIsoDate } from '@shared/dates';
import type { AsideItem } from '@shared/merge';
import { isDataPath } from '@shared/paths';
import { CONFIG_PATH, type FileMap, type IsoDate } from '@shared/types';

/** Upper bound for one complete set of data files and for one exported text file. */
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;
export const MAX_ASIDE_ITEMS = 5000;
export const MAX_REPO_URL_LENGTH = 2048;
export const MAX_BRANCH_LENGTH = 250;
export const MAX_NAME_LENGTH = 200;
export const MAX_EMAIL_LENGTH = 320;
export const MAX_PATH_LENGTH = 4096;

const MAX_COMMIT_MESSAGE_LENGTH = 20_000;
const MAX_DIALOG_TITLE_LENGTH = 200;
const MAX_FILE_NAME_LENGTH = 120;
const MAX_FILTERS = 10;
const MAX_EXTENSIONS_PER_FILTER = 10;
const MAX_NOTIFICATION_TITLE_LENGTH = 120;
const MAX_NOTIFICATION_BODY_LENGTH = 500;
const MAX_EXTERNAL_URL_LENGTH = 2048;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RUNS = /[\u0000-\u001f\u007f]+/g;
/** Full object name as git prints it (SHA-1 or SHA-256 repositories). */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** `ics`, `json`, `week.json`, or `*` for "all files". */
const FILTER_EXTENSION = /^(?:\*|[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)$/;

export class InvalidArgumentError extends TypeError {
  constructor(message: string) {
    super(`Invalid argument: ${message}`);
    this.name = 'InvalidArgumentError';
  }
}

function fail(message: string): never {
  throw new InvalidArgumentError(message);
}

// ───────────────────────────── building blocks ─────────────────────────────

/**
 * True for `{…}` objects only. Dates, Maps, class instances and arrays also survive the
 * trip over IPC, and none of them is ever a valid argument.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  return isPlainObject(value) ? value : fail(`${name} must be an object`);
}

function asString(value: unknown, name: string, maxLength = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string') return fail(`${name} must be text`);
  if (value.length > maxLength) return fail(`${name} is longer than ${maxLength} characters`);
  return value;
}

function asBoolean(value: unknown, name: string): boolean {
  return typeof value === 'boolean' ? value : fail(`${name} must be true or false`);
}

function asArray(value: unknown, name: string, maxLength: number): unknown[] {
  if (!Array.isArray(value)) return fail(`${name} must be a list`);
  if (value.length > maxLength) return fail(`${name} has more than ${maxLength} entries`);
  return value;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function hasControlChars(text: string): boolean {
  return CONTROL_CHARS.test(text);
}

/** One-line form of a typed value: control characters (tabs, pasted line breaks) become spaces. */
export function cleanLine(text: string): string {
  return text.replace(CONTROL_CHAR_RUNS, ' ').trim();
}

/**
 * The longest head of `text` that fits into `maxLength` UTF-16 units without splitting an
 * emoji or other surrogate pair in half. Stops reading at the limit, however long the text is.
 */
function head(text: string, maxLength: number): string {
  let kept = '';
  for (const symbol of text) {
    if (kept.length + symbol.length > maxLength) break;
    kept += symbol;
  }
  return kept;
}

function clip(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${head(text, maxLength - 1)}…`;
}

// ───────────────────────────── settings and connection ─────────────────────────────

/**
 * Checks the types of a settings patch and keeps only what may be changed this way.
 * Dropped: unknown keys; `repoUrl` and `branch`, which only change through connectRepo;
 * and a `gitPath` other than null — "find git automatically" may be asked for here, but
 * a program to run is only ever taken from the file dialog of chooseGitExecutable.
 */
export function parseSettingsPatch(value: unknown): Partial<LocalSettings> {
  const input = asObject(value, 'settings');
  const patch: Partial<LocalSettings> = {};
  if (input.language !== undefined) {
    patch.language = input.language === 'en' || input.language === 'he' ? input.language : fail('language must be "en" or "he"');
  }
  if (input.userName !== undefined) patch.userName = asString(input.userName, 'userName', MAX_NAME_LENGTH);
  if (input.userEmail !== undefined) patch.userEmail = asString(input.userEmail, 'userEmail', MAX_EMAIL_LENGTH);
  if (input.gitPath === null) patch.gitPath = null;
  else if (input.gitPath !== undefined && typeof input.gitPath !== 'string') fail('gitPath must be text or null');
  if (input.pollSeconds !== undefined) {
    patch.pollSeconds =
      typeof input.pollSeconds === 'number' && Number.isFinite(input.pollSeconds)
        ? input.pollSeconds
        : fail('pollSeconds must be a number');
  }
  if (input.notifications !== undefined) patch.notifications = asBoolean(input.notifications, 'notifications');
  return patch;
}

/** Types only: what the user typed is judged by the controller, which answers with an error value. */
export function parseConnectRequest(value: unknown): ConnectRequest {
  const input = asObject(value, 'connect request');
  return {
    url: asString(input.url, 'url'),
    branch: input.branch === null ? null : asString(input.branch, 'branch'),
    userName: asString(input.userName, 'userName'),
    userEmail: asString(input.userEmail, 'userEmail'),
    ...(input.createBranch === undefined ? {} : { createBranch: asBoolean(input.createBranch, 'createBranch') }),
  };
}

/** `C:\…`, `C:/…`, `\\server\share`, `/…`, or git's own spelling of a network folder, `%(prefix)///server/share/…`. */
const FULL_FOLDER_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]|%\(prefix\)\/)/;

/**
 * A folder for git's `safe.directory`. It becomes a command-line argument, so it must not
 * look like an option; and it must name exactly one folder by its full path: `*` (or a
 * trailing `/*`) would switch git's ownership check off for every folder (below it), and
 * no real folder name on Windows contains a `*` anyway.
 */
export function parseTrustPath(value: unknown): string {
  const path = asString(value, 'path', MAX_PATH_LENGTH);
  if (path.trim() === '' || path.startsWith('-') || hasControlChars(path)) return fail('path is not a folder name');
  if (path.includes('*')) return fail('path must name one folder');
  if (!FULL_FOLDER_PATH.test(path)) return fail('path must be a full path');
  return path;
}

// ───────────────────────────── schedule data ─────────────────────────────

/** Only schedule.json and weeks/<date>.json may ever be written, and never more than 20 MB in total. */
export function parseFileMap(value: unknown): FileMap {
  const input = asObject(value, 'files');
  const files: FileMap = {};
  let total = 0;
  for (const [path, text] of Object.entries(input)) {
    if (!isDataPath(path)) return fail(`files: "${clip(cleanLine(path), 80)}" is not a schedule file`);
    if (typeof text !== 'string') return fail(`files: the content of ${path} must be text`);
    total += utf8Bytes(text);
    if (total > MAX_TEXT_BYTES) return fail('files: more than 20 MB');
    files[path] = text;
  }
  return files;
}

/**
 * The file set of something that gets published. Publishing replaces ALL data files, so a
 * set without schedule.json would delete the team's schedule; no feature of the app does
 * that, and a mistake of that size is refused instead of pushed.
 */
function parsePublishedFiles(value: unknown): FileMap {
  const files = parseFileMap(value);
  return Object.hasOwn(files, CONFIG_PATH) ? files : fail(`files: ${CONFIG_PATH} is missing`);
}

function parseSha(value: unknown, name: string): string {
  const sha = asString(value, name, 64);
  return SHA.test(sha) ? sha : fail(`${name} must be a commit id`);
}

function parseCommitMessage(value: unknown): string {
  const message = asString(value, 'message', MAX_COMMIT_MESSAGE_LENGTH);
  // git refuses an empty message, and a NUL cannot be passed on a command line at all.
  if (message.trim() === '' || message.includes('\u0000')) return fail('message must be readable text');
  return message;
}

export function parseCreateScheduleRequest(value: unknown): { files: FileMap; message: string } {
  const input = asObject(value, 'request');
  return { files: parsePublishedFiles(input.files), message: parseCommitMessage(input.message) };
}

export function parsePublishRequest(value: unknown): PublishRequest {
  const input = asObject(value, 'request');
  return {
    files: parsePublishedFiles(input.files),
    message: parseCommitMessage(input.message),
    expectedRemoteSha: input.expectedRemoteSha === null ? null : parseSha(input.expectedRemoteSha, 'expectedRemoteSha'),
  };
}

export function parseApplyUpdateRequest(value: unknown): ApplyUpdateRequest {
  const input = asObject(value, 'request');
  return { files: parseFileMap(input.files), expectedRemoteSha: parseSha(input.expectedRemoteSha, 'expectedRemoteSha') };
}

export function parseFetchOptions(value: unknown): { interactive: boolean } {
  const input = asObject(value, 'options');
  return { interactive: asBoolean(input.interactive, 'interactive') };
}

export function parseWeekStart(value: unknown): IsoDate {
  return isValidIsoDate(value) ? value : fail('weekStart must be a date (YYYY-MM-DD)');
}

/**
 * The shape every stored aside entry must have. The values inside (`mine`, `theirs`) are
 * the renderer's own data and come back to it unchanged, so they are not inspected.
 */
export function isAsideItem(value: unknown): value is AsideItem {
  return isPlainObject(value) && typeof value.key === 'string' && value.key !== '';
}

export function parseAsideItems(value: unknown): AsideItem[] {
  return asArray(value, 'aside list', MAX_ASIDE_ITEMS).map((item: unknown, index) =>
    isAsideItem(item) ? item : fail(`aside entry ${index} must be an object with a key`),
  );
}

// ───────────────────────────── files, shell, notifications ─────────────────────────────

function parseFilters(value: unknown): FileFilter[] {
  return asArray(value, 'filters', MAX_FILTERS).map((entry: unknown) => {
    const filter = asObject(entry, 'filter');
    const extensions = asArray(filter.extensions, 'filter extensions', MAX_EXTENSIONS_PER_FILTER).map((extension: unknown) => {
      const text = asString(extension, 'filter extension', 20);
      return FILTER_EXTENSION.test(text) ? text : fail('filter extension must be letters and digits');
    });
    if (extensions.length === 0) return fail('filter needs at least one extension');
    return { name: cleanLine(asString(filter.name, 'filter name', 100)), extensions };
  });
}

export function parseSaveFileRequest(value: unknown): SaveFileRequest {
  const input = asObject(value, 'request');
  const content = asString(input.content, 'content', MAX_TEXT_BYTES);
  if (utf8Bytes(content) > MAX_TEXT_BYTES) return fail('content: more than 20 MB');
  return {
    title: cleanLine(asString(input.title, 'title', MAX_DIALOG_TITLE_LENGTH)),
    defaultName: asString(input.defaultName, 'defaultName', 1024),
    filters: parseFilters(input.filters),
    content,
  };
}

export function parseOpenFileRequest(value: unknown): OpenFileRequest {
  const input = asObject(value, 'request');
  return {
    title: cleanLine(asString(input.title, 'title', MAX_DIALOG_TITLE_LENGTH)),
    filters: parseFilters(input.filters),
  };
}

/**
 * Control characters other than tab and line breaks. Windows builds a notification from
 * XML, where these characters cannot be written at all: one of them and nothing is shown.
 */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE_RUNS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g;

/** Over-long texts are shortened instead of rejected: a clipped notification beats none. */
export function parseNotifyRequest(value: unknown): { title: string; body: string } {
  const input = asObject(value, 'notification');
  // Cut roughly before cleaning, so that a text of any size costs the same little work.
  const title = asString(input.title, 'title').slice(0, 4 * MAX_NOTIFICATION_TITLE_LENGTH);
  const body = asString(input.body, 'body').slice(0, 4 * MAX_NOTIFICATION_BODY_LENGTH);
  return {
    title: clip(cleanLine(title), MAX_NOTIFICATION_TITLE_LENGTH),
    body: clip(body.replace(UNPRINTABLE_RUNS, ' ').trim(), MAX_NOTIFICATION_BODY_LENGTH),
  };
}

/** Windows device names: a file called `con` or `nul.txt` cannot be created. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/**
 * Not allowed in Windows file names, plus the invisible direction marks that can make
 * `…exe.ics` read like something else in a right-to-left name.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_NAME_CHARS = /[\u0000-\u001f\u007f<>:"|?*\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Reduces a suggested file name to a plain name that Windows accepts: no folders, no
 * reserved characters, no trailing dots or spaces, at most 120 characters (the extension
 * survives the cut). Hebrew and other letters are kept. `fallback` is used when nothing is left.
 */
export function sanitizeFileName(name: string, fallback: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? '';
  const cleaned = leaf
    // Tabs and line breaks separate words: they become a space instead of gluing the words together.
    .replace(/[\t\n\r\f\v]+/g, ' ')
    .replace(UNSAFE_FILE_NAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trimStart();
  if (cleaned === '') return fallback;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
  const stem = cleaned.slice(0, cleaned.length - extension.length);
  // Cutting can expose a dot or a space at the end again; Windows would silently drop it.
  const shortened = `${head(stem, MAX_FILE_NAME_LENGTH - extension.length).trimEnd()}${extension}`.replace(/[. ]+$/, '');
  if (shortened === '') return fallback;
  return DEVICE_NAME.test(shortened.split('.')[0].trim()) ? `_${shortened}` : shortened;
}

/** The normalized address when `value` is an https:// link, otherwise null (nothing else is ever opened). */
export function toHttpsUrl(value: string): string | null {
  if (value.length > MAX_EXTERNAL_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' && url.hostname !== '' ? url.href : null;
}

// ───────────────────────────── one call ─────────────────────────────

/** The argument list of every bridge method, as the renderer is supposed to send it. */
export type ApiArgs = { [M in ApiInvokeMethod]: Parameters<ScheduleApi[M]> };

/** Arguments beyond the ones a method takes are ignored, like JavaScript itself does. */
const noArguments = (): [] => [];

/** Typed per method, so the compiler refuses a bridge method that has no check for its arguments. */
const ARGUMENT_PARSERS: { [M in ApiInvokeMethod]: (raw: readonly unknown[]) => ApiArgs[M] } = {
  boot: noArguments,
  saveSettings: (raw) => [parseSettingsPatch(raw[0])],
  detectGit: noArguments,
  chooseGitExecutable: noArguments,
  connectRepo: (raw) => [parseConnectRequest(raw[0])],
  trustRepoPath: (raw) => [parseTrustPath(raw[0])],
  createSchedule: (raw) => [parseCreateScheduleRequest(raw[0])],
  loadSnapshot: noArguments,
  loadRemote: noArguments,
  writeWorking: (raw) => [parseFileMap(raw[0])],
  fetch: (raw) => [parseFetchOptions(raw[0])],
  applyUpdate: (raw) => [parseApplyUpdateRequest(raw[0])],
  publish: (raw) => [parsePublishRequest(raw[0])],
  discardLocal: noArguments,
  blame: (raw) => [parseWeekStart(raw[0])],
  getAside: noArguments,
  setAside: (raw) => [parseAsideItems(raw[0])],
  saveTextFile: (raw) => [parseSaveFileRequest(raw[0])],
  openTextFile: (raw) => [parseOpenFileRequest(raw[0])],
  // Whether the path may be opened / the link is https is decided by the controller, which answers "no" as a value.
  openSavedFile: (raw) => [asString(raw[0], 'path', MAX_PATH_LENGTH)],
  openRepoFolder: noArguments,
  openExternal: (raw) => [asString(raw[0], 'url')],
  notify: (raw) => [parseNotifyRequest(raw[0])],
  ackCloseRequest: noArguments,
  closeWindow: noArguments,
};

/** Checks the raw arguments of one IPC call and returns them typed, or throws InvalidArgumentError. */
export function parseApiArgs<M extends ApiInvokeMethod>(method: M, raw: readonly unknown[]): ApiArgs[M] {
  // hasOwn: a name such as "constructor" must not find something on the table's prototype.
  if (!Object.hasOwn(ARGUMENT_PARSERS, method)) fail(`Unknown bridge method: ${String(method)}`);
  return ARGUMENT_PARSERS[method](raw);
}

// ───────────────────────────── what the user typed ─────────────────────────────

/**
 * git's rules for a branch name (git-check-ref-format), plus "must not start with a
 * dash" because the name is passed to git on the command line.
 */
export function isValidBranchName(name: string): boolean {
  if (name === '' || name.length > MAX_BRANCH_LENGTH || name === '@' || name === 'HEAD') return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * Why git could not record changes under this identity, or null when it can. git itself
 * strips punctuation from both ends of a name and refuses what is left when that is nothing.
 */
export function describeIdentityProblem(userName: string, userEmail: string): string | null {
  if (userName.length > MAX_NAME_LENGTH || !/[^\s.,:;<>"\\']/.test(userName)) {
    return 'A name is required: it is recorded with every change you publish';
  }
  if (userEmail.length > MAX_EMAIL_LENGTH || !/^[^\s@<>]+@[^\s@<>]+$/.test(userEmail)) {
    return 'A valid e-mail address is required (for example name@example.com)';
  }
  return null;
}
