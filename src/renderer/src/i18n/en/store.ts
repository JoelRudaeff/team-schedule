/** Texts shown by the application store itself: toasts, error dialogs, notifications. */
export const store = {
  // start-up
  fatalStart: 'The app could not start.',
  fatalNewerVersion:
    'This schedule was saved by a newer version of Team Schedule. Please install the latest version of the app.',
  fatalDamagedConfig: 'The file schedule.json in the local folder is damaged and cannot be read.',
  unexpected: 'Something went wrong.',

  // editing
  readOnlyWeek: 'This week cannot be changed because its file cannot be read.',
  saveLocalFailed: 'Your changes could not be saved on this computer.',
  closeUnsavedTitle: 'Your latest changes are not saved yet',
  closeUnsavedText:
    'The app could not write your latest changes to this computer. If you close now, those changes are lost.',
  closeAnywayLose: 'Close and lose them',
  brokenLocalFiles:
    'This computer has schedule files that cannot be read and that differ from the team\'s version. Repair them, or discard your unpublished changes, and then save again.',
  strandedAside_one:
    '{count} of your changes is in a week that the team holds in a form this version of the app cannot read. It was kept aside.',
  strandedAside_other:
    '{count} of your changes are in a week that the team holds in a form this version of the app cannot read. They were kept aside.',
  settingsFailed: 'The settings could not be saved.',

  // repository problems, by kind
  errOffline: 'The team repository cannot be reached. Check the network connection.',
  errAuth: 'Sign-in is needed, or you do not have access to the team repository.',
  errNotFound: 'The team repository was not found. Check its address in Settings.',
  errDubious: 'Git does not trust the repository folder because another Windows user owns it.',
  errBranchMissing: 'This repository has no branch with that name.',
  errTimeout: 'The team repository did not answer in time.',
  errGitMissing: 'Git was not found on this computer.',
  errInvalidUrl: 'The repository address is not valid.',
  errUnknown: 'Git reported a problem.',
  actionSignIn: 'Sign in',
  actionTrust: 'Trust this folder',
  trustTitle: 'Trust this folder?',
  trustMessage:
    'Git will be told that the folder below is safe to use although another Windows user owns it. Do this only for a folder that belongs to your team.',
  trustDone: 'The folder is now trusted. Please try again.',

  // looking for updates
  upToDate: 'The schedule is up to date.',
  updatesAvailable_one: '{count} update from {authors}',
  updatesAvailable_other: '{count} updates from {authors}',
  andOthers: '{names} and others',
  actionUpdate: 'Update',
  notifyTitle: 'Team Schedule: update available',

  // update
  updateFailedTitle: 'Could not update',
  updated_one: 'Updated: {count} change from {authors}.',
  updated_other: 'Updated: {count} changes from {authors}.',
  updatedKept_one: 'Updated. Your {count} unpublished change was kept.',
  updatedKept_other: 'Updated. Your {count} unpublished changes were kept.',
  updatedPlain: 'Updated to the team\'s latest version.',
  keptAside_one: '{count} of your versions was kept aside for a later decision.',
  keptAside_other: '{count} of your versions were kept aside for a later decision.',
  alreadyIncluded: 'Your changes were already part of the team\'s schedule.',
  teamUnreadable: 'The team\'s schedule is damaged and cannot be read.',
  teamNewer:
    'The team\'s schedule was saved by a newer version of Team Schedule. Please install the latest version of the app.',
  tooManyRetries: 'The team keeps publishing changes right now. Please try again in a moment.',
  branchMissing:
    'The team\'s branch no longer exists on the server, so there is nothing to update. Saving will create it again from your copy.',
  noteRestored: '{kind} "{name}" was kept because an event still uses it.',
  noteTimeGrid: 'The day\'s hours were taken from the team\'s version.',
  noteCourseDates:
    'Your course dates and the team\'s did not fit together (the course would end before it starts). The team\'s dates were kept.',
  noteMerged: '{kind} "{name}" was in the list twice, once from you and once from the team. The two entries were combined into one.',
  noteDuplicate:
    '{kind} "{name}" is now in the list twice: you and the team each gave that name to a different entry. Rename one of them in Settings.',
  mergeOutdated: 'The schedule changed after this overview was drawn, so it was built again. Please decide once more.',

  // publish
  nothingToPublish: 'There is nothing to save: no unpublished changes.',
  published: 'Saved and shared with the team.',
  publishFailedTitle: 'Could not save',
  discarded: 'Your unpublished changes were discarded.',
  filesRestored: 'The damaged files were replaced by the team\'s version.',

  // kept aside
  asideApplied: 'Your version is back in the schedule (not published yet).',
  asideCannotApply:
    'This version no longer fits the schedule (its hours or dates would contradict the current ones), so it stays in the list.',
  asideRefsDropped: 'Something this version used (a teacher, class, location or subject) no longer exists and was left out.',

  // first schedule
  scheduleCreated: 'The schedule was created and shared with the team.',
  scheduleExisted: 'A teammate created the schedule in the meantime. It has been loaded.',
  createFailedTitle: 'Could not create the schedule',
  createMessage: 'Create schedule',

  // output
  exportNoEvents: 'There are no events to export.',
  exportIcsTitle: 'Export to Outlook',
  exportIcsDone_one: '{count} event exported.',
  exportIcsDone_other: '{count} events exported.',
  actionOpen: 'Open',
  exportWeekTitle: 'Save week to file',
  exportWeekDone_one: 'The whole week was saved to a file ({count} event).',
  exportWeekDone_other: 'The whole week was saved to a file ({count} events).',
  importWeekTitle: 'Load week from file',
  importInvalid: 'This is not a valid week file.',
  importNewer: 'This week file was saved by a newer version of Team Schedule.',
  importDone_one: '{count} event loaded into the week.',
  importDone_other: '{count} events loaded into the week.',
  importCreated: 'New list entries were added: {list}.',
  importSnapped_one: '{count} event had a time off the quarter-hour grid and was moved to the nearest quarter hour.',
  importSnapped_other: '{count} events had times off the quarter-hour grid and were moved to the nearest quarter hour.',
  importShortened_one: '{count} text was longer than the schedule allows and was cut.',
  importShortened_other: '{count} texts were longer than the schedule allows and were cut.',
  fileFilterWeek: 'Week file',
  fileFilterIcs: 'Calendar file',
  icsTeachers: 'Teachers',
  icsClasses: 'Classes',
  icsSubject: 'Subject',
  icsUntitled: 'Event',
  icsDefaultName: 'Team Schedule',

  kindSubject: 'Subject',
  kindLocation: 'Location',
  kindTeacher: 'Teacher',
  kindClass: 'Class',
};

export type StoreMessages = typeof store;
