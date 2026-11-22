/**
 * Application entry point of the main process: one window, the bridge, and the rules that
 * keep the renderer boxed in (no navigation, no new windows, no permissions).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, Notification, app, dialog, screen, session, shell } from 'electron';
import { CLOSE_REQUESTED_CHANNEL } from '@shared/api';
import { AppController, type Desktop, type GitLayer } from './appController';
import { CloseGuard } from './closeGuard';
import { createGitRunner, detectGit } from './git/gitRunner';
import { RepoService } from './git/repoService';
import { registerIpc } from './ipc';
import { LocalStore } from './localStore';
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, isAppUrl, restorableBounds } from './windowRules';

// Must happen before anything asks for the path: the end-to-end tests run every app
// instance on its own data folder.
const userDataOverride = process.env.TEAM_SCHEDULE_USER_DATA;
if (userDataOverride) app.setPath('userData', userDataOverride);
// A development run must never touch the data (or take the single-instance lock) of the installed app.
else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Team Schedule (dev)'));

/**
 * Date boxes are drawn by Chromium in the app's locale, which otherwise follows the Windows
 * display language — on an English Windows that means month/day/year, the opposite of what
 * the rest of the app (and an Israeli team) uses. Both app languages are day-first locales.
 * The locale can only be chosen before the app is ready, hence the synchronous read.
 */
function chooseLocale(): void {
  let language: unknown;
  try {
    const stored: unknown = JSON.parse(readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8').replace(/^﻿/, ''));
    if (typeof stored === 'object' && stored !== null && 'language' in stored) language = stored.language;
  } catch {
    // First start (or an unreadable file): fall back to the language of Windows.
  }
  if (language !== 'he' && language !== 'en') {
    language = /^(he|iw)\b/i.test(app.getPreferredSystemLanguages()[0] ?? '') ? 'he' : 'en';
  }
  app.commandLine.appendSwitch('lang', language === 'he' ? 'he' : 'en-GB');
}
chooseLocale();

// Only a development run takes its page from a server: the installed app must never be
// talked into loading another page (with the bridge attached) through an environment variable.
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const isDevelopment = Boolean(devServerUrl);
const rendererFile = join(__dirname, '../renderer/index.html');
const appUrl = devServerUrl ?? pathToFileURL(rendererFile).toString();
const iconFile = join(__dirname, '../../resources/icon.png');

let mainWindow: BrowserWindow | null = null;
let closeGuard: CloseGuard | null = null;
/** False until the page has loaded (and again after a crash): nobody is there to answer a close request. */
let rendererAlive = false;

function focusMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const desktop: Desktop = {
  appVersion: () => app.getVersion(),
  systemLocale: () => app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
  documentsDir: () => app.getPath('documents'),

  async showSaveDialog(options) {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return null;
    const result = await dialog.showSaveDialog(win, {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  },

  async showOpenDialog(options) {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(win, {
      title: options.title,
      defaultPath: options.defaultPath === '' ? undefined : options.defaultPath,
      filters: options.filters,
      properties: ['openFile'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  },

  openPath: (path) => shell.openPath(path),
  openExternal: (url) => shell.openExternal(url),

  notify(title, body) {
    const win = mainWindow;
    if (!win || win.isDestroyed() || win.isFocused()) return;
    if (Notification.isSupported()) {
      const notification = new Notification({ title, body, icon: existsSync(iconFile) ? iconFile : undefined });
      notification.on('click', focusMainWindow);
      notification.show();
    }
    win.flashFrame(true);
    win.once('focus', () => {
      if (!win.isDestroyed()) win.flashFrame(false);
    });
  },

  acknowledgeCloseRequest: () => closeGuard?.acknowledge(),

  closeWindow() {
    closeGuard?.approve();
    const win = mainWindow;
    if (win && !win.isDestroyed()) win.close();
  },
};

const gitLayer: GitLayer = {
  detectGit,
  createGitRunner,
  connect: (git, params) => RepoService.connect(git, params),
  open: (git, dir, url, branch) => RepoService.open(git, dir, url, branch),
};

/** The renderer shows only the app's own page: no links out, no pop-ups, no embedded pages, no permissions. */
function lockDownWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url, appUrl)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

async function createMainWindow(store: LocalStore): Promise<BrowserWindow> {
  const saved = await store.getWindowState();
  const bounds = restorableBounds(
    saved,
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const win = new BrowserWindow({
    ...(bounds ?? DEFAULT_WINDOW_SIZE),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    title: 'Team Schedule',
    backgroundColor: '#f3f5f9',
    show: false,
    icon: existsSync(iconFile) ? iconFile : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  if (saved?.maximized && bounds) win.maximize();
  win.once('ready-to-show', () => win.show());

  const guard = new CloseGuard({
    ask() {
      if (!rendererAlive || win.isDestroyed() || win.webContents.isDestroyed()) return false;
      win.webContents.send(CLOSE_REQUESTED_CHANNEL);
      return true;
    },
    force() {
      if (!win.isDestroyed()) win.close();
    },
  });
  closeGuard = guard;

  win.webContents.on('did-finish-load', () => {
    rendererAlive = true;
  });
  win.webContents.on('did-start-loading', () => {
    rendererAlive = false;
  });
  win.webContents.on('render-process-gone', () => {
    rendererAlive = false;
  });

  win.on('close', (event) => {
    if (!guard.allowClose()) {
      event.preventDefault();
      return;
    }
    const normal = win.getNormalBounds();
    void store.setWindowState({ ...normal, maximized: win.isMaximized() }).catch((error: unknown) => {
      console.error('The window position could not be saved:', error);
    });
  });
  win.on('closed', () => {
    guard.dispose();
    if (closeGuard === guard) closeGuard = null;
    if (mainWindow === win) mainWindow = null;
  });

  if (isDevelopment || process.env.TEAM_SCHEDULE_DEVTOOLS === '1') {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      if (key === 'f12' || (input.control && input.shift && key === 'i')) {
        win.webContents.toggleDevTools();
        event.preventDefault();
      } else if (input.control && key === 'r') {
        win.webContents.reload();
        event.preventDefault();
      }
    });
  }

  if (devServerUrl) await win.loadURL(devServerUrl);
  else await win.loadFile(rendererFile);
  return win;
}

async function start(): Promise<void> {
  app.setAppUserModelId('com.teamschedule.app');
  Menu.setApplicationMenu(null);
  lockDownWebContents();

  const store = new LocalStore(app.getPath('userData'));
  const controller = new AppController({ store, desktop, git: gitLayer });
  registerIpc(controller, (event) => {
    const win = mainWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
    return isAppUrl(event.senderFrame?.url ?? '', appUrl);
  });

  app.on('second-instance', focusMainWindow);
  app.on('window-all-closed', () => {
    // Settings and git work that are still in flight finish before the process ends — except
    // a check for updates that is still waiting for the server after a moment: that one is
    // ended, or the closed app would stay alive (and could not be opened again) for as long
    // as git keeps waiting.
    void controller.shutdown().finally(() => app.quit());
  });

  mainWindow = await createMainWindow(store);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(start).catch((error: unknown) => {
    console.error('Team Schedule could not start:', error);
    dialog.showErrorBox('Team Schedule', error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
}
