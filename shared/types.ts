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

export interface Note {
  id: string;
  name: string;
  text: string;
}

export type ThemeMode = 'system' | 'light' | 'dark';
export type AccentKey = 'sage' | 'slate' | 'terracotta';
export type GoogleSource = 'calendar' | 'tasks' | 'gmail';
export type SourceKey = GoogleSource | 'carriers' | 'news' | 'inbox' | 'weather' | 'speedtest';
export type ViewKey = 'home' | 'news' | 'inbox' | 'you' | 'training' | 'money' | 'server';

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
  /** Google calendar ids the user unticked in Settings. */
  hiddenCalendars: string[];
  /** Per-source on/off switches from Settings. */
  sources: Record<GoogleSource, boolean>;
  /** Search terms for the News tab, in display order. */
  newsTopics: string[];
  /** 2-hour forecast area for the weather beside the clock (e.g. "Bishan"); empty hides it. */
  weatherArea: string;
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
  topic: string;
  /** Newest first. */
  articles: NewsArticle[];
  /** Claude's digest of the headlines, or null before the first one (or without an API key). */
  stories: NewsStory[] | null;
  summarisedAt: string | null;
  fetchedAt: string | null;
  error: string | null;
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

/** One amount of money in or out on a day. Planned ones are the forecast; done ones actually happened. */
export interface MoneyEntry {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  kind: 'in' | 'out';
  amount: number;
  note: string;
  /** Optional; empty when not set. */
  category: MoneyCategory | '';
  planned: boolean;
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
  /** The first day tracked (YYYY-MM-DD) and the balance that morning. */
  start: string;
  opening: number;
  /** Sorted by date, then in the order they were added. */
  entries: MoneyEntry[];
  wishlist: WishItem[];
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

/** Workouts from Hevy, newest first, and where they came from (shared/training.ts). */
export interface Training {
  workouts: Workout[];
  /** 'csv' for Hevy's export; empty before the first import. */
  source: 'csv' | '';
  importedAt: string | null;
}

export interface SpeedTest {
  /** ISO date-time. */
  at: string;
  downMbps: number;
  upMbps: number;
  pingMs: number;
  jitterMs: number;
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
}

export interface Backup {
  version: 1;
  exported: string;
  bookmarks: BookmarkGroup[];
  notes: Note[];
}
