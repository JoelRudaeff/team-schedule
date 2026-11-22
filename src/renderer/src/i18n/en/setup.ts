/** "setup" texts (English - the source of truth for this namespace's keys). */
export const setup = {
  welcomeTitle: 'Welcome to Team Schedule',
  welcomeText:
    'The weekly schedule of your team, kept in a shared git repository so that everyone sees the same schedule.',
  language: 'Language',

  gitMissingTitle: 'Git is not installed on this computer',
  gitMissingText:
    'Team Schedule uses Git for Windows to share the schedule. Install it, then come back and press "Check again".',
  gitDownload: 'Download Git for Windows',
  gitRecheck: 'Check again',
  gitLocate: 'Locate git.exe…',
  gitFound: 'Git {version} is installed',
  gitNotValid: 'That file is not Git.',

  connectTitle: 'Connect to your team\'s repository',
  howItWorks: 'How it works',
  howItWorksText:
    'This computer keeps its own copy of the schedule. "Save" sends your changes to the team and "Update" brings in theirs. Nothing is sent before you confirm it.',
  repoUrl: 'Repository address',
  repoUrlHint: 'For example https://github.com/team/schedule.git, or a shared folder such as \\\\server\\share\\schedule.git',
  repoUrlEmpty: 'Enter the address of the repository.',
  repoUrlUnsupported: 'This does not look like the address of a git repository.',
  repoUrlUnsafe: 'This address is not allowed.',
  userName: 'Your name',
  userNameHint: 'Teammates see it next to every change you make.',
  userNameRequired: 'Enter your name.',
  userEmail: 'Your e-mail',
  userEmailInvalid: 'Enter a valid e-mail address.',
  advanced: 'Advanced',
  branch: 'Branch',
  branchHint: 'Leave empty to use the repository\'s default branch.',
  connect: 'Connect',
  connectFailed: 'Could not connect',
  trustText:
    'Git refuses to use this folder because another Windows user owns it. This is normal for a shared folder; you can tell Git to trust it.',
  trustAndRetry: 'Trust this folder and try again',

  createTitle: 'Create the team schedule',
  createText: 'The repository "{name}" is connected, but it does not contain a schedule yet.',
  courseName: 'Course name',
  courseNamePlaceholder: 'e.g. DevOps 2027',
  courseStart: 'Course starts',
  courseEnd: 'Course ends',
  courseDatesHint: 'Optional. With a start date, weeks are numbered from the first week of the course.',
  courseDatesInvalid: 'The end date must not be before the start date.',
  createInfo:
    'This creates the schedule files and uploads them to the repository (git commit and push). Teammates who connect afterwards receive this schedule.',
  create: 'Create schedule',
  otherRepo: 'Use a different repository',
};

export type SetupMessages = typeof setup;
