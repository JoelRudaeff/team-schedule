/**
 * RepoService against real git: a bare "team" repository and several clones, each made
 * through RepoService.connect with its own identity.
 */
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublishResult } from '@shared/api';
import type { FileMap } from '@shared/types';
import { GitError } from '../../src/main/git/gitRunner';
import { RepoService } from '../../src/main/git/repoService';
import {
  CONFIG_TEXT,
  DANA,
  NOA,
  WEEK,
  WEEK_FILE,
  YOSSI,
  createSandbox,
  eventLine,
  readText,
  shPath,
  weekText,
  type Sandbox,
} from './helpers';

const E1 = eventLine('e1', 0, '09:00', '10:30', 'מבוא ל-Docker');
const E2 = eventLine('e2', 2, '13:00', '14:00', 'Lab');
const FIRST: FileMap = { 'schedule.json': CONFIG_TEXT, [WEEK_FILE]: weekText('Week 1', [E1, E2]) };

function expectOk(result: PublishResult): asserts result is Extract<PublishResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.reason}: ${result.reason === 'error' ? result.error.detail : ''}`);
  }
}

/** A team repository that already has a schedule (published by Dana) and a second member (Yossi). */
async function teamOfTwo(globalConfig = ''): Promise<{ box: Sandbox; dana: RepoService; yossi: RepoService }> {
  const box = await createSandbox(globalConfig);
  const dana = (await box.connect('dana', DANA)).service;
  expectOk(await dana.createSchedule(FIRST, 'Create schedule'));
  const yossi = (await box.connect('yossi', YOSSI)).service;
  return { box, dana, yossi };
}

/** Publishes `files` from `who`, based on whatever the team's tip is right now. */
async function publishNow(who: RepoService, files: FileMap, message: string): Promise<string> {
  const status = await who.fetch(false);
  if (status.behind > 0) {
    const remote = await who.loadRemote();
    if (!remote) throw new Error('fixture: no remote');
    const moved = await who.applyUpdate(files, remote.sha);
    if (!moved.ok) throw new Error('fixture: applyUpdate failed');
  }
  const result = await who.publish(files, message, (await who.status()).remoteSha);
  expectOk(result);
  if (result.commitSha === null) throw new Error('fixture: nothing was published');
  return result.commitSha;
}

describe('starting a schedule in an empty repository', () => {
  let box: Sandbox;
  let dana: RepoService;
  let noa: RepoService;

  beforeAll(async () => {
    // The defaults of a fresh Git for Windows, which the app must not be bothered by.
    box = await createSandbox('[core]\n\tautocrlf = true\n[init]\n\tdefaultBranch = master\n');
  });
  afterAll(() => box.cleanup());

  it('connects to an empty remote: nothing there yet, branch "main"', async () => {
    const outcome = await box.connect('dana', DANA);
    dana = outcome.service;
    expect(outcome.remoteEmpty).toBe(true);
    expect(outcome.hasSchedule).toBe(false);
    // The first schedule goes to the branch the server's HEAD names (here "master", from init.defaultBranch).
    const serverDefault = (await box.raw(box.remote, 'symbolic-ref', '--short', 'HEAD')).stdout.trim();
    expect(dana.branch).toBe(serverDefault);
    expect(await dana.status()).toMatchObject({
      headSha: null,
      remoteSha: null,
      baseSha: null,
      ahead: 0,
      behind: 0,
      incoming: [],
      fetchError: null,
    });
    expect(await dana.loadSnapshot()).toMatchObject({ baseFiles: {}, workingFiles: {} });
    expect(await dana.loadRemote()).toBeNull();
    expect(await dana.hasSchedule()).toBe(false);
    expect((await dana.blame(WEEK)).events).toEqual({});

    noa = (await box.connect('noa', NOA)).service;
  });

  it('creates and publishes the first schedule under the user\'s identity', async () => {
    const result = await dana.createSchedule(FIRST, 'Create schedule');
    expectOk(result);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.status).toMatchObject({
      headSha: result.commitSha,
      remoteSha: result.commitSha,
      baseSha: result.commitSha,
      ahead: 0,
      behind: 0,
    });
    const tree = await box.raw(box.remote, 'ls-tree', '-r', '--name-only', dana.branch);
    expect(tree.stdout.split('\n').filter(Boolean).sort()).toEqual(['.gitattributes', 'schedule.json', WEEK_FILE].sort());
    const head = await box.raw(box.remote, 'log', '-1', '--format=%an <%ae>|%s', dana.branch);
    expect(head.stdout.trim()).toBe(`${DANA.name} <${DANA.email}>|Create schedule`);
    expect(await dana.hasSchedule()).toBe(true);
  });

  it('tells a teammate who connected earlier that a schedule exists; connecting again picks it up', async () => {
    const result = await noa.createSchedule(FIRST, 'Create schedule (too late)');
    expect(result).toMatchObject({ ok: false, reason: 'remote-changed' });
    expect((await noa.loadSnapshot()).workingFiles).toEqual({});

    const again = await box.connect('noa', NOA);
    expect(again.hasSchedule).toBe(true);
    expect(again.remoteEmpty).toBe(false);
    const snapshot = await again.service.loadSnapshot();
    expect(snapshot.workingFiles).toEqual(FIRST);
    expect(snapshot.status).toMatchObject({ ahead: 0, behind: 0 });
  });

  it('gives a new teammate the files byte for byte (LF, Hebrew) despite core.autocrlf=true', async () => {
    const outcome = await box.connect('yossi', YOSSI);
    expect(outcome.remoteEmpty).toBe(false);
    expect(outcome.hasSchedule).toBe(true);
    const snapshot = await outcome.service.loadSnapshot();
    expect(snapshot.workingFiles).toEqual(FIRST);
    expect(snapshot.baseFiles).toEqual(FIRST);
    expect(await readText(join(outcome.service.dir, 'schedule.json'))).toBe(CONFIG_TEXT);
    expect(await readText(join(outcome.service.dir, 'weeks', `${WEEK}.json`))).not.toContain('\r');
  });
});

describe('publishing and updating', () => {
  let box: Sandbox;
  let dana: RepoService;
  let yossi: RepoService;
  const SECOND: FileMap = {
    ...FIRST,
    [WEEK_FILE]: weekText('Week 1', [eventLine('e1', 0, '09:00', '10:30', 'Docker basics'), E2]),
  };
  let secondSha = '';

  beforeAll(async () => {
    ({ box, dana, yossi } = await teamOfTwo());
  });
  afterAll(() => box.cleanup());

  it('publishes a change as one commit with the message as given', async () => {
    const message = 'Update schedule: events ~1 (week 2026-11-22)\n\n~ 2026-11-22 Sun 09:00-10:30 "Docker basics" (title)\nהערה בעברית';
    const before = await dana.status();
    const result = await dana.publish(SECOND, message, before.remoteSha);
    expectOk(result);
    secondSha = result.commitSha ?? '';
    expect(secondSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.status).toMatchObject({ headSha: secondSha, remoteSha: secondSha, ahead: 0, behind: 0 });
    const stored = await box.raw(box.remote, 'log', '-1', '--format=%B', dana.branch);
    expect(stored.stdout.trim()).toBe(message);
    const parent = await box.raw(box.remote, 'rev-parse', `${dana.branch}^`);
    expect(parent.stdout.trim()).toBe(before.remoteSha);
  });

  it('answers "nothing to publish" when the files already match the team', async () => {
    const result = await dana.publish(SECOND, 'no change', secondSha);
    expectOk(result);
    expect(result.commitSha).toBeNull();
    expect((await box.raw(box.remote, 'rev-parse', dana.branch)).stdout.trim()).toBe(secondSha);
  });

  it('shows the teammate that an update is available, with who and what', async () => {
    const status = await yossi.fetch(false);
    expect(status).toMatchObject({ behind: 1, ahead: 0, fetchError: null, remoteSha: secondSha });
    expect(status.baseSha).toBe(status.headSha);
    expect(status.lastFetchAt).not.toBeNull();
    expect(status.incoming).toHaveLength(1);
    expect(status.incoming[0]).toMatchObject({
      sha: secondSha,
      authorName: DANA.name,
      authorEmail: DANA.email,
      subject: 'Update schedule: events ~1 (week 2026-11-22)',
    });
    expect(Math.abs(status.incoming[0].time - Date.now())).toBeLessThan(5 * 60_000);
    expect(await yossi.loadRemote()).toEqual({ sha: secondSha, files: SECOND });
    // Fetching alone changes nothing locally.
    expect(await yossi.loadSnapshot()).toMatchObject({ baseFiles: FIRST, workingFiles: FIRST });
  });

  it('refuses an update that was prepared against an older team version', async () => {
    const firstSha = (await yossi.status()).headSha ?? '';
    const result = await yossi.applyUpdate(SECOND, firstSha);
    expect(result).toMatchObject({ ok: false, reason: 'remote-changed' });
    expect((await yossi.loadSnapshot()).workingFiles).toEqual(FIRST);
  });

  it('applies the update: local copy equals the team\'s, nothing unpublished', async () => {
    const result = await yossi.applyUpdate(SECOND, secondSha);
    expect(result.ok).toBe(true);
    expect(result.status).toMatchObject({ headSha: secondSha, remoteSha: secondSha, baseSha: secondSha, ahead: 0, behind: 0 });
    expect(await yossi.loadSnapshot()).toMatchObject({ baseFiles: SECOND, workingFiles: SECOND });
  });

  it('keeps unpublished work through an update and then publishes it on top', async () => {
    const yossiLine = eventLine('y1', 4, '10:00', '11:00', 'Yossi lesson');
    const yossiEdit: FileMap = { ...SECOND, 'weeks/2026-11-29.json': weekText('', [yossiLine], '2026-11-29') };
    await yossi.writeWorking(yossiEdit);

    const THIRD: FileMap = { ...SECOND, [WEEK_FILE]: weekText('Week 1 (updated)', [eventLine('e1', 0, '09:00', '10:30', 'Docker basics'), E2]) };
    const thirdSha = await publishNow(dana, THIRD, 'Dana renames the week');

    // Publishing against the old tip is refused before anything is written.
    const stale = await yossi.publish(yossiEdit, 'Yossi adds a lesson', secondSha);
    expect(stale).toMatchObject({ ok: false, reason: 'remote-changed' });
    expect(stale.status).toMatchObject({ headSha: secondSha, remoteSha: thirdSha, behind: 1, ahead: 0 });
    expect((await yossi.loadSnapshot()).workingFiles).toEqual(yossiEdit);

    // The renderer merges; here: Dana's week + Yossi's new week.
    const merged: FileMap = { ...THIRD, 'weeks/2026-11-29.json': yossiEdit['weeks/2026-11-29.json'] };
    const updated = await yossi.applyUpdate(merged, thirdSha);
    expect(updated.ok).toBe(true);
    expect(updated.status).toMatchObject({ headSha: thirdSha, ahead: 0, behind: 0 });
    expect(await yossi.loadSnapshot()).toMatchObject({ baseFiles: THIRD, workingFiles: merged });

    const published = await yossi.publish(merged, 'Yossi adds a lesson', thirdSha);
    expectOk(published);
    expect((await box.raw(yossi.dir, 'rev-parse', 'HEAD^')).stdout.trim()).toBe(thirdSha);
    const author = await box.raw(box.remote, 'log', '-1', '--format=%an|%ae', dana.branch);
    expect(author.stdout.trim()).toBe(`${YOSSI.name}|${YOSSI.email}`);
    expect(await yossi.loadSnapshot()).toMatchObject({ baseFiles: merged, workingFiles: merged });
  });

  it('never stages or commits files that are not schedule data', async () => {
    await writeFile(join(yossi.dir, 'notes.txt'), 'private notes', 'utf8');
    const current = (await yossi.loadSnapshot()).workingFiles;
    const next: FileMap = { ...current };
    delete next['weeks/2026-11-29.json'];
    const sha = await publishNow(yossi, next, 'Yossi removes the lesson');
    const changed = await box.raw(yossi.dir, 'show', '--name-status', '--format=', sha);
    expect(changed.stdout.trim()).toBe('D\tweeks/2026-11-29.json');
    expect((await box.raw(yossi.dir, 'status', '--porcelain')).stdout.trim()).toBe('?? notes.txt');
    expect(await readText(join(yossi.dir, 'notes.txt'))).toBe('private notes');
  });
});

describe('when publishing does not go through', () => {
  let box: Sandbox;
  let dana: RepoService;
  let yossi: RepoService;

  beforeAll(async () => {
    ({ box, dana, yossi } = await teamOfTwo());
  });
  afterAll(() => box.cleanup());

  it('undoes the commit when a teammate\'s push lands during ours (the race)', async () => {
    // Noa has a commit ready; a pre-push hook in Yossi's clone lets her push it at the worst moment.
    const noa = (await box.connect('noa', NOA)).service;
    const noaFiles: FileMap = { ...FIRST, [WEEK_FILE]: weekText('Noa was faster', [E1, E2]) };
    await noa.writeWorking(noaFiles);
    await box.raw(noa.dir, 'add', '-A');
    await box.raw(noa.dir, 'commit', '--quiet', '-m', 'Noa renames the week');
    await box.installHook(
      join(yossi.dir, '.git'),
      'pre-push',
      `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\ngit -C "${shPath(noa.dir)}" push --quiet origin HEAD:refs/heads/${noa.branch}\nexit 0\n`,
    );

    const before = await yossi.fetch(false);
    const yossiFiles: FileMap = { ...FIRST, 'weeks/2026-11-29.json': weekText('', [eventLine('y1', 1, '08:00', '09:00', 'Y')], '2026-11-29') };
    const result = await yossi.publish(yossiFiles, 'Yossi adds a week', before.remoteSha);

    expect(result).toMatchObject({ ok: false, reason: 'remote-changed' });
    expect(result.status.headSha).toBe(before.headSha);
    expect(result.status.behind).toBe(1);
    expect(result.status.ahead).toBe(0);
    expect(result.status.incoming[0]).toMatchObject({ authorName: NOA.name, subject: 'Noa renames the week' });
    // The work is still there, as unpublished changes.
    expect((await yossi.loadSnapshot()).workingFiles).toEqual(yossiFiles);
    // And the team has exactly Noa's commit, not Yossi's.
    const log = await box.raw(box.remote, 'log', '--format=%s', dana.branch);
    expect(log.stdout.trim().split('\n')).toEqual(['Noa renames the week', 'Create schedule']);
  });

  it('reports an error and undoes the commit when the server refuses the push', async () => {
    await box.installHook(box.remote, 'pre-receive', '#!/bin/sh\necho "policy: pushes are closed today" >&2\nexit 1\n');
    const before = await dana.fetch(false);
    const remote = await dana.loadRemote();
    if (!remote) throw new Error('fixture: no remote');
    expect((await dana.applyUpdate(remote.files, remote.sha)).ok).toBe(true);

    const files: FileMap = { ...remote.files, 'weeks/2026-12-06.json': weekText('December', [], '2026-12-06') };
    const result = await dana.publish(files, 'Dana adds December', before.remoteSha);
    expect(result).toMatchObject({ ok: false, reason: 'error' });
    if (result.ok || result.reason !== 'error') return;
    expect(result.error.detail).toContain('pushes are closed today');
    expect(result.status).toMatchObject({ headSha: remote.sha, remoteSha: remote.sha, ahead: 0, behind: 0 });
    expect((await dana.loadSnapshot()).workingFiles).toEqual(files);
    await box.installHook(box.remote, 'pre-receive', '#!/bin/sh\nexit 0\n');
  });

  it('reports an unreachable team repository without throwing, and recovers', async () => {
    const known = (await dana.status()).remoteSha;
    await rename(box.remote, `${box.remote}.away`);
    try {
      const status = await dana.fetch(false);
      expect(status.fetchError).not.toBeNull();
      expect(['offline', 'not-found']).toContain(status.fetchError?.code);
      expect(status.remoteSha).toBe(known);

      const blocked = await dana.publish((await dana.loadSnapshot()).workingFiles, 'will not arrive', known);
      expect(blocked).toMatchObject({ ok: false, reason: 'error' });
    } finally {
      await rename(`${box.remote}.away`, box.remote);
    }
    const status = await dana.fetch(false);
    expect(status.fetchError).toBeNull();
  });

  it('folds local commits the team never got back into unpublished work (after a crash)', async () => {
    const snapshot = await yossi.loadSnapshot();
    const remote = await yossi.loadRemote();
    if (!remote) throw new Error('fixture: no remote');
    expect((await yossi.applyUpdate(snapshot.workingFiles, remote.sha)).ok).toBe(true);
    // A crash between commit and push would leave exactly this behind.
    await box.raw(yossi.dir, 'add', '-A');
    await box.raw(yossi.dir, 'commit', '--quiet', '-m', 'half-published');

    const status = await yossi.status();
    expect(status).toMatchObject({ ahead: 1, behind: 0, baseSha: remote.sha });
    const after = await yossi.loadSnapshot();
    expect(after.baseFiles).toEqual(remote.files);
    expect(after.workingFiles).toEqual(snapshot.workingFiles);

    const result = await yossi.publish(after.workingFiles, 'Yossi adds a week', remote.sha);
    expectOk(result);
    expect(result.status).toMatchObject({ ahead: 0, behind: 0 });
    const log = await box.raw(box.remote, 'log', '--format=%s', dana.branch);
    expect(log.stdout.trim().split('\n')[0]).toBe('Yossi adds a week');
    expect(log.stdout).not.toContain('half-published');
  });
});

describe('the working folder', () => {
  let box: Sandbox;
  let dana: RepoService;

  beforeAll(async () => {
    ({ box, dana } = await teamOfTwo());
  });
  afterAll(() => box.cleanup());

  it('refuses to write anything that is not a schedule data file', async () => {
    for (const bad of ['README.md', '../evil.json', 'weeks/../schedule.json', 'C:\\Windows\\x.json', 'weeks/notes.json']) {
      await expect(dana.writeWorking({ ...FIRST, [bad]: 'x' })).rejects.toThrow(/not a schedule data file/);
    }
    // A refused request writes nothing at all.
    expect((await dana.loadSnapshot()).workingFiles).toEqual(FIRST);
  });

  it('makes the data files exactly what was asked, and leaves everything else alone', async () => {
    await writeFile(join(dana.dir, 'README.md'), 'hello', 'utf8');
    const december = weekText('דצמבר', [eventLine('d1', 3, '18:00', '19:30', 'ערב הורים')], '2026-12-06');
    const next: FileMap = { 'schedule.json': CONFIG_TEXT, 'weeks/2026-12-06.json': december };
    await dana.writeWorking(next);
    expect((await dana.loadSnapshot()).workingFiles).toEqual(next);
    expect(await readText(join(dana.dir, 'weeks', '2026-12-06.json'))).toBe(december);
    expect((await readdir(join(dana.dir, 'weeks'))).sort()).toEqual(['2026-12-06.json']);
    expect(await readText(join(dana.dir, 'README.md'))).toBe('hello');
  });

  it('discards unpublished edits', async () => {
    const snapshot = await dana.discardLocal();
    expect(snapshot.workingFiles).toEqual(FIRST);
    expect(snapshot.baseFiles).toEqual(FIRST);
    expect((await readdir(join(dana.dir, 'weeks'))).sort()).toEqual([`${WEEK}.json`]);
  });

  it('re-uses the folder on a second connect and keeps unpublished work', async () => {
    const edited: FileMap = { ...FIRST, [WEEK_FILE]: weekText('unpublished title', [E1, E2]) };
    await dana.writeWorking(edited);
    const again = await box.connect('dana', DANA);
    expect(again.service.dir).toBe(dana.dir);
    expect(again.hasSchedule).toBe(true);
    expect((await again.service.loadSnapshot()).workingFiles).toEqual(edited);
  });

  it('opens an existing clone only when it belongs to the same repository', async () => {
    expect(await RepoService.open(box.git, dana.dir, box.remote, dana.branch)).not.toBeNull();
    expect(await RepoService.open(box.git, dana.dir, `${box.remote}-other`, dana.branch)).toBeNull();
    const plain = join(box.root, 'plain-folder');
    await mkdir(plain, { recursive: true });
    expect(await RepoService.open(box.git, plain, box.remote, dana.branch)).toBeNull();
    expect(await RepoService.open(box.git, join(box.root, 'missing'), box.remote, dana.branch)).toBeNull();
  });

  it('moves a folder aside when it belongs to another repository', async () => {
    const other = join(box.root, 'other.git');
    await box.raw(box.root, 'init', '--bare', '--quiet', other);
    const outcome = await RepoService.connect(box.git, {
      url: other,
      dir: dana.dir,
      branch: null,
      userName: DANA.name,
      userEmail: DANA.email,
    });
    expect(outcome.remoteEmpty).toBe(true);
    expect(outcome.hasSchedule).toBe(false);
    const siblings = await readdir(join(box.root, 'clones'));
    const kept = siblings.find((name) => name.startsWith('dana.old-'));
    expect(kept).toBeDefined();
    // The unpublished work of the previous repository is still in the folder that was moved aside.
    expect(await readText(join(box.root, 'clones', kept ?? '', 'weeks', `${WEEK}.json`))).toContain('unpublished title');
  });

  it('fails cleanly when the repository does not exist', async () => {
    const dir = box.dirOf('nobody');
    const attempt = RepoService.connect(box.git, {
      url: join(box.root, 'no-such-repo.git'),
      dir,
      branch: null,
      userName: NOA.name,
      userEmail: NOA.email,
    });
    await expect(attempt).rejects.toBeInstanceOf(GitError);
    await expect(attempt).rejects.toMatchObject({ code: expect.stringMatching(/^(not-found|offline)$/) });
    expect(await RepoService.open(box.git, dir, join(box.root, 'no-such-repo.git'), dana.branch)).toBeNull();
  });
});

describe('who last edited what (git blame)', () => {
  let box: Sandbox;
  let dana: RepoService;
  let yossi: RepoService;

  beforeAll(async () => {
    ({ box, dana, yossi } = await teamOfTwo());
  });
  afterAll(() => box.cleanup());

  it('attributes every event line and the title to its last editor', async () => {
    const firstSha = (await dana.status()).headSha;

    // Yossi inserts an event above the others (their lines move down) and edits e2.
    const e0 = eventLine('e0', 0, '08:00', '08:45', 'Opening');
    const e2Changed = eventLine('e2', 2, '13:00', '15:00', 'Lab (long)');
    const yossiVersion: FileMap = { ...FIRST, [WEEK_FILE]: weekText('Week 1', [e0, E1, e2Changed]) };
    const yossiSha = await publishNow(yossi, yossiVersion, 'Yossi: opening + longer lab');

    // Dana only renames the week.
    const danaVersion: FileMap = { ...FIRST, [WEEK_FILE]: weekText('שבוע הפתיחה', [e0, E1, e2Changed]) };
    const danaSha = await publishNow(dana, danaVersion, 'Dana: week title');

    const blame = await dana.blame(WEEK);
    expect(blame.headSha).toBe(danaSha);
    expect(Object.keys(blame.events).sort()).toEqual(['e0', 'e1', 'e2']);
    expect(blame.events.e0).toMatchObject({ sha: yossiSha, authorName: YOSSI.name, authorEmail: YOSSI.email, summary: 'Yossi: opening + longer lab' });
    // e1 only moved down a line: still Dana's original commit.
    expect(blame.events.e1).toMatchObject({ sha: firstSha, authorName: DANA.name, summary: 'Create schedule' });
    expect(blame.events.e2).toMatchObject({ sha: yossiSha, authorName: YOSSI.name });
    expect(blame.title).toMatchObject({ sha: danaSha, authorName: DANA.name, summary: 'Dana: week title' });
    expect(Math.abs(blame.events.e0.time - Date.now())).toBeLessThan(5 * 60_000);
  });

  it('gives an empty answer for a week that has no published file', async () => {
    const blame = await dana.blame('2027-01-03');
    expect(blame.events).toEqual({});
    expect(blame.title).toBeNull();
  });

  it('stores the identity it is given', async () => {
    await yossi.setIdentity('Yossi C.', 'yc@example.com');
    const next: FileMap = { ...FIRST, [WEEK_FILE]: weekText('renamed by Yossi C.', []) };
    await publishNow(yossi, next, 'new identity');
    const author = await box.raw(box.remote, 'log', '-1', '--format=%an|%ae', dana.branch);
    expect(author.stdout.trim()).toBe('Yossi C.|yc@example.com');
  });
});

describe('unusual repository states must not cost anybody their schedule', () => {
  it('starting a schedule where schedule.json was removed by hand keeps the week files', async () => {
    const { box, dana, yossi } = await teamOfTwo();
    try {
      await box.raw(yossi.dir, 'rm', '--quiet', 'schedule.json');
      await box.raw(yossi.dir, 'commit', '--quiet', '-m', 'schedule.json removed by hand');
      await box.raw(yossi.dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${yossi.branch}`);

      // A new teammate is told "no schedule here yet" and starts one.
      const outcome = await box.connect('noa', NOA);
      expect(outcome.remoteEmpty).toBe(false);
      expect(outcome.hasSchedule).toBe(false);
      const result = await outcome.service.createSchedule({ 'schedule.json': CONFIG_TEXT }, 'Create schedule');
      expectOk(result);

      const tree = await box.raw(box.remote, 'ls-tree', '-r', '--name-only', dana.branch);
      expect(tree.stdout.split('\n').filter(Boolean).sort()).toEqual(['.gitattributes', 'schedule.json', WEEK_FILE].sort());
      expect((await outcome.service.loadSnapshot()).workingFiles).toEqual(FIRST);
      // The week's history is still the original one: the file was never deleted and re-added.
      const blame = await outcome.service.blame(WEEK);
      expect(blame.events.e1).toMatchObject({ authorName: DANA.name, summary: 'Create schedule' });
    } finally {
      await box.cleanup();
    }
  });

  it('starting a schedule keeps week files that only exist in the local folder', async () => {
    const box = await createSandbox();
    try {
      const dana = (await box.connect('dana', DANA)).service;
      await dana.writeWorking({ [WEEK_FILE]: weekText('Week 1', [E1]) });
      expectOk(await dana.createSchedule({ 'schedule.json': CONFIG_TEXT }, 'Create schedule'));
      const expected: FileMap = { 'schedule.json': CONFIG_TEXT, [WEEK_FILE]: weekText('Week 1', [E1]) };
      expect((await dana.loadSnapshot()).workingFiles).toEqual(expected);
      expect((await dana.loadRemote())?.files).toEqual(expected);
    } finally {
      await box.cleanup();
    }
  });

  it('discarding when the team\'s branch has disappeared goes back to the last version, not to nothing', async () => {
    const { box, dana } = await teamOfTwo();
    try {
      await box.raw(box.remote, 'update-ref', '-d', `refs/heads/${dana.branch}`);
      const status = await dana.fetch(false);
      expect(status).toMatchObject({ remoteSha: null, baseSha: null, fetchError: null });
      expect(status.headSha).not.toBeNull();

      await dana.writeWorking({ ...FIRST, [WEEK_FILE]: weekText('edited', [E1]) });
      const snapshot = await dana.discardLocal();
      expect(snapshot.workingFiles).toEqual(FIRST);

      // Publishing puts the schedule, history included, back on the server.
      const edited: FileMap = { ...FIRST, [WEEK_FILE]: weekText('back again', [E1, E2]) };
      const result = await dana.publish(edited, 'Publish again', null);
      expectOk(result);
      const log = await box.raw(box.remote, 'log', '--format=%s', dana.branch);
      expect(log.stdout.trim().split('\n')).toEqual(['Publish again', 'Create schedule']);
      expect(result.status).toMatchObject({ ahead: 0, behind: 0 });
    } finally {
      await box.cleanup();
    }
  });

  it('discarding in a repository without any version leaves the local files alone', async () => {
    const box = await createSandbox();
    try {
      const dana = (await box.connect('dana', DANA)).service;
      await dana.writeWorking(FIRST);
      expect((await dana.discardLocal()).workingFiles).toEqual(FIRST);
    } finally {
      await box.cleanup();
    }
  });
});

describe('a server whose default branch does not exist', () => {
  it('connects a new teammate to the branch that actually holds the schedule', async () => {
    const { box, dana } = await teamOfTwo();
    try {
      // Typical for a bare repository on a shared folder that was created with another
      // default branch name than the one the first schedule was pushed to.
      await box.raw(box.remote, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
      const outcome = await box.connect('noa', NOA);
      expect(outcome.service.branch).toBe(dana.branch);
      expect(outcome.remoteEmpty).toBe(false);
      expect(outcome.hasSchedule).toBe(true);
      expect((await outcome.service.loadSnapshot()).workingFiles).toEqual(FIRST);
      expect(await outcome.service.status()).toMatchObject({ ahead: 0, behind: 0 });
    } finally {
      await box.cleanup();
    }
  });
});
