import type { TimeMessages } from '../en/time';

/** "time" texts (Hebrew). Must have exactly the keys of the English table. */
export const time: TimeMessages = {
  now: 'עכשיו',
  minutesAgo_one: 'לפני דקה',
  minutesAgo_two: 'לפני שתי דקות',
  minutesAgo_other: 'לפני {count} דקות',
  hoursAgo_one: 'לפני שעה',
  hoursAgo_two: 'לפני שעתיים',
  hoursAgo_other: 'לפני {count} שעות',
  daysAgo_one: 'אתמול',
  daysAgo_two: 'שלשום',
  daysAgo_other: 'לפני {count} ימים',
  monthsAgo_one: 'לפני חודש',
  monthsAgo_two: 'לפני חודשיים',
  monthsAgo_other: 'לפני {count} חודשים',
  yearsAgo_one: 'לפני שנה',
  yearsAgo_two: 'לפני שנתיים',
  yearsAgo_other: 'לפני {count} שנים',
};
