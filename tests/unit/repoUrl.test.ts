/** Validation and display of the repository address. */
import { describe, expect, it } from 'vitest';
import { checkRepoUrl, maskRepoUrl, repoDisplayName, type RepoUrlKind } from '@shared/repoUrl';

describe('checkRepoUrl accepts', () => {
  const accepted: [string, RepoUrlKind][] = [
    ['https://github.com/team/schedule.git', 'https'],
    ['https://github.com/team/schedule', 'https'],
    ['https://dev.azure.com/org/project/_git/schedule', 'https'],
    ['https://user@host.example/team/schedule.git', 'https'],
    ['https://user:secret@host.example/team/schedule.git', 'https'],
    ['https://host.example:8443/team/schedule.git', 'https'],
    ['HTTPS://GitHub.com/team/schedule.git', 'https'],
    ['http://intranet/git/schedule.git', 'http'],
    ['http://10.0.0.5:3000/team/schedule', 'http'],
    ['ssh://host/path/repo.git', 'ssh'],
    ['ssh://git@host/path/repo.git', 'ssh'],
    ['ssh://git@host:2222/path/repo.git', 'ssh'],
    ['git://host/path/repo.git', 'git'],
    ['git@github.com:team/schedule.git', 'ssh'],
    ['git@github.com:schedule.git', 'ssh'],
    ['myserver:repos/schedule.git', 'ssh'],
    ['user@host:/srv/git/schedule.git', 'ssh'],
    ['file:///C:/repos/schedule.git', 'file'],
    ['file:///srv/git/schedule.git', 'file'],
    ['FILE:///C:/repos/schedule.git', 'file'],
    ['\\\\server\\share\\repo.git', 'file'],
    ['//server/share/repo.git', 'file'],
    ['C:\\path\\repo.git', 'file'],
    ['C:/path/repo.git', 'file'],
    ['g:\\git\\schedule', 'file'],
    ['C:\\Users\\Dana Levi\\My Repos\\schedule.git', 'file'],
    ['\\\\server\\share\\לוח זמנים.git', 'file'],
    ['/unix/path', 'file'],
    ['/srv/git/schedule.git', 'file'],
    ['./relative/repo', 'file'],
    ['../sibling/repo.git', 'file'],
    ['~/repos/schedule.git', 'file'],
  ];

  it.each(accepted)('%s as %s', (url, kind) => {
    expect(checkRepoUrl(url)).toEqual({ ok: true, url, kind });
  });

  it('trims surrounding white space', () => {
    expect(checkRepoUrl('  https://github.com/team/schedule.git \n')).toEqual({
      ok: true,
      url: 'https://github.com/team/schedule.git',
      kind: 'https',
    });
    expect(checkRepoUrl('\tC:\\path\\repo.git\r\n')).toEqual({ ok: true, url: 'C:\\path\\repo.git', kind: 'file' });
  });

  it('strips one pair of surrounding quotes (as pasted from "Copy as path")', () => {
    expect(checkRepoUrl('"C:\\my repos\\schedule.git"')).toEqual({ ok: true, url: 'C:\\my repos\\schedule.git', kind: 'file' });
    expect(checkRepoUrl("'https://github.com/team/schedule.git'")).toEqual({
      ok: true,
      url: 'https://github.com/team/schedule.git',
      kind: 'https',
    });
    expect(checkRepoUrl('  " \\\\server\\share\\repo.git "  ')).toEqual({ ok: true, url: '\\\\server\\share\\repo.git', kind: 'file' });
  });

  it('never returns the quotes or outer spaces in the url', () => {
    for (const input of ['"git@github.com:team/schedule.git"', " 'git@github.com:team/schedule.git' "]) {
      const result = checkRepoUrl(input);
      expect(result).toEqual({ ok: true, url: 'git@github.com:team/schedule.git', kind: 'ssh' });
    }
  });
});

describe('checkRepoUrl rejects', () => {
  it.each(['', ' ', '\t\n', '""', "''", '"  "'])('%j as empty', (input) => {
    expect(checkRepoUrl(input)).toEqual({ ok: false, reason: 'empty' });
  });

  it.each([
    '-upload-pack=x',
    '--upload-pack=touch /tmp/x',
    '-u',
    '-',
    '  -upload-pack=x',
    '"-upload-pack=x"',
    "'--config=core.sshCommand=x'",
    '-oProxyCommand=calc:repo',
  ])('%j as unsafe (would be read as an option)', (input) => {
    expect(checkRepoUrl(input)).toEqual({ ok: false, reason: 'unsafe' });
  });

  it.each([
    'ext::sh -c x',
    'ext::sh -c "touch /tmp/x"',
    'fd::17',
    'fd::17/foo',
    'foo::https://host/x.git',
    'EXT::sh -c x',
    'a::b',
    'remote-helper+x.y-z::address',
    '"ext::sh -c x"',
    "'ext::sh -c x'",
    '  ext::sh -c x  ',
  ])('%j as unsafe (transport helper)', (input) => {
    expect(checkRepoUrl(input)).toEqual({ ok: false, reason: 'unsafe' });
  });

  it.each([
    'https://host/a\u0000b',
    'https://host/a\nb',
    'https://host/a\rb',
    'https://host/a\tb',
    'https://host/a\u001bb',
    'https://host/a\u007fb',
    'C:\\path\\re\u0007po.git',
    'git@host:team/\u0001x.git',
  ])('%j as unsafe (control character)', (input) => {
    expect(checkRepoUrl(input)).toEqual({ ok: false, reason: 'unsafe' });
  });

  it.each([
    'ftp://host/x',
    'ftps://host/x',
    'sftp://host/x',
    'rsync://host/x',
    'javascript://x/y',
    'schedule',
    'my repo',
    'github.com/team/schedule',
    'team/schedule',
    'https://',
    'https://host',
    'https://host/',
    'http://host',
    'ssh://host',
    'git://host',
    'C:',
    '"https://host/x.git',
    '.',
    '..',
    '@',
    ':',
  ])('%j as unsupported', (input) => {
    expect(checkRepoUrl(input)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('does not mistake a Windows drive path for a transport helper or scp address', () => {
    expect(checkRepoUrl('C:\\a::b\\repo.git')).toEqual({ ok: true, url: 'C:\\a::b\\repo.git', kind: 'file' });
    expect(checkRepoUrl('D:/x')).toMatchObject({ ok: true, kind: 'file' });
  });

  it('a drive letter followed by "::" is still a transport helper', () => {
    expect(checkRepoUrl('C::\\repo')).toEqual({ ok: false, reason: 'unsafe' });
  });

  it('an accepted address never starts with "-" and never contains a control character', () => {
    const inputs = [
      'https://github.com/team/schedule.git',
      '"-x"',
      " '-x' ",
      '"\u0000"',
      '\u0000https://host/x',
      'git@github.com:team/schedule.git',
      '"\t-x"',
      "'  --upload-pack=x  '",
    ];
    for (const input of inputs) {
      const result = checkRepoUrl(input);
      if (result.ok) {
        expect(result.url.startsWith('-')).toBe(false);
        // eslint-disable-next-line no-control-regex
        expect(/[\u0000-\u001f\u007f]/.test(result.url)).toBe(false);
        expect(result.url).toBe(result.url.trim());
      }
    }
    expect(checkRepoUrl('"\t-x"')).toEqual({ ok: false, reason: 'unsafe' });
    expect(checkRepoUrl("'  --upload-pack=x  '")).toEqual({ ok: false, reason: 'unsafe' });
  });
});

describe('maskRepoUrl', () => {
  it('hides the password and keeps the user name', () => {
    expect(maskRepoUrl('https://dana:s3cret@github.com/team/schedule.git')).toBe('https://dana:***@github.com/team/schedule.git');
    expect(maskRepoUrl('http://dana:s3cret@intranet/git/schedule.git')).toBe('http://dana:***@intranet/git/schedule.git');
    expect(maskRepoUrl('HTTPS://dana:s3cret@github.com/x.git')).toBe('HTTPS://dana:***@github.com/x.git');
  });

  it('hides a lone token completely', () => {
    expect(maskRepoUrl('https://ghp_abcDEF123@github.com/team/schedule.git')).toBe('https://***@github.com/team/schedule.git');
  });

  it('hides the secret of the user:token form used by access tokens', () => {
    const masked = maskRepoUrl('https://x-access-token:ghp_abcDEF123@github.com/team/schedule.git');
    expect(masked).toBe('https://x-access-token:***@github.com/team/schedule.git');
    expect(masked).not.toContain('ghp_');
  });

  it('treats an empty password like a password', () => {
    expect(maskRepoUrl('https://dana:@github.com/x.git')).toBe('https://dana:***@github.com/x.git');
  });

  it('leaves addresses without credentials unchanged', () => {
    for (const url of [
      'https://github.com/team/schedule.git',
      'https://host.example:8443/team/schedule.git',
      'http://intranet/git/schedule.git',
      'https://github.com/team/user@name.git',
      'https://host:8443/team/a@b.git',
      'git@github.com:team/schedule.git',
      'C:\\path\\repo.git',
      '\\\\server\\share\\repo.git',
      'file:///C:/repos/schedule.git',
      '',
    ]) {
      expect(maskRepoUrl(url)).toBe(url);
    }
  });

  it('keeps host, port and path', () => {
    expect(maskRepoUrl('https://dana:pw@host.example:8443/a/b.git?x=1')).toBe('https://dana:***@host.example:8443/a/b.git?x=1');
  });

  it('does not leak any part of a password that contains "@"', () => {
    const masked = maskRepoUrl('https://dana:p@ss@github.com/team/schedule.git');
    expect(masked).not.toContain('ss');
    expect(masked).not.toContain('p@');
    expect(masked).toBe('https://dana:***@github.com/team/schedule.git');
  });

  it('does not leak a password that contains ":"', () => {
    const masked = maskRepoUrl('https://dana:pa:ss@github.com/team/schedule.git');
    expect(masked).toBe('https://dana:***@github.com/team/schedule.git');
  });
});

describe('repoDisplayName', () => {
  it.each([
    ['https://github.com/team/schedule.git', 'schedule'],
    ['https://github.com/team/schedule', 'schedule'],
    ['https://github.com/team/schedule/', 'schedule'],
    ['https://github.com/team/schedule.git/', 'schedule'],
    ['https://github.com/team/Schedule.GIT', 'Schedule'],
    ['https://dana:pw@github.com/team/schedule.git', 'schedule'],
    ['  https://github.com/team/schedule.git  ', 'schedule'],
    ['ssh://git@host:2222/path/repo.git', 'repo'],
    ['git@github.com:team/schedule.git', 'schedule'],
    ['git@github.com:schedule.git', 'schedule'],
    ['myserver:schedule', 'schedule'],
    ['\\\\server\\share\\repo.git', 'repo'],
    ['\\\\server\\share\\repo.git\\', 'repo'],
    ['\\\\server\\share\\team schedule', 'team schedule'],
    ['//server/share/repo.git', 'repo'],
    ['C:\\path\\repo.git', 'repo'],
    ['C:\\path\\repo', 'repo'],
    ['C:/path/repo.git/', 'repo'],
    ['C:\\path\\לוח זמנים.git', 'לוח זמנים'],
    ['file:///C:/repos/schedule.git', 'schedule'],
    ['/srv/git/schedule.git', 'schedule'],
    ['schedule.git', 'schedule'],
    ['my.schedule.v2.git', 'my.schedule.v2'],
    ['https://github.com/team/git', 'git'],
    ['https://github.com/team/legit', 'legit'],
  ])('%s -> %s', (url, name) => {
    expect(repoDisplayName(url)).toBe(name);
  });

  it('does not throw on degenerate input', () => {
    expect(repoDisplayName('')).toBe('');
    expect(repoDisplayName('C:\\')).toBe('C');
    expect(typeof repoDisplayName('///')).toBe('string');
  });
});
