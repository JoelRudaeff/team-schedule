/**
 * Git sequences that an independent review of version 1.0.0 found broken. Each test pins
 * the corrected behaviour against real temporary repositories.
 */
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublishResult } from '@shared/api';
import { RAW_BYTES_PREFIX, buildFileMap, filesToDataset, serializeWeek } from '@shared/serialize';
import type { FileMap, ScheduleEvent, WeekData } from '@shared/types';
import { GitError, detectGit, type GitRunner } from '../../src/main/git/gitRunner';
import { RepoService, fileBytesOf, fileTextOf } from '../../src/main/git/repoService';
import { CONFIG_TEXT, DANA, WEEK, WEEK_FILE, YOSSI, createSandbox, eventLine, weekText, type Sandbox } from './helpers';

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
