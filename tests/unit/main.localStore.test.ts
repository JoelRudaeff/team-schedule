/**
 * Tests for src/main/localStore.ts with real files in a temp folder: defaults, tolerance
 * for damaged files, atomic and ordered writes, the window position, the aside lists and
 * the folder key of a repository.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLL_SECONDS, MAX_POLL_SECONDS, MIN_POLL_SECONDS, type LocalSettings } from '@shared/api';
import type { AsideItem } from '@shared/merge';
import {
  DEFAULT_SETTINGS,
  LocalStore,
  clampPollSeconds,
  normalizeSettings,
  normalizeWindowState,
  repoKey,
  retryWhileInUse,
} from '../../src/main/localStore';
import { MAX_ASIDE_ITEMS } from '../../src/main/validate';

const BOM = String.fromCharCode(0xfeff);
const URL_A = 'https://github.com/team/schedule.git';
const URL_B = 'https://gitlab.com/other/schedule.git';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'team-schedule-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function settingsFile(): string {
  return join(dir, 'settings.json');
}

async function readSettingsFile(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(settingsFile(), 'utf8'));
  return parsed as Record<string, unknown>;
}

/** Every file below the temp folder, relative, with forward slashes. */
async function allFiles(): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1).replaceAll('\\', '/'))
    .sort();
}

function aside(key: string, extra: Record<string, unknown> = {}): AsideItem {
  return { key, ...extra } as unknown as AsideItem;
}

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

// ───────────────────────────── reading ─────────────────────────────

describe('LocalStore: reading settings', () => {
  it('gives the defaults and firstRun when there is no file', async () => {
    const store = new LocalStore(dir);
    const { settings, firstRun } = await store.load();
    expect(firstRun).toBe(true);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings).toEqual({
      language: 'en',
      repoUrl: null,
      branch: null,
      userName: '',
      userEmail: '',
      gitPath: null,
      pollSeconds: DEFAULT_POLL_SECONDS,
      notifications: true,
    });
    expect(await store.getWindowState()).toBeNull();
  });

  it('does not create anything by reading', async () => {
    const store = new LocalStore(join(dir, 'not', 'there', 'yet'));
    await store.load();
    await store.getSettings();
    await store.getWindowState();
    await store.readAside(URL_A);
    expect(await readdir(dir)).toEqual([]);
  });

  it('stays firstRun over repeated reads', async () => {
    const store = new LocalStore(dir);
    expect((await store.load()).firstRun).toBe(true);
    expect((await store.load()).firstRun).toBe(true);
  });

  it('exposes the path of the settings file', () => {
    expect(new LocalStore(dir).settingsPath).toBe(settingsFile());
  });

  it('reads back what a file holds', async () => {
    const stored: LocalSettings = {
      language: 'he',
      repoUrl: URL_A,
      branch: 'main',
      userName: 'דנה כהן',
      userEmail: 'dana@example.com',
      gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
      pollSeconds: 120,
      notifications: false,
    };
    await writeFile(settingsFile(), JSON.stringify(stored), 'utf8');
    const { settings, firstRun } = await new LocalStore(dir).load();
    expect(firstRun).toBe(false);
    expect(settings).toEqual(stored);
  });

  it.each([
    ['garbage', 'this is not json {'],
    ['an empty file', ''],
    ['half a file', '{"language":"he","userNa'],
    ['a list', '[1,2,3]'],
    ['a text', '"hello"'],
    ['null', 'null'],
    ['a number', '42'],
  ])('gives the defaults for %s, and it is not a first run', async (_label, content) => {
    await writeFile(settingsFile(), content, 'utf8');
    const store = new LocalStore(dir);
    const { settings, firstRun } = await store.load();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(firstRun).toBe(false);
    expect(await store.getWindowState()).toBeNull();
  });

  it('gives the defaults when settings.json is a folder', async () => {
    await mkdir(settingsFile());
    const { settings, firstRun } = await new LocalStore(dir).load();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(firstRun).toBe(false);
  });

  it('reads a file that starts with a byte-order mark', async () => {
    await writeFile(settingsFile(), `${BOM}{"language":"he","pollSeconds":300,"window":{"x":1,"y":2,"width":900,"height":700}}`, 'utf8');
    const store = new LocalStore(dir);
    const { settings, firstRun } = await store.load();
    expect(firstRun).toBe(false);
    expect(settings.language).toBe('he');
    expect(settings.pollSeconds).toBe(300);
    expect(await store.getWindowState()).toEqual({ x: 1, y: 2, width: 900, height: 700, maximized: false });
  });

  it('falls back field by field: one wrong value does not cost the others', async () => {
    await writeFile(
      settingsFile(),
      JSON.stringify({
        language: 'fr',
        repoUrl: URL_A,
        branch: 42,
        userName: 'Dana',
        userEmail: ['dana@example.com'],
        gitPath: 'C:\\git\\git.exe',
        pollSeconds: '60',
        notifications: false,
        somethingElse: { nested: true },
      }),
      'utf8',
    );
    expect((await new LocalStore(dir).load()).settings).toEqual({
      language: 'en',
      repoUrl: URL_A,
      branch: null,
      userName: 'Dana',
      userEmail: '',
      gitPath: 'C:\\git\\git.exe',
      pollSeconds: DEFAULT_POLL_SECONDS,
      notifications: false,
    });
  });

  it('never hands out the frozen defaults object itself', async () => {
    const store = new LocalStore(dir);
    const settings = await store.getSettings();
    expect(settings).not.toBe(DEFAULT_SETTINGS);
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  });
});

describe('normalizeSettings', () => {
  it.each([[undefined], [null], [42], ['text'], [[]], [new Date()], [new Map()]])('gives the defaults for %s', (raw) => {
    expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('drops unknown keys', () => {
    expect(Object.keys(normalizeSettings({ extra: 1, window: { x: 1 }, language: 'he' })).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it.each([['he'], ['en']])('accepts the language %s', (language) => {
    expect(normalizeSettings({ language }).language).toBe(language);
  });

  it.each([['HE'], ['hebrew'], [''], [1], [null], [true]])('replaces the language %j by English', (language) => {
    expect(normalizeSettings({ language }).language).toBe('en');
  });

  it.each([
    [URL_A, URL_A],
    ['git@github.com:team/schedule.git', 'git@github.com:team/schedule.git'],
    ['\\\\server\\share\\schedule.git', '\\\\server\\share\\schedule.git'],
    [`  ${URL_A}  `, URL_A],
  ])('accepts the address %j', (repoUrl, expected) => {
    expect(normalizeSettings({ repoUrl }).repoUrl).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['--upload-pack=calc.exe'],
    ['ext::sh -c calc.exe'],
    ['https://x/y\nevil'],
    ['ftp://example.com/repo.git'],
    ['just words'],
    [`https://example.com/${'a'.repeat(2100)}`],
    [42],
    [null],
    [{ url: URL_A }],
  ])('refuses the address %j', (repoUrl) => {
    expect(normalizeSettings({ repoUrl }).repoUrl).toBeNull();
  });

  it.each([['main'], ['feature/2026-schedule'], ['לוח']])('accepts the branch %j', (branch) => {
    expect(normalizeSettings({ branch }).branch).toBe(branch);
  });

  it.each([[''], ['-delete'], ['a..b'], ['with space'], ['x.lock'], ['HEAD'], ['a'.repeat(300)], [7], [null]])(
    'refuses the branch %j',
    (branch) => {
      expect(normalizeSettings({ branch }).branch).toBeNull();
    },
  );

  it('makes one line of a name or an e-mail address', () => {
    const settings = normalizeSettings({ userName: '  Dana\tCohen\r\n', userEmail: ' dana@example.com\n' });
    expect(settings.userName).toBe('Dana Cohen');
    expect(settings.userEmail).toBe('dana@example.com');
  });

  it('refuses a name or an address that is too long, instead of cutting it', () => {
    expect(normalizeSettings({ userName: 'n'.repeat(200) }).userName).toBe('n'.repeat(200));
    expect(normalizeSettings({ userName: 'n'.repeat(201) }).userName).toBe('');
    expect(normalizeSettings({ userEmail: `${'e'.repeat(308)}@example.com` }).userEmail).toHaveLength(320);
    expect(normalizeSettings({ userEmail: `${'e'.repeat(309)}@example.com` }).userEmail).toBe('');
  });

  it.each([[''], ['   '], ['C:\\git\u0000\\git.exe'], ['C:\\git\n.exe'], ['x'.repeat(4097)], [5], [false], [undefined]])(
    'refuses the git path %j',
    (gitPath) => {
      expect(normalizeSettings({ gitPath }).gitPath).toBeNull();
    },
  );

  it('keeps a usable git path exactly as it is', () => {
    const gitPath = 'C:\\Program Files\\Git\\cmd\\git.exe';
    expect(normalizeSettings({ gitPath }).gitPath).toBe(gitPath);
  });

  it.each([
    [MIN_POLL_SECONDS, MIN_POLL_SECONDS],
    [MAX_POLL_SECONDS, MAX_POLL_SECONDS],
    [0, MIN_POLL_SECONDS],
    [-5, MIN_POLL_SECONDS],
    [14.4, MIN_POLL_SECONDS],
    [14.6, MIN_POLL_SECONDS],
    [59.5, 60],
    [60.4, 60],
    [3600.4, MAX_POLL_SECONDS],
    [1e12, MAX_POLL_SECONDS],
  ])('turns pollSeconds %d into %d', (stored, expected) => {
    expect(normalizeSettings({ pollSeconds: stored }).pollSeconds).toBe(expected);
    expect(clampPollSeconds(stored)).toBe(expected);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], ['60'], [null], [true], [[60]]])(
    'uses the default for pollSeconds %j',
    (stored) => {
      expect(normalizeSettings({ pollSeconds: stored }).pollSeconds).toBe(DEFAULT_POLL_SECONDS);
    },
  );

  it('has limits of 15 seconds and one hour, and a default inside them', () => {
    expect(MIN_POLL_SECONDS).toBe(15);
    expect(MAX_POLL_SECONDS).toBe(3600);
    expect(clampPollSeconds(DEFAULT_POLL_SECONDS)).toBe(DEFAULT_POLL_SECONDS);
  });

  it.each([['true'], [1], [0], [null]])('uses the default for notifications %j', (notifications) => {
    expect(normalizeSettings({ notifications }).notifications).toBe(true);
  });

  it('is stable: normalizing twice changes nothing', () => {
    const once = normalizeSettings({ language: 'he', repoUrl: ` ${URL_A} `, branch: 'main', userName: ' a\tb ', pollSeconds: 5 });
    expect(normalizeSettings(once)).toEqual(once);
  });
});

// ───────────────────────────── writing ─────────────────────────────

describe('LocalStore: updating settings', () => {
  it('returns the complete settings and stores them', async () => {
    const store = new LocalStore(dir);
    const settings = await store.updateSettings({ language: 'he', userName: 'Dana' });
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, language: 'he', userName: 'Dana' });
    expect(await store.getSettings()).toEqual(settings);
    expect(await new LocalStore(dir).getSettings()).toEqual(settings);
  });

  it('is no first run any more after the first write, in this store or a later one', async () => {
    const store = new LocalStore(dir);
    expect((await store.load()).firstRun).toBe(true);
    await store.updateSettings({});
    expect((await store.load()).firstRun).toBe(false);
    expect((await new LocalStore(dir).load()).firstRun).toBe(false);
  });

  it('stops being a first run when the window position is the first thing written', async () => {
    const store = new LocalStore(dir);
    await store.setWindowState({ x: 0, y: 0, width: 1200, height: 800, maximized: false });
    expect((await store.load()).firstRun).toBe(false);
  });

  it('writes even when nothing was loaded before', async () => {
    const store = new LocalStore(dir);
    await store.updateSettings({ notifications: false });
    expect((await readSettingsFile()).notifications).toBe(false);
  });

  it('creates the data folder when it does not exist yet', async () => {
    const nested = join(dir, 'a', 'b');
    const store = new LocalStore(nested);
    await store.updateSettings({ language: 'he' });
    expect((await new LocalStore(nested).getSettings()).language).toBe('he');
  });

  it('leaves complete JSON and no temp file behind after every update', async () => {
    const store = new LocalStore(dir);
    const steps: Array<Partial<LocalSettings>> = [
      { language: 'he' },
      { userName: 'דנה', userEmail: 'dana@example.com' },
      { repoUrl: URL_A, branch: 'main' },
      { pollSeconds: 300 },
      { notifications: false },
      { gitPath: 'C:\\git\\git.exe' },
    ];
    let expected: LocalSettings = { ...DEFAULT_SETTINGS };
    for (const step of steps) {
      expected = { ...expected, ...step };
      await store.updateSettings(step);
      const text = await readFile(settingsFile(), 'utf8');
      expect(text.endsWith('}\n')).toBe(true);
      expect(text.startsWith(BOM)).toBe(false);
      expect(JSON.parse(text)).toEqual(expected);
      expect(await allFiles()).toEqual(['settings.json']);
    }
  });

  it('overwrites a temp file left behind by a crash', async () => {
    await writeFile(`${settingsFile()}.tmp`, '{"half":', 'utf8');
    const store = new LocalStore(dir);
    await store.updateSettings({ language: 'he' });
    expect(await allFiles()).toEqual(['settings.json']);
    expect((await readSettingsFile()).language).toBe('he');
  });

  it('replaces a damaged file by a good one on the first update', async () => {
    await writeFile(settingsFile(), 'garbage', 'utf8');
    const store = new LocalStore(dir);
    await store.updateSettings({ userName: 'Dana' });
    expect(await readSettingsFile()).toEqual({ ...DEFAULT_SETTINGS, userName: 'Dana' });
  });

  it('ignores undefined in a patch', async () => {
    const store = new LocalStore(dir);
    await store.updateSettings({ language: 'he', userName: 'Dana', repoUrl: URL_A, branch: 'main', pollSeconds: 300, notifications: false });
    const after = await store.updateSettings({
      language: undefined,
      userName: undefined,
      repoUrl: undefined,
      branch: undefined,
      pollSeconds: undefined,
      notifications: undefined,
      gitPath: undefined,
      userEmail: 'dana@example.com',
    });
    expect(after).toEqual({
      ...DEFAULT_SETTINGS,
      language: 'he',
      userName: 'Dana',
      userEmail: 'dana@example.com',
      repoUrl: URL_A,
      branch: 'main',
      pollSeconds: 300,
      notifications: false,
    });
  });

  it('lets null reset what may be null', async () => {
    const store = new LocalStore(dir);
    await store.updateSettings({ repoUrl: URL_A, branch: 'main', gitPath: 'C:\\git\\git.exe' });
    const after = await store.updateSettings({ repoUrl: null, branch: null, gitPath: null });
    expect(after.repoUrl).toBeNull();
    expect(after.branch).toBeNull();
    expect(after.gitPath).toBeNull();
  });

  it('clamps pollSeconds and replaces invalid values by their defaults', async () => {
    const store = new LocalStore(dir);
    expect((await store.updateSettings({ pollSeconds: 1 })).pollSeconds).toBe(MIN_POLL_SECONDS);
    expect((await store.updateSettings({ pollSeconds: 99_999 })).pollSeconds).toBe(MAX_POLL_SECONDS);
    expect((await store.updateSettings({ pollSeconds: 44.5 })).pollSeconds).toBe(45);
    expect((await store.updateSettings({ pollSeconds: Number.NaN })).pollSeconds).toBe(DEFAULT_POLL_SECONDS);
    const odd = await store.updateSettings({ language: 'xx', repoUrl: '--evil', branch: '-x' } as unknown as Partial<LocalSettings>);
    expect(odd.language).toBe('en');
    expect(odd.repoUrl).toBeNull();
    expect(odd.branch).toBeNull();
    expect((await readSettingsFile()).pollSeconds).toBe(DEFAULT_POLL_SECONDS);
  });

  it('applies updates that were started together in the order they were asked for', async () => {
    const store = new LocalStore(dir);
    const results = await Promise.all(Array.from({ length: 40 }, (_unused, index) => store.updateSettings({ pollSeconds: 100 + index })));
    expect(results.map((settings) => settings.pollSeconds)).toEqual(Array.from({ length: 40 }, (_unused, index) => 100 + index));
    expect((await store.getSettings()).pollSeconds).toBe(139);
    expect((await readSettingsFile()).pollSeconds).toBe(139);
    expect(await allFiles()).toEqual(['settings.json']);
  });

  it('merges updates of different fields that were started together', async () => {
    const store = new LocalStore(dir);
    await Promise.all([
      store.updateSettings({ language: 'he' }),
      store.updateSettings({ userName: 'Dana' }),
      store.setWindowState({ x: 5, y: 6, width: 1100, height: 700, maximized: true }),
      store.updateSettings({ userEmail: 'dana@example.com' }),
      store.updateSettings({ notifications: false }),
    ]);
    const fresh = new LocalStore(dir);
    expect(await fresh.getSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      language: 'he',
      userName: 'Dana',
      userEmail: 'dana@example.com',
      notifications: false,
    });
    expect(await fresh.getWindowState()).toEqual({ x: 5, y: 6, width: 1100, height: 700, maximized: true });
  });

  it('rejects and keeps the old settings when the file cannot be written', async () => {
    const store = new LocalStore(dir);
    await store.updateSettings({ userName: 'Dana' });
    // A folder in the way of the temp file: writing it fails whatever the user's rights are.
    await mkdir(`${settingsFile()}.tmp`);
    await expect(store.updateSettings({ userName: 'Changed' })).rejects.toThrow();
    expect((await store.getSettings()).userName).toBe('Dana');
    expect((await readSettingsFile()).userName).toBe('Dana');
    // The store keeps working once the obstacle is gone.
    await rm(`${settingsFile()}.tmp`, { recursive: true, force: true });
    expect((await store.updateSettings({ language: 'he' })).userName).toBe('Dana');
    expect(await readSettingsFile()).toMatchObject({ userName: 'Dana', language: 'he' });
  });

  it('stays a first run when the very first write fails', async () => {
    const store = new LocalStore(dir);
    await mkdir(`${settingsFile()}.tmp`);
    await expect(store.updateSettings({ userName: 'Dana' })).rejects.toThrow();
    expect((await store.load()).firstRun).toBe(true);
  });

  it('idle() resolves after pending writes, also failed ones', async () => {
    const store = new LocalStore(dir);
    await mkdir(`${settingsFile()}.tmp`);
    const failing = store.updateSettings({ userName: 'Dana' });
    failing.catch(() => undefined);
    await expect(store.idle()).resolves.toBeUndefined();
    await rm(`${settingsFile()}.tmp`, { recursive: true, force: true });
    void store.updateSettings({ userName: 'Dana' });
    await store.idle();
    expect((await readSettingsFile()).userName).toBe('Dana');
  });
});

// ───────────────────────────── window position ─────────────────────────────

describe('LocalStore: window position', () => {
  it('round-trips through the file', async () => {
    const state = { x: -1800, y: 40, width: 1360, height: 860, maximized: true };
    const store = new LocalStore(dir);
    await store.setWindowState(state);
    expect(await store.getWindowState()).toEqual(state);
    expect(await new LocalStore(dir).getWindowState()).toEqual(state);
    expect((await readSettingsFile()).window).toEqual(state);
  });

  it('does not disturb the settings, nor the settings it', async () => {
    const store = new LocalStore(dir);
    await store.updateSettings({ language: 'he', userName: 'Dana' });
    await store.setWindowState({ x: 1, y: 2, width: 1100, height: 700, maximized: false });
    await store.updateSettings({ pollSeconds: 30 });
    const fresh = new LocalStore(dir);
    expect(await fresh.getSettings()).toEqual({ ...DEFAULT_SETTINGS, language: 'he', userName: 'Dana', pollSeconds: 30 });
    expect(await fresh.getWindowState()).toEqual({ x: 1, y: 2, width: 1100, height: 700, maximized: false });
  });

  it('writes no "window" entry while there is no position', async () => {
    const store = new LocalStore(dir);
    await store.updateSettings({ language: 'he' });
    expect('window' in (await readSettingsFile())).toBe(false);
  });

  it.each([
    ['a text', '"100,100"'],
    ['null', 'null'],
    ['a list', '[0,0,800,600]'],
    ['a missing number', '{"x":0,"y":0,"width":800}'],
    ['numbers as text', '{"x":"0","y":"0","width":"800","height":"600"}'],
    ['zero width', '{"x":0,"y":0,"width":0,"height":600}'],
    ['negative height', '{"x":0,"y":0,"width":800,"height":-600}'],
    ['a huge exponent (Infinity after parsing)', '{"x":0,"y":0,"width":1e999,"height":600}'],
  ])('ignores a stored position that is %s, keeping the settings', async (_label, windowJson) => {
    await writeFile(settingsFile(), `{"language":"he","window":${windowJson}}`, 'utf8');
    const store = new LocalStore(dir);
    expect(await store.getWindowState()).toBeNull();
    expect((await store.getSettings()).language).toBe('he');
  });
});

describe('normalizeWindowState', () => {
  it('accepts four numbers and rounds them', () => {
    expect(normalizeWindowState({ x: 10.4, y: -20.6, width: 800.5, height: 600.2 })).toEqual({
      x: 10,
      y: -21,
      width: 801,
      height: 600,
      maximized: false,
    });
  });

  it('takes maximized only from a real true', () => {
    const rect = { x: 0, y: 0, width: 800, height: 600 };
    expect(normalizeWindowState({ ...rect, maximized: true })?.maximized).toBe(true);
    for (const maximized of [false, 'true', 1, null, undefined]) {
      expect(normalizeWindowState({ ...rect, maximized })?.maximized).toBe(false);
    }
  });

  it('drops unknown keys', () => {
    expect(normalizeWindowState({ x: 0, y: 0, width: 800, height: 600, display: 2 })).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      maximized: false,
    });
  });

  it.each([
    [undefined],
    [null],
    ['x'],
    [[1, 2, 3, 4]],
    [{}],
    [{ x: 0, y: 0, width: 800 }],
    [{ x: Number.NaN, y: 0, width: 800, height: 600 }],
    [{ x: 0, y: Number.POSITIVE_INFINITY, width: 800, height: 600 }],
    [{ x: 0, y: 0, width: 0, height: 600 }],
    [{ x: 0, y: 0, width: 800, height: 0.4 }],
    [{ x: 0, y: 0, width: -800, height: 600 }],
    [{ x: null, y: 0, width: 800, height: 600 }],
  ])('rejects %j', (raw) => {
    expect(normalizeWindowState(raw)).toBeNull();
  });
});

// ───────────────────────────── aside lists ─────────────────────────────

describe('LocalStore: versions kept aside', () => {
  it('gives an empty list when there is no file', async () => {
    expect(await new LocalStore(dir).readAside(URL_A)).toEqual([]);
  });

  it('round-trips a list unchanged, in order', async () => {
    const items = [
      aside('2026-11-22/ev1', { mine: { title: 'שיעור חשבון', day: 0, start: 510 }, theirs: null, at: 1_795_000_000_000 }),
      aside('2026-11-22/ev2', { mine: null, theirs: { title: 'Physics "lab"\n2' } }),
      aside('config'),
    ];
    const store = new LocalStore(dir);
    await store.writeAside(URL_A, items);
    expect(await store.readAside(URL_A)).toEqual(items);
    expect(await new LocalStore(dir).readAside(URL_A)).toEqual(items);
  });

  it('stores the list as complete JSON under aside/<key>.json and leaves no temp file', async () => {
    const store = new LocalStore(dir);
    await store.writeAside(URL_A, [aside('a')]);
    expect(await allFiles()).toEqual([`aside/${repoKey(URL_A)}.json`]);
    expect(store.asidePath(URL_A)).toBe(join(dir, 'aside', `${repoKey(URL_A)}.json`));
    const text = await readFile(store.asidePath(URL_A), 'utf8');
    expect(JSON.parse(text)).toEqual([{ key: 'a' }]);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('does not make a first run stop being one', async () => {
    const store = new LocalStore(dir);
    await store.writeAside(URL_A, [aside('a')]);
    expect((await store.load()).firstRun).toBe(true);
  });

  it('keeps one list per repository, also for two repositories of the same name', async () => {
    const store = new LocalStore(dir);
    await store.writeAside(URL_A, [aside('from-a')]);
    await store.writeAside(URL_B, [aside('from-b'), aside('from-b-2')]);
    expect(await store.readAside(URL_A)).toEqual([{ key: 'from-a' }]);
    expect(await store.readAside(URL_B)).toEqual([{ key: 'from-b' }, { key: 'from-b-2' }]);
    expect(await store.readAside('https://example.com/third.git')).toEqual([]);
  });

  it('replaces the list on every write; an empty list empties it', async () => {
    const store = new LocalStore(dir);
    await store.writeAside(URL_A, [aside('a'), aside('b')]);
    await store.writeAside(URL_A, [aside('c')]);
    expect(await store.readAside(URL_A)).toEqual([{ key: 'c' }]);
    await store.writeAside(URL_A, []);
    expect(await store.readAside(URL_A)).toEqual([]);
  });

  it.each([
    ['garbage', 'not json at all'],
    ['an empty file', ''],
    ['half a list', '[{"key":"a"},{"ke'],
    ['an object', '{"key":"a"}'],
    ['a text', '"list"'],
    ['null', 'null'],
  ])('gives an empty list for %s', async (_label, content) => {
    const store = new LocalStore(dir);
    await mkdir(dirname(store.asidePath(URL_A)), { recursive: true });
    await writeFile(store.asidePath(URL_A), content, 'utf8');
    expect(await store.readAside(URL_A)).toEqual([]);
  });

  it('reads a list that starts with a byte-order mark', async () => {
    const store = new LocalStore(dir);
    await mkdir(dirname(store.asidePath(URL_A)), { recursive: true });
    await writeFile(store.asidePath(URL_A), `${BOM}[{"key":"a"}]`, 'utf8');
    expect(await store.readAside(URL_A)).toEqual([{ key: 'a' }]);
  });

  it('keeps the usable entries of a partly damaged list', async () => {
    const store = new LocalStore(dir);
    await mkdir(dirname(store.asidePath(URL_A)), { recursive: true });
    await writeFile(
      store.asidePath(URL_A),
      JSON.stringify([{ key: 'good-1' }, null, 'text', 7, [], {}, { key: '' }, { key: 5 }, { nokey: true }, { key: 'good-2', mine: 1 }]),
      'utf8',
    );
    expect(await store.readAside(URL_A)).toEqual([{ key: 'good-1' }, { key: 'good-2', mine: 1 }]);
  });

  it('reads at most the allowed number of entries: the first ones', async () => {
    const store = new LocalStore(dir);
    const many = Array.from({ length: MAX_ASIDE_ITEMS + 25 }, (_unused, index) => ({ key: `k${index}` }));
    await mkdir(dirname(store.asidePath(URL_A)), { recursive: true });
    await writeFile(store.asidePath(URL_A), JSON.stringify(many), 'utf8');
    const read = await store.readAside(URL_A);
    expect(read).toHaveLength(MAX_ASIDE_ITEMS);
    expect(read[0]).toEqual({ key: 'k0' });
    expect(read.at(-1)).toEqual({ key: `k${MAX_ASIDE_ITEMS - 1}` });
  });

  it('never lets a read overtake a write that was asked for before it', async () => {
    const store = new LocalStore(dir);
    const order: string[] = [];
    const write1 = store.writeAside(URL_A, [aside('first')]).then(() => order.push('w1'));
    const read1 = store.readAside(URL_A);
    const write2 = store.writeAside(URL_A, [aside('second')]).then(() => order.push('w2'));
    const read2 = store.readAside(URL_A);
    expect(await read1).toEqual([{ key: 'first' }]);
    expect(await read2).toEqual([{ key: 'second' }]);
    await Promise.all([write1, write2]);
    expect(order).toEqual(['w1', 'w2']);
  });

  it('refuses a list of more than 20 MB and keeps the old one', async () => {
    const store = new LocalStore(dir);
    await store.writeAside(URL_A, [aside('kept')]);
    const huge = [aside('huge', { mine: 'x'.repeat(21 * 1024 * 1024) })];
    await expect(store.writeAside(URL_A, huge)).rejects.toBeInstanceOf(RangeError);
    expect(await store.readAside(URL_A)).toEqual([{ key: 'kept' }]);
    expect(await allFiles()).toEqual([`aside/${repoKey(URL_A)}.json`]);
  });
});

// ───────────────────────────── repository key ─────────────────────────────

describe('repoKey', () => {
  const KEY = /^[A-Za-z0-9._-]{1,40}-[0-9a-f]{10}$/;

  it('is the display name plus ten hex characters of the address hash', () => {
    expect(repoKey(URL_A)).toMatch(/^schedule-[0-9a-f]{10}$/);
  });

  it('never changes for an address (existing clones depend on it)', () => {
    // SHA-1 of the exact address, first 10 hex characters.
    expect(repoKey('https://github.com/team/schedule.git')).toBe(repoKey('https://github.com/team/schedule.git'));
    expect(repoKey('abc')).toBe('abc-a9993e3647');
    expect(repoKey('')).toBe('repo-da39a3ee5e');
  });

  it('gives two addresses with the same display name different keys', () => {
    const keys = [
      repoKey(URL_A),
      repoKey(URL_B),
      repoKey('git@github.com:team/schedule.git'),
      repoKey('\\\\server\\share\\schedule.git'),
      repoKey('https://github.com/team/schedule'),
      repoKey('https://github.com/team/schedule.git/'),
      repoKey('https://github.com/team/Schedule.git'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys.slice(0, 6)) expect(key).toMatch(/^schedule-[0-9a-f]{10}$/);
  });

  it('gives keys that differ in more than letter case (Windows folders ignore case)', () => {
    const lower = repoKey('https://github.com/team/schedule.git');
    const upper = repoKey('https://github.com/team/Schedule.git');
    expect(lower.toLowerCase()).not.toBe(upper.toLowerCase());
  });

  it('falls back to "repo" when nothing of the name is left (Hebrew)', () => {
    const key = repoKey('\\\\server\\שיתוף\\מערכת שעות.git');
    expect(key).toMatch(/^repo-[0-9a-f]{10}$/);
    expect(repoKey('\\\\server\\שיתוף\\לוח אחר.git')).toMatch(/^repo-[0-9a-f]{10}$/);
    expect(repoKey('\\\\server\\שיתוף\\לוח אחר.git')).not.toBe(key);
  });

  it('drops spaces and other odd characters from the name', () => {
    expect(repoKey('C:\\Team Files\\My Schedule (2026)!.git')).toMatch(/^MySchedule2026-[0-9a-f]{10}$/);
    expect(repoKey('https://example.com/team/sche%20dule$.git')).toMatch(/^sche20dule-[0-9a-f]{10}$/);
    expect(repoKey('https://example.com/a/לוח-2026.git')).toMatch(/^-2026-[0-9a-f]{10}$/);
  });

  it('cuts a very long name to 40 characters', () => {
    const key = repoKey(`https://example.com/team/${'x'.repeat(300)}.git`);
    expect(key).toMatch(new RegExp(`^x{40}-[0-9a-f]{10}$`));
    expect(key).toHaveLength(51);
  });

  it.each([
    [URL_A],
    ['git@github.com:team/schedule.git'],
    ['ssh://git@example.com:2222/team/schedule.git'],
    ['file:///C:/repos/schedule.git'],
    ['C:\\repos\\schedule.git'],
    ['\\\\server\\share\\schedule.git'],
    ['//server/share/מערכת.git'],
    ['https://example.com/a/b/c:d*e?f"g<h>i|j.git'],
    ['https://example.com/'],
    ['/'],
    ['   '],
    [`https://example.com/${'long/'.repeat(300)}repo.git`],
  ])('is a plain, safe file name for %j', (url) => {
    const key = repoKey(url);
    expect(key).toMatch(KEY);
    expect(basename(join('base', key))).toBe(key);
  });

  it('is never a name that leaves the folder or that Windows cannot create', () => {
    for (const url of ['https://example.com/..', 'https://example.com/.', 'https://example.com/con.git', 'C:\\x\\nul']) {
      const key = repoKey(url);
      expect(key).toMatch(KEY);
      expect(key).not.toBe('..');
      expect(key.endsWith('.')).toBe(false);
      expect(key).toMatch(/-[0-9a-f]{10}$/);
    }
  });

  it('places the clone and the aside file of a repository under the data folder', () => {
    const store = new LocalStore(dir);
    expect(store.repoDir(URL_A)).toBe(join(dir, 'repos', repoKey(URL_A)));
    expect(store.asidePath(URL_A)).toBe(join(dir, 'aside', `${repoKey(URL_A)}.json`));
    expect(store.repoDir(URL_A)).not.toBe(store.repoDir(URL_B));
    const odd = store.repoDir('https://example.com/../../..');
    expect(dirname(odd)).toBe(join(dir, 'repos'));
  });
});

// ───────────────────────────── retry ─────────────────────────────

describe('retryWhileInUse', () => {
  it('returns the result of a first success without waiting', async () => {
    let calls = 0;
    const result = await retryWhileInUse(async () => {
      calls++;
      return 'done';
    }, [1000, 1000]);
    expect(result).toBe('done');
    expect(calls).toBe(1);
  });

  it.each([['EPERM'], ['EACCES'], ['EBUSY']])('tries again while the file is in use (%s)', async (code) => {
    let calls = 0;
    const result = await retryWhileInUse(async () => {
      calls++;
      if (calls < 3) throw fsError(code);
      return calls;
    }, [1, 1, 1]);
    expect(result).toBe(3);
  });

  it('passes any other error on at once', async () => {
    let calls = 0;
    await expect(
      retryWhileInUse(async () => {
        calls++;
        throw fsError('ENOSPC');
      }, [1, 1, 1]),
    ).rejects.toThrow('ENOSPC');
    expect(calls).toBe(1);
    await expect(
      retryWhileInUse(async () => {
        throw new Error('no code at all');
      }, [1]),
    ).rejects.toThrow('no code at all');
  });

  it('gives up with the last error after one try per pause plus a final one', async () => {
    let calls = 0;
    await expect(
      retryWhileInUse(async () => {
        calls++;
        throw fsError('EBUSY');
      }, [1, 1, 1]),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls).toBe(4);
  });

  it('tries exactly once when there are no pauses', async () => {
    let calls = 0;
    await expect(
      retryWhileInUse(async () => {
        calls++;
        throw fsError('EBUSY');
      }, []),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls).toBe(1);
  });
});
