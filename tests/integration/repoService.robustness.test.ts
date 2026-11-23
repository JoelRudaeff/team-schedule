/**
 * Git sequences that an independent review of version 1.0.0 found broken. Each test pins
 * the corrected behaviour against real temporary repositories.
 */
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishResult } from '@shared/api';
import { RAW_BYTES_PREFIX, buildFileMap, filesToDataset, serializeWeek } from '@shared/serialize';
import type { FileMap, ScheduleEvent, WeekData } from '@shared/types';
import { GitError, detectGit, type GitRunner } from '../../src/main/git/gitRunner';
import { RepoService, fileBytesOf, fileTextOf } from '../../src/main/git/repoService';
import { CONFIG_TEXT, DANA, WEEK, WEEK_FILE, YOSSI, createSandbox, eventLine, weekText, type Sandbox } from './helpers';
import { startSilentServer, type SilentServer } from './silentServer';

const E1 = eventLine('e1', 0, '09:00', '10:30', 'מבוא');
const E2 = eventLine('e2', 1, '09:00', '10:30', 'שני');
const FIRST: FileMap = { 'schedule.json': CONFIG_TEXT, [WEEK_FILE]: weekText('Week 1', [E1]) };

function ok(result: PublishResult): asserts result is Extract<PublishResult, { ok: true }> {
  if (!result.ok) throw new Error(`publish failed: ${result.reason} ${result.reason === 'error' ? result.error.detail : ''}`);
}

function ev(id: string, day: number, title: string, start = 540): ScheduleEvent {
  return { id, day: day as ScheduleEvent['day'], start, end: start + 60, title, subjectId: null, locationId: null, teacherIds: [], classIds: [], notes: '' };
}

function week(events: ScheduleEvent[], title = 'Week 1'): WeekData {
  return { weekStart: WEEK, title, events };
}

async function expectGitError(action: Promise<unknown>): Promise<GitError> {
  try {
    await action;
  } catch (error) {
    if (error instanceof GitError) return error;
    throw error;
  }
  throw new Error('expected a GitError, but the call succeeded');
}

// ───────────────────────────── who last edited an event ─────────────────────────────

describe('who last edited an event', () => {
  let box: Sandbox;
  let dana: RepoService;
  let yossi: RepoService;
  const A = ev('aaa', 0, 'Dana lecture (Sunday)');
  const B = ev('bbb', 1, 'Dana lab (Monday)');
  const C = ev('ccc', 3, 'Yossi workshop (Wednesday)');
  const publishAs = async (who: RepoService, events: ScheduleEvent[], message: string, title = 'Week 1'): Promise<void> => {
    await who.fetch(false);
    const remote = await who.loadRemote();
    if (remote) await who.applyUpdate(remote.files, remote.sha);
    const files: FileMap = { 'schedule.json': CONFIG_TEXT, [WEEK_FILE]: serializeWeek(week(events, title)) };
    ok(await who.publish(files, message, (await who.status()).remoteSha));
  };

  beforeAll(async () => {
    box = await createSandbox();
    dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule({ 'schedule.json': CONFIG_TEXT, [WEEK_FILE]: serializeWeek(week([A, B])) }, 'Dana creates A and B'));
    yossi = (await box.connect('yossi', YOSSI)).service;
  });
  afterAll(() => box.cleanup());

  it('adding an event behind the last one does not make its neighbour "edited" by the one who added it', async () => {
    await publishAs(yossi, [A, B, C], 'Yossi adds C');
    const blame = await yossi.blame(WEEK);
    expect(blame.events.ccc.authorName).toBe(YOSSI.name);
    expect(blame.events.aaa.authorName).toBe(DANA.name);
    // B is the line that got a comma. Nobody edited the event.
    expect(blame.events.bbb.authorName).toBe(DANA.name);
    expect(blame.events.bbb.summary).toBe('Dana creates A and B');
  });

  it('removing the last event does not touch its neighbour either', async () => {
    await publishAs(dana, [A, B], 'Dana deletes C');
    const blame = await dana.blame(WEEK);
    expect(Object.keys(blame.events).sort()).toEqual(['aaa', 'bbb']);
    expect(blame.events.bbb.summary).toBe('Dana creates A and B');
    expect(blame.events.bbb.authorName).toBe(DANA.name);
  });

  it('a real edit moves the event to its editor, with the time and message of that save', async () => {
    await publishAs(yossi, [A, { ...B, title: 'Dana lab (moved)', start: 600, end: 660 }], 'Yossi moves the lab');
    const blame = await yossi.blame(WEEK);
    expect(blame.events.bbb).toMatchObject({ authorName: YOSSI.name, authorEmail: YOSSI.email, summary: 'Yossi moves the lab' });
    expect(blame.events.bbb.time).toBeGreaterThan(Date.now() - 600_000);
    expect(blame.events.aaa.authorName).toBe(DANA.name);
    expect(blame.headSha).toBe((await yossi.status()).headSha);
  });

  it('an event that was changed and changed back belongs to the one who changed it back', async () => {
    await publishAs(dana, [{ ...A, title: 'Changed' }, { ...B, title: 'Dana lab (moved)', start: 600, end: 660 }], 'Dana renames A');
    await publishAs(yossi, [A, { ...B, title: 'Dana lab (moved)', start: 600, end: 660 }], 'Yossi restores A');
    const blame = await yossi.blame(WEEK);
    expect(blame.events.aaa.summary).toBe('Yossi restores A');
  });

  it('the week title belongs to whoever last changed it, not to whoever last saved the file', async () => {
    const before = await yossi.blame(WEEK);
    expect(before.title?.summary).toBe('Dana creates A and B');
    await publishAs(dana, [A, { ...B, title: 'Dana lab (moved)', start: 600, end: 660 }], 'Dana names the week', 'Exam week');
    await publishAs(yossi, [A, { ...B, title: 'Dana lab (moved)', start: 600, end: 660 }, C], 'Yossi adds C again', 'Exam week');
    const blame = await yossi.blame(WEEK);
    expect(blame.title?.summary).toBe('Dana names the week');
    expect(blame.events.ccc.summary).toBe('Yossi adds C again');
  });

  it('a file written in another layout is compared by content, not by lines', async () => {
    // Somebody reformats the file by hand: every event spread over several lines.
    const pretty = JSON.stringify(JSON.parse(serializeWeek(week([A, { ...B, title: 'Dana lab (moved)', start: 600, end: 660 }, C], 'Exam week'))), null, 2);
    await yossi.fetch(false);
    ok(await yossi.publish({ 'schedule.json': CONFIG_TEXT, [WEEK_FILE]: `${pretty}\n` }, 'Reformatted by hand', (await yossi.status()).remoteSha));
    const blame = await yossi.blame(WEEK);
    // Nothing was edited, so nobody new is named.
    expect(blame.events.ccc.summary).toBe('Yossi adds C again');
    expect(blame.events.aaa.summary).toBe('Yossi restores A');
    expect(blame.title?.summary).toBe('Dana names the week');
  });

  it('a week without a file, and an id every object "has", give no answer instead of a wrong one', async () => {
    const empty = await yossi.blame('2026-12-06');
    expect(empty.events).toEqual({});
    expect(empty.title).toBeNull();
    const blame = await yossi.blame(WEEK);
    expect(blame.events.constructor).toBeUndefined();
    expect(blame.events.toString).toBeUndefined();
  });
});

// ───────────────────────────── files that are not UTF-8 ─────────────────────────────

describe('file contents never lose a byte', () => {
  it('UTF-8 text travels as text (a byte order mark included) and comes back as the same bytes', () => {
    const plain = Buffer.from('{"title":"שבוע 1"}\n', 'utf8');
    expect(fileTextOf(plain)).toBe('{"title":"שבוע 1"}\n');
    expect(fileBytesOf(fileTextOf(plain)).equals(plain)).toBe(true);
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
    expect(fileTextOf(withBom).charCodeAt(0)).toBe(0xfeff);
    expect(fileBytesOf(fileTextOf(withBom)).equals(withBom)).toBe(true);
    expect(fileBytesOf(fileTextOf(Buffer.alloc(0))).length).toBe(0);
  });

  it('bytes that are not UTF-8 travel as bytes, and nothing is replaced', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}', 'utf16le')]);
    const ansi = Buffer.from([0x7b, 0x22, 0xe9, 0xf9, 0x22, 0x7d]);
    const cut = Buffer.from([0xd7, 0xa9, 0xd7]); // ends in the middle of a letter
    for (const bytes of [utf16, ansi, cut]) {
      const text = fileTextOf(bytes);
      expect(text.startsWith(RAW_BYTES_PREFIX)).toBe(true);
      expect(text).not.toContain(String.fromCharCode(0xfffd));
      expect(fileBytesOf(text).equals(bytes)).toBe(true);
    }
  });

  it('a text that happens to begin like the marker is not mistaken for bytes', () => {
    const odd = Buffer.from(`${RAW_BYTES_PREFIX}aGVsbG8=`, 'utf8');
    expect(fileBytesOf(fileTextOf(odd)).equals(odd)).toBe(true);
  });

  it('the window reports such a file as unreadable and keeps it for writing back', () => {
    const text = fileTextOf(Buffer.from([0xff, 0xfe, 0x7b, 0x00]));
    const parsed = filesToDataset({ 'schedule.json': CONFIG_TEXT, 'weeks/2026-12-06.json': text });
    expect(parsed.problems.map((problem) => [problem.path, problem.code])).toEqual([['weeks/2026-12-06.json', 'invalid']]);
    expect(parsed.problems[0].message).toContain('not a UTF-8 text file');
    expect(parsed.passthrough).toEqual({ 'weeks/2026-12-06.json': text });
  });
});

describe('a data file that is not UTF-8 (written with other tools)', () => {
  let box: Sandbox;
  let dana: RepoService;
  let yossi: RepoService;
  const UTF16_FILE = 'weeks/2026-12-06.json';
  const ANSI_FILE = 'weeks/2026-12-13.json';
  let utf16Bytes: Buffer;
  let ansiBytes: Buffer;

  beforeAll(async () => {
    box = await createSandbox();
    dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule(FIRST, 'Create schedule'));
    yossi = (await box.connect('yossi', YOSSI)).service;

    // A third person works with plain git and Windows tools.
    const outsider = join(box.root, 'outsider');
    await box.raw(box.root, 'clone', '--quiet', box.remote, outsider);
    await box.raw(outsider, 'config', 'user.name', 'Outsider');
    await box.raw(outsider, 'config', 'user.email', 'out@example.com');
    await mkdir(join(outsider, 'weeks'), { recursive: true });
    // PowerShell 5 "Out-File" writes UTF-16 LE with a byte order mark.
    utf16Bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(weekText('שבוע 3', [], '2026-12-06'), 'utf16le')]);
    await writeFile(join(outsider, ...UTF16_FILE.split('/')), utf16Bytes);
    // An old editor saves Hebrew in Windows-1255.
    ansiBytes = Buffer.from(weekText('XX', [eventLine('h1', 1, '09:00', '10:00', 'YY')], '2026-12-13'), 'latin1');
    for (const marker of ['XX', 'YY']) {
      const at = ansiBytes.indexOf(Buffer.from(marker, 'latin1'));
      ansiBytes[at] = 0xe9;
      ansiBytes[at + 1] = 0xf9;
    }
    await writeFile(join(outsider, ...ANSI_FILE.split('/')), ansiBytes);
    await box.raw(outsider, '-c', 'core.autocrlf=false', 'add', '-A');
    await box.raw(outsider, 'commit', '--quiet', '-m', 'outsider adds two weeks');
    await box.raw(outsider, 'push', '--quiet', 'origin', `HEAD:${dana.branch}`);
  });
  afterAll(() => box.cleanup());

  it('an update leaves the files exactly as the team has them: nothing counts as changed here', async () => {
    await yossi.fetch(false);
    const remote = (await yossi.loadRemote())!;
    expect(filesToDataset(remote.files).problems.map((problem) => problem.path)).toEqual([UTF16_FILE, ANSI_FILE]);
    expect((await yossi.applyUpdate(remote.files, remote.sha)).ok).toBe(true);

    expect((await box.raw(yossi.dir, 'status', '--porcelain')).stdout).toBe('');
    expect((await readFile(join(yossi.dir, ...UTF16_FILE.split('/')))).equals(utf16Bytes)).toBe(true);
    expect((await readFile(join(yossi.dir, ...ANSI_FILE.split('/')))).equals(ansiBytes)).toBe(true);
  });

  it('a save of something else does not touch them: the commit holds only what was edited', async () => {
    // What the window does for "save": parse, edit, buildFileMap(dataset, passthrough), publish.
    const snapshot = await yossi.loadSnapshot();
    const parsed = filesToDataset(snapshot.workingFiles);
    const edited = { ...parsed.dataset, weeks: { ...parsed.dataset.weeks, [WEEK]: { ...parsed.dataset.weeks[WEEK], title: 'Yossi renames week 1' } } };
    ok(await yossi.publish(buildFileMap(edited, parsed.passthrough), 'Yossi renames week 1', snapshot.status.remoteSha));

    const touched = (await box.raw(yossi.dir, 'show', '--name-only', '--format=', 'HEAD')).stdout.trim().split('\n');
    expect(touched).toEqual([WEEK_FILE]);
    const blobOf = async (path: string): Promise<Buffer> => (await box.raw(box.remote, 'cat-file', 'blob', `${dana.branch}:${path}`)).stdoutBuffer;
    expect((await blobOf(UTF16_FILE)).equals(utf16Bytes)).toBe(true);
    expect((await blobOf(ANSI_FILE)).equals(ansiBytes)).toBe(true);
  });
});

// ───────────────────────────── a lock file left behind ─────────────────────────────

describe('a lock file that a dead git left behind', () => {
  let box: Sandbox;
  afterAll(() => box.cleanup());

  it('is cleared, so that saving and updating work again without anybody deleting files by hand', async () => {
    box = await createSandbox();
    const dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule(FIRST, 'Create schedule'));
    const lock = join(dana.dir, '.git', 'index.lock');
    await writeFile(lock, '');

    const files = { ...FIRST, [WEEK_FILE]: weekText('changed', [E1]) };
    const result = await dana.publish(files, 'change', (await dana.status()).remoteSha);

    ok(result);
    expect(result.commitSha).not.toBeNull();
    expect(await readdir(join(dana.dir, '.git'))).not.toContain('index.lock');
    const onServer = (await box.raw(box.remote, 'cat-file', 'blob', `${dana.branch}:${WEEK_FILE}`)).stdout;
    expect(onServer).toContain('"title": "changed"');
    // And the same for an update.
    const yossi = (await box.connect('yossi', YOSSI)).service;
    ok(await dana.publish({ ...FIRST, [WEEK_FILE]: weekText('changed again', [E1]) }, 'again', (await dana.status()).remoteSha));
    await writeFile(join(yossi.dir, '.git', 'index.lock'), '');
    await yossi.fetch(false);
    const remote = (await yossi.loadRemote())!;
    expect((await yossi.applyUpdate(remote.files, remote.sha)).ok).toBe(true);
    expect((await yossi.status()).behind).toBe(0);
  });
});

// ───────────────────────────── lock files in the branches ─────────────────────────────

describe('lock files that a git which was ended by force left behind in the branches', () => {
  let box: Sandbox;
  let dana: RepoService;
  let lock = '';
  let round = 0;

  beforeAll(async () => {
    box = await createSandbox();
    dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule(FIRST, 'Create schedule'));
    lock = join(dana.dir, '.git', 'refs', 'remotes', 'origin', `${dana.branch}.lock`);
  });
  afterAll(() => box.cleanup());

  /** A new commit on the team's branch, made on the "server" itself. */
  async function teamCommits(): Promise<string> {
    const head = (await box.raw(box.remote, 'rev-parse', `refs/heads/${dana.branch}`)).stdout.trim();
    const tree = (await box.raw(box.remote, 'rev-parse', `${head}^{tree}`)).stdout.trim();
    const sha = (
      await box.git.run(['-c', 'user.name=Team', '-c', 'user.email=team@example.com', 'commit-tree', tree, '-p', head, '-m', `team commit ${++round}`], { cwd: box.remote })
    ).stdout.trim();
    await box.raw(box.remote, 'update-ref', `refs/heads/${dana.branch}`, sha);
    return sha;
  }

  /** A lock file as a git that died `ageMs` ago would have left it. */
  async function leftBehind(path: string, ageMs = 60_000): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '');
    const then = new Date(Date.now() - ageMs);
    await utimes(path, then, then);
  }

  async function locksIn(folder: string): Promise<string[]> {
    const entries = await readdir(folder, { recursive: true });
    return entries.filter((name) => name.endsWith('.lock'));
  }

  it('without help git refuses every check from then on (this is what the app must not pass on to the user)', async () => {
    await teamCommits();
    await leftBehind(lock);
    const error = await expectGitError(box.raw(dana.dir, 'fetch', '--prune', 'origin'));
    expect(error.detail).toMatch(/Unable to create '.*\.lock': File exists/);
    await rm(lock);
    await box.raw(dana.dir, 'fetch', '--prune', 'origin');
  });

  it('the next check clears the lock on the team branch and brings the team\'s commit', async () => {
    const sha = await teamCommits();
    await leftBehind(lock);

    const status = await dana.fetch(false);

    expect(status.fetchError).toBeNull();
    expect(status.remoteSha).toBe(sha);
    expect(status.behind).toBeGreaterThan(0);
    expect(await locksIn(join(dana.dir, '.git', 'refs'))).toEqual([]);
    expect((await dana.applyUpdate(FIRST, sha)).ok).toBe(true);
    expect((await dana.status()).behind).toBe(0);
  });

  it('a save whose first step (a check) meets such a lock gets past it: it sees that the team was faster', async () => {
    const seen = (await dana.status()).remoteSha;
    const sha = await teamCommits();
    await leftBehind(lock);

    const result = await dana.publish({ ...FIRST, [WEEK_FILE]: weekText('mine', [E1]) }, 'Save', seen);

    expect(result).toMatchObject({ ok: false, reason: 'remote-changed' });
    expect(result.status.fetchError).toBeNull();
    expect(result.status.remoteSha).toBe(sha);
    expect(await locksIn(join(dana.dir, '.git', 'refs'))).toEqual([]);
    expect((await dana.applyUpdate(FIRST, sha)).ok).toBe(true);
  });

  it('a save that meets the lock only when git records what it has sent still goes out, and is counted as saved', async () => {
    // Nothing new on the server, so the save's own check has no reason to touch the branch …
    const tip = (await dana.status()).remoteSha;
    expect((await dana.status()).behind).toBe(0);
    // … and the lock is in the way only at the very end, when git notes down the commit it pushed.
    await leftBehind(lock);
    const files = { ...FIRST, [WEEK_FILE]: weekText('saved past a lock', [E1]) };

    const result = await dana.publish(files, 'Save', tip);

    ok(result);
    expect(result.commitSha).not.toBeNull();
    expect((await box.raw(box.remote, 'show', `${dana.branch}:${WEEK_FILE}`)).stdout).toContain('saved past a lock');
    // The team has it, so nothing counts as unpublished here.
    expect(result.status).toMatchObject({ headSha: result.commitSha, remoteSha: result.commitSha, ahead: 0, behind: 0 });
    expect(await locksIn(join(dana.dir, '.git', 'refs'))).toEqual([]);
    // For the tests below the files are as the team has them again.
    ok(await dana.publish(FIRST, 'Back', result.commitSha));
  });

  it('a git that died in the middle of a large update left a lock per branch: all of them go, and the one of packed-refs', async () => {
    await teamCommits();
    const origin = join(dana.dir, '.git', 'refs', 'remotes', 'origin');
    for (let i = 0; i < 40; i++) await leftBehind(join(origin, 'extra', `r${i % 4}`, `b${i}.lock`));
    await leftBehind(join(dana.dir, '.git', 'packed-refs.lock'));
    await leftBehind(lock);

    const status = await dana.fetch(false);

    expect(status.fetchError).toBeNull();
    expect(await locksIn(join(dana.dir, '.git', 'refs'))).toEqual([]);
    expect(await readdir(join(dana.dir, '.git'))).not.toContain('packed-refs.lock');
  });

  it('a branch that was removed on the server is still removed here when the lock of packed-refs was left behind', async () => {
    const sha = (await box.raw(box.remote, 'rev-parse', `refs/heads/${dana.branch}`)).stdout.trim();
    await box.raw(box.remote, 'update-ref', 'refs/heads/short-lived', sha);
    expect((await dana.fetch(false)).fetchError).toBeNull();
    // Packed, so that removing it means rewriting packed-refs.
    await box.raw(dana.dir, 'pack-refs', '--all');
    await box.raw(box.remote, 'update-ref', '-d', 'refs/heads/short-lived');
    await leftBehind(join(dana.dir, '.git', 'packed-refs.lock'));

    const status = await dana.fetch(false);

    expect(status.fetchError).toBeNull();
    const left = (await box.raw(dana.dir, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin')).stdout;
    expect(left).not.toContain('short-lived');
    expect(await readdir(join(dana.dir, '.git'))).not.toContain('packed-refs.lock');
  });

  it('a lock that was made a moment ago gets its moment: the check waits about two seconds, then clears it', async () => {
    const sha = await teamCommits();
    await leftBehind(lock, 0);
    const started = Date.now();

    const status = await dana.fetch(false);

    expect(status.fetchError).toBeNull();
    expect(status.remoteSha).toBe(sha);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
  });

  it('a lock that somebody keeps renewing belongs to a git that is at work: it is left alone, and the check says what git said', async () => {
    await teamCommits();
    await leftBehind(lock, 0);
    // Somebody's git "holds" the lock: it is never older than a moment.
    const holder = setInterval(() => {
      const now = new Date();
      void utimes(lock, now, now).catch(() => undefined);
    }, 100);
    try {
      const status = await dana.fetch(false);

      expect(status.fetchError?.code).toBe('unknown');
      expect(status.fetchError?.detail).toMatch(/File exists/);
      expect(await locksIn(join(dana.dir, '.git', 'refs'))).toHaveLength(1);
    } finally {
      clearInterval(holder);
      await rm(lock, { force: true });
    }
    // Once that git is done, everything works as before.
    expect((await dana.fetch(false)).fetchError).toBeNull();
  });

  it('connecting again — what a user tries when nothing works — gets past such a lock too', async () => {
    await teamCommits();
    await leftBehind(lock);

    const again = await box.connect('dana', DANA);

    expect(again.hasSchedule).toBe(true);
    expect(await locksIn(join(dana.dir, '.git', 'refs'))).toEqual([]);
  });

  it('a file that merely looks like a lock outside the repository\'s own .git folder is never touched', async () => {
    await teamCommits();
    const stranger = join(dana.dir, 'weeks', 'notes.lock');
    await leftBehind(stranger);
    await leftBehind(lock);

    expect((await dana.fetch(false)).fetchError).toBeNull();

    expect(await readdir(join(dana.dir, 'weeks'))).toContain('notes.lock');
    await rm(stranger);
  });

  // The cases below were found by the fourth review of pull request #1.

  it('a git that died while it moved the branch left several locks at once (HEAD, the branch, the index): the first update afterwards goes through', async () => {
    const sha = await teamCommits();
    expect((await dana.fetch(false)).fetchError).toBeNull();
    const gitDir = join(dana.dir, '.git');
    // git names only the first lock it runs into; the single retry must not meet the next one.
    await leftBehind(join(gitDir, 'HEAD.lock'));
    await leftBehind(join(gitDir, 'refs', 'heads', `${dana.branch}.lock`));
    await leftBehind(join(gitDir, 'index.lock'));

    const result = await dana.applyUpdate(FIRST, sha);

    expect(result.ok).toBe(true);
    expect(result.status).toMatchObject({ headSha: sha, behind: 0 });
    expect(await locksIn(gitDir)).toEqual([]);
  });

  it('the same for a save', async () => {
    const tip = (await dana.status()).remoteSha;
    const gitDir = join(dana.dir, '.git');
    await leftBehind(join(gitDir, 'HEAD.lock'));
    await leftBehind(join(gitDir, 'refs', 'heads', `${dana.branch}.lock`));
    await leftBehind(join(gitDir, 'index.lock'));

    const result = await dana.publish({ ...FIRST, [WEEK_FILE]: weekText('saved past three locks', [E1]) }, 'Save', tip);

    ok(result);
    expect(result.commitSha).not.toBeNull();
    expect(result.status).toMatchObject({ ahead: 0, behind: 0 });
    expect(await locksIn(gitDir)).toEqual([]);
    ok(await dana.publish(FIRST, 'Back', result.commitSha));
  });

  it('a lock whose time lies in the future (the clock was set back since) is not waited for longer than the usual moment', async () => {
    const sha = await teamCommits();
    await writeFile(lock, '');
    const inAnHour = new Date(Date.now() + 3_600_000);
    await utimes(lock, inAnHour, inAnHour);
    const started = Date.now();

    const status = await dana.fetch(false);

    expect(status.fetchError).toBeNull();
    expect(status.remoteSha).toBe(sha);
    // Two fetches and the two-second moment in between. (That the wait is exactly that
    // moment is pinned, without a clock, in tests/unit/main.staleLocks.test.ts.)
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(await locksIn(join(dana.dir, '.git', 'refs'))).toEqual([]);
    expect((await dana.applyUpdate(FIRST, sha)).ok).toBe(true);
  });

  it('a lock on the clone\'s configuration (a git that died while connecting) does not stop a new name from being stored', async () => {
    const configLock = join(dana.dir, '.git', 'config.lock');
    await leftBehind(configLock);
    // What git itself says about it, in words unlike those for every other lock.
    const refused = await expectGitError(box.raw(dana.dir, 'config', 'user.name', 'Somebody'));
    expect(refused.detail).toMatch(/could not lock config file .*config: File exists/);

    await dana.setIdentity('Dana L.', 'dana.l@example.com');

    expect((await box.raw(dana.dir, 'config', 'user.name')).stdout.trim()).toBe('Dana L.');
    expect((await box.raw(dana.dir, 'config', 'user.email')).stdout.trim()).toBe('dana.l@example.com');
    expect(await readdir(join(dana.dir, '.git'))).not.toContain('config.lock');
  });

  it('nor connecting again', async () => {
    await leftBehind(join(dana.dir, '.git', 'config.lock'));

    const again = await box.connect('dana', DANA);

    expect(again.hasSchedule).toBe(true);
    expect((await box.raw(dana.dir, 'config', 'user.name')).stdout.trim()).toBe(DANA.name);
    expect(await readdir(join(dana.dir, '.git'))).not.toContain('config.lock');
  });

  // The cases below were found by the fifth review of pull request #1: looking at every kind
  // of lock whenever one was in the way also took locks that may belong to somebody who is
  // working in the folder with git by hand.

  it('a branch lock in the way of a check does not make the app touch the index, HEAD or the configuration: each goes only when a command of the app meets it', async () => {
    const sha = await teamCommits();
    const gitDir = join(dana.dir, '.git');
    for (const name of ['index.lock', 'HEAD.lock', 'config.lock']) await leftBehind(join(gitDir, name));
    await leftBehind(lock);

    // The check meets the branch lock, and nothing else.
    expect((await dana.fetch(false)).fetchError).toBeNull();
    expect((await locksIn(gitDir)).sort()).toEqual(['HEAD.lock', 'config.lock', 'index.lock']);

    // An update needs the index and HEAD: those two go, the configuration's lock stays.
    expect((await dana.applyUpdate(FIRST, sha)).ok).toBe(true);
    expect(await locksIn(gitDir)).toEqual(['config.lock']);

    // Storing the name needs the configuration.
    await dana.setIdentity(DANA.name, DANA.email);
    expect(await locksIn(gitDir)).toEqual([]);
  });

  /**
   * A git that hangs in `command` (a subcommand, or whatever `command` says yes to) and is
   * ended on its time limit, as the runner reports that. `leaves`: what it had locked by then.
   */
  function endedByForceIn(command: string | ((args: readonly string[]) => boolean), leaves: () => Promise<void> = async () => undefined): GitRunner {
    const hangs = typeof command === 'string' ? (args: readonly string[]): boolean => args[0] === command : command;
    return {
      gitPath: box.git.gitPath,
      async run(args, options) {
        if (!hangs(args)) return box.git.run(args, options);
        await leaves();
        throw new GitError({ code: 'timeout', message: 'git did not finish in time and was stopped', detail: '' }, null);
      },
    };
  }

  it('a command that moves the working copy and is ended on its time limit clears what it can have left (index, HEAD, branch) — and not the configuration\'s lock', async () => {
    const sha = await teamCommits();
    expect((await dana.fetch(false)).fetchError).toBeNull();
    const gitDir = join(dana.dir, '.git');
    await leftBehind(join(gitDir, 'config.lock'));
    const stuck = endedByForceIn('reset', async () => {
      // What it had locked in the moment it was ended.
      await leftBehind(join(gitDir, 'index.lock'));
      await leftBehind(join(gitDir, 'HEAD.lock'));
      await leftBehind(join(gitDir, 'refs', 'heads', `${dana.branch}.lock`));
    });
    const service = (await RepoService.open(stuck, dana.dir, box.remote, dana.branch))!;

    const result = await service.applyUpdate(FIRST, sha);

    if (result.ok || result.reason !== 'error') throw new Error('expected the update to report the time limit');
    expect(result.error.code).toBe('timeout');
    expect(await locksIn(gitDir)).toEqual(['config.lock']);
    await rm(join(gitDir, 'config.lock'));
    // Nothing is in the way of the next try.
    expect((await dana.applyUpdate(FIRST, sha)).ok).toBe(true);
  });

  it('a command that only reads and is ended on its time limit clears nothing at all', async () => {
    const gitDir = join(dana.dir, '.git');
    for (const name of ['index.lock', 'HEAD.lock', 'config.lock']) await leftBehind(join(gitDir, name));
    await leftBehind(lock);
    const service = (await RepoService.open(endedByForceIn('ls-tree'), dana.dir, box.remote, dana.branch))!;

    const error = await expectGitError(service.loadRemote());

    expect(error.code).toBe('timeout');
    const still = await locksIn(gitDir);
    expect(still).toHaveLength(4);
    for (const name of still) await rm(join(gitDir, name));
  });

  // The cases below were found by the review of pull request #2. (Every row of the two
  // tables behind them is pinned in tests/unit/main.staleLocks.test.ts; here the rows a
  // save, a check and the settings really go through, with real git around them.)

  it('connecting to another branch gets through at the first try when a lock on that branch and one on HEAD were both left behind', async () => {
    const tip = (await box.raw(box.remote, 'rev-parse', `refs/heads/${dana.branch}`)).stdout.trim();
    await box.raw(box.remote, 'update-ref', 'refs/heads/other', tip);
    const yossi = (await box.connect('yossi', YOSSI)).service;
    const gitDir = join(yossi.dir, '.git');
    // git creates the branch before it moves HEAD: it names the branch lock first, and the
    // single retry must not then run into the one on HEAD.
    await leftBehind(join(gitDir, 'refs', 'heads', 'other.lock'));
    await leftBehind(join(gitDir, 'HEAD.lock'));

    const again = await box.connect('yossi', YOSSI, 'other');

    expect(again.service.branch).toBe('other');
    expect(again.hasSchedule).toBe(true);
    expect((await box.raw(yossi.dir, 'symbolic-ref', '--short', 'HEAD')).stdout.trim()).toBe('other');
    expect(await locksIn(gitDir)).toEqual([]);
  });

  it('a commit that is ended on its time limit (a hook that hangs, a signing prompt nobody answers) clears the index, HEAD and branch locks it left, and not somebody\'s lock on the configuration', async () => {
    const tip = (await dana.status()).remoteSha;
    const gitDir = join(dana.dir, '.git');
    await leftBehind(join(gitDir, 'config.lock'));
    const stuck = endedByForceIn('commit', async () => {
      await leftBehind(join(gitDir, 'index.lock'));
      await leftBehind(join(gitDir, 'HEAD.lock'));
      await leftBehind(join(gitDir, 'refs', 'heads', `${dana.branch}.lock`));
    });
    const service = (await RepoService.open(stuck, dana.dir, box.remote, dana.branch))!;
    const files = { ...FIRST, [WEEK_FILE]: weekText('after a commit that hung', [E1]) };

    const result = await service.publish(files, 'Save', tip);

    if (result.ok || result.reason !== 'error') throw new Error('expected the save to report the time limit');
    expect(result.error.code).toBe('timeout');
    expect(await locksIn(gitDir)).toEqual(['config.lock']);
    await rm(join(gitDir, 'config.lock'));
    // The next save meets nothing in its way.
    const next = await dana.publish(files, 'Save', tip);
    ok(next);
    ok(await dana.publish(FIRST, 'Back', next.commitSha));
  });

  it('a push that is ended on its time limit clears the branch lock it left; the commit is taken back and the next save goes out', async () => {
    const tip = (await dana.status()).remoteSha;
    const gitDir = join(dana.dir, '.git');
    await leftBehind(join(gitDir, 'config.lock'));
    const service = (await RepoService.open(endedByForceIn('push', () => leftBehind(lock)), dana.dir, box.remote, dana.branch))!;
    const files = { ...FIRST, [WEEK_FILE]: weekText('after a push that hung', [E1]) };

    const result = await service.publish(files, 'Save', tip);

    if (result.ok || result.reason !== 'error') throw new Error('expected the save to report the time limit');
    expect(result.error.code).toBe('timeout');
    expect(result.status).toMatchObject({ headSha: tip, ahead: 0 });
    expect(await locksIn(gitDir)).toEqual(['config.lock']);
    await rm(join(gitDir, 'config.lock'));
    const next = await dana.publish(files, 'Save', tip);
    ok(next);
    ok(await dana.publish(FIRST, 'Back', next.commitSha));
  });

  it('storing the name, ended on its time limit, clears the configuration\'s lock and leaves the index and HEAD to whoever holds them', async () => {
    const gitDir = join(dana.dir, '.git');
    await leftBehind(join(gitDir, 'index.lock'));
    await leftBehind(join(gitDir, 'HEAD.lock'));
    const stuck = endedByForceIn(
      (args) => args[0] === 'config' && args[1] === 'user.name',
      () => leftBehind(join(gitDir, 'config.lock')),
    );
    const service = (await RepoService.open(stuck, dana.dir, box.remote, dana.branch))!;

    const error = await expectGitError(service.setIdentity('Dana L.', 'dana.l@example.com'));

    expect(error.code).toBe('timeout');
    expect((await locksIn(gitDir)).sort()).toEqual(['HEAD.lock', 'index.lock']);
    for (const name of ['index.lock', 'HEAD.lock']) await rm(join(gitDir, name));
  });

  it('writing the mark of what was agreed with the team (the last step of a check), ended on its time limit, clears its own lock and never the index', async () => {
    const gitDir = join(dana.dir, '.git');
    expect(await dana.status()).toMatchObject({ ahead: 0, behind: 0 });
    // Without the mark, the next look at the status writes it.
    await box.raw(dana.dir, 'update-ref', '-d', 'refs/team-schedule/synced');
    await leftBehind(join(gitDir, 'index.lock'));
    await leftBehind(join(gitDir, 'config.lock'));
    const stuck = endedByForceIn('update-ref', () => leftBehind(join(gitDir, 'refs', 'team-schedule', 'synced.lock')));
    const service = (await RepoService.open(stuck, dana.dir, box.remote, dana.branch))!;

    const error = await expectGitError(service.status());

    expect(error.code).toBe('timeout');
    expect((await locksIn(gitDir)).sort()).toEqual(['config.lock', 'index.lock']);
    for (const name of ['index.lock', 'config.lock']) await rm(join(gitDir, name));
    // The next look writes the mark.
    expect(await dana.status()).toMatchObject({ ahead: 0, behind: 0 });
    expect((await box.raw(dana.dir, 'rev-parse', 'refs/team-schedule/synced')).stdout.trim()).toBe((await dana.status()).headSha);
  });
});

// ───────────────────────────── a mistyped branch ─────────────────────────────

describe('a branch name that the repository does not have', () => {
  let box: Sandbox;
  let dana: RepoService;
  let typo = '';
  beforeAll(async () => {
    box = await createSandbox();
    dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule(FIRST, 'Create schedule'));
    typo = dana.branch === 'main' ? 'mian' : `${dana.branch}x`;
  });
  afterAll(() => box.cleanup());

  it('is refused with the branches that do exist, and nothing is created on the server', async () => {
    const error = await expectGitError(box.connect('yossi', YOSSI, typo));
    expect(error.code).toBe('branch-missing');
    expect(error.branches).toEqual([dana.branch]);
    expect(error.toSyncError()).toMatchObject({ code: 'branch-missing', branches: [dana.branch] });
    const branches = (await box.raw(box.remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).stdout.trim().split('\n');
    expect(branches).toEqual([dana.branch]);
  });

  it('connecting again with the right name simply works (the folder of the failed try is re-used)', async () => {
    const outcome = await box.connect('yossi', YOSSI, dana.branch);
    expect(outcome.hasSchedule).toBe(true);
    const snapshot = await outcome.service.loadSnapshot();
    expect(snapshot.status).toMatchObject({ ahead: 0, behind: 0 });
    expect(snapshot.workingFiles[WEEK_FILE]).toBe(FIRST[WEEK_FILE]);
  });

  it('a second schedule on a new branch is possible, but only when it is asked for by name', async () => {
    const outcome = await RepoService.connect(box.git, {
      url: box.remote,
      dir: box.dirOf('noa'),
      branch: 'second-course',
      userName: 'Noa',
      userEmail: 'noa@example.com',
      createBranch: true,
    });
    expect(outcome.service.branch).toBe('second-course');
    expect((await outcome.service.status()).remoteSha).toBeNull();
  });

  it('a repository without any branch takes whatever name is given: there is nothing to mistype against', async () => {
    const empty = await createSandbox();
    try {
      const outcome = await empty.connect('dana', DANA, 'schedule');
      expect(outcome.remoteEmpty).toBe(true);
      expect(outcome.service.branch).toBe('schedule');
    } finally {
      await empty.cleanup();
    }
  });
});

// ───────────────────────────── the team's branch is moved back ─────────────────────────────

describe('the team branch is moved back on the server (somebody undoes a bad save)', () => {
  let box: Sandbox;
  let dana: RepoService;
  let yossi: RepoService;
  let good = '';
  let bad = '';

  beforeAll(async () => {
    box = await createSandbox();
    dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule(FIRST, 'Create schedule'));
    yossi = (await box.connect('yossi', YOSSI)).service;
    good = (await dana.status()).headSha!;
    ok(await dana.publish({ ...FIRST, [WEEK_FILE]: weekText('Week 1', []) }, 'Dana deletes everything by mistake', good));
    bad = (await dana.status()).headSha!;
    await yossi.fetch(false);
    const remote = (await yossi.loadRemote())!;
    await yossi.applyUpdate(remote.files, remote.sha);
    // The admin moves the branch back to the good commit.
    await box.raw(box.remote, 'update-ref', `refs/heads/${dana.branch}`, good);
  });
  afterAll(() => box.cleanup());

  it('a computer that had updated sees an update to follow, not work of its own to publish again', async () => {
    const status = await yossi.fetch(false);
    expect(status).toMatchObject({ headSha: bad, remoteSha: good, baseSha: bad, ahead: 0, behind: 1 });
    const snapshot = await yossi.loadSnapshot();
    // Yossi edited nothing: his copy equals the last version he shared with the team.
    expect(snapshot.workingFiles[WEEK_FILE]).toBe(snapshot.baseFiles[WEEK_FILE]);
  });

  it('updating brings the restored schedule', async () => {
    const remote = (await yossi.loadRemote())!;
    expect(remote.sha).toBe(good);
    expect((await yossi.applyUpdate(remote.files, remote.sha)).ok).toBe(true);
    const snapshot = await yossi.loadSnapshot();
    expect(snapshot.status).toMatchObject({ headSha: good, remoteSha: good, ahead: 0, behind: 0 });
    expect(snapshot.workingFiles[WEEK_FILE]).toContain('"e1"');
  });

  it('edits made before the roll-back stay this user\'s unpublished work on top of the restored schedule', async () => {
    // Dana (who made the bad save) had meanwhile added a title; she still sits on the bad commit.
    await dana.writeWorking({ ...FIRST, [WEEK_FILE]: weekText('Dana names the week', []) });
    const status = await dana.fetch(false);
    expect(status).toMatchObject({ headSha: bad, remoteSha: good, baseSha: bad, ahead: 0, behind: 1 });
    const snapshot = await dana.loadSnapshot();
    // Her own change is the difference between the base and her working copy: the title only.
    expect(snapshot.baseFiles[WEEK_FILE]).toBe(weekText('Week 1', []));
    expect(snapshot.workingFiles[WEEK_FILE]).toBe(weekText('Dana names the week', []));
  });

  it('a commit that never reached the team (the app was stopped between commit and push) is still unpublished work', async () => {
    // In step with the team first …
    const remote = (await yossi.loadRemote())!;
    await yossi.applyUpdate(remote.files, remote.sha);
    expect((await yossi.status()).ahead).toBe(0);
    // … then a local commit that was never pushed.
    await yossi.writeWorking({ ...FIRST, [WEEK_FILE]: weekText('Week 1', [E1, E2]) });
    await box.raw(yossi.dir, 'add', '-A');
    await box.raw(yossi.dir, 'commit', '--quiet', '-m', 'never pushed');
    const status = await yossi.status();
    expect(status).toMatchObject({ remoteSha: good, baseSha: good, ahead: 1, behind: 0 });
    const snapshot = await yossi.loadSnapshot();
    expect(snapshot.baseFiles[WEEK_FILE]).toBe(FIRST[WEEK_FILE]);
    expect(snapshot.workingFiles[WEEK_FILE]).toContain('"e2"');
    // Saving publishes it.
    ok(await yossi.publish(snapshot.workingFiles, 'now pushed', snapshot.status.remoteSha));
    expect((await yossi.status())).toMatchObject({ ahead: 0, behind: 0 });
  });
});

// ───────────────────────────── the first schedule, second try ─────────────────────────────

describe('creating the first schedule in a repository that already has a commit', () => {
  let box: Sandbox;
  afterAll(() => box.cleanup());

  it('after one refused attempt the retry still commits .gitattributes', async () => {
    box = await createSandbox();
    // The team's repository was made on the server with a README.
    const seed = join(box.root, 'seed');
    await box.raw(box.root, 'clone', '--quiet', box.remote, seed);
    await writeFile(join(seed, 'README.md'), '# schedule\n');
    await box.raw(seed, 'config', 'user.name', 'Admin');
    await box.raw(seed, 'config', 'user.email', 'admin@example.com');
    await box.raw(seed, 'add', '-A');
    await box.raw(seed, 'commit', '--quiet', '-m', 'Initial commit');
    await box.raw(seed, 'push', '--quiet', 'origin', 'HEAD');

    const dana = (await box.connect('dana', DANA)).service;
    await box.installHook(box.remote, 'pre-receive', '#!/bin/sh\necho "refused for now" >&2\nexit 1\n');
    expect((await dana.createSchedule(FIRST, 'Create schedule')).ok).toBe(false);
    await rm(join(box.remote, 'hooks', 'pre-receive'));
    ok(await dana.createSchedule(FIRST, 'Create schedule'));

    const tree = (await box.raw(box.remote, 'ls-tree', '-r', '--name-only', dana.branch)).stdout.split('\n').filter(Boolean).sort();
    expect(tree).toEqual(['.gitattributes', 'README.md', 'schedule.json', WEEK_FILE]);
    expect((await box.raw(dana.dir, 'status', '--porcelain')).stdout).toBe('');
  });
});

// ───────────────────────────── a folder git refuses ─────────────────────────────

describe('the local folder belongs to another Windows user (copied over, restored from a backup)', () => {
  let box: Sandbox;
  afterAll(async () => {
    delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    await box.cleanup();
  });

  it('connecting again says so and names the folder to trust; the unpublished work stays where it is', async () => {
    box = await createSandbox();
    // The shared folder itself stays trusted: only the local clone is affected.
    await writeFile(join(box.root, 'global.gitconfig'), `[safe]\n\tdirectory = ${box.remote.replace(/\\/g, '/')}\n`, 'utf8');
    const dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule(FIRST, 'Create schedule'));
    await dana.writeWorking({ ...FIRST, [WEEK_FILE]: weekText('MY UNPUBLISHED WORK', [E1]) });

    // git's own switch for exactly this situation.
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';

    const atStart = await expectGitError(RepoService.open(box.git, dana.dir, dana.url, dana.branch));
    expect(atStart.code).toBe('dubious-ownership');

    const again = await expectGitError(box.connect('dana', DANA));
    expect(again.code).toBe('dubious-ownership');
    expect(again.trustPath?.replace(/\\/g, '/').toLowerCase()).toBe(dana.dir.replace(/\\/g, '/').toLowerCase());

    // Nothing was moved aside, nothing was cloned afresh.
    expect(await readdir(dirname(dana.dir))).toEqual(['dana']);
    expect(await readFile(join(dana.dir, WEEK_FILE), 'utf8')).toContain('MY UNPUBLISHED WORK');

    // Once the folder is trusted the same connect re-uses it, work included.
    delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    const trusted = await box.connect('dana', DANA);
    expect((await trusted.service.loadSnapshot()).workingFiles[WEEK_FILE]).toContain('MY UNPUBLISHED WORK');
    expect(await readdir(dirname(dana.dir))).toEqual(['dana']);
  });

  it('a folder that really is something else is still moved aside, as before', async () => {
    const stray = box.dirOf('stray');
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, 'notes.txt'), 'not a repository');
    const outcome = await box.connect('stray', YOSSI);
    expect(outcome.hasSchedule).toBe(true);
    const siblings = await readdir(dirname(stray));
    expect(siblings.filter((name) => name.startsWith('stray.old-'))).toHaveLength(1);
  });
});

// ───────────────────────────── a server that does not answer ─────────────────────────────

describe('a check for updates that waits for a server that does not answer', () => {
  let box: Sandbox;
  afterAll(() => box.cleanup());

  it('does not hold back writing edits to the working folder', async () => {
    box = await createSandbox();
    const dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule(FIRST, 'Create schedule'));
    const HANG_MS = 3000;
    let fetches = 0;
    let running = 0;
    let overlapped = false;
    const slow: GitRunner = {
      gitPath: box.git.gitPath,
      async run(args, options) {
        if (args[0] !== 'fetch') return box.git.run(args, options);
        fetches += 1;
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, HANG_MS));
        try {
          return await box.git.run(args, options);
        } finally {
          running -= 1;
        }
      },
    };
    const service = (await RepoService.open(slow, dana.dir, dana.url, dana.branch))!;

    const background = service.fetch(false);
    const second = service.fetch(false);
    const started = Date.now();
    await service.writeWorking({ ...FIRST, [WEEK_FILE]: weekText('edited while the server is silent', [E1]) });
    const snapshot = await service.loadSnapshot();
    const waited = Date.now() - started;

    expect(waited).toBeLessThan(HANG_MS / 2);
    expect(snapshot.workingFiles[WEEK_FILE]).toContain('edited while the server is silent');
    expect(await readFile(join(dana.dir, WEEK_FILE), 'utf8')).toContain('edited while the server is silent');

    // Network commands themselves still run strictly one after another.
    await background;
    await second;
    expect(fetches).toBe(2);
    expect(overlapped).toBe(false);
    await service.idle();
  });
});

describe('the app is closed while a check for updates waits for a server that does not answer', () => {
  let box: Sandbox;
  let server: SilentServer;
  /** Dana's clone, with its `origin` pointed at the server that never answers. */
  let service: RepoService;
  let dir = '';

  beforeAll(async () => {
    box = await createSandbox();
    server = await startSilentServer();
    const dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule(FIRST, 'Create schedule'));
    dir = dana.dir;
    await box.raw(dir, 'remote', 'set-url', 'origin', server.url);
    service = (await RepoService.open(box.git, dir, server.url, dana.branch))!;
  });
  afterAll(async () => {
    await server.close();
    await box.cleanup();
  });

  it('stopFetch() ends the waiting check at once: it comes back like one that ran into its time limit', async () => {
    const before = server.connections();
    const started = Date.now();
    const check = service.fetch(false);
    await server.waitForConnections(before + 1);
    // Still waiting: the quiet check would go on for 45 seconds.
    expect(await Promise.race([check.then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 300))])).toBe('waiting');

    service.stopFetch();
    const status = await check;

    expect(status.fetchError?.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(30_000);
    // Everything of the service is over, which is what the closing app waits for.
    await service.idle();
    // The schedule itself was not touched.
    expect(status.headSha).not.toBeNull();
    expect(await readFile(join(dir, WEEK_FILE), 'utf8')).toBe(FIRST[WEEK_FILE]);
  });

  it('after that, a further check does not ask the server at all', async () => {
    const before = server.connections();
    const started = Date.now();
    const status = await service.fetch(false);

    expect(status.fetchError?.code).toBe('timeout');
    expect(server.connections()).toBe(before);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a check that was only queued behind the waiting one is not started either', async () => {
    const fresh = (await RepoService.open(box.git, dir, server.url, service.branch))!;
    const before = server.connections();
    const first = fresh.fetch(false);
    const second = fresh.fetch(true);
    await server.waitForConnections(before + 1);

    fresh.stopFetch();

    expect((await first).fetchError?.code).toBe('timeout');
    expect((await second).fetchError?.code).toBe('timeout');
    expect(server.connections()).toBe(before + 1);
    await fresh.idle();
  });

  it('a check that is ended by force leaves no lock on the branches behind, whatever it was writing in that moment', async () => {
    const fresh = (await RepoService.open(box.git, dir, server.url, service.branch))!;
    const before = server.connections();
    const check = fresh.fetch(false);
    await server.waitForConnections(before + 1);
    // What a git leaves that is ended while it writes branches. (Put there by hand: this
    // server never lets git get that far, and a real one only for a few milliseconds.)
    const origin = join(dir, '.git', 'refs', 'remotes', 'origin');
    await mkdir(join(origin, 'extra'), { recursive: true });
    for (const name of [`${service.branch}.lock`, join('extra', 'a.lock'), join('extra', 'b.lock')]) await writeFile(join(origin, name), '');
    await writeFile(join(dir, '.git', 'packed-refs.lock'), '');
    const stoppedAt = Date.now();

    fresh.stopFetch();
    const status = await check;

    expect(status.fetchError?.code).toBe('timeout');
    const left = (await readdir(join(dir, '.git', 'refs'), { recursive: true })).filter((name) => name.endsWith('.lock'));
    expect(left).toEqual([]);
    expect(await readdir(join(dir, '.git'))).not.toContain('packed-refs.lock');
    // These locks were brand new, so they were given their moment first (about two seconds).
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(1500);
    await fresh.idle();
  });

  it('the locks of the index, HEAD and the configuration are not a check\'s business: ended by force, it leaves them where they are', async () => {
    const fresh = (await RepoService.open(box.git, dir, server.url, service.branch))!;
    const before = server.connections();
    const check = fresh.fetch(false);
    await server.waitForConnections(before + 1);
    // Somebody is working in this folder with git by hand, and has been for a while: an
    // editor opened by `git commit` keeps the index locked for as long as it is open.
    const gitDir = join(dir, '.git');
    const longAgo = new Date(Date.now() - 60_000);
    const theirs = ['index.lock', 'HEAD.lock', 'config.lock'].map((name) => join(gitDir, name));
    const branchLock = join(gitDir, 'refs', 'remotes', 'origin', `${service.branch}.lock`);
    for (const path of [...theirs, branchLock]) {
      await writeFile(path, '');
      await utimes(path, longAgo, longAgo);
    }

    fresh.stopFetch();
    const status = await check;

    expect(status.fetchError?.code).toBe('timeout');
    expect(await readdir(gitDir)).toEqual(expect.arrayContaining(['index.lock', 'HEAD.lock', 'config.lock']));
    // What a check itself can leave is cleared as before.
    expect((await readdir(join(gitDir, 'refs'), { recursive: true })).filter((name) => name.endsWith('.lock'))).toEqual([]);
    for (const path of theirs) await rm(path);
    await fresh.idle();
  });

  it('with no lock left behind, ending a check costs no extra time', async () => {
    const fresh = (await RepoService.open(box.git, dir, server.url, service.branch))!;
    const before = server.connections();
    const check = fresh.fetch(false);
    await server.waitForConnections(before + 1);
    const stoppedAt = Date.now();

    fresh.stopFetch();
    await check;

    expect(Date.now() - stoppedAt).toBeLessThan(1500);
    await fresh.idle();
  });
});

describe('the app is closed: what stopFetch() must leave alone', () => {
  let box: Sandbox;
  afterAll(() => box.cleanup());

  it('a save still goes out: the fetch that is its first step is not a check for updates', async () => {
    box = await createSandbox();
    const dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule(FIRST, 'Create schedule'));

    dana.stopFetch();
    const files = { ...FIRST, [WEEK_FILE]: weekText('saved while closing', [E1]) };
    const result = await dana.publish(files, 'Save', (await dana.status()).remoteSha);

    ok(result);
    expect(result.commitSha).not.toBeNull();
    expect((await box.raw(box.remote, 'show', `${dana.branch}:${WEEK_FILE}`)).stdout).toContain('saved while closing');
  });

  it('local work goes on as before: edits are written and read', async () => {
    const dana = (await RepoService.open(box.git, box.dirOf('dana'), box.remote, 'main')) ?? (await box.connect('dana', DANA)).service;
    dana.stopFetch();
    await dana.writeWorking({ ...FIRST, [WEEK_FILE]: weekText('edited while closing', [E1]) });
    expect((await dana.loadSnapshot()).workingFiles[WEEK_FILE]).toContain('edited while closing');
  });
});

// ───────────────────────────── which git is run ─────────────────────────────

describe('finding git', () => {
  const original = process.cwd();
  let folder = '';
  afterAll(async () => {
    process.chdir(original);
    if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('never picks up a git.exe that merely lies in the folder the app was started from', async () => {
    const real = await detectGit();
    expect(real.found).toBe(true);
    folder = await mkdtemp(join(tmpdir(), 'team-schedule-cwd-'));
    // Any program called git.exe that answers "--version" like git would do as a plant.
    // (cmd\git.exe is only a launcher that needs its install folder; the program itself is mingw64\bin\git.exe.)
    const program = /\\cmd\\git\.exe$/i.test(real.path!) ? real.path!.replace(/\\cmd\\git\.exe$/i, '\\mingw64\\bin\\git.exe') : real.path!;
    await copyFile(program, join(folder, process.platform === 'win32' ? 'git.exe' : 'git'));
    process.chdir(folder);

    const picked = await detectGit();
    expect(picked.path?.toLowerCase()).toBe(real.path!.toLowerCase());
  });

  it('skips PATH entries that mean "the current folder"', async () => {
    const real = await detectGit();
    const saved = process.env.PATH;
    try {
      process.env.PATH = ['.', '', 'relative\\folder', saved ?? ''].join(process.platform === 'win32' ? ';' : ':');
      const picked = await detectGit();
      expect(picked.path?.toLowerCase()).toBe(real.path!.toLowerCase());
    } finally {
      process.env.PATH = saved;
    }
  });
});

// The cases below were found by the review of the first round of fixes (pull request #1).

// ───────────────────────────── a save after a save whose commit failed ─────────────────────────────

describe('a save after one whose commit failed (its files were left staged)', () => {
  const WEEK2 = '2026-11-29';
  const WEEK2_FILE = `weeks/${WEEK2}.json`;
  const BOTH: FileMap = { ...FIRST, [WEEK2_FILE]: weekText('Week 2', [], WEEK2) };
  let box: Sandbox;
  let dana: RepoService;

  beforeEach(async () => {
    box = await createSandbox();
    dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule(BOTH, 'Create schedule'));
  });
  afterEach(() => box.cleanup());

  /** A save that gets as far as `git add` and is then refused, as by a cancelled signing prompt. */
  async function saveThatFailsAtCommit(files: FileMap): Promise<void> {
    await box.installHook(join(dana.dir, '.git'), 'pre-commit', '#!/bin/sh\necho "commit refused for now" >&2\nexit 1\n');
    const refused = await dana.publish(files, 'refused', (await dana.status()).remoteSha);
    expect(refused.ok).toBe(false);
    await rm(join(dana.dir, '.git', 'hooks', 'pre-commit'));
    // This is the state the next save starts from: the change is staged, nothing is committed.
    expect((await box.raw(dana.dir, 'diff', '--cached', '--name-only')).stdout.trim()).not.toBe('');
  }

  it('what was discarded after the failed save is not published by the next one', async () => {
    // Save 1: Dana wipes week 1 by mistake. The commit fails. She discards her changes.
    await saveThatFailsAtCommit({ ...BOTH, [WEEK_FILE]: weekText('MISTAKE', []) });
    expect((await dana.discardLocal()).workingFiles[WEEK_FILE]).toBe(BOTH[WEEK_FILE]);

    // Save 2: only week 2 is edited.
    const edited = { ...BOTH, [WEEK2_FILE]: weekText('Week 2 edited', [], WEEK2) };
    ok(await dana.publish(edited, 'Edit week 2', (await dana.status()).remoteSha));

    const touched = (await box.raw(box.remote, 'show', '--name-only', '--format=', dana.branch)).stdout.trim().split('\n');
    expect(touched).toEqual([WEEK2_FILE]);
    expect((await box.raw(box.remote, 'cat-file', 'blob', `${dana.branch}:${WEEK_FILE}`)).stdout).toBe(BOTH[WEEK_FILE]);
    expect((await box.raw(dana.dir, 'status', '--porcelain')).stdout).toBe('');
  });

  it('a removal whose commit failed is saved on the next try', async () => {
    const withoutWeek2: FileMap = { 'schedule.json': CONFIG_TEXT, [WEEK_FILE]: BOTH[WEEK_FILE] };
    await saveThatFailsAtCommit(withoutWeek2);

    ok(await dana.publish(withoutWeek2, 'Remove week 2', (await dana.status()).remoteSha));

    const tree = (await box.raw(box.remote, 'ls-tree', '-r', '--name-only', dana.branch)).stdout.split('\n').filter(Boolean);
    expect(tree).not.toContain(WEEK2_FILE);
    expect(tree).toContain(WEEK_FILE);
  });

  it('a file somebody staged by hand in the app\'s folder does not ride along either', async () => {
    await writeFile(join(dana.dir, 'notes.txt'), 'not part of the schedule');
    await box.raw(dana.dir, 'add', 'notes.txt');

    ok(await dana.publish({ ...BOTH, [WEEK_FILE]: weekText('Week 1 renamed', [E1]) }, 'Rename week 1', (await dana.status()).remoteSha));

    const touched = (await box.raw(box.remote, 'show', '--name-only', '--format=', dana.branch)).stdout.trim().split('\n');
    expect(touched).toEqual([WEEK_FILE]);
    // The file itself is still there, merely not staged any more.
    expect(await readFile(join(dana.dir, 'notes.txt'), 'utf8')).toBe('not part of the schedule');
  });
});

// ───────────────────────────── a branch name in the wrong case ─────────────────────────────

describe('a branch name that differs from the team branch only in upper / lower case', () => {
  let box: Sandbox;
  afterAll(() => box.cleanup());

  it('is refused also in a clone that is re-used, where a Windows disk finds the branch under either spelling', async () => {
    box = await createSandbox();
    const dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule(FIRST, 'Create schedule'));
    const typo = dana.branch.charAt(0).toUpperCase() + dana.branch.slice(1); // "Main" / "Master"
    expect(typo).not.toBe(dana.branch);

    // Yossi is connected and has received one update, as every working clone has.
    const yossi = (await box.connect('yossi', YOSSI)).service;
    ok(await dana.publish({ ...FIRST, [WEEK_FILE]: weekText('Week 1 b', [E1]) }, 'change', (await dana.status()).remoteSha));
    await yossi.fetch(false);
    const remote = (await yossi.loadRemote())!;
    expect((await yossi.applyUpdate(remote.files, remote.sha)).ok).toBe(true);

    // He lands on the set-up screen again and types the branch with a capital letter.
    const error = await expectGitError(box.connect('yossi', YOSSI, typo));
    expect(error.code).toBe('branch-missing');
    expect(error.branches).toEqual([dana.branch]);

    // The clone is as it was, and still works under the right name.
    const again = await box.connect('yossi', YOSSI, dana.branch);
    expect(again.service.branch).toBe(dana.branch);
    expect((await again.service.status())).toMatchObject({ ahead: 0, behind: 0 });
    const branches = (await box.raw(box.remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).stdout.trim().split('\n');
    expect(branches).toEqual([dana.branch]);
  });
});

// ───────────────────────────── who last edited, with a merge in the history ─────────────────────────────

describe('who last edited an event, when two branches were merged outside the app', () => {
  let box: Sandbox;
  afterEach(() => box.cleanup());

  it.each([
    ['the branch that edits A is committed last', true],
    ['the branch that adds C is committed last', false],
  ])('%s: A belongs to Xavier, C to Yael, B to Dana, and nothing to whoever merged', async (_name, editLast) => {
    box = await createSandbox();
    const A = ev('aaa', 0, 'A');
    const B = ev('bbb', 1, 'B');
    const C = ev('ccc', 3, 'C');
    const dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule({ 'schedule.json': CONFIG_TEXT, [WEEK_FILE]: serializeWeek(week([A, B])) }, 'Dana creates A and B'));

    const outside = join(box.root, 'outsider');
    await box.raw(box.root, 'clone', '--quiet', box.remote, outside);
    const file = join(outside, ...WEEK_FILE.split('/'));
    const commitAs = async (who: string, message: string): Promise<void> => {
      await box.raw(outside, 'add', '-A');
      await box.raw(outside, '-c', `user.name=${who}`, '-c', `user.email=${who.toLowerCase()}@example.com`, 'commit', '--quiet', '-m', message);
    };
    const editA = async (): Promise<void> => {
      await box.raw(outside, 'checkout', '--quiet', '-b', 'x', `origin/${dana.branch}`);
      await writeFile(file, serializeWeek(week([{ ...A, title: 'A edited by Xavier' }, B])));
      await commitAs('Xavier', 'Xavier edits A');
    };
    const addC = async (): Promise<void> => {
      await box.raw(outside, 'checkout', '--quiet', '-b', 'y', `origin/${dana.branch}`);
      await writeFile(file, serializeWeek(week([A, B, C])));
      await commitAs('Yael', 'Yael adds C');
    };
    if (editLast) {
      await addC();
      await editA();
    } else {
      await editA();
      await addC();
    }
    // Somebody merges the two branches; the result holds both changes.
    await box.raw(outside, 'checkout', '--quiet', 'x');
    await box.raw(outside, '-c', 'user.name=Merger', '-c', 'user.email=m@example.com', 'merge', '--quiet', '--no-ff', '--no-commit', '-s', 'ours', 'y');
    await writeFile(file, serializeWeek(week([{ ...A, title: 'A edited by Xavier' }, B, C])));
    await commitAs('Merger', 'Merge branch y');
    await box.raw(outside, 'push', '--quiet', 'origin', `HEAD:${dana.branch}`);

    const yossi = (await box.connect('yossi', YOSSI)).service;
    const blame = await yossi.blame(WEEK);

    expect(blame.events.aaa?.authorName).toBe('Xavier');
    expect(blame.events.ccc?.authorName).toBe('Yael');
    expect(blame.events.bbb?.authorName).toBe(DANA.name);
    expect(blame.title?.summary).toBe('Dana creates A and B');
  });

  it('what a merge itself changed (a hand-made resolution) belongs to whoever merged', async () => {
    box = await createSandbox();
    const A = ev('aaa', 0, 'A');
    const dana = (await box.connect('dana', DANA)).service;
    ok(await dana.createSchedule({ 'schedule.json': CONFIG_TEXT, [WEEK_FILE]: serializeWeek(week([A])) }, 'Dana creates A'));

    const outside = join(box.root, 'outsider');
    await box.raw(box.root, 'clone', '--quiet', box.remote, outside);
    const file = join(outside, ...WEEK_FILE.split('/'));
    const commitAs = async (who: string, message: string): Promise<void> => {
      await box.raw(outside, 'add', '-A');
      await box.raw(outside, '-c', `user.name=${who}`, '-c', `user.email=${who.toLowerCase()}@example.com`, 'commit', '--quiet', '-m', message);
    };
    await box.raw(outside, 'checkout', '--quiet', '-b', 'x', `origin/${dana.branch}`);
    await writeFile(file, serializeWeek(week([{ ...A, title: 'Xavier says' }])));
    await commitAs('Xavier', 'Xavier renames A');
    await box.raw(outside, 'checkout', '--quiet', '-b', 'y', `origin/${dana.branch}`);
    await writeFile(file, serializeWeek(week([{ ...A, title: 'Yael says' }])));
    await commitAs('Yael', 'Yael renames A');
    await box.raw(outside, 'checkout', '--quiet', 'x');
    await box.raw(outside, '-c', 'user.name=Merger', '-c', 'user.email=m@example.com', 'merge', '--quiet', '--no-ff', '--no-commit', '-s', 'ours', 'y');
    // Neither side's title: the merger writes a third one.
    await writeFile(file, serializeWeek(week([{ ...A, title: 'Settled by the merger' }])));
    await commitAs('Merger', 'Merge branch y');
    await box.raw(outside, 'push', '--quiet', 'origin', `HEAD:${dana.branch}`);

    const blame = await (await box.connect('yossi', YOSSI)).service.blame(WEEK);
    expect(blame.events.aaa?.authorName).toBe('Merger');
  });
});
