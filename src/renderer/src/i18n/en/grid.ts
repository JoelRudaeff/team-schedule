/** "grid" texts (English - the source of truth for this namespace's keys). */
export const grid = {
  weekGrid: 'Weekly schedule',
  today: 'Today',
  outsideCourse: 'Outside the course dates',
  emptyWeek: 'No events this week',
  emptyWeekHint: 'Click a time slot, or drag across several, to add an event.',
  noMatches: 'No events match the filter',
  readOnlyWeek:
    'This week\'s file cannot be read by this version of the app, so the week cannot be shown or changed. The file was left untouched.',
  readOnlyTeamCopy:
    'This week\'s file on this computer cannot be read. You are looking at the team\'s version; the week cannot be changed until the file is repaired.',

  // event card and details
  unpublishedAdded: 'New, not published yet',
  unpublishedModified: 'Changed, not published yet',
  clashTitle: 'Double booking',
  clashLocation: '{name} is also used by "{other}" at this time',
  clashTeacher: '{name} also teaches "{other}" at this time',
  clashClass: '{name} also has "{other}" at this time',
  lastEditedBy: 'Last edited by {name}',
  publishedEditedBy: 'Published version last edited by {name}',
  eventDetails: 'Event details',
  edit: 'Edit',
  duplicate: 'Duplicate',
  delete: 'Delete',
  deleted: 'Event deleted.',
  undo: 'Undo',
  resizeHint: 'Drag to change the end time',

  // versions kept aside
  asideGhost: 'Kept aside',
  asideTitle: 'Your version, kept aside',
  asideChanged: 'The team changed this event while you were working on it. This is your version.',
  asideTeamDeleted: 'The team deleted this event. This is your version.',
  asideUseMine: 'Use my version',
  asideDiscardMine: 'Discard my version',
  asideIDeleted: 'You had deleted this event, but the team changed it.',
  asideDeleteAnyway: 'Delete it anyway',
  asideKeepTheirs: 'Keep the team\'s version',
};

export type GridMessages = typeof grid;
