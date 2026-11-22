/**
 * Tests for classifyGitFailure() and GitError in src/main/git/gitRunner.ts, with the
 * texts git, ssh and the usual hosts really print.
 */
import { describe, expect, it } from 'vitest';
import type { SyncErrorCode } from '@shared/api';
import { GitError, classifyGitFailure } from '../../src/main/git/gitRunner';

function classify(stderr: string, patch: Partial<Parameters<typeof classifyGitFailure>[0]> = {}) {
  return classifyGitFailure({ args: ['fetch', 'origin'], stdout: '', stderr, exitCode: 128, timedOut: false, ...patch });
}

const SSH_TAIL =
  'fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n';

const DUBIOUS_SHARE = [
  "fatal: detected dubious ownership in repository at '//server/share/repo.git'",
  "'//server/share/repo.git' is owned by:",
  "\t'S-1-5-21-1111111111-2222222222-3333333333-1001'",
  'but the current user is:',
  "\t'S-1-5-21-1111111111-2222222222-3333333333-1002'",
  'To add an exception for this directory, call:',
  '',
  "\tgit config --global --add safe.directory '%(prefix)///server/share/repo.git'",
  '',
].join('\n');

describe('classifyGitFailure: categories', () => {
  const cases: Array<[label: string, stderr: string, code: SyncErrorCode]> = [
    // ── not-found ──
    ['GitHub over https, no such repository', "remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found\n", 'not-found'],
    ['GitHub over ssh, no such repository', `ERROR: Repository not found.\n${SSH_TAIL}`, 'not-found'],
    ['git itself, repository not found', "fatal: repository 'https://example.com/team/none.git/' not found\n", 'not-found'],
    ['a local folder that is no repository', `fatal: 'C:/x/repo.git' does not appear to be a git repository\n${SSH_TAIL}`, 'not-found'],
    ['a shared folder that is not there (clone)', "fatal: repository '//server/share/none.git' does not exist\n", 'not-found'],
    ['http 404', "fatal: unable to access 'https://example.com/x.git/': The requested URL returned error: 404\n", 'not-found'],
    // ── auth ──
    ['wrong password', "fatal: Authentication failed for 'https://github.com/x/y.git/'\n", 'auth'],
    [
      'GitHub: password sign-in removed',
      "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/x/y.git/'\n",
      'auth',
    ],
    ['no sign-in window allowed', "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n", 'auth'],
    ['no password prompt possible', "fatal: could not read Password for 'https://example.com': No such device or address\n", 'auth'],
    ['ssh key refused', `git@github.com: Permission denied (publickey).\n${SSH_TAIL}`, 'auth'],
    ['ssh key refused, several methods', `dana@example.com: Permission denied (publickey,password).\n${SSH_TAIL}`, 'auth'],
    [
      'no permission to push (403)',
      "remote: Permission to x/y.git denied to dana.\nfatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403\n",
      'auth',
    ],
    ['http 401', "fatal: unable to access 'https://example.com/x.git/': The requested URL returned error: 401\n", 'auth'],
    ['Azure DevOps wording', "remote: TF401019: The Git repository does not exist or you do not have permissions. HTTP 403\nfatal: unable to access 'https://dev.azure.com/o/p/_git/r/': HTTP 403\n", 'auth'],
    ['GitLab wording', "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/x/y.git/'\n", 'auth'],
    [
      'credential manager without interaction',
      "fatal: Cannot prompt because user interactivity has been disabled.\nfatal: User interaction is not allowed.\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      'auth',
    ],
    // ── offline ──
    ['DNS failure', "fatal: unable to access 'https://x/': Could not resolve host: x\n", 'offline'],
    ['ssh timeout', `ssh: connect to host example.com port 22: Connection timed out\n${SSH_TAIL}`, 'offline'],
    ['ssh refused', `ssh: connect to host example.com port 22: Connection refused\n${SSH_TAIL}`, 'offline'],
    ['ssh DNS failure', `ssh: Could not resolve hostname example.com: No such host is known.\n${SSH_TAIL}`, 'offline'],
    ['https port closed', "fatal: unable to access 'https://example.com/x.git/': Failed to connect to example.com port 443 after 21050 ms: Timed out\n", 'offline'],
    ['connection reset', "fatal: unable to access 'https://example.com/x.git/': Recv failure: Connection was reset\n", 'offline'],
    ['network unreachable', `ssh: connect to host example.com port 22: Network is unreachable\n${SSH_TAIL}`, 'offline'],
    ['connection dropped half way', 'error: RPC failed; curl 56 Recv failure\nfatal: early EOF\nfatal: The remote end hung up unexpectedly\n', 'offline'],
    ['only the generic ssh tail', SSH_TAIL, 'offline'],
    // ── unknown ──
    ['something else entirely', "error: pathspec 'nothing' did not match any file(s) known to git\n", 'unknown'],
    ['a push that was rejected', ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'origin\'\n', 'unknown'],
    ['no output at all', '', 'unknown'],
  ];

  it.each(cases)('%s', (_label, stderr, code) => {
    const error = classify(stderr);
    expect(error.code).toBe(code);
    expect(error.message).not.toBe('');
    expect(error.detail).toBe(stderr.trim());
    expect(error.trustPath).toBeUndefined();
  });

  it('is not fooled by upper or lower case', () => {
    expect(classify('FATAL: AUTHENTICATION FAILED FOR X').code).toBe('auth');
    expect(classify('fatal: could not resolve HOST: x').code).toBe('offline');
    expect(classify('REMOTE: REPOSITORY NOT FOUND.').code).toBe('not-found');
  });

  it('looks into stdout as well, and shows stdout when stderr is empty', () => {
    const error = classify('', { stdout: "fatal: Authentication failed for 'https://example.com/x.git/'\n" });
    expect(error.code).toBe('auth');
    expect(error.detail).toBe("fatal: Authentication failed for 'https://example.com/x.git/'");
  });

  it('shows stderr when both streams have text, and treats blank stderr as empty', () => {
    expect(classify('fatal: bad\n', { stdout: 'some progress' }).detail).toBe('fatal: bad');
    expect(classify('  \n', { stdout: 'only this' }).detail).toBe('only this');
  });

  it('gives every known category a fixed, non-empty summary', () => {
    const auth = classify("fatal: Authentication failed for 'https://a/b.git/'");
    const auth2 = classify('git@github.com: Permission denied (publickey).');
    expect(auth.message).toBe(auth2.message);
    expect(auth.message.length).toBeGreaterThan(5);
  });
});

describe('classifyGitFailure: order of the checks', () => {
  it('a timeout wins over everything in the output', () => {
    const error = classify("fatal: Authentication failed for 'https://github.com/x/y.git/'\n", { timedOut: true, exitCode: null });
    expect(error.code).toBe('timeout');
    expect(error.detail).toContain('Authentication failed');
    expect(classify(DUBIOUS_SHARE, { timedOut: true, exitCode: null }).code).toBe('timeout');
    expect(classify('', { timedOut: true, exitCode: null }).code).toBe('timeout');
  });

  it('dubious ownership wins over the generic lines that follow it', () => {
    expect(classify(`${DUBIOUS_SHARE}${SSH_TAIL}`).code).toBe('dubious-ownership');
    expect(classify(`${DUBIOUS_SHARE}fatal: '//server/share/repo.git' does not appear to be a git repository\n`).code).toBe(
      'dubious-ownership',
    );
  });

  it('sign-in problems win over "not found" and "unreachable"', () => {
    expect(classify(`remote: Repository not found.\nfatal: Authentication failed for 'https://github.com/x/y.git/'\n`).code).toBe('auth');
    expect(classify(`git@github.com: Permission denied (publickey).\n${SSH_TAIL}`).code).toBe('auth');
  });

  it('"not found" wins over "unreachable"', () => {
    expect(classify(`ERROR: Repository not found.\n${SSH_TAIL}`).code).toBe('not-found');
  });
});

describe('classifyGitFailure: dubious ownership', () => {
  it('extracts the folder from git’s hint for a shared folder', () => {
    const error = classify(DUBIOUS_SHARE);
    expect(error.code).toBe('dubious-ownership');
    expect(error.trustPath).toBe('%(prefix)///server/share/repo.git');
    expect(error.detail).toBe(DUBIOUS_SHARE.trim());
  });

  it('extracts an unquoted local folder', () => {
    const error = classify(
      "fatal: detected dubious ownership in repository at 'C:/Users/dana/AppData/Roaming/team-schedule/repos/schedule-0123456789'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory C:/Users/dana/AppData/Roaming/team-schedule/repos/schedule-0123456789\n",
    );
    expect(error.trustPath).toBe('C:/Users/dana/AppData/Roaming/team-schedule/repos/schedule-0123456789');
  });

  it('copes with Windows line endings', () => {
    const error = classify(DUBIOUS_SHARE.replaceAll('\n', '\r\n'));
    expect(error.code).toBe('dubious-ownership');
    expect(error.trustPath).toBe('%(prefix)///server/share/repo.git');
  });

  it('keeps spaces inside a quoted folder', () => {
    const error = classify(
      "fatal: detected dubious ownership in repository at 'D:/Team Files/repo'\n\tgit config --global --add safe.directory 'D:/Team Files/repo'\n",
    );
    expect(error.trustPath).toBe('D:/Team Files/repo');
  });

  it('undoes git’s shell quoting of an apostrophe and an exclamation mark', () => {
    const error = classify(
      "fatal: detected dubious ownership in repository at 'D:/O'Brien/wow!/repo'\n\tgit config --global --add safe.directory 'D:/O'\\''Brien/wow'\\!'/repo'\n",
    );
    expect(error.trustPath).toBe("D:/O'Brien/wow!/repo");
  });

  it('removes double quotes as well', () => {
    const error = classify('fatal: detected dubious ownership in repository at \'D:/x\'\n\tgit config --global --add safe.directory "D:/x y"\n');
    expect(error.trustPath).toBe('D:/x y');
  });

  it('keeps Hebrew folder names', () => {
    const error = classify(
      "fatal: detected dubious ownership in repository at '//server/מערכת/repo.git'\n\tgit config --global --add safe.directory '%(prefix)///server/מערכת/repo.git'\n",
    );
    expect(error.trustPath).toBe('%(prefix)///server/מערכת/repo.git');
  });

  it('reports the category without a folder when git gave no hint', () => {
    const error = classify("fatal: detected dubious ownership in repository at '//server/share/repo.git'\n");
    expect(error.code).toBe('dubious-ownership');
    expect(error.trustPath).toBeUndefined();
  });

  it('finds the hint in stdout too', () => {
    const error = classify('', { stdout: DUBIOUS_SHARE });
    expect(error.code).toBe('dubious-ownership');
    expect(error.trustPath).toBe('%(prefix)///server/share/repo.git');
  });
});

describe('classifyGitFailure: a missing path', () => {
  const missing = "fatal: '//server/share/repo.git': No such file or directory\n";

  it.each([['clone'], ['fetch'], ['pull'], ['push'], ['ls-remote']])('means "not reachable" for git %s', (command) => {
    expect(classify(missing, { args: [command, 'origin'] }).code).toBe('offline');
  });

  it('finds the subcommand behind options that take a value', () => {
    expect(classify(missing, { args: ['-c', 'core.quotepath=false', '-c', 'protocol.ext.allow=never', 'fetch', 'origin'] }).code).toBe('offline');
    expect(classify(missing, { args: ['-C', 'fetch', '--no-pager', 'ls-remote', '--heads', 'origin'] }).code).toBe('offline');
    expect(classify(missing, { args: ['--git-dir', 'push', '--work-tree', 'clone', 'status'] }).code).toBe('unknown');
  });

  it('means nothing special for a local command', () => {
    const error = classify("fatal: cannot open 'weeks/2026-11-22.json': No such file or directory\n", { args: ['show', 'HEAD:weeks/2026-11-22.json'] });
    expect(error.code).toBe('unknown');
    expect(classify(missing, { args: ['-C', 'clone', 'status'] }).code).toBe('unknown');
    expect(classify(missing, { args: ['commit', '-m', 'push'] }).code).toBe('unknown');
  });
});

describe('classifyGitFailure: unknown failures', () => {
  it('names the command and the exit code', () => {
    expect(classify('error: nope', { args: ['checkout', 'main'], exitCode: 1 }).message).toBe('git checkout failed with exit code 1');
    expect(classify('error: nope', { args: ['-c', 'a=b', 'commit', '-m', 'x'], exitCode: 128 }).message).toBe(
      'git commit failed with exit code 128',
    );
  });

  it('says "was stopped" when there is no exit code', () => {
    expect(classify('', { args: ['fetch'], exitCode: null }).message).toBe('git fetch was stopped');
  });

  it('says just "git" when there is no subcommand', () => {
    expect(classify('', { args: [], exitCode: 129 }).message).toBe('git failed with exit code 129');
    expect(classify('', { args: ['--version'], exitCode: 1 }).message).toBe('git failed with exit code 1');
    expect(classify('', { args: ['-c'], exitCode: 1 }).message).toBe('git failed with exit code 1');
  });
});

describe('classifyGitFailure: detail', () => {
  it('masks a password inside an address', () => {
    const error = classify("fatal: unable to access 'https://user:secret@host.example/team/x.git/': Could not resolve host: host.example\n");
    expect(error.code).toBe('offline');
    expect(error.detail).not.toContain('secret');
    expect(error.detail).toContain('https://user:***@host.example/team/x.git/');
  });

  it('masks a token used as the user name', () => {
    const error = classify("fatal: Authentication failed for 'https://ghp_AbCdEf0123456789@github.com/x/y.git/'\n");
    expect(error.detail).not.toContain('ghp_AbCdEf0123456789');
    expect(error.detail).toContain('https://***@github.com/x/y.git/');
  });

  it('masks every address in the output, in stdout as well, whatever the case of the scheme', () => {
    const text = [
      'Cloning into bare repository ...',
      "fatal: unable to access 'HTTPS://dana:pw1@one.example/x.git/': boom",
      'error: failed to push some refs to "http://bot:pw2@two.example/y.git"',
      'see https://x-access-token:pw3@three.example/z.git for details',
    ].join('\n');
    for (const error of [classify(text), classify('', { stdout: text })]) {
      expect(error.detail).not.toMatch(/pw[123]/);
      expect(error.detail).toContain('dana:***@one.example');
      expect(error.detail).toContain('bot:***@two.example');
      expect(error.detail).toContain('x-access-token:***@three.example');
    }
  });

  it('leaves an address without credentials and an ssh address alone', () => {
    const text = "fatal: repository 'https://github.com/x/y.git/' not found\nand git@github.com:x/y.git";
    expect(classify(text).detail).toBe(text);
  });

  it('never puts a masked secret into the summary', () => {
    const error = classify("fatal: unable to access 'https://user:secret@host/x.git/': something new\n", { args: ['frobnicate'] });
    expect(error.message).not.toContain('secret');
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('trims the output', () => {
    expect(classify('\n\n  fatal: x  \n\n').detail).toBe('fatal: x');
  });

  it('keeps an output of exactly 4000 characters whole', () => {
    const text = 'x'.repeat(4000);
    expect(classify(text).detail).toBe(text);
  });

  it('cuts a very long output to about 4000 characters, keeping its start and its end', () => {
    const lines = Array.from({ length: 2000 }, (_unused, index) => `remote: line ${index}`);
    const text = `${lines.join('\n')}\nfatal: the last line that matters`;
    const error = classify(text);
    expect(error.detail.length).toBeLessThanOrEqual(4010);
    expect(error.detail.length).toBeGreaterThan(3900);
    expect(error.detail.startsWith('remote: line 0\nremote: line 1\n')).toBe(true);
    expect(error.detail.endsWith('fatal: the last line that matters')).toBe(true);
    expect(error.detail).toContain('\n…\n');
  });

  it('still classifies by text that was cut out of the detail', () => {
    const text = `${'a'.repeat(1500)}\nfatal: Authentication failed for 'https://example.com/x.git/'\n${'b'.repeat(6000)}`;
    const error = classify(text);
    expect(error.code).toBe('auth');
    expect(error.detail).not.toContain('Authentication failed');
  });

  it('masks credentials before cutting, so no secret survives at the seam', () => {
    const url = 'https://user:topsecretpassword@host.example/x.git';
    // The address straddles the 1000-character seam, then again the start of the kept tail.
    const text = `${'a'.repeat(985)} ${url} ${'b'.repeat(3000)} ${url} ${'c'.repeat(2990)}`;
    const error = classify(text);
    expect(error.detail).not.toContain('topsecret');
    expect(error.detail).not.toContain('secretpassword');
  });
});

describe('GitError', () => {
  it('carries the SyncError and gives it back unchanged', () => {
    const sync = classify(DUBIOUS_SHARE);
    const error = new GitError(sync, 128);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GitError');
    expect(error.message).toBe(sync.message);
    expect(error.code).toBe('dubious-ownership');
    expect(error.exitCode).toBe(128);
    expect(error.trustPath).toBe('%(prefix)///server/share/repo.git');
    expect(error.toSyncError()).toEqual(sync);
  });

  it('has no trustPath and may have no exit code for other failures', () => {
    const error = new GitError(classify('', { timedOut: true, exitCode: null }), null);
    expect(error.code).toBe('timeout');
    expect(error.exitCode).toBeNull();
    expect(error.toSyncError().trustPath).toBeUndefined();
  });
});
