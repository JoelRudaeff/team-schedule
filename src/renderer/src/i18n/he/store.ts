import type { StoreMessages } from '../en/store';

/** טקסטים שהמאגר עצמו מציג: הודעות קופצות, חלונות שגיאה והתראות. */
export const store: StoreMessages = {
  // start-up
  fatalStart: 'לא ניתן היה להפעיל את התוכנה.',
  fatalNewerVersion: 'הלו״ז נשמר בגרסה חדשה יותר של התוכנה. יש להתקין את הגרסה העדכנית.',
  fatalDamagedConfig: 'הקובץ schedule.json בתיקייה המקומית פגום ולא ניתן לקרוא אותו.',
  unexpected: 'משהו השתבש.',

  // editing
  readOnlyWeek: 'לא ניתן לשנות את השבוע הזה כי לא ניתן לקרוא את הקובץ שלו.',
  saveLocalFailed: 'לא ניתן היה לשמור את השינויים במחשב הזה.',
  closeUnsavedTitle: 'השינויים האחרונים עדיין לא נשמרו',
  closeUnsavedText: 'התוכנה לא הצליחה לכתוב את השינויים האחרונים למחשב הזה. סגירה עכשיו תגרום לאובדן שלהם.',
  closeAnywayLose: 'לסגור ולוותר עליהם',
  brokenLocalFiles:
    'במחשב הזה יש קובצי לו״ז שלא ניתן לקרוא ושונים מהגרסה של הצוות. יש לתקן אותם, או לבטל את השינויים שטרם פורסמו, ואז לשמור שוב.',
  strandedAside_one: 'שינוי אחד שלך נמצא בשבוע שהצוות מחזיק בצורה שהגרסה הזו של התוכנה אינה יכולה לקרוא. הוא הונח בצד.',
  strandedAside_other:
    '{count} שינויים שלך נמצאים בשבוע שהצוות מחזיק בצורה שהגרסה הזו של התוכנה אינה יכולה לקרוא. הם הונחו בצד.',
  settingsFailed: 'לא ניתן היה לשמור את ההגדרות.',

  // repository problems, by kind
  errOffline: 'אין גישה למאגר הצוות. כדאי לבדוק את החיבור לרשת.',
  errAuth: 'נדרשת התחברות, או שאין הרשאת גישה למאגר הצוות.',
  errNotFound: 'מאגר הצוות לא נמצא. כדאי לבדוק את הכתובת בהגדרות.',
  errDubious: 'Git אינו סומך על תיקיית המאגר כי היא שייכת למשתמש Windows אחר.',
  errBranchMissing: 'במאגר הזה אין ענף בשם הזה.',
  errTimeout: 'מאגר הצוות לא הגיב בזמן.',
  errGitMissing: 'Git לא נמצא במחשב הזה.',
  errInvalidUrl: 'כתובת המאגר אינה תקינה.',
  errUnknown: 'Git דיווח על בעיה.',
  actionSignIn: 'התחברות',
  actionTrust: 'אישור התיקייה',
  trustTitle: 'לסמוך על התיקייה הזו?',
  trustMessage:
    'Git יקבל הוראה להתייחס לתיקייה שלמטה כבטוחה לשימוש, אף שהיא שייכת למשתמש Windows אחר. מומלץ לאשר רק תיקייה ששייכת לצוות.',
  trustDone: 'התיקייה אושרה. אפשר לנסות שוב.',

  // looking for updates
  upToDate: 'הלו״ז מעודכן.',
  updatesAvailable_one: 'עדכון אחד מאת {authors}',
  updatesAvailable_other: '{count} עדכונים מאת {authors}',
  andOthers: '{names} ואחרים',
  actionUpdate: 'עדכון',
  notifyTitle: 'לו״ז צוות: יש עדכון',

  // update
  updateFailedTitle: 'העדכון נכשל',
  updated_one: 'הלו״ז עודכן: שינוי אחד מאת {authors}.',
  updated_other: 'הלו״ז עודכן: {count} שינויים מאת {authors}.',
  updatedKept_one: 'הלו״ז עודכן. השינוי שלך נשאר אצלך וטרם פורסם.',
  updatedKept_other: 'הלו״ז עודכן. {count} השינויים שלך נשארו אצלך וטרם פורסמו.',
  updatedPlain: 'הלו״ז עודכן לגרסה האחרונה של הצוות.',
  keptAside_one: 'גרסה אחת שלך הונחה בצד להחלטה מאוחרת.',
  keptAside_other: '{count} גרסאות שלך הונחו בצד להחלטה מאוחרת.',
  alreadyIncluded: 'השינויים שלך כבר נמצאים בלו״ז של הצוות.',
  teamUnreadable: 'הלו״ז של הצוות פגום ולא ניתן לקרוא אותו.',
  teamNewer: 'הלו״ז של הצוות נשמר בגרסה חדשה יותר של התוכנה. יש להתקין את הגרסה העדכנית.',
  tooManyRetries: 'הצוות מפרסם שינויים ברגעים אלה. כדאי לנסות שוב בעוד רגע.',
  branchMissing: 'הענף של הצוות אינו קיים עוד בשרת, ולכן אין מה לעדכן. שמירה תיצור אותו מחדש מהעותק שלך.',
  noteRestored: 'הפריט ״{name}״ ({kind}) לא הוסר מהרשימה, כי יש אירוע שעדיין משויך אליו.',
  noteTimeGrid: 'שעות היום נלקחו מהגרסה של הצוות.',
  noteCourseDates: 'תאריכי הקורס שלך ושל הצוות לא התיישבו יחד (הקורס היה מסתיים לפני שהתחיל), ולכן נשמרו התאריכים של הצוות.',
  noteMerged: 'הפריט ״{name}״ ({kind}) נוסף פעמיים, אצלך ובצוות. האירועים שלך משויכים עכשיו לפריט של הצוות.',
  noteDuplicate: 'הפריט ״{name}״ ({kind}) מופיע עכשיו פעמיים ברשימה: השם ניתן לשני פריטים שונים, אצלך ובצוות. כדאי לשנות את השם של אחד מהם בהגדרות.',
  mergeOutdated: 'הלו״ז השתנה אחרי שהתמונה הזו הוצגה, ולכן היא נבנתה מחדש. צריך להחליט שוב.',

  // publish
  nothingToPublish: 'אין מה לשמור: אין שינויים שטרם פורסמו.',
  published: 'נשמר ושותף עם הצוות.',
  publishFailedTitle: 'השמירה נכשלה',
  discarded: 'השינויים שטרם פורסמו בוטלו.',
  filesRestored: 'הקבצים הפגומים הוחלפו בגרסה של הצוות.',

  // kept aside
  asideApplied: 'הגרסה שלך חזרה ללו״ז (טרם פורסמה).',
  asideCannotApply: 'הגרסה הזו כבר לא מתאימה ללו״ז (השעות או התאריכים שבה סותרים את הנוכחיים), ולכן היא נשארת ברשימה.',
  asideRefsDropped: 'משהו שהגרסה הזו השתמשה בו (מורה, כיתה, מיקום או נושא) כבר לא קיים, ולכן הושמט.',

  // first schedule
  scheduleCreated: 'הלו״ז נוצר ושותף עם הצוות.',
  scheduleExisted: 'חבר צוות יצר את הלו״ז בינתיים. הוא נטען.',
  createFailedTitle: 'יצירת הלו״ז נכשלה',
  createMessage: 'Create schedule',

  // output
  exportNoEvents: 'אין אירועים לייצוא.',
  exportIcsTitle: 'ייצוא ל-Outlook',
  exportIcsDone_one: 'אירוע אחד יוצא.',
  exportIcsDone_other: '{count} אירועים יוצאו.',
  actionOpen: 'פתיחה',
  exportWeekTitle: 'שמירת שבוע לקובץ',
  exportWeekDone_one: 'השבוע כולו נשמר לקובץ (אירוע אחד).',
  exportWeekDone_other: 'השבוע כולו נשמר לקובץ ({count} אירועים).',
  importWeekTitle: 'טעינת שבוע מקובץ',
  importInvalid: 'זה אינו קובץ שבוע תקין.',
  importNewer: 'קובץ השבוע נשמר בגרסה חדשה יותר של התוכנה.',
  importDone_one: 'אירוע אחד נטען לשבוע.',
  importDone_other: '{count} אירועים נטענו לשבוע.',
  importCreated: 'נוספו פריטים חדשים לרשימות: {list}.',
  importSnapped_one: 'באירוע אחד השעה לא הייתה על רבע שעה עגול, והיא הוזזה לרבע השעה הקרוב.',
  importSnapped_other: 'ב-{count} אירועים השעות לא היו על רבע שעה עגול, והן הוזזו לרבע השעה הקרוב.',
  importShortened_one: 'טקסט אחד היה ארוך ממה שהלו״ז מאפשר, ולכן קוצר.',
  importShortened_other: '{count} טקסטים היו ארוכים ממה שהלו״ז מאפשר, ולכן קוצרו.',
  fileFilterWeek: 'קובץ שבוע',
  fileFilterIcs: 'קובץ יומן',
  icsTeachers: 'מורים',
  icsClasses: 'כיתות',
  icsSubject: 'נושא',
  icsUntitled: 'אירוע',
  icsDefaultName: 'לו״ז צוות',

  kindSubject: 'נושא',
  kindLocation: 'מיקום',
  kindTeacher: 'מורה',
  kindClass: 'כיתה',
};
