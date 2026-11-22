/**
 * Tests for src/main/validate.ts: everything the renderer sends over the bridge is
 * checked here before it reaches git, the file system or the shell.
 */
import { describe, expect, it } from 'vitest';
import { API_INVOKE_METHODS, type ApiInvokeMethod } from '@shared/api';
import { CONFIG_PATH } from '@shared/types';
import {
  InvalidArgumentError,
  MAX_ASIDE_ITEMS,
  MAX_TEXT_BYTES,
  cleanLine,
  describeIdentityProblem,
  hasControlChars,
  isAsideItem,
  isPlainObject,
  isValidBranchName,
  parseApiArgs,
  parseApplyUpdateRequest,
  parseAsideItems,
  parseConnectRequest,
  parseCreateScheduleRequest,
  parseFetchOptions,
  parseFileMap,
  parseNotifyRequest,
  parseOpenFileRequest,
  parsePublishRequest,
  parseSaveFileRequest,
  parseSettingsPatch,
  parseTrustPath,
  parseWeekStart,
  sanitizeFileName,
  toHttpsUrl,
} from '../../src/main/validate';

const WEEK = 'weeks/2026-11-22.json';
const SHA1 = '0123456789abcdef0123456789abcdef01234567';
const SHA256 = `${SHA1}${'89abcdef'.repeat(3)}`;
const FILES = { [CONFIG_PATH]: '{"version":1}\n', [WEEK]: '{"events":[]}\n' };
const ICS_FILTER = { name: 'Calendar', extensions: ['ics'] };

class Custom {
  url = 'x';
}

/** Values that are objects for `typeof` but never a valid argument object. */
const NOT_OBJECTS: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['a text', 'text'],
  ['a number', 5],
  ['true', true],
  ['a list', []],
  ['a date', new Date(0)],
  ['a map', new Map()],
  ['a class instance', new Custom()],
  ['a function', () => ({})],
];

function rejects(action: () => unknown): void {
  expect(action).toThrow(InvalidArgumentError);
}

/** An object whose own key is literally `__proto__`, as JSON (and IPC) can deliver it. */
function withProtoKey(value: unknown): Record<string, unknown> {
  return JSON.parse(`{"__proto__":${JSON.stringify(value)}}`) as Record<string, unknown>;
}

// ───────────────────────────── building blocks ─────────────────────────────

describe('InvalidArgumentError', () => {
  it('is a TypeError with a recognisable name and message', () => {
    const error = new InvalidArgumentError('x must be text');
    expect(error).toBeInstanceOf(TypeError);
    expect(error.name).toBe('InvalidArgumentError');
    expect(error.message).toBe('Invalid argument: x must be text');
  });
});

describe('isPlainObject', () => {
  it('accepts literal objects and objects without a prototype', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(JSON.parse('{"a":1}'))).toBe(true);
  });

  it.each(NOT_OBJECTS)('rejects %s', (_label, value) => {
    expect(isPlainObject(value)).toBe(false);
  });

  it('rejects an object that inherits from another object', () => {
    expect(isPlainObject(Object.create({ inherited: true }))).toBe(false);
  });
});

describe('hasControlChars / cleanLine', () => {
  it('finds control characters, and nothing else', () => {
    for (const text of ['a\u0000b', 'a\tb', 'a\nb', 'a\rb', '\u001f', 'a\u007f']) expect(hasControlChars(text)).toBe(true);
    for (const text of ['', 'plain', 'שלום עולם', 'a b', 'emoji 🙂', 'C:\\x\\y']) expect(hasControlChars(text)).toBe(false);
  });

  it('gives the same answer every time (no state between calls)', () => {
    expect(hasControlChars('a\nb')).toBe(true);
    expect(hasControlChars('a\nb')).toBe(true);
    expect(hasControlChars('ab')).toBe(false);
    expect(hasControlChars('a\nb')).toBe(true);
  });

  it('makes one trimmed line, a run of control characters becoming one space', () => {
    expect(cleanLine('  Dana \t Cohen\r\n')).toBe('Dana   Cohen');
    expect(cleanLine('a\r\n\tb')).toBe('a b');
    expect(cleanLine('\n\n')).toBe('');
    expect(cleanLine('שלום\u0000עולם')).toBe('שלום עולם');
    expect(cleanLine('a\nb')).toBe('a b');
    expect(cleanLine('a\nb')).toBe('a b');
  });
});

// ───────────────────────────── settings and connection ─────────────────────────────

describe('parseSettingsPatch', () => {
  it('accepts a complete, correct patch', () => {
    expect(
      parseSettingsPatch({ language: 'he', userName: 'דנה', userEmail: 'dana@example.com', gitPath: null, pollSeconds: 120, notifications: false }),
    ).toEqual({ language: 'he', userName: 'דנה', userEmail: 'dana@example.com', gitPath: null, pollSeconds: 120, notifications: false });
  });

  it('accepts an empty patch and returns a new object', () => {
    const input = {};
    const patch = parseSettingsPatch(input);
    expect(patch).toEqual({});
    expect(patch).not.toBe(input);
  });

  it('drops repoUrl, branch and unknown keys', () => {
    const patch = parseSettingsPatch({ repoUrl: 'https://evil.example/x.git', branch: 'evil', admin: true, language: 'en' });
    expect(patch).toEqual({ language: 'en' });
    expect(Object.keys(patch)).toEqual(['language']);
  });

  it('drops a git path other than null: a program to run never comes from the renderer', () => {
    const patch = parseSettingsPatch({ gitPath: 'C:\\Windows\\System32\\calc.exe' });
    expect(patch).toEqual({});
    expect('gitPath' in patch).toBe(false);
  });

  it('leaves range checks to the store: any finite number passes', () => {
    expect(parseSettingsPatch({ pollSeconds: -3 }).pollSeconds).toBe(-3);
    expect(parseSettingsPatch({ pollSeconds: 1e9 }).pollSeconds).toBe(1e9);
  });

  it('treats undefined like "not given"', () => {
    expect(parseSettingsPatch({ language: undefined, userName: undefined, gitPath: undefined, pollSeconds: undefined })).toEqual({});
  });

  it('does not take values from the prototype chain of a __proto__ key', () => {
    const patch = parseSettingsPatch(withProtoKey({ language: 'he' }));
    expect(patch).toEqual({});
    expect(patch.language).toBeUndefined();
  });

  it.each(NOT_OBJECTS)('rejects %s', (_label, value) => {
    rejects(() => parseSettingsPatch(value));
  });

  it.each([
    ['language', 'fr'],
    ['language', 'HE'],
    ['language', 1],
    ['language', null],
    ['userName', 5],
    ['userName', null],
    ['userName', ['Dana']],
    ['userName', 'n'.repeat(201)],
    ['userEmail', {}],
    ['userEmail', 'e'.repeat(321)],
    ['gitPath', 5],
    ['gitPath', false],
    ['gitPath', {}],
    ['pollSeconds', '60'],
    ['pollSeconds', Number.NaN],
    ['pollSeconds', Number.POSITIVE_INFINITY],
    ['pollSeconds', null],
    ['notifications', 'true'],
    ['notifications', 1],
    ['notifications', null],
  ])('rejects %s = %j', (key, value) => {
    rejects(() => parseSettingsPatch({ [key]: value }));
  });

  it('accepts a name and an address of exactly the longest length', () => {
    expect(parseSettingsPatch({ userName: 'n'.repeat(200) }).userName).toHaveLength(200);
    expect(parseSettingsPatch({ userEmail: 'e'.repeat(320) }).userEmail).toHaveLength(320);
  });
});

describe('parseConnectRequest', () => {
  const good = { url: 'https://github.com/team/schedule.git', branch: 'main', userName: 'Dana', userEmail: 'dana@example.com' };

  it('accepts a correct request and returns a new object with just the four fields', () => {
    const parsed = parseConnectRequest({ ...good, extra: 'ignored' });
    expect(parsed).toEqual(good);
    expect(Object.keys(parsed).sort()).toEqual(['branch', 'url', 'userEmail', 'userName']);
  });

  it('accepts "no branch"', () => {
    expect(parseConnectRequest({ ...good, branch: null }).branch).toBeNull();
  });

  it('judges types only: what the user typed wrong is passed on to the controller', () => {
    const typed = { url: '--evil', branch: '..', userName: '', userEmail: 'nope' };
    expect(parseConnectRequest(typed)).toEqual(typed);
  });

  it.each(NOT_OBJECTS)('rejects %s', (_label, value) => {
    rejects(() => parseConnectRequest(value));
  });

  it.each([
    ['url', undefined],
    ['url', null],
    ['url', 5],
    ['url', ['https://x/y']],
    ['branch', undefined],
    ['branch', 5],
    ['branch', false],
    ['userName', undefined],
    ['userName', null],
    ['userName', {}],
    ['userEmail', undefined],
    ['userEmail', 0],
  ])('rejects %s = %j', (key, value) => {
    rejects(() => parseConnectRequest({ ...good, [key]: value }));
  });
});

describe('parseTrustPath', () => {
  it.each([
    ['C:/Users/dana/AppData/Roaming/team-schedule/repos/schedule-0123456789'],
    ['C:\\Users\\dana\\repo'],
    ['%(prefix)///server/share/repo.git'],
    ['//server/share/מערכת שעות.git'],
    ['\\\\server\\share\\repo.git'],
    ['/home/dana/repo'],
    [`C:/${'x'.repeat(4093)}`],
  ])('accepts %j unchanged', (path) => {
    expect(parseTrustPath(path)).toBe(path);
  });

  it.each([
    ['nothing', ''],
    ['blanks', '   '],
    ['an option', '--global'],
    ['a short option', '-c'],
    ['every folder', '*'],
    ['every folder below one', 'C:/Users/*'],
    ['every folder below one, written the Windows way', 'C:\\Users\\*'],
    ['every folder below the root', '/*'],
    ['a pattern in the middle', 'C:/Users/*/repo'],
    ['a folder without its full path', 'repo'],
    ['a relative path', 'repos/schedule'],
    ['a drive without a folder', 'C:'],
    ['a line break', 'C:/repo\n--system'],
    ['a NUL', 'C:/repo\u0000'],
    ['a tab', 'C:/re\tpo'],
    ['an over-long path', `C:/${'x'.repeat(4094)}`],
  ])('rejects %s', (_label, path) => {
    rejects(() => parseTrustPath(path));
  });

  it.each([[undefined], [null], [5], [['C:/repo']], [{ path: 'C:/repo' }]])('rejects the non-text %j', (value) => {
    rejects(() => parseTrustPath(value));
  });
});

// ───────────────────────────── schedule data ─────────────────────────────

describe('parseFileMap', () => {
  it('accepts schedule.json and week files, as a new object', () => {
    const parsed = parseFileMap(FILES);
    expect(parsed).toEqual(FILES);
    expect(parsed).not.toBe(FILES);
  });

  it('accepts an empty set, empty files and Hebrew content', () => {
    expect(parseFileMap({})).toEqual({});
    expect(parseFileMap({ [WEEK]: '' })).toEqual({ [WEEK]: '' });
    expect(parseFileMap({ [WEEK]: '{"title":"שבוע ראשון"}' })[WEEK]).toBe('{"title":"שבוע ראשון"}');
  });

  it('accepts many week files', () => {
    const many: Record<string, string> = {};
    for (let day = 1; day <= 28; day++) for (let month = 1; month <= 12; month++) many[`weeks/2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}.json`] = '{}';
    expect(Object.keys(parseFileMap(many))).toHaveLength(336);
  });

  it.each([
    ['../x.json'],
    ['weeks/../schedule.json'],
    ['README.md'],
    ['.git/config'],
    ['.gitattributes'],
    ['/schedule.json'],
    ['./schedule.json'],
    ['schedule.json/'],
    ['Schedule.json'],
    ['schedule.JSON'],
    ['schedule.json '],
    [' schedule.json'],
    ['schedule.json\n'],
    ['schedule.json\u0000.exe'],
    ['C:\\Windows\\schedule.json'],
    ['C:/schedule.json'],
    ['weeks\\2026-11-22.json'],
    ['weeks/2026-11-22.json\n'],
    ['weeks/2026-11-22.json/..'],
    ['weeks//2026-11-22.json'],
    ['Weeks/2026-11-22.json'],
    ['weeks/2026-11-22.JSON'],
    ['weeks/2026-11-22.json.exe'],
    ['weeks/2026-11-22'],
    ['weeks/2026-13-01.json'],
    ['weeks/2026-02-30.json'],
    ['weeks/2026-1-1.json'],
    ['weeks/x/2026-11-22.json'],
    ['weeks/../weeks/2026-11-22.json'],
    ['other/2026-11-22.json'],
    ['weeks/'],
    [''],
    ['constructor'],
    ['toString'],
    ['hasOwnProperty'],
  ])('rejects the path %j', (path) => {
    rejects(() => parseFileMap({ [path]: '{}' }));
    rejects(() => parseFileMap({ ...FILES, [path]: '{}' }));
  });

  it('rejects an own __proto__ key and leaves no trace of it', () => {
    rejects(() => parseFileMap(withProtoKey('{}')));
    rejects(() => parseFileMap(withProtoKey({ 'schedule.json': 'x' })));
    expect(({} as Record<string, unknown>)['schedule.json']).toBeUndefined();
  });

  it('shows a bad path in the message as one clipped line', () => {
    const path = `evil\n${'x'.repeat(500)}`;
    let message = '';
    try {
      parseFileMap({ [path]: '' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('evil x');
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThan(200);
  });

  it.each([[5], [null], [undefined], [{ nested: 'x' }], [['x']], [true]])('rejects the content %j', (content) => {
    rejects(() => parseFileMap({ [WEEK]: content }));
  });

  it.each(NOT_OBJECTS)('rejects %s', (_label, value) => {
    rejects(() => parseFileMap(value));
  });

  it('accepts exactly 20 MB in total and rejects one byte more', () => {
    const half = 'x'.repeat(MAX_TEXT_BYTES / 2);
    expect(Object.keys(parseFileMap({ [CONFIG_PATH]: half, [WEEK]: half }))).toHaveLength(2);
    rejects(() => parseFileMap({ [CONFIG_PATH]: half, [WEEK]: `${half}x` }));
    rejects(() => parseFileMap({ [CONFIG_PATH]: half, [WEEK]: half, 'weeks/2026-11-29.json': 'x' }));
  });

  it('counts bytes, not characters', () => {
    // 6 million Hebrew letters are 12 MB as UTF-8; twice that is over the limit.
    const hebrew = 'א'.repeat(6_000_000);
    expect(parseFileMap({ [WEEK]: hebrew })[WEEK]).toHaveLength(6_000_000);
    rejects(() => parseFileMap({ [CONFIG_PATH]: hebrew, [WEEK]: hebrew }));
  });
});

describe('parseCreateScheduleRequest', () => {
  it('accepts files with schedule.json and a message', () => {
    expect(parseCreateScheduleRequest({ files: FILES, message: 'Create the schedule', extra: 1 })).toEqual({
      files: FILES,
      message: 'Create the schedule',
    });
  });

  it('keeps a multi-line Hebrew message exactly', () => {
    const message = 'יצירת מערכת\n\nשורה שנייה\t!';
    expect(parseCreateScheduleRequest({ files: FILES, message }).message).toBe(message);
  });

  it('rejects a file set without schedule.json: publishing it would delete the schedule', () => {
    rejects(() => parseCreateScheduleRequest({ files: { [WEEK]: '{}' }, message: 'm' }));
    rejects(() => parseCreateScheduleRequest({ files: {}, message: 'm' }));
  });

  it('is not fooled by a schedule.json that is only inherited', () => {
    const inherited = Object.create(null) as Record<string, string>;
    inherited[WEEK] = '{}';
    rejects(() => parseCreateScheduleRequest({ files: inherited, message: 'm' }));
    rejects(() => parseCreateScheduleRequest({ files: withProtoKey({ [CONFIG_PATH]: '{}' }), message: 'm' }));
  });

  it('rejects bad files', () => {
    rejects(() => parseCreateScheduleRequest({ files: { ...FILES, 'README.md': 'x' }, message: 'm' }));
    rejects(() => parseCreateScheduleRequest({ files: null, message: 'm' }));
    rejects(() => parseCreateScheduleRequest({ message: 'm' }));
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 5],
    ['empty', ''],
    ['blank', ' \n\t '],
    ['with a NUL', 'Update\u0000--amend'],
    ['too long', 'm'.repeat(20_001)],
    ['a list', ['m']],
  ])('rejects a message that is %s', (_label, message) => {
    rejects(() => parseCreateScheduleRequest({ files: FILES, message }));
  });

  it('accepts a message of exactly the longest length', () => {
    expect(parseCreateScheduleRequest({ files: FILES, message: 'm'.repeat(20_000) }).message).toHaveLength(20_000);
  });

  it.each(NOT_OBJECTS)('rejects %s', (_label, value) => {
    rejects(() => parseCreateScheduleRequest(value));
  });
});

describe('parsePublishRequest', () => {
  const good = { files: FILES, message: 'Update week 12', expectedRemoteSha: SHA1 };

  it('accepts a correct request', () => {
    expect(parsePublishRequest({ ...good, force: true })).toEqual(good);
  });

  it('accepts "the remote is empty" and a SHA-256 commit id', () => {
    expect(parsePublishRequest({ ...good, expectedRemoteSha: null }).expectedRemoteSha).toBeNull();
    expect(parsePublishRequest({ ...good, expectedRemoteSha: SHA256 }).expectedRemoteSha).toBe(SHA256);
  });

  it.each([
    ['missing', undefined],
    ['a number', 5],
    ['empty', ''],
    ['too short', SHA1.slice(1)],
    ['too long', `${SHA1}0`],
    ['of a length between SHA-1 and SHA-256', SHA256.slice(0, 50)],
    ['longer than SHA-256', `${SHA256}0`],
    ['upper case', SHA1.toUpperCase()],
    ['not hex', `g${SHA1.slice(1)}`],
    ['a branch name', 'main'],
    ['an option', `--force${'0'.repeat(33)}`],
    ['followed by a line break', `${SHA1}\n`],
    ['padded', ` ${SHA1.slice(2)} `],
    ['a list', [SHA1]],
  ])('rejects a commit id that is %s', (_label, expectedRemoteSha) => {
    rejects(() => parsePublishRequest({ ...good, expectedRemoteSha }));
  });

  it('rejects files without schedule.json, bad files and bad messages', () => {
    rejects(() => parsePublishRequest({ ...good, files: { [WEEK]: '{}' } }));
    rejects(() => parsePublishRequest({ ...good, files: { ...FILES, '../x.json': '' } }));
    rejects(() => parsePublishRequest({ ...good, files: 'schedule.json' }));
    rejects(() => parsePublishRequest({ ...good, message: '' }));
    rejects(() => parsePublishRequest({ ...good, message: undefined }));
  });

  it.each(NOT_OBJECTS)('rejects %s', (_label, value) => {
    rejects(() => parsePublishRequest(value));
  });
});

describe('parseApplyUpdateRequest', () => {
  it('accepts a correct request', () => {
    expect(parseApplyUpdateRequest({ files: FILES, expectedRemoteSha: SHA1, message: 'ignored' })).toEqual({
      files: FILES,
      expectedRemoteSha: SHA1,
    });
  });

  it('accepts a file set without schedule.json (nothing is published here)', () => {
    expect(parseApplyUpdateRequest({ files: {}, expectedRemoteSha: SHA256 })).toEqual({ files: {}, expectedRemoteSha: SHA256 });
  });

  it('needs a commit id: null is not enough here', () => {
    rejects(() => parseApplyUpdateRequest({ files: FILES, expectedRemoteSha: null }));
    rejects(() => parseApplyUpdateRequest({ files: FILES }));
    rejects(() => parseApplyUpdateRequest({ files: FILES, expectedRemoteSha: 'HEAD' }));
    rejects(() => parseApplyUpdateRequest({ files: FILES, expectedRemoteSha: SHA1.toUpperCase() }));
  });

  it('rejects bad files', () => {
    rejects(() => parseApplyUpdateRequest({ files: { 'README.md': '' }, expectedRemoteSha: SHA1 }));
    rejects(() => parseApplyUpdateRequest({ files: { [WEEK]: 5 }, expectedRemoteSha: SHA1 }));
    rejects(() => parseApplyUpdateRequest({ expectedRemoteSha: SHA1 }));
  });

  it.each(NOT_OBJECTS)('rejects %s', (_label, value) => {
    rejects(() => parseApplyUpdateRequest(value));
  });
});

describe('parseFetchOptions', () => {
  it('accepts true and false', () => {
    expect(parseFetchOptions({ interactive: true })).toEqual({ interactive: true });
    expect(parseFetchOptions({ interactive: false, timeoutMs: 1 })).toEqual({ interactive: false });
  });

  it.each([[undefined], [null], ['true'], [1], [0], [{}]])('rejects interactive = %j', (interactive) => {
    rejects(() => parseFetchOptions({ interactive }));
  });

  it.each(NOT_OBJECTS)('rejects %s', (_label, value) => {
    rejects(() => parseFetchOptions(value));
  });
});

describe('parseWeekStart', () => {
  it('accepts a date', () => {
    expect(parseWeekStart('2026-11-22')).toBe('2026-11-22');
    expect(parseWeekStart('2028-02-29')).toBe('2028-02-29');
  });

  it.each([
    ['2026-13-01'],
    ['2026-02-30'],
    ['2026-00-10'],
    ['2026-11-00'],
    ['2026-1-5'],
    ['26-11-22'],
    ['2026/11/22'],
    ['22-11-2026'],
    ['2026-11-22T00:00:00Z'],
    ['2026-11-22\n'],
    [' 2026-11-22'],
    ['../../etc'],
    [''],
    [20261122],
    [null],
    [undefined],
    [new Date('2026-11-22')],
    [['2026-11-22']],
  ])('rejects %j', (value) => {
    rejects(() => parseWeekStart(value));
  });
});

describe('isAsideItem / parseAsideItems', () => {
  it('accepts objects with a non-empty key, whatever else they hold, without copying them', () => {
    const items = [{ key: 'a' }, { key: '2026-11-22/ev1', mine: { title: 'x' }, theirs: null, extra: [1, 2] }];
    const parsed = parseAsideItems(items);
    expect(parsed).toEqual(items);
    expect(parsed).not.toBe(items);
    expect(isAsideItem(items[1])).toBe(true);
  });

  it('accepts an empty list', () => {
    expect(parseAsideItems([])).toEqual([]);
  });

  it.each([[null], [undefined], ['a'], [5], [[]], [{}], [{ key: '' }], [{ key: 5 }], [{ key: null }], [{ Key: 'a' }], [new Custom()], [new Map([['key', 'a']])]])(
    'rejects the entry %j',
    (entry) => {
      expect(isAsideItem(entry)).toBe(false);
      rejects(() => parseAsideItems([entry]));
      rejects(() => parseAsideItems([{ key: 'good' }, entry, { key: 'good too' }]));
    },
  );

  it('rejects an entry whose key is only inherited through __proto__', () => {
    rejects(() => parseAsideItems([withProtoKey({ key: 'a' })]));
  });

  it('says which entry is wrong', () => {
    expect(() => parseAsideItems([{ key: 'a' }, { key: 'b' }, {}])).toThrow(/entry 2/);
  });

  it.each([[undefined], [null], ['[]'], [5], [{}], [{ length: 0 }], [{ 0: { key: 'a' }, length: 1 }]])('rejects %j instead of a list', (value) => {
    rejects(() => parseAsideItems(value));
  });

  it('accepts the largest allowed list and rejects one entry more', () => {
    const full = Array.from({ length: MAX_ASIDE_ITEMS }, (_unused, index) => ({ key: `k${index}` }));
    expect(parseAsideItems(full)).toHaveLength(MAX_ASIDE_ITEMS);
    rejects(() => parseAsideItems([...full, { key: 'one too many' }]));
  });

  it('checks the size before it looks at the entries', () => {
    const huge = new Array<unknown>(1_000_000).fill(null);
    expect(() => parseAsideItems(huge)).toThrow(/more than/);
  });
});

// ───────────────────────────── files, shell, notifications ─────────────────────────────

describe('parseSaveFileRequest', () => {
  const good = { title: 'Export to Outlook', defaultName: 'week-12.ics', filters: [ICS_FILTER], content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' };

  it('accepts a correct request', () => {
    expect(parseSaveFileRequest({ ...good, path: 'C:\\evil.exe' })).toEqual(good);
  });

  it('keeps the content byte for byte, also when it is empty', () => {
    const content = 'שורה\r\n\tline\u0000 2\n';
    expect(parseSaveFileRequest({ ...good, content }).content).toBe(content);
    expect(parseSaveFileRequest({ ...good, content: '' }).content).toBe('');
  });

  it('makes one line of the title and of filter names', () => {
    const parsed = parseSaveFileRequest({ ...good, title: ' Save\r\nas\t', filters: [{ name: ' Week\nfile ', extensions: ['week.json', 'json'] }] });
    expect(parsed.title).toBe('Save as');
    expect(parsed.filters).toEqual([{ name: 'Week file', extensions: ['week.json', 'json'] }]);
  });

  it('accepts "all files", no filters at all, and drops unknown filter keys', () => {
    expect(parseSaveFileRequest({ ...good, filters: [] }).filters).toEqual([]);
    expect(parseSaveFileRequest({ ...good, filters: [{ name: 'All', extensions: ['*'], secret: 1 }] }).filters).toEqual([
      { name: 'All', extensions: ['*'] },
    ]);
  });

  it('passes the suggested name on as typed (the controller reduces it to a safe name)', () => {
    expect(parseSaveFileRequest({ ...good, defaultName: '..\\..\\con.ics' }).defaultName).toBe('..\\..\\con.ics');
  });

  it.each([
    ['title', undefined],
    ['title', 5],
    ['title', 't'.repeat(201)],
    ['defaultName', undefined],
    ['defaultName', null],
    ['defaultName', 'n'.repeat(1025)],
    ['content', undefined],
    ['content', null],
    ['content', 5],
    ['content', ['text']],
    ['content', Buffer.from('x')],
    ['filters', undefined],
    ['filters', null],
    ['filters', 'ics'],
    ['filters', { name: 'x', extensions: ['ics'] }],
    ['filters', Array.from({ length: 11 }, () => ICS_FILTER)],
    ['filters', [null]],
    ['filters', ['ics']],
    ['filters', [{ name: 'x' }]],
    ['filters', [{ name: 'x', extensions: 'ics' }]],
    ['filters', [{ name: 'x', extensions: [] }]],
    ['filters', [{ name: 5, extensions: ['ics'] }]],
    ['filters', [{ extensions: ['ics'] }]],
    ['filters', [{ name: 'n'.repeat(101), extensions: ['ics'] }]],
    ['filters', [{ name: 'x', extensions: [5] }]],
    ['filters', [{ name: 'x', extensions: [''] }]],
    ['filters', [{ name: 'x', extensions: ['.ics'] }]],
    ['filters', [{ name: 'x', extensions: ['*.ics'] }]],
    ['filters', [{ name: 'x', extensions: ['ics;exe'] }]],
    ['filters', [{ name: 'x', extensions: ['i cs'] }]],
    ['filters', [{ name: 'x', extensions: ['ics\n'] }]],
    ['filters', [{ name: 'x', extensions: ['../x'] }]],
    ['filters', [{ name: 'x', extensions: ['week..json'] }]],
    ['filters', [{ name: 'x', extensions: ['json.'] }]],
    ['filters', [{ name: 'x', extensions: ['a'.repeat(21)] }]],
    ['filters', [{ name: 'x', extensions: Array.from({ length: 11 }, () => 'ics') }]],
    ['filters', [ICS_FILTER, { name: 'bad', extensions: ['**'] }]],
  ])('rejects %s = %j', (key, value) => {
    rejects(() => parseSaveFileRequest({ ...good, [key]: value }));
  });

  it('accepts the largest numbers of filters and extensions', () => {
    const filters = Array.from({ length: 10 }, () => ({ name: 'x', extensions: Array.from({ length: 10 }, () => 'ics') }));
    expect(parseSaveFileRequest({ ...good, filters }).filters).toHaveLength(10);
    expect(parseSaveFileRequest({ ...good, title: 't'.repeat(200), defaultName: 'n'.repeat(1024) }).title).toHaveLength(200);
  });

  it('accepts content of exactly 20 MB and rejects more, counted in bytes', () => {
    expect(parseSaveFileRequest({ ...good, content: 'x'.repeat(MAX_TEXT_BYTES) }).content).toHaveLength(MAX_TEXT_BYTES);
    rejects(() => parseSaveFileRequest({ ...good, content: 'x'.repeat(MAX_TEXT_BYTES + 1) }));
    // 11 million Hebrew letters: fewer characters than the limit, but 22 MB as UTF-8.
    rejects(() => parseSaveFileRequest({ ...good, content: 'א'.repeat(11_000_000) }));
  });

  it.each(NOT_OBJECTS)('rejects %s', (_label, value) => {
    rejects(() => parseSaveFileRequest(value));
  });
});

describe('parseOpenFileRequest', () => {
  it('accepts a correct request and returns just title and filters', () => {
    expect(parseOpenFileRequest({ title: ' Load a\nweek ', filters: [{ name: 'Week', extensions: ['json'] }], defaultPath: 'C:\\' })).toEqual({
      title: 'Load a week',
      filters: [{ name: 'Week', extensions: ['json'] }],
    });
  });

  it.each([
    ['title', undefined],
    ['title', null],
    ['title', 't'.repeat(201)],
    ['filters', undefined],
    ['filters', {}],
    ['filters', [{ name: 'x', extensions: [] }]],
    ['filters', [{ name: 'x', extensions: ['e x e'] }]],
    ['filters', Array.from({ length: 11 }, () => ICS_FILTER)],
  ])('rejects %s = %j', (key, value) => {
    rejects(() => parseOpenFileRequest({ title: 'Open', filters: [ICS_FILTER], [key]: value }));
  });

  it.each(NOT_OBJECTS)('rejects %s', (_label, value) => {
    rejects(() => parseOpenFileRequest(value));
  });
});

describe('parseNotifyRequest', () => {
  it('accepts a normal notification unchanged', () => {
    expect(parseNotifyRequest({ title: 'עדכון חדש', body: 'Dana published 3 changes', icon: 'x' })).toEqual({
      title: 'עדכון חדש',
      body: 'Dana published 3 changes',
    });
  });

  it('makes one line of the title', () => {
    expect(parseNotifyRequest({ title: ' New\r\nupdate\u0007 ', body: '' }).title).toBe('New update');
  });

  it('keeps tabs and line breaks in the body but no other control characters', () => {
    expect(parseNotifyRequest({ title: 't', body: ' line 1\n\tline 2\r\nbell\u0007\u0000\u001b[31m end\u007f ' }).body).toBe(
      'line 1\n\tline 2\r\nbell [31m end',
    );
  });

  it('shortens an over-long title to 120 and a body to 500 characters, ending in an ellipsis', () => {
    const parsed = parseNotifyRequest({ title: 't'.repeat(121), body: 'b'.repeat(501) });
    expect(parsed.title).toBe(`${'t'.repeat(119)}…`);
    expect(parsed.body).toBe(`${'b'.repeat(499)}…`);
  });

  it('leaves texts of exactly the longest length alone', () => {
    const parsed = parseNotifyRequest({ title: 't'.repeat(120), body: 'b'.repeat(500) });
    expect(parsed.title).toBe('t'.repeat(120));
    expect(parsed.body).toBe('b'.repeat(500));
  });

  it('copes with enormous texts', () => {
    const parsed = parseNotifyRequest({ title: 't'.repeat(5_000_000), body: 'b'.repeat(5_000_000) });
    expect(parsed.title).toHaveLength(120);
    expect(parsed.body).toHaveLength(500);
  });

  it('never cuts an emoji in half', () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (let lead = 110; lead <= 122; lead++) {
      const parsed = parseNotifyRequest({ title: `${'t'.repeat(lead)}${'🙂'.repeat(300)}`, body: `${'b'.repeat(lead + 380)}${'🙂'.repeat(900)}` });
      expect(parsed.title).not.toMatch(lone);
      expect(parsed.body).not.toMatch(lone);
      expect(parsed.title.length).toBeLessThanOrEqual(120);
      expect(parsed.body.length).toBeLessThanOrEqual(500);
      expect(parsed.title.endsWith('…')).toBe(true);
      expect(parsed.body.endsWith('…')).toBe(true);
    }
  });

  it.each([
    [{ title: 5, body: 'b' }],
    [{ title: 't', body: null }],
    [{ title: 't' }],
    [{ body: 'b' }],
    [{ title: ['t'], body: 'b' }],
    [{}],
  ])('rejects %j', (value) => {
    rejects(() => parseNotifyRequest(value));
  });

  it.each(NOT_OBJECTS)('rejects %s', (_label, value) => {
    rejects(() => parseNotifyRequest(value));
  });
});

describe('sanitizeFileName', () => {
  it('keeps a plain name, Hebrew included', () => {
    expect(sanitizeFileName('week-12.ics', 'schedule')).toBe('week-12.ics');
    expect(sanitizeFileName('מערכת שעות - שבוע 3.ics', 'schedule')).toBe('מערכת שעות - שבוע 3.ics');
    expect(sanitizeFileName('2026-11-22.week.json', 'schedule')).toBe('2026-11-22.week.json');
  });

  it.each([
    ['..\\..\\Windows\\System32\\evil.ics', 'evil.ics'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\dana\\x.ics', 'x.ics'],
    ['a/b\\c/d.json', 'd.json'],
    ['\\\\server\\share\\x.ics', 'x.ics'],
  ])('keeps only the last part of the path %j', (name, expected) => {
    expect(sanitizeFileName(name, 'schedule')).toBe(expected);
  });

  it.each([[''], ['   '], ['.'], ['..'], ['...'], [' . . '], ['folder/'], ['folder\\'], ['a/..'], ['<>:"|?*'], ['\u0000\u001f'], ['\u202e\u200f'], ['\t\n']])(
    'uses the fallback when nothing is left of %j',
    (name) => {
      expect(sanitizeFileName(name, 'schedule')).toBe('schedule');
    },
  );

  it('removes the characters Windows does not allow in a name', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.ics', 'schedule')).toBe('abcdefgh.ics');
    expect(sanitizeFileName('week\u0000 12\u001f.ics', 'schedule')).toBe('week 12.ics');
    expect(sanitizeFileName('C:evil.ics', 'schedule')).toBe('Cevil.ics');
  });

  it('removes direction marks that could disguise the extension', () => {
    expect(sanitizeFileName('schedule\u202Egnp.exe', 'x')).toBe('schedulegnp.exe');
    expect(sanitizeFileName('\u200f\u2066name\u2069\u061c.ics', 'x')).toBe('name.ics');
  });

  it.each([
    ['name.', 'name'],
    ['name...', 'name'],
    ['name ', 'name'],
    ['name. . .', 'name'],
    ['name.ics.', 'name.ics'],
    ['name.ics . ', 'name.ics'],
    ['  name.ics', 'name.ics'],
    ['a   b\t\tc.ics', 'a b c.ics'],
  ])('tidies %j into %j', (name, expected) => {
    expect(sanitizeFileName(name, 'schedule')).toBe(expected);
  });

  it.each([
    ['CON', '_CON'],
    ['con', '_con'],
    ['con.ics', '_con.ics'],
    ['PRN.json', '_PRN.json'],
    ['aux', '_aux'],
    ['nul.txt', '_nul.txt'],
    ['NUL.week.json', '_NUL.week.json'],
    ['COM1.ics', '_COM1.ics'],
    ['com9', '_com9'],
    ['LPT1', '_LPT1'],
    ['lpt0.ics', '_lpt0.ics'],
    // the space before the extension goes too: Windows reads "con .ics" as the device as well
    ['con .ics', '_con.ics'],
    ['con.', '_con'],
    ['folder/nul', '_nul'],
    ['c<o>n.ics', '_con.ics'],
  ])('defuses the device name %j', (name, expected) => {
    expect(sanitizeFileName(name, 'schedule')).toBe(expected);
  });

  it.each([['console.ics'], ['com10.ics'], ['nulls.json'], ['icon'], ['my con.ics'], ['com.ics'], ['lpt.json']])('leaves %j alone', (name) => {
    expect(sanitizeFileName(name, 'schedule')).toBe(name);
  });

  it('cuts a long name to 120 characters and keeps the extension', () => {
    const cut = sanitizeFileName(`${'a'.repeat(300)}.ics`, 'schedule');
    expect(cut).toBe(`${'a'.repeat(116)}.ics`);
    expect(sanitizeFileName(`${'ש'.repeat(300)}.week.json`, 'schedule')).toBe(`${'ש'.repeat(115)}.json`.replace('.json', '.json'));
    expect(sanitizeFileName('b'.repeat(500), 'schedule')).toBe('b'.repeat(120));
    expect(sanitizeFileName('c'.repeat(120), 'schedule')).toBe('c'.repeat(120));
  });

  it('never cuts an emoji in half', () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (let lead = 0; lead < 4; lead++) {
      const cut = sanitizeFileName(`${'a'.repeat(lead)}${'🙂'.repeat(100)}.ics`, 'schedule');
      expect(cut).not.toMatch(lone);
      expect(cut.length).toBeLessThanOrEqual(120);
      expect(cut.endsWith('.ics')).toBe(true);
    }
  });

  it('never returns a name that ends in a dot or a space, even after cutting', () => {
    const names = [
      `${'a'.repeat(119)}.${'b'.repeat(40)}`,
      `${'a'.repeat(119)} ${'b'.repeat(40)}`,
      `${'a'.repeat(118)}. ${'b'.repeat(40)}`,
      `${'a'.repeat(115)}....${'b'.repeat(40)}`,
      `${'a'.repeat(119)}.${'b'.repeat(40)}.ics`,
    ];
    for (const name of names) {
      const result = sanitizeFileName(name, 'schedule');
      expect(result.length).toBeLessThanOrEqual(120);
      expect(result).not.toMatch(/[. ]$/);
      expect(result).not.toBe('');
    }
  });

  it('always gives a single safe name, whatever comes in', () => {
    const inputs = [
      'x',
      '..',
      'a/../b',
      'CON.',
      ' nul .txt',
      'aux.tar.gz',
      '.gitignore',
      '.ics',
      'a.b.c.d.e',
      `${'x'.repeat(200)}.${'y'.repeat(200)}`,
      `${'.'.repeat(200)}ics`,
      'שבוע/3?.ics',
      'emoji 🙂.ics',
      '\\',
      ':',
      'a:b',
    ];
    for (const input of inputs) {
      const result = sanitizeFileName(input, 'schedule');
      expect(result).not.toBe('');
      expect(result.length).toBeLessThanOrEqual(120);
      // eslint-disable-next-line no-control-regex
      expect(result).not.toMatch(/[\\/<>:"|?*\u0000-\u001f]/);
      expect(result).not.toMatch(/[. ]$/);
      expect(result).not.toMatch(/^\s/);
      expect(result).not.toBe('..');
      expect(result.split('.')[0].trim()).not.toMatch(/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i);
    }
  });
});

describe('toHttpsUrl', () => {
  it.each([
    ['https://example.com/', 'https://example.com/'],
    ['https://example.com', 'https://example.com/'],
    ['https://git-scm.com/download/win', 'https://git-scm.com/download/win'],
    ['HTTPS://Example.COM/Path?q=1#frag', 'https://example.com/Path?q=1#frag'],
    ['https://example.com:8443/a b', 'https://example.com:8443/a%20b'],
    ['https://he.wikipedia.org/wiki/שלום', 'https://he.wikipedia.org/wiki/%D7%A9%D7%9C%D7%95%D7%9D'],
  ])('accepts %j', (value, expected) => {
    expect(toHttpsUrl(value)).toBe(expected);
  });

  it.each([
    ['http://example.com/'],
    ['file:///C:/Windows/System32/calc.exe'],
    ['file://server/share/x.exe'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['mailto:someone@example.com'],
    ['ms-settings:display'],
    ['ftp://example.com/x'],
    ['ssh://git@example.com/x'],
    ['vbscript:msgbox(1)'],
    ['C:\\Windows\\System32\\calc.exe'],
    ['\\\\server\\share\\x.exe'],
    ['//example.com/x'],
    ['example.com'],
    ['www.example.com/path'],
    ['garbage'],
    ['not a url at all'],
    [''],
    ['https://'],
    ['https:///'],
    ['https'],
    ['https:'],
    ['httpsx://example.com/'],
    ['xhttps://example.com/'],
    ['http://https://example.com/'],
  ])('rejects %j', (value) => {
    expect(toHttpsUrl(value)).toBeNull();
  });

  it('rejects a link of more than 2048 characters', () => {
    expect(toHttpsUrl(`https://example.com/${'a'.repeat(2048 - 20)}`)).not.toBeNull();
    expect(toHttpsUrl(`https://example.com/${'a'.repeat(2048)}`)).toBeNull();
  });

  it('answers with an address that parses to https again', () => {
    for (const value of ['https://example.com/x', 'https://user:pw@example.com/x', 'https://[::1]/x', 'https://例え.jp/']) {
      const link = toHttpsUrl(value);
      expect(link).not.toBeNull();
      expect(new URL(link ?? '').protocol).toBe('https:');
    }
  });
});

// ───────────────────────────── one call ─────────────────────────────

describe('parseApiArgs', () => {
  const settingsPatch = { language: 'he' };
  const connect = { url: 'https://github.com/team/schedule.git', branch: null, userName: 'Dana', userEmail: 'dana@example.com' };
  const create = { files: FILES, message: 'Create' };
  const publish = { files: FILES, message: 'Update', expectedRemoteSha: SHA1 };
  const applyUpdate = { files: FILES, expectedRemoteSha: SHA1 };
  const saveFile = { title: 'Save', defaultName: 'x.ics', filters: [ICS_FILTER], content: 'x' };
  const openFile = { title: 'Open', filters: [ICS_FILTER] };
  const notification = { title: 't', body: 'b' };

  /** Per method: correct arguments, and for methods that take one, values it must refuse. */
  const TABLE: Record<ApiInvokeMethod, { good: unknown[]; bad: unknown[] }> = {
    boot: { good: [], bad: [] },
    saveSettings: { good: [settingsPatch], bad: [null, 'he', { language: 'fr' }, [settingsPatch]] },
    detectGit: { good: [], bad: [] },
    chooseGitExecutable: { good: [], bad: [] },
    connectRepo: { good: [connect], bad: [null, 'https://x/y.git', { ...connect, url: 5 }, { ...connect, branch: undefined }] },
    trustRepoPath: { good: ['C:/repos/schedule'], bad: [null, 5, '', '-x', '*', 'C:/*', 'a\nb', { path: 'C:/x' }] },
    createSchedule: { good: [create], bad: [null, { ...create, files: { [WEEK]: '' } }, { ...create, message: '' }, FILES] },
    loadSnapshot: { good: [], bad: [] },
    loadRemote: { good: [], bad: [] },
    writeWorking: { good: [FILES], bad: [null, 'schedule.json', { '../x.json': '' }, { 'README.md': '' }, { [WEEK]: 5 }, [FILES]] },
    fetch: { good: [{ interactive: false }], bad: [null, true, {}, { interactive: 'no' }] },
    applyUpdate: { good: [applyUpdate], bad: [null, { ...applyUpdate, expectedRemoteSha: null }, { ...applyUpdate, files: { 'x.json': '' } }, FILES] },
    publish: { good: [publish], bad: [null, { ...publish, expectedRemoteSha: 'main' }, { ...publish, message: ' ' }, { ...publish, files: {} }] },
    discardLocal: { good: [], bad: [] },
    blame: { good: ['2026-11-22'], bad: [null, 20261122, '2026-13-01', 'weeks/2026-11-22.json', { weekStart: '2026-11-22' }] },
    getAside: { good: [], bad: [] },
    setAside: { good: [[{ key: 'a' }]], bad: [null, {}, 'a', [{}], [{ key: '' }], [null]] },
    saveTextFile: { good: [saveFile], bad: [null, 'x', { ...saveFile, content: 5 }, { ...saveFile, filters: [{ name: 'x', extensions: ['.exe'] }] }] },
    openTextFile: { good: [openFile], bad: [null, 'x', { ...openFile, title: 5 }, { title: 'Open' }] },
    openSavedFile: { good: ['C:\\Users\\dana\\Documents\\x.ics'], bad: [null, 5, ['C:\\x.ics'], { path: 'C:\\x.ics' }, 'x'.repeat(4097)] },
    openRepoFolder: { good: [], bad: [] },
    openExternal: { good: ['https://git-scm.com/'], bad: [null, 5, ['https://x/'], { url: 'https://x/' }] },
    notify: { good: [notification], bad: [null, 't', { title: 't' }, { ...notification, body: 5 }] },
    ackCloseRequest: { good: [], bad: [] },
    closeWindow: { good: [], bad: [] },
  };

  it('has a case for every method of the bridge', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...API_INVOKE_METHODS].sort());
    expect(new Set(API_INVOKE_METHODS).size).toBe(API_INVOKE_METHODS.length);
  });

  describe.each(API_INVOKE_METHODS.map((method) => [method] as const))('%s', (method) => {
    const { good, bad } = TABLE[method];

    it('returns exactly the arguments the method takes, as an array', () => {
      const parsed = parseApiArgs(method, good);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(good.length);
    });

    it('ignores arguments beyond the ones the method takes', () => {
      const parsed: unknown[] = parseApiArgs(method, [...good, 'extra', { more: true }, null]);
      expect(parsed).toHaveLength(good.length);
      expect(parsed).toEqual(parseApiArgs(method, good));
    });

    if (good.length === 0) {
      it('takes no arguments and passes none on, whatever was sent', () => {
        expect(parseApiArgs(method, [])).toEqual([]);
        expect(parseApiArgs(method, [{ evil: true }])).toEqual([]);
        expect(parseApiArgs(method, [undefined, null, 'x', 5])).toEqual([]);
      });
    } else {
      it('rejects a call without arguments', () => {
        rejects(() => parseApiArgs(method, []));
        rejects(() => parseApiArgs(method, [undefined]));
      });

      it('rejects the correct argument in the wrong position', () => {
        rejects(() => parseApiArgs(method, [undefined, ...good]));
      });

      it.each(bad.map((value) => [value] as const))('rejects %j', (value) => {
        rejects(() => parseApiArgs(method, [value]));
      });
    }
  });

  it('hands back checked copies, not what the renderer sent', () => {
    const sent = { ...publish, files: { ...FILES }, sneaky: true };
    const [parsed] = parseApiArgs('publish', [sent]);
    expect(parsed).toEqual(publish);
    expect(parsed).not.toBe(sent);
    expect(parsed.files).not.toBe(sent.files);
    expect('sneaky' in parsed).toBe(false);
  });

  it('applies the cleaning of the single parsers', () => {
    expect(parseApiArgs('notify', [{ title: ' a\nb ', body: 'x'.repeat(600) }])).toEqual([{ title: 'a b', body: `${'x'.repeat(499)}…` }]);
    expect(parseApiArgs('saveSettings', [{ repoUrl: 'https://evil/x.git', branch: 'x', gitPath: 'C:\\calc.exe', notifications: true }])).toEqual([
      { notifications: true },
    ]);
  });

  it('passes a path or a link on as typed: the controller decides about them', () => {
    expect(parseApiArgs('openExternal', ['javascript:alert(1)'])).toEqual(['javascript:alert(1)']);
    expect(parseApiArgs('openSavedFile', ['C:\\Windows\\System32\\calc.exe'])).toEqual(['C:\\Windows\\System32\\calc.exe']);
  });

  it('throws for a method name that does not exist instead of doing anything', () => {
    for (const name of ['nope', 'constructor', 'toString', '__proto__', '']) {
      expect(() => parseApiArgs(name as ApiInvokeMethod, [])).toThrow();
    }
  });
});

// ───────────────────────────── what the user typed ─────────────────────────────

describe('isValidBranchName', () => {
  it.each([
    ['main'],
    ['master'],
    ['feature/schedule-2026'],
    ['a'],
    ['v1.2.3'],
    ['user/dana/week_12'],
    ['שבוע-3'],
    ['head'],
    ['a@b'],
    ['a.b'],
    ['x-lock'],
    ['lock'],
    ['a'.repeat(250)],
  ])('accepts %j', (name) => {
    expect(isValidBranchName(name)).toBe(true);
  });

  it.each([
    ['nothing', ''],
    ['a leading dash', '-main'],
    ['an option', '--upload-pack=calc'],
    ['a single dash', '-'],
    ['two dots', 'a..b'],
    ['only two dots', '..'],
    ['a space', 'my branch'],
    ['a leading space', ' main'],
    ['a trailing space', 'main '],
    ['a tab', 'a\tb'],
    ['a line break', 'main\n'],
    ['a NUL', 'ma\u0000in'],
    ['a DEL', 'ma\u007fin'],
    ['a tilde', 'a~1'],
    ['a caret', 'a^'],
    ['a colon', 'a:b'],
    ['a question mark', 'a?'],
    ['an asterisk', 'a*'],
    ['an opening bracket', 'a[0]'],
    ['a backslash', 'a\\b'],
    ['a trailing .lock', 'main.lock'],
    ['a part with a trailing .lock', 'a.lock/b'],
    ['"@{"', 'a@{1}'],
    ['just "@"', '@'],
    ['HEAD', 'HEAD'],
    ['a leading slash', '/main'],
    ['a trailing slash', 'main/'],
    ['a double slash', 'a//b'],
    ['a trailing dot', 'main.'],
    ['a leading dot', '.main'],
    ['a part with a leading dot', 'a/.b'],
    ['a single dot', '.'],
    ['an over-long name', 'a'.repeat(251)],
  ])('rejects %s', (_label, name) => {
    expect(isValidBranchName(name)).toBe(false);
  });
});

describe('describeIdentityProblem', () => {
  it.each([
    ['Dana Cohen', 'dana@example.com'],
    ['דנה כהן', 'dana@example.co.il'],
    ['D', 'a@b'],
    ['O\'Brien, Jr.', 'first.last+tag@sub.example.com'],
    ['n'.repeat(200), `${'e'.repeat(308)}@example.com`],
  ])('finds nothing wrong with %j <%s>', (name, email) => {
    expect(describeIdentityProblem(name, email)).toBeNull();
  });

  it.each([[''], ['   '], ['.'], ['...'], ['.,:;<>"\\\''], [' . , '], ['\t'], ['n'.repeat(201)]])('asks for a name instead of %j', (name) => {
    expect(describeIdentityProblem(name, 'dana@example.com')).toMatch(/name is required/i);
  });

  it.each([
    [''],
    ['   '],
    ['dana'],
    ['dana@'],
    ['@example.com'],
    ['dana@@example.com'],
    ['dana@exa@mple.com'],
    ['dana cohen@example.com'],
    ['dana@exam ple.com'],
    [' dana@example.com'],
    ['dana@example.com '],
    ['dana@example.com\n'],
    ['<dana@example.com>'],
    ['Dana <dana@example.com>'],
    ['dana@example.com>'],
    [`${'e'.repeat(309)}@example.com`],
  ])('asks for an e-mail address instead of %j', (email) => {
    expect(describeIdentityProblem('Dana', email)).toMatch(/e-mail address is required/i);
  });

  it('reports the name first when both are wrong', () => {
    expect(describeIdentityProblem('', '')).toMatch(/name is required/i);
  });
});
