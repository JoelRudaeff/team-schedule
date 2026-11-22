/**
 * "time" texts: how long ago something happened (English - the source of truth for this
 * namespace's keys). Written out here instead of taken from the system: the wording must not
 * change with the version of the runtime, and Hebrew needs its own words for one and two.
 */
export const time = {
  now: 'just now',
  minutesAgo_one: '1 minute ago',
  minutesAgo_two: '2 minutes ago',
  minutesAgo_other: '{count} minutes ago',
  hoursAgo_one: '1 hour ago',
  hoursAgo_two: '2 hours ago',
  hoursAgo_other: '{count} hours ago',
  daysAgo_one: 'yesterday',
  daysAgo_two: '2 days ago',
  daysAgo_other: '{count} days ago',
  monthsAgo_one: 'last month',
  monthsAgo_two: '2 months ago',
  monthsAgo_other: '{count} months ago',
  yearsAgo_one: 'last year',
  yearsAgo_two: '2 years ago',
  yearsAgo_other: '{count} years ago',
};

export type TimeMessages = typeof time;
