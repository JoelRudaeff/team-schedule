import type { GridMessages } from '../en/grid';

/** "grid" texts (Hebrew). Must have exactly the keys of the English table. */
export const grid: GridMessages = {
  weekGrid: 'לו״ז שבועי',
  today: 'היום',
  outsideCourse: 'מחוץ לתאריכי הקורס',
  emptyWeek: 'אין אירועים בשבוע הזה',
  emptyWeekHint: 'לחיצה על משבצת זמן, או גרירה על כמה משבצות, מוסיפה אירוע.',
  noMatches: 'אין אירועים שמתאימים לסינון',
  readOnlyWeek: 'הגרסה הזו של התוכנה אינה יכולה לקרוא את הקובץ של השבוע הזה, ולכן לא ניתן להציג או לשנות אותו. הקובץ נשאר ללא שינוי.',
  readOnlyTeamCopy: 'לא ניתן לקרוא את הקובץ של השבוע הזה במחשב הזה. מוצגת הגרסה של הצוות; לא ניתן לשנות את השבוע עד לתיקון הקובץ.',

  // event card and details
  unpublishedAdded: 'חדש, טרם פורסם',
  unpublishedModified: 'שונה, טרם פורסם',
  clashTitle: 'שיבוץ כפול',
  clashLocation: '{name} משמש באותו זמן גם את ״{other}״',
  clashTeacher: '{name} מלמד/ת באותו זמן גם את ״{other}״',
  clashClass: 'ל-{name} יש באותו זמן גם את ״{other}״',
  lastEditedBy: 'נערך לאחרונה על ידי {name}',
  publishedEditedBy: 'הגרסה שפורסמה נערכה לאחרונה על ידי {name}',
  eventDetails: 'פרטי האירוע',
  edit: 'עריכה',
  duplicate: 'שכפול',
  delete: 'מחיקה',
  deleted: 'האירוע נמחק.',
  undo: 'ביטול',
  resizeHint: 'גרירה לשינוי שעת הסיום',

  // versions kept aside
  asideGhost: 'ממתין בצד',
  asideTitle: 'הגרסה שלך, שממתינה בצד',
  asideChanged: 'הצוות שינה את האירוע הזה בזמן שעבדת עליו. זו הגרסה שלך.',
  asideTeamDeleted: 'הצוות מחק את האירוע הזה. זו הגרסה שלך.',
  asideUseMine: 'שימוש בגרסה שלי',
  asideDiscardMine: 'ויתור על הגרסה שלי',
  asideIDeleted: 'מחקת את האירוע הזה, אבל הצוות שינה אותו.',
  asideDeleteAnyway: 'למחוק בכל זאת',
  asideKeepTheirs: 'להשאיר את גרסת הצוות',
};
