/**
 * Validation and display helpers for the git repository address typed by the user.
 * Pure code, used by the set-up screen (instant feedback) and by the main process
 * (which re-validates before passing anything to git).
 */

export type RepoUrlKind = 'https' | 'http' | 'ssh' | 'git' | 'file';

export type RepoUrlCheck =
  | { ok: true; url: string; kind: RepoUrlKind }
  | { ok: false; reason: 'empty' | 'unsupported' | 'unsafe' };

/**
 * Accepts:
 *   https://host/path(.git)        http://…          ssh://[user@]host[:port]/path
 *   git://host/path                user@host:path  (scp-like ssh, e.g. git@github.com:team/schedule.git)
 *   file:///C:/path  \\server\share\repo.git  C:\path\repo.git  /unix/path  (a shared folder or local bare repo)
 * Rejects as `unsafe`: anything starting with `-` (would be read as a git option), any
 * control character, and git "transport helper" addresses (`ext::…`, `fd::…`, or any
 * `<word>::<address>` form), which can run arbitrary commands.
 * The returned url is the trimmed input (surrounding quotes removed).
 */
export function checkRepoUrl(input: string): RepoUrlCheck {
  let url = input.trim();
  if (url.length >= 2 && ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'")))) {
    url = url.slice(1, -1).trim();
  }
  if (url === '') return { ok: false, reason: 'empty' };
  // eslint-disable-next-line no-control-regex
  if (url.startsWith('-') || /[\u0000-\u001f\u007f]/.test(url)) return { ok: false, reason: 'unsafe' };
  // Windows drive paths (C:\… or C:/…) contain a colon but are not transport helpers.
  const isDrivePath = /^[a-zA-Z]:[\\/]/.test(url);
  if (!isDrivePath && /^[a-zA-Z][a-zA-Z0-9+.-]*::/.test(url)) return { ok: false, reason: 'unsafe' };

  if (isDrivePath) return { ok: true, url, kind: 'file' };
  if (url.startsWith('\\\\') || url.startsWith('//')) return { ok: true, url, kind: 'file' };
  if (/^file:\/\//i.test(url)) return { ok: true, url, kind: 'file' };
  if (/^https:\/\/[^\s/]+\/\S+/i.test(url)) return { ok: true, url, kind: 'https' };
  if (/^http:\/\/[^\s/]+\/\S+/i.test(url)) return { ok: true, url, kind: 'http' };
  if (/^ssh:\/\/[^\s/]+\/\S+/i.test(url)) return { ok: true, url, kind: 'ssh' };
  if (/^git:\/\/[^\s/]+\/\S+/i.test(url)) return { ok: true, url, kind: 'git' };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) return { ok: false, reason: 'unsupported' };
  // scp-like: [user@]host:path — host has no slash, path does not start with //
  if (/^([^\s@/:]+@)?[^\s@/:]+:[^\s/][^\s]*$/.test(url) || /^([^\s@/:]+@)?[^\s@/:]+:\/[^\s/][^\s]*$/.test(url)) {
    return { ok: true, url, kind: 'ssh' };
  }
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || url.startsWith('~')) {
    return { ok: true, url, kind: 'file' };
  }
  return { ok: false, reason: 'unsupported' };
}

/** Hides a password or token embedded in an http(s) address: `https://user:***@host/…`. */
export function maskRepoUrl(url: string): string {
  // The sign-in part is everything up to the LAST "@" before the path: a password may itself contain "@".
  return url.replace(/^(https?:\/\/)([^\s/]*)@/i, (_match, scheme: string, userInfo: string) => {
    const colon = userInfo.indexOf(':');
    return colon >= 0 ? `${scheme}${userInfo.slice(0, colon)}:***@` : `${scheme}***@`;
  });
}

/** Short human name of the repository, e.g. `schedule` for `https://github.com/team/schedule.git`. */
export function repoDisplayName(url: string): string {
  const cleaned = url.trim().replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const last = cleaned.split(/[\\/:]/).filter(Boolean).pop();
  return last ?? cleaned;
}
