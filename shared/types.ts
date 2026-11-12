// Types shared by the server (server/src) and the web app (web/src).

export interface Bookmark {
  id: string;
  name: string;
  url: string;
}

export interface BookmarkGroup {
  id: string;
  name: string;
  items: Bookmark[];
}

/** How often and how lately a bookmark's been opened (shared/bookmarks.ts). */
export interface OpenCount {
  /** Each open adds 1, and the total halves every two weeks since `last`. */
  score: number;
  last: string;
  /** Opens ever. */
  n: number;
}

/** Keyed by bookmark id. */
export type BookmarkOpens = Record<string, OpenCount>;

/** A bookmark the link check couldn't open. */
export interface LinkProblem {
  /** gone: not found, or the address doesn't resolve · failing: errors or doesn't answer. */
  kind: 'gone' | 'failing';
  /** What happened, e.g. "Not found (404)". */
  why: string;
  at: string;
}

/** The weekly check of every bookmark (server/src/bookmarks.ts). */
export interface LinkCheck {
  checkedAt: string | null;
  running: boolean;
  /** Keyed by the bookmark's address; ones that opened fine aren't listed. */
  problems: Record<string, LinkProblem>;
  /** Why the last check didn't count (the server couldn't reach anything); its results are the ones before. */
  error?: string;
}

export interface Note {
  id: string;
  name: string;
  text: string;
  /** Lower case, without "#" (shared/notes.ts); missing on notepads that never had any. */
  tags?: string[];
  /** Shown first among the tabs. */
  pinned?: boolean;
}

/** An earlier version of a notepad, as it was until `at` (server/src/notes.ts keeps them). */
export interface NoteVersion {
  at: string;
  name: string;
  text: string;
}

export type ThemeMode = 'system' | 'light' | 'dark';
export type AccentKey = 'sage' | 'slate' | 'terracotta';
/** The whole-page design picked in Settings › Layout. Every design shows every view; only the arrangement and look change. */
export type DesignKey = 'broadsheet' | 'console' | 'bento' | 'horizon';
export type GoogleSource = 'calendar' | 'tasks' | 'gmail';
export type SourceKey = GoogleSource | 'carriers' | 'news' | 'inbox' | 'weather' | 'speedtest';
export type ViewKey = 'home' | 'news' | 'inbox' | 'you' | 'training' | 'learn' | 'money' | 'server';

/** One place to search: "yt lofi" opens url with %s replaced by "lofi". The first engine is the default. */
export interface SearchEngine {
  prefix: string;
  name: string;
  url: string;
}

export interface Prefs {
  /** Name used in the greeting. */
  name: string;
  theme: ThemeMode;
  accent: AccentKey;
  /** Layout for the whole dashboard (Settings › Layout). */
  design: DesignKey;
  /** Google calendar ids the user unticked in Settings. */
  hiddenCalendars: string[];
  /** Per-source on/off switches from Settings. */
  sources: Record<GoogleSource, boolean>;
  /** Search terms for the News tab, in display order. */
  newsTopics: string[];
  /** 2-hour forecast area for the weather beside the clock (e.g. "Bishan"); empty hides it. */
  weatherArea: string;
  /** Free text about the owner that Claude reads when it writes the inbox digest, e.g. what incoming PayNow transfers usually are. */
  aboutMe: string;
  /** Things switched off in Settings › Panels, e.g. "panel:notes", "top:cig", "view:server" (see HIDEABLE). */
  hidden: string[];
  /** Where the search box and ⌘K search the web. */
  searchEngines: SearchEngine[];
  /** Cigarettes a day to stay under; 0 means no limit. */
  cigaretteLimit: number;
  /** Hours between automatic internet speed tests; 0 turns them off. */
  speedTestHours: number;
  /** The internet plan's download speed, drawn on the speed chart; 0 hides the line. */
  speedPlanMbps: number;
  /** Working sets a week to aim for per muscle, drawn in Training › Sets per muscle. */
  setsPerWeek: number;
  /** Exercise names always shown first in Training › Your lifts. */
  pinnedLifts: string[];
  /** What the gym costs a month, in dollars, for the cost of each session; 0 hides it. */
  gymMonthly: number;
}

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
}

export interface CalEvent {
  id: string;
  calendarId: string;
  title: string;
  /** ISO date-time, or YYYY-MM-DD for all-day events. */
  start: string;
  /** ISO date-time, or YYYY-MM-DD (exclusive) for all-day events. */
  end: string;
  allDay: boolean;
  location?: string;
  conferenceUrl?: string;
  conferenceType?: string;
  description?: string;
  htmlLink?: string;
}

export interface TaskList {
  id: string;
  title: string;
}

export interface Task {
  id: string;
  listId: string;
  title: string;
  /** YYYY-MM-DD or null. */
  due: string | null;
}

export interface TrackingEvent {
  /** ISO date-time. */
  at: string;
  location: string;
  event: string;
}

/** 0 Info received, 1 In transit, 2 Out for delivery, 3 Delivered. */
export type Stage = 0 | 1 | 2 | 3;

export interface Package {
  id: string;
  label: string;
  carrier: string;
  number: string;
  stage: Stage;
  exception: boolean;
  statusText: string;
  source: 'manual' | 'gmail';
  isNew: boolean;
  /** Newest first. */
  timeline: TrackingEvent[];
  deliveredAt: string | null;
  archived: boolean;
  createdAt: string;
  lastChecked: string | null;
  trackingError: string | null;
}

export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  /** ISO date-time. */
  publishedAt: string;
}

export interface NewsStory {
  headline: string;
  summary: string;
  /** The headlines this story was written from. */
  links: { source: string; url: string }[];
}

export interface NewsTopic {
  /** What's followed, as in prefs.newsTopics (see shared/news.ts). */
  topic: string;
  /** A feed's own title, once it's been fetched. */
  title?: string;
  /** Newest first. */
  articles: NewsArticle[];
  /** Claude's digest of the headlines, or null before the first one (or without an API key). */
  stories: NewsStory[] | null;
  summarisedAt: string | null;
  fetchedAt: string | null;
  error: string | null;
}

/** A story or headline kept to read later. */
export interface SavedStory {
  id: string;
  title: string;
  url: string;
  source: string;
  /** What it was found under, as in prefs.newsTopics. */
  topic: string;
  /** Claude's summary, for a saved story; empty for a headline. */
  summary: string;
  savedAt: string;
  /** Marked read: it stays a week in case you want it again. */
  readAt: string | null;
}

/** The reading list, headlines hidden from a topic, and sources muted everywhere (shared/news.ts). */
export interface NewsLists {
  saved: SavedStory[];
  /** Keyed by lower-cased topic. */
  hidden: Record<string, { url: string; at: string }[]>;
  /** Outlet names, as headlines give them. */
  muted: string[];
}

/** How far back an inbox digest looks. */
export type InboxRange = '2d' | '7d';

export interface InboxEmail {
  id: string;
  threadId: string;
  /** Display name, e.g. "DBS Bank". */
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  /** ISO date-time Gmail received it. */
  at: string;
  unread: boolean;
  /** Gmail's inbox tab: primary, updates, promotions, social or forums. */
  category: string;
}

export interface InboxItem {
  /** action: something to do · update: worth knowing · fyi: one line is enough. */
  kind: 'action' | 'update' | 'fyi';
  headline: string;
  summary: string;
  /** A deadline in the email's own words, e.g. "by Fri 31 Oct"; empty when there is none. */
  due: string;
  /** Ids of the emails it covers, newest first. */
  emails: string[];
}

export interface InboxDigest {
  overview: string;
  items: InboxItem[];
  /** One line on what was left out, e.g. "Also 23 promotions (Shopee, Grab) and 4 newsletters." */
  skimmed: string;
  /** How many emails the digest was written from. */
  emailCount: number;
  summarisedAt: string;
}

export interface InboxState {
  /** The last 7 days, newest first. */
  emails: InboxEmail[];
  /** Claude's digest per range, or null before the first one (or without an API key). */
  digests: Record<InboxRange, InboxDigest | null>;
  fetchedAt: string | null;
  /** The last summary failure, shown in the Inbox view. */
  error: string | null;
}

export interface Weather {
  /** The forecast area actually used (City when the chosen one isn't listed). */
  area: string;
  /** Meteorological Service Singapore wording, e.g. "Thundery Showers", "Partly Cloudy (Night)". */
  forecast: string;
  /** ISO date-time the 2-hour forecast runs to. */
  validUntil: string | null;
  /** Air temperature at the station nearest the area. */
  tempC: number | null;
  station: string | null;
  observedAt: string | null;
  issuedAt: string;
  /** Optional extras; each is null when its feed failed (and missing in older cached copies). */
  air?: AirQuality | null;
  uv?: UvIndex | null;
  rain?: Rain | null;
  outlook?: OutlookDay[];
}

export interface AirQuality {
  /** PSI region nearest the area: north, south, east, west or central. */
  region: string;
  /** 24-hour PSI. */
  psi: number;
  /** 24-hour PM2.5 in µg/m³. */
  pm25: number;
  at: string;
}

export interface UvIndex {
  value: number;
  at: string;
  /** Today's highest hourly reading so far. */
  peak: number;
  peakAt: string;
}

export interface Rain {
  station: string;
  /** 5-minute totals for the last hour, oldest first. */
  steps: { at: string; mm: number }[];
  mmLastHour: number;
  /** The latest 5-minute reading had rain. */
  raining: boolean;
}

export interface OutlookDay {
  /** YYYY-MM-DD. */
  date: string;
  forecast: string;
  low: number;
  high: number;
}

export interface Countdown {
  id: string;
  title: string;
  /** YYYY-MM-DD. For yearly ones, the month and day repeat. */
  date: string;
  yearly: boolean;
  /** ISO date-time; the progress bar runs from here to the date. */
  createdAt: string;
}

export interface Mood {
  /** 1 Rough · 2 Low · 3 Okay · 4 Good · 5 Great. */
  level: number;
  note: string;
}

export type MoneyCategory = 'Food' | 'Transport' | 'Shopping' | 'Bills' | 'Family' | 'Fun' | 'Travel' | 'Pay' | 'Other';

/**
 * One amount of money in or out of an account on a day, or moved from one account to
 * another. Planned ones are the forecast; done ones actually happened.
 */
export interface MoneyEntry {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  kind: 'in' | 'out' | 'move';
  amount: number;
  note: string;
  /** Optional; empty when not set, and always for a move. */
  category: MoneyCategory | '';
  planned: boolean;
  /** The account it goes into or comes out of; for a move, the one it leaves. */
  account: string;
  /** For a move, the account it goes to; empty otherwise. */
  to: string;
  /** The invoice this is the money for (Owed); absent for everything else. */
  invoice?: string;
}

/**
 * A gig someone owes you for. Its money is the entry linked to it: planned money in on
 * the due date until it's paid, then done on the day it came in.
 */
export interface Invoice {
  id: string;
  /** The invoice number, like "INV-036". */
  num: string;
  /** The gig it's for. */
  event: string;
  amount: number;
  /** YYYY-MM-DD: when it should be paid by. */
  due: string;
}

export type AccountKind = 'bank' | 'cash' | 'invest' | 'pot';

/** Somewhere money is kept: a bank, a wallet, investments, or a pot set aside for something. */
export interface MoneyAccount {
  id: string;
  name: string;
  kind: AccountKind;
  /**
   * Money for day to day. Only these count towards "in the bank", the month's
   * balances and the forecasts; money moved out of them counts as money out.
   */
  spendable: boolean;
  /** The balance on the first day tracked. */
  opening: number;
  /** A savings goal and the month (YYYY-MM) to reach it by; null and empty when there's none. */
  goal: number | null;
  goalBy: string;
  /** Kept for its history but no longer offered for new entries. */
  archived: boolean;
}

export type WishPriority = '' | 'High' | 'Medium' | 'Low';
export type WishStatus = '' | 'Wanted' | 'Saving up' | 'Purchased' | 'Dropped';

export interface WishItem {
  id: string;
  name: string;
  category: string;
  priority: WishPriority;
  status: WishStatus;
  price: number | null;
  /** YYYY-MM the item is wanted by; empty when there's no target. */
  target: string;
  notes: string;
}

/** The money tracker: what's typed in. Balances and totals are worked out from it (shared/money.ts). */
export interface Money {
  /** The first day tracked (YYYY-MM-DD). Each account has its balance that morning. */
  start: string;
  /** At least one; the first spendable one is where entries without an account go. */
  accounts: MoneyAccount[];
  /** Sorted by date, then in the order they were added. */
  entries: MoneyEntry[];
  wishlist: WishItem[];
  /** What people owe you, each with its money as an entry. */
  invoices: Invoice[];
}

export type SetType = 'normal' | 'warmup' | 'dropset' | 'failure';

/** One set as Hevy records it. A value that wasn't logged is null. */
export interface WorkoutSet {
  type: SetType;
  kg: number | null;
  reps: number | null;
  km: number | null;
  sec: number | null;
  rpe: number | null;
}

export interface WorkoutExercise {
  title: string;
  notes: string;
  sets: WorkoutSet[];
}

export interface Workout {
  id: string;
  title: string;
  /** ISO date-times. */
  start: string;
  end: string;
  exercises: WorkoutExercise[];
}

/** Hevy's muscle groups, as its API names them. */
export type Muscle =
  | 'chest' | 'lats' | 'upper_back' | 'shoulders' | 'biceps' | 'triceps' | 'forearms' | 'traps' | 'lower_back'
  | 'quadriceps' | 'hamstrings' | 'glutes' | 'calves' | 'abductors' | 'adductors' | 'abdominals' | 'neck' | 'full_body' | 'cardio' | 'other';

/** What an exercise trains: the main muscle and the ones it works less. */
export interface ExerciseMuscles {
  primary: Muscle;
  secondary: Muscle[];
}

/** Claude's short note on the training, written after an import. */
export interface TrainingNote {
  headline: string;
  points: string[];
  writtenAt: string;
  /** The start of the newest workout it was written from, so a newer import writes a new one. */
  latest: string;
}

/** Workouts from Hevy, newest first, and where they came from (shared/training.ts). */
export interface Training {
  workouts: Workout[];
  /** 'csv' for Hevy's export; empty before the first import. */
  source: 'csv' | '';
  importedAt: string | null;
}

export type AssessmentKind = 'Assignment' | 'Problem set' | 'Lab' | 'Quiz' | 'Test' | 'Exam' | 'Essay' | 'Project' | 'Presentation' | 'Reading' | 'Other';
/** Not started, in progress, or handed in (marked once it has a score). */
export type AssessmentStatus = 'todo' | 'doing' | 'done';

/** Something graded or due in a course: an assignment, a quiz, an exam. */
export interface Assessment {
  id: string;
  courseId: string;
  title: string;
  kind: AssessmentKind;
  /** Percent of the course grade; 0 when it doesn't count. */
  weight: number;
  /** YYYY-MM-DD, or empty when there's no date. */
  due: string;
  /** HH:MM, or empty for the whole day. */
  time: string;
  status: AssessmentStatus;
  /** Percent scored, once marked. */
  score: number | null;
}

export interface Course {
  id: string;
  /** Short code, e.g. "CS 210"; may be empty. Also used to spot classes in the calendar. */
  code: string;
  name: string;
  /** A hex colour from COURSE_COLORS. */
  color: string;
  /** The grade aimed for, in percent; 0 means no target. */
  target: number;
  /** Study minutes a week to aim for; 0 means no goal. */
  goalMin: number;
  links: { name: string; url: string }[];
  /** Topics to revise, with how sure they feel: 1 not yet, 2 getting there, 3 solid. */
  topics: { name: string; conf: 1 | 2 | 3 }[];
  archived: boolean;
}

export interface StudySession {
  id: string;
  /** Empty for study that isn't for one course. */
  courseId: string;
  /** ISO date-time it started. */
  start: string;
  minutes: number;
}

/** Learning outside class: a book, an online course, a language. */
export interface SideLearning {
  id: string;
  title: string;
  /** Plural, e.g. "lessons", "chapters". */
  unit: string;
  done: number;
  total: number;
  /** ISO date-time of the last +1; null before the first. */
  lastAt: string | null;
}

/** The Learn view: courses, what's due in them, study time and learning on the side (shared/learn.ts). */
export interface Learn {
  courses: Course[];
  assessments: Assessment[];
  /** Oldest first. */
  sessions: StudySession[];
  side: SideLearning[];
  /** The study timer, kept on the server so it carries across tabs. */
  timer: { courseId: string; start: string } | null;
  /** Google calendar whose events are classes; empty matches events by course code or name instead. */
  calendarId: string;
}

/** Claude's short note on the week ahead in Learn. */
export interface LearnNote {
  headline: string;
  points: string[];
  writtenAt: string;
}

export interface SpeedTest {
  /** ISO date-time. */
  at: string;
  downMbps: number;
  upMbps: number;
  pingMs: number;
  jitterMs: number;
}

/** The Server view's terminal and file explorer, which reach the host over SSH. */
export interface ShellInfo {
  /** SSH_HOST and SSH_USER are set. */
  configured: boolean;
  /** user@host, or user@host:port off the usual port. */
  target: string | null;
  /** Launchpad's own key, to add to the user's ~/.ssh/authorized_keys. */
  publicKey: string;
  /** The fingerprint the host offers now, when it no longer matches the one trusted on the first connection. */
  newHostKey: string | null;
  /** Cloudflare Access is on, so only your Access login can open the terminal. */
  guarded: boolean;
}

export interface FileEntry {
  name: string;
  /** For a symlink, what it points at; `other` for sockets, devices and broken links. */
  kind: 'dir' | 'file' | 'other';
  link: boolean;
  size: number;
  mtime: string;
  /** Permission bits, e.g. 0o644. */
  mode: number;
}

export interface DirListing {
  /** Absolute, with symlinks resolved. */
  path: string;
  entries: FileEntry[];
}

export interface ContainerInfo {
  name: string;
  image: string;
  /** running, exited, restarting… */
  state: string;
  /** Docker's own wording, e.g. "Up 3 days (healthy)". */
  status: string;
}

export interface ServerStats {
  at: string;
  hostname: string;
  uptimeSec: number;
  load: [number, number, number];
  cpu: { pct: number; cores: number; tempC: number | null };
  mem: { usedBytes: number; totalBytes: number };
  /** The filesystem holding the data folder. */
  disk: { usedBytes: number; totalBytes: number } | null;
  data: { photosBytes: number; dbBytes: number };
  /** Bytes per second every 5 s for the last 5 min, oldest first. `host` is false when only the container's own traffic is visible. */
  net: { iface: string; ifaces: string[]; host: boolean; samples: { at: string; rxBps: number; txBps: number }[] } | null;
  /** null when Docker isn't connected (DOCKER_HOST). */
  containers: ContainerInfo[] | null;
  containersError: string | null;
  speed: { tests: SpeedTest[]; running: boolean };
}

export interface Photo {
  id: string;
  /** The point to keep in frame when the panel crops the photo, in percent from the top left. */
  focus: { x: number; y: number };
}

export interface SyncStatus {
  lastSuccess: string | null;
  lastAttempt: string | null;
  lastError: string | null;
}

export interface GoogleInfo {
  /** GOOGLE_CLIENT_ID/SECRET are set on the server. */
  configured: boolean;
  connected: boolean;
  email?: string;
  name?: string;
  /** Set when Google stopped accepting the sign-in and Launchpad disconnected itself: why, and when. */
  signedOut?: { reason: string; at: string };
}

export interface AppState {
  bookmarks: BookmarkGroup[];
  /** For ranking search and ⌘K results. */
  bookmarkOpens: BookmarkOpens;
  linkCheck: LinkCheck;
  notes: Note[];
  prefs: Prefs;
  google: GoogleInfo;
  calendars: CalendarInfo[];
  events: CalEvent[];
  taskLists: TaskList[];
  tasks: Task[];
  packages: Package[];
  sync: Record<SourceKey, SyncStatus>;
  /** Carriers that get live status (SingPost always; others with a 17TRACK key). */
  tracking: { allCarriers: boolean };
  news: NewsTopic[];
  newsLists: NewsLists;
  /** ANTHROPIC_API_KEY is set, so news topics and the inbox get summaries and not just lists. */
  newsSummaries: boolean;
  inbox: InboxState;
  /** Latest reading for prefs.weatherArea, and the areas Settings can offer. */
  weather: { areas: string[]; now: Weather | null };
  /** Shown in the photo panels, in display order. The files are at /api/photos/:id. */
  photos: Photo[];
  countdowns: Countdown[];
  /** When each cigarette was logged (ISO), oldest first, for the last 60 days. */
  smokes: string[];
  /** Keyed by YYYY-MM-DD. */
  moods: Record<string, Mood>;
  money: Money;
  training: Training;
  /** What each exercise trains, by name, as Claude read it. Names missing here fall back to rules in shared/training.ts. */
  exerciseMuscles: Record<string, ExerciseMuscles>;
  /** Body weight in kg, keyed by YYYY-MM-DD. */
  weights: Record<string, number>;
  /** null before the first note, or without an Anthropic API key. `error` is the last failure, shown in Training. */
  trainingNote: { note: TrainingNote | null; error: string | null };
  learn: Learn;
  /** null before the first note, or without an Anthropic API key. */
  learnNote: { note: LearnNote | null; error: string | null };
  /** The version of each document the page saves whole; missing in copies cached by older versions. */
  versions?: Partial<Record<SavedDoc, string>>;
}

/** Bookmarks and notes (version 1, from older Launchpads), or everything you've entered (version 2). */
/** The documents the page saves whole, so two devices could overwrite each other; each save says which version it started from. */
export type SavedDoc = 'bookmarks' | 'notes' | 'money' | 'learn';

export interface Backup {
  version: 1 | 2;
  exported: string;
  bookmarks: BookmarkGroup[];
  notes: Note[];
  prefs?: Prefs;
  countdowns?: Countdown[];
  /** Every cigarette logged, not just the last 60 days. */
  smokes?: string[];
  moods?: Record<string, Mood>;
  weights?: Record<string, number>;
  money?: Money;
  learn?: Learn;
  training?: Training;
  exerciseMuscles?: Record<string, ExerciseMuscles>;
  /** Including archived ones. */
  packages?: Package[];
  /** The photo panels' order and focus points. The files come in a .zip backup; a JSON one only re-lists photos still on the server. */
  photos?: Photo[];
  /** The reading list, hidden headlines and muted sources. */
  newsLists?: NewsLists;
  /** How often each bookmark's been opened, for ranking. */
  bookmarkOpens?: BookmarkOpens;
  /** Earlier versions of each notepad, by its id. The images notes show come in a .zip backup. */
  noteHistory?: Record<string, NoteVersion[]>;
}

export type BackupPart = Exclude<keyof Backup, 'version' | 'exported'>;

/** A copy of the database Launchpad took by itself: every night, before a restore, or when asked. */
export interface BackupSnapshot {
  id: string;
  /** ISO time it was taken. */
  at: string;
  reason: 'daily' | 'before-restore' | 'manual';
  /** Bytes. */
  size: number;
}
