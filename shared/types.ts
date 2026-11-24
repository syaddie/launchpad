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
export type DesignKey = 'mission' | 'broadsheet' | 'console' | 'bento' | 'horizon' | 'vista' | 'focus' | 'poster';
/** Every design, for checking a saved or sent one is still known. */
export const DESIGN_KEYS: DesignKey[] = ['mission', 'broadsheet', 'console', 'bento', 'horizon', 'vista', 'focus', 'poster'];
/**
 * A panel's place on the home grid (web/src/layout.ts). `hero` is the clock-and-next tile (Bento,
 * Focus); `wx` the weather and air panel Console and Bento print in full; `bm` the bookmarks row.
 */
export type HomeArea = 'today' | 'tasks' | 'notes' | 'pkgs' | 'photo' | 'photo2' | 'bm' | 'hero' | 'wx';
export const HOME_AREAS: HomeArea[] = ['today', 'tasks', 'notes', 'pkgs', 'photo', 'photo2', 'bm', 'hero', 'wx'];
/**
 * Home arrangements set by hand in Settings › Layout: for each design, its columns of panels left to
 * right; `narrow` is the phone's one column (shared by every design); Focus's one list is its tab order.
 * A design that's missing uses its own built-in arrangement.
 */
export type HomeLayouts = Partial<Record<DesignKey | 'narrow', HomeArea[][]>>;
export type GoogleSource = 'calendar' | 'tasks' | 'gmail';
export type SourceKey = GoogleSource | 'carriers' | 'digest' | 'inbox' | 'weather' | 'speedtest';
export type ViewKey = 'home' | 'digest' | 'inbox' | 'you' | 'training' | 'learn' | 'money' | 'server' | 'review' | 'music';

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
  /** What the daily digest teaches, one lesson a day each (shared/digest.ts). */
  digestSubjects: string[];
  /** What the old News view followed. Nothing reads it any more; kept so nothing typed in is lost. */
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
  /** Folders on the server starred in Server › Files, in the order they were pinned. */
  pinnedFolders: string[];
  /** What the gym costs a month, in dollars, for the cost of each session; 0 hides it. */
  gymMonthly: number;
  /** What a pack of cigarettes costs, in dollars, for what they cost; 0 hides it. */
  packPrice: number;
  /** Cigarettes in a pack. */
  packSize: number;
  /** A monthly budget for Claude in US dollars; going over it shows a warning. 0 means none. Missing in older saved prefs. */
  claudeBudget?: number;
  /** Copy the daily database copies to Google Drive, once the Google sign-in allows it. */
  driveBackup: boolean;
  /** Which kinds of phone alert are on (Settings › Alerts). Where they go is kept apart from prefs (server/src/notify.ts). */
  alerts: Record<AlertKind, boolean>;
  /** Unpack archives (a link, or what's in a torrent) next to them when they finish downloading. Missing in older saved prefs. */
  autoUnpack?: boolean;
  /** Home panels put in order by hand (Settings › Layout). Missing in older saved prefs. */
  homeLayouts?: HomeLayouts;
}

/** What a phone alert is about; each has its own switch in Settings › Alerts. */
export type AlertKind = 'health' | 'containers' | 'disks' | 'minecraft' | 'busking';
export const ALERT_KINDS: AlertKind[] = ['health', 'containers', 'disks', 'minecraft', 'busking'];

/** One alert sent to the phone, for Settings › Alerts. */
export interface AlertRecord {
  at: string;
  kind: AlertKind | 'test';
  /** problem: something started going wrong. fixed: it cleared. paused: too many about one thing, so it's held back. event: a one-off (a crash). */
  type: 'problem' | 'fixed' | 'paused' | 'event' | 'test';
  title: string;
}

/** GET /api/alerts: where alerts go and how sending is going. */
export interface AlertsInfo {
  /** The ntfy topic's address, or '' when alerts aren't set up. */
  topicUrl: string;
  /** Problems the phone has been told about that haven't cleared yet. */
  open: { kind: AlertKind; title: string; at: string }[];
  /** Newest first, the last 20. */
  recent: AlertRecord[];
  /** The last send that failed, until one works again. */
  lastError: { at: string; message: string } | null;
}

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  /** You can add events to it (you own it or can edit it). Missing in calendars synced before this was kept. */
  writable?: boolean;
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
  /** The task this is a subtask of. */
  parent?: string;
  notes?: string;
  /** Google's order among its siblings (compare as strings). */
  position?: string;
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

/** A multiple-choice question on a lesson, for Quick recall. `answer` is the index of the right option. */
export interface DigestQuiz {
  question: string;
  options: string[];
  answer: number;
  /** Why the right answer is right. */
  why: string;
}

/** One time a lesson came up in Quick recall. `choice` is -1 when it isn't known. */
export interface DigestRecall {
  at: string;
  choice: number;
  right: boolean;
}

/** "Too basic" or "Too deep" on a lesson; Claude pitches the subject's next ones from it. */
export type DigestFeedback = '' | 'basic' | 'deep';

/** A follow-up question asked on a lesson, with Claude's short answer. */
export interface DigestAsk {
  q: string;
  /** Plain text, maths in LaTeX between $…$ (shared/math.ts). */
  a: string;
  at: string;
}

/**
 * One lesson in the daily digest (shared/digest.ts). Lessons written before the digest went
 * short have `body` paragraphs and a `takeaway` but no `gist`, `points` or `check`; newer ones
 * the other way round. Text may have maths in LaTeX between $…$ (shared/math.ts).
 */
export interface DigestCard {
  id: string;
  /** What it was written for, as in prefs.digestSubjects. */
  subject: string;
  /** The concept's usual name. */
  title: string;
  /** A one-line teaser: why it's worth a look. */
  hook: string;
  /** The idea in a sentence or two ('' on lessons from before). */
  gist: string;
  /** Its key formula in LaTeX, without dollar signs, or ''. */
  formula: string;
  /** What the formula's symbols stand for, one line. */
  where: string;
  /** Two or three short lines on how it works ([] on lessons from before). */
  points: string[];
  /** Lessons from before: short paragraphs explaining it. */
  body: string[];
  /** A small worked example, as plain text (it may be a few lines of code or a sum). */
  example: string;
  /** The example is code: shown in the mono font, with no maths read from it. */
  exampleCode: boolean;
  /** Lessons from before: one line to remember. */
  takeaway: string;
  /** Words to look it up by, for "Go deeper". */
  search: string;
  /** The quick question on the card itself, answered there and then. */
  check: DigestQuiz | null;
  /** The option picked in `check`, or -1 before it's answered. */
  checked: number;
  /** The question Quick recall asks a few days later. */
  quiz: DigestQuiz | null;
  starred: boolean;
  feedback: DigestFeedback;
  /** Oldest first. */
  recalls: DigestRecall[];
  /** Follow-up questions, oldest first. */
  asks: DigestAsk[];
}

export interface DigestDay {
  /** YYYY-MM-DD, the server's day (Asia/Singapore). */
  date: string;
  cards: DigestCard[];
}

/** Every day's lessons, as the store keeps them. */
export interface DigestStore {
  /** Newest first. */
  days: DigestDay[];
  /** "subject: title" of lessons swapped out with "Another one", so they aren't written again. */
  skipped: string[];
  /** Why the last try at writing lessons failed, until one works. */
  error: string | null;
}

/** Today's question in Quick recall. The answer comes once it's been given. */
export interface RecallQuestion {
  cardId: string;
  /** The day the lesson was written. */
  date: string;
  subject: string;
  title: string;
  question: string;
  options: string[];
  answered: { choice: number; right: boolean; answer: number; why: string; takeaway: string } | null;
}

/** The digest as the page gets it: the last two weeks, with the rest in the archive's search. */
export interface DigestState {
  /** Newest first. */
  days: DigestDay[];
  /** Lessons in the whole archive. */
  total: number;
  /** Subjects in the archive with how many lessons each, most first. */
  subjects: { subject: string; count: number }[];
  recall: RecallQuestion | null;
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
  /** Archived from Launchpad: left out of the digest and the list. */
  archived?: boolean;
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
  /** 1 Rough · 2 Low · 3 Okay · 4 Good · 5 Great; 0 for a day with only a journal entry. */
  level: number;
  /** The day's journal entry, in light Markdown (it began as a one-line note). */
  note: string;
}

/** What set off a craving. */
export type CravingTrigger = 'stress' | 'coffee' | 'meal' | 'social' | 'boredom' | 'alcohol' | 'waking' | 'other';

/** A craving for a cigarette that wasn't acted on. */
export interface Craving {
  id: string;
  /** ISO date-time. */
  at: string;
  /** 1 mild · 2 medium · 3 strong. */
  strength: 1 | 2 | 3;
  /** Empty when not given. */
  trigger: CravingTrigger | '';
  note: string;
}

/** Cigarettes a day before `before` (YYYY-MM-DD), keyed by day; from that day on, count `smokes` instead. */
export interface SmokeDays {
  before: string;
  counts: Record<string, number>;
}

/** Claude's short recap of a week, for the Review view. */
export interface ReviewNote {
  headline: string;
  points: string[];
  writtenAt: string;
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
  /** Entries added together on repeat share this (and a subscription is one); absent for one-offs. */
  series?: string;
  /**
   * The bank statement lines it's the money for (shared/statement.ts keys), so importing
   * a statement again skips them. Several for a busking session's tips; absent when typed in.
   */
  refs?: string[];
}

/**
 * What a statement import remembers about where money went: the name and category you
 * left on the last one, so the next statement starts from them. `id` is the match key:
 * `m:` and the merchant as the bank writes it, or `p:` and a person's name.
 */
export interface MoneyRule {
  id: string;
  /** The note to use; empty keeps the one made from the bank's text. */
  name: string;
  category: MoneyCategory | '';
  /** Money with this person is a move to or from this account of yours (your own PayNow from another bank). */
  move?: string;
}

export type Every = 'week' | 'fortnight' | 'month';

/** A repeating money-out entry marked as a subscription. Its name, amount and account come from the entries. */
export interface Subscription {
  /** The `series` of its entries. */
  id: string;
  every: Every;
  /** Marked to reconsider. */
  review: boolean;
  /** YYYY-MM it started, if before the first entry here; empty to go by the first entry. */
  since: string;
}

/** Something to save up for, kept in an account or set aside somewhere Money doesn't track. */
export interface SavingsGoal {
  id: string;
  name: string;
  target: number | null;
  /** YYYY-MM to reach it by; empty when there's no date. */
  by: string;
  /** The account it's kept in; empty when it's somewhere else. */
  account: string;
  /** What's set aside so far, when it isn't in an account. */
  saved: number;
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
  /** What it prints as, when it was made in the invoice form; its amount is then these rows' total. */
  doc?: InvoiceDoc;
}

/** One row on an invoice: a set, a fee, or (with a negative rate) a discount. */
export interface InvoiceLine {
  desc: string;
  /** A second, smaller line under the description; may be empty. */
  note: string;
  qty: number;
  rate: number;
}

/** Who an invoice is billed to. */
export interface InvoiceClient {
  company: string;
  /** The person it's for ("Attn: …"); may be empty. */
  attn: string;
  /** Lines separated by newlines. */
  address: string;
  phone: string;
}

/** You, at the top of an invoice. */
export interface InvoiceFrom {
  name: string;
  address: string;
  phone: string;
  email: string;
}

/** A way to pay you, printed as a box at the bottom: "PayNow", "T1234567A", "NRIC". */
export interface InvoicePay {
  label: string;
  value: string;
  note: string;
}

/**
 * Everything an invoice prints besides its number, event, amount and due date (the
 * Invoice's own). Your details and terms are a copy, so an old invoice prints as it was sent.
 */
export interface InvoiceDoc {
  /** YYYY-MM-DD: the invoice's date. */
  issued: string;
  client: InvoiceClient;
  /** YYYY-MM-DD, or empty when it isn't printed. */
  eventDate: string;
  venue: string;
  lines: InvoiceLine[];
  from: InvoiceFrom;
  pay: InvoicePay[];
  terms: string;
  thanks: string;
}

/** A row you add often, one tap away in the invoice form. A null rate is filled in each time. */
export interface InvoiceItem {
  id: string;
  desc: string;
  note: string;
  rate: number | null;
}

/** What each new invoice starts from; updated every time one is made. */
export interface InvoiceSetup {
  from: InvoiceFrom;
  pay: InvoicePay[];
  terms: string;
  thanks: string;
  /** Days from the invoice's date to its due date. */
  dueDays: number;
  /** Who you've billed, latest first. */
  clients: InvoiceClient[];
  items: InvoiceItem[];
  /** The last number used, so one made without adding it to Owed still moves the count on. */
  lastNum: string;
}

export type AccountKind = 'bank' | 'cash' | 'invest' | 'pot';

/** Somewhere money is kept: a bank, a wallet, investments, or a pot set aside for something. */
/**
 * A bill, due notice or receipt found in Gmail, waiting for Keep or Dismiss in the Inbox view.
 * Keep adds it to Money: planned money out on the due date, or done on the day it was paid.
 */
export interface BillSuggestion {
  /** The email's id. */
  id: string;
  threadId: string;
  subject: string;
  payee: string;
  amount: number;
  /** ISO code, e.g. SGD or USD. */
  currency: string;
  /** due: still to pay · paid: a receipt. */
  status: 'due' | 'paid';
  /** YYYY-MM-DD: when it's due, or when it was paid. */
  date: string;
  /** The email didn't give a due date, so `date` is the day it arrived. */
  noDate?: boolean;
  category: MoneyCategory | '';
  /** Read by the rules for known senders, or by Claude. */
  source: 'rules' | 'claude';
  foundAt: string;
}

// ---------- importing a bank statement (shared/statement.ts, POST /api/money/statement) ----------

/** What the page asks the server about a statement's dates and merchants. No people's names are sent. */
export interface StatementAsk {
  /** YYYY-MM-DD, the first and last day on the statement. */
  from: string;
  to: string;
  /** Shops as the bank writes them, for Claude to name and put in a category. */
  merchants: { text: string; dir: 'in' | 'out'; /** Where the card was used, e.g. IDN, when the bank says. */ country?: string }[];
}

/** A busking session: a calendar event or one of your NAC bookings. */
export interface BuskSession {
  /** YYYY-MM-DD it started (Singapore time). */
  date: string;
  /** It ran past midnight, so the next day's tips are its too. */
  late: boolean;
  /** Where, for the entry's note, e.g. "Paya Lebar". */
  where: string;
  from: 'calendar' | 'nac';
}

/** A bill or receipt email in the statement's dates. */
export interface StatementEmail {
  id: string;
  payee: string;
  subject: string;
  amount: number;
  date: string;
  status: 'due' | 'paid';
  category: MoneyCategory | '';
}

export interface StatementContext {
  sessions: BuskSession[];
  emails: StatementEmail[];
  /** Claude's name and category for each merchant asked about it, by the bank's text. */
  names: Record<string, { name: string; category: MoneyCategory | '' }>;
  /** What couldn't be checked and why, shown in the review. */
  notes: string[];
}

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
  /** Repeating money out marked as subscriptions. */
  subs: Subscription[];
  goals: SavingsGoal[];
  /** Names and categories learned from statement imports; missing in trackers from before them. */
  rules?: MoneyRule[];
  /** Your details, saved clients and quick-add rows for the invoice form; missing until the first invoice is made. */
  invoiceSetup?: InvoiceSetup;
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
  /** A what-if score kept as what you're aiming for; absent when there's none. */
  aim?: number;
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
  /** Docker's full 64-character id. */
  id: string;
  name: string;
  image: string;
  /** running, exited, restarting… */
  state: string;
  /** Docker's own wording, e.g. "Up 3 days (healthy)". */
  status: string;
  /** Launchpad's own container, which the page won't restart. */
  self: boolean;
}

/** A line of a container's log. */
export interface LogLine {
  /** Docker's timestamp, with the fraction padded to 9 digits so later lines sort after earlier ones. */
  at: string | null;
  stream: 'out' | 'err';
  text: string;
}

/** A disk's SMART health, read with smartctl over SSH. */
export interface DiskHealth {
  /** e.g. /dev/sda or /dev/nvme0. */
  name: string;
  model: string | null;
  serial: string | null;
  capacityBytes: number | null;
  kind: 'nvme' | 'ssd' | 'hdd' | 'unknown';
  /** SMART's overall verdict; null when the disk didn't give one. */
  passed: boolean | null;
  tempC: number | null;
  powerOnHours: number | null;
  /** ATA and SATA disks. */
  reallocated: number | null;
  pending: number | null;
  uncorrectable: number | null;
  /** NVMe drives: how much of the rated write endurance is used, errors on the media, spare blocks left (%). */
  percentUsed: number | null;
  mediaErrors: number | null;
  availableSpare: number | null;
  /** good, worth a look (warn), or failing (bad). */
  level: 'good' | 'warn' | 'bad' | 'unknown';
  /** What's worrying, in plain words. */
  problems: string[];
  /** smartctl couldn't read this disk. */
  error: string | null;
}

export interface DisksReport {
  /** When the disks were last read; null before the first time. */
  at: string | null;
  /** ok, or what's missing: SSH off, the sudoers rule, or smartmontools itself. */
  status: 'ok' | 'no-ssh' | 'no-sudo' | 'no-smartctl' | 'error';
  message: string | null;
  disks: DiskHealth[];
}

/** A saved command for the terminal. */
export interface Snippet {
  id: string;
  name: string;
  command: string;
}

// ---------- Minecraft ----------

/** How a Minecraft server's console is reached: the tmux or screen session it runs in. */
export type McMux = 'tmux' | 'screen';

/** A Minecraft server saved in Launchpad, so it's listed (and can be started) while it's stopped. */
export interface McServer {
  id: string;
  name: string;
  /** The server's folder, with server.properties and logs/latest.log in it. */
  dir: string;
  mux: McMux;
  /** The tmux or screen session's name. */
  session: string;
  /** What to type in the session to start it, e.g. ./start.sh. Empty: no Start button. */
  start: string;
  /** Start it again when it stops on its own (a crash). Needs a start command. Missing: off. */
  autoRestart?: boolean;
  /** How many of Launchpad's world backups to keep; older ones are removed after a new one. Missing: MC_KEEP_BACKUPS. */
  keepBackups?: number;
  /** Where world backups go. Missing: a backups folder inside `dir`. */
  backupDir?: string;
}

export interface McStatus extends McServer {
  /** Saved in Launchpad; otherwise only found running. */
  saved: boolean;
  running: boolean;
  pid: number | null;
  /** It runs inside tmux or screen, so commands can be typed into it. */
  attached: boolean;
  /** A backup or restore is under way. */
  job?: 'backup' | 'restore';
  /** Restart if it crashes gave up after too many crashes in a row. */
  gaveUp?: boolean;
}

/** World backups kept per server unless the server says otherwise. */
export const MC_KEEP_BACKUPS = 7;

/** One thing the check found out about a server that won't start (or is misbehaving). */
export interface McFinding {
  level: 'error' | 'warn' | 'info';
  text: string;
  /** The line of output it came from, when there is one. */
  detail?: string;
}

/** What Diagnose reports: the findings, plus the raw output they came from. */
export interface McDiagnosis {
  findings: McFinding[];
  /** What the tmux or screen session last printed. */
  pane: string;
  /** The end of logs/latest.log. */
  log: string;
  running: boolean;
  /** When the check ran (ms since epoch). */
  at: number;
  /** The newest report in crash-reports/, however old. */
  crash?: McCrashSummary | null;
}

/** New lines of a server's logs/latest.log since `offset`. */
export interface McLog {
  text: string;
  /** Where the next read starts. */
  offset: number;
  /** The log started over (a restart) or this is the first read: replace what's shown. */
  reset: boolean;
  /** There's no logs/latest.log in the folder. */
  missing: boolean;
}

// ---------- Minecraft: players, meters, backups, crashes ----------

export interface McPlayer {
  name: string;
  /** With dashes; null when nothing Launchpad read says. */
  uuid: string | null;
  op: boolean;
  whitelisted: boolean;
}

/** Who's on, from a Server List Ping and, when that doesn't name everyone, the console's `list`. */
export interface McPlayers {
  running: boolean;
  /** null when the server didn't answer the ping. */
  online: number | null;
  max: number | null;
  players: McPlayer[];
  /** whitelist.json. */
  whitelist: { name: string; uuid: string | null }[];
  /** white-list=true in server.properties. */
  whitelistOn: boolean;
  /** As the server reports it, e.g. "Paper 1.21.1". */
  version: string | null;
  /** Why some or all names are missing, when they are. */
  note: string | null;
  at: number;
}

export type McPlayerAction = 'kick' | 'op' | 'deop' | 'whitelist-add' | 'whitelist-remove' | 'tp';

/** The Java process's memory and CPU, and TPS/MSPT where the server reports them. */
export interface McMeters {
  running: boolean;
  /** Resident memory, bytes. */
  rss: number | null;
  /** Share of the whole machine, 0–100. */
  cpu: number | null;
  cores: number | null;
  /** Seconds the process has been up. */
  uptime: number | null;
  online: number | null;
  max: number | null;
  /** Ticks per second and milliseconds per tick: null when the server can't say (vanilla before 1.20.3 without Spark). */
  tps: number | null;
  mspt: number | null;
  tpsFrom: 'spark' | 'paper' | 'vanilla' | null;
  /** When TPS was read (ms since epoch). */
  tpsAt: number | null;
  at: number;
}

export interface McBackup {
  name: string;
  size: number;
  /** When it was taken (ISO). */
  at: string;
  /** Taken just before a restore, to undo it. */
  beforeRestore: boolean;
}

/** A backup or restore under way, or the last one to finish. */
export interface McJob {
  kind: 'backup' | 'restore';
  /** What it's doing now, as a short sentence. */
  step: string;
  startedAt: string;
  endedAt: string | null;
  ok: boolean | null;
  /** How it went, once it's over. */
  message: string | null;
  file: string | null;
  /** How big the backup is so far, while it's being packed. */
  bytes: number | null;
}

export interface McBackups {
  dir: string;
  keep: number;
  list: McBackup[];
  job: McJob | null;
  /** Free space where backups go, bytes; null when it can't be read. */
  free: number | null;
  /** Folders a restore left behind when it was cut off, in the server's folder. */
  leftovers: string[];
}

export interface McCrashReport {
  name: string;
  at: string;
  size: number;
}

export interface McCrashSummary extends McCrashReport {
  description: string | null;
  /** The exception and its first lines. */
  lines: string[];
}

/** One thing Restart if it crashes noticed or did. */
export interface McRestart {
  at: string;
  kind: 'crash' | 'restart' | 'gave-up';
  reason: string;
}

/** What's kept per server for Restart if it crashes. */
export interface McWatchRecord {
  gaveUp: boolean;
  /** Newest last. */
  log: McRestart[];
}

export interface McCrashes {
  reports: McCrashReport[];
  /** Restart if it crashes, for saved servers. */
  autoRestart: boolean;
  gaveUp: boolean;
  restarts: McRestart[];
}

/** What Claude made of the end of a log. */
export interface ExplainResult {
  summary: string;
  cause: string;
  fix: string[];
  /** Exactly what was sent, secrets taken out. */
  excerpt: string;
  /** The log had a clear error in it, rather than only its last lines. */
  foundError: boolean;
}

export interface ExplainStatus {
  /** There's an API key; without one the button isn't shown at all. */
  configured: boolean;
  ready: boolean;
  /** Why not, in a sentence, when it isn't. */
  reason: string | null;
}

// ---------- downloads and torrents ----------

export interface DownloadJob {
  id: string;
  url: string;
  /** The file's name in `dir`; known once the site answers. */
  name: string;
  dir: string;
  received: number;
  /** From Content-Length; null when the site doesn't say. */
  total: number | null;
  bps: number;
  state: 'starting' | 'downloading' | 'done' | 'failed' | 'cancelled';
  error: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Instagram posts or a profile, rather than one file: `url` is what was pasted, `received` counts every file. */
  ig?: IgProgress;
  /** A video (or its sound) saved with yt-dlp: `received` and `total` are the download's, then the copy's into `dir`. */
  video?: VideoProgress;
}

/** Server › Downloads' choices for a video: yt-dlp's best, up to 1080p as an .mp4, or the sound as an .mp3. */
export type VideoFormat = 'best' | '1080p' | 'mp3';

export interface VideoProgress {
  format: VideoFormat;
  /** The site as yt-dlp names it (Youtube, TikTok, Vimeo…), once it has looked. */
  site: string | null;
  title: string | null;
  /** Finding the video; downloading it (`part` of `parts`: the video, then its sound); ffmpeg at work on it (`step`); copying it into the folder. */
  phase: 'finding' | 'downloading' | 'processing' | 'saving';
  part: number;
  parts: number;
  /** What ffmpeg is doing: joining the video and sound, making an MP3 or an MP4, tidying the file, or adding its title. */
  step: 'join' | 'mp3' | 'mp4' | 'fix' | 'tags' | null;
  /** The link was a playlist's (or a channel's), so only its first video was taken. */
  playlist: boolean;
}

export interface VideoInfo {
  /** yt-dlp and ffmpeg are installed where Launchpad can run them (they come with the Docker image). */
  available: boolean;
  version: string | null;
  /** Why it isn't available. */
  error: string | null;
}

export interface IgProgress {
  /** A profile's newest how many; null for post links. Kept for Try again. */
  limit: number | null;
  /** Each post's caption (.txt) and details (.json) are saved beside it. */
  metadata: boolean;
  /** Posts asked for: the links pasted, or the profile's limit (it may have fewer). */
  want: number;
  /** Posts finished with, saved or not. */
  postsDone: number;
  /** The post being saved: files done of its total. */
  current: { done: number; of: number } | null;
  /** Photos and videos saved, ones already in the folder, and posts that couldn't be read. */
  files: number;
  skipped: number;
  failed: number;
  /** Why the last post that couldn't be read couldn't be. */
  lastError: string | null;
  /** Where the files went: the account's folder, or `dir` when the posts came from several accounts. */
  folder: string | null;
  /** Waiting for another Instagram download to finish (they run one at a time). */
  queued: boolean;
  /** Instagram asked to slow down; carrying on at this time. */
  waitUntil: string | null;
}

export interface InstagramInfo {
  /** instaloader is installed where Launchpad can run it (it comes with the Docker image). */
  available: boolean;
  version: string | null;
  /** Why it isn't available. */
  error: string | null;
  /** Signed in with this account's session; null downloads public posts only. */
  account: string | null;
  /** Instagram turned the session away last time it was used. */
  stale: boolean;
}

export interface DownloadsInfo {
  jobs: DownloadJob[];
  /** Where a download goes unless another folder is picked: ~/Downloads, or home. Null without SSH. */
  defaultDir: string | null;
  instagram: InstagramInfo;
  video: VideoInfo;
  /** Archives unpacked after they finished downloading, newest first, since Launchpad started. */
  unpacks: UnpackRecord[];
}

/** One archive unpacked (or being unpacked) because it finished downloading. */
export interface UnpackRecord {
  id: string;
  /** When it was queued, then when it finished. */
  at: string;
  /** The archive on the server. */
  file: string;
  from: 'link' | 'torrent';
  state: 'waiting' | 'unpacking' | 'done' | 'failed';
  /** The folder it went into, also when it failed partway. */
  folder?: string;
  message?: string;
}

export type TorrentStatus = 'downloading' | 'seeding' | 'done' | 'paused' | 'queued' | 'checking' | 'stalled' | 'metadata' | 'moving' | 'error';

export interface Torrent {
  hash: string;
  name: string;
  size: number;
  /** Bytes downloaded of `size`. */
  done: number;
  /** 0 to 1. */
  progress: number;
  dlBps: number;
  upBps: number;
  /** Seconds to go; null when unknown or finished. */
  etaSec: number | null;
  /** qBittorrent's own state, e.g. stalledDL. */
  state: string;
  status: TorrentStatus;
  seeds: number;
  peers: number;
  ratio: number;
  addedAt: string;
  /** Where qBittorrent saves it, inside its container. */
  savePath: string;
  /** The same folder on the server itself, for Files; null when QBIT_HOST_DIR isn't set or it's elsewhere. */
  hostDir: string | null;
  /** qBittorrent's category ('' for none) and tags. */
  category: string;
  tags: string[];
  /** Launchpad takes it out of qBittorrent, keeping its files, once it has seeded to this ratio; null to seed on. */
  ratioLimit: number | null;
}

/** qBittorrent's speed caps in bytes a second (0 for none): the usual ones, and turtle mode's (its alternative limits). */
export interface TorrentSpeed {
  turtle: boolean;
  dl: number;
  up: number;
  turtleDl: number;
  turtleUp: number;
}

/** A torrent that reached its ratio and was taken out of qBittorrent, its files left where they are. */
export interface RetiredTorrent {
  name: string;
  ratio: number;
  at: string;
  hostDir: string | null;
}

export interface TorrentFile {
  /** qBittorrent's number for the file. */
  index: number;
  /** Its path inside the torrent. */
  name: string;
  size: number;
  /** 0 to 1. */
  progress: number;
  priority: 'skip' | 'normal' | 'high';
  /** The folder it's in on the server, for Files; null when that can't be known. */
  hostDir: string | null;
}

/** What a torrent can be added with: qBittorrent's categories (each a save folder) and tags. */
export interface TorrentOptions {
  categories: { name: string; savePath: string; hostDir: string | null }[];
  tags: string[];
}

export interface TorrentsInfo {
  /** QBIT_URL is set. */
  configured: boolean;
  error: string | null;
  torrents: Torrent[];
  dlBps: number;
  upBps: number;
  version: string | null;
  /** Where finished torrents land on the server (QBIT_HOST_DIR), if known. */
  hostDir: string | null;
  speed: TorrentSpeed | null;
  /** Taken out of qBittorrent at their ratio since Launchpad started, newest first. */
  retired: RetiredTorrent[];
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
  /** The restart-only Docker proxy is connected (DOCKER_RESTART_HOST), so containers can be restarted from the page. */
  canRestart: boolean;
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
  /** Failures in a row since the last success; missing in statuses saved before it was counted. */
  failures?: number;
}

/** Copying the daily database copies to a "Launchpad backups" folder in Google Drive. */
export interface DriveStatus {
  /** The switch in Settings › General › Backup (prefs.driveBackup). */
  on: boolean;
  /** The Google sign-in allows Drive (the drive.file scope). */
  allowed: boolean;
  lastSuccess: string | null;
  lastAttempt: string | null;
  lastError: string | null;
  running: boolean;
}

/** Something the health check found wrong. `key` is a SourceKey for a sync, or database, copies or drive. */
export interface HealthWarning {
  key: SourceKey | 'database' | 'copies' | 'drive';
  name: string;
  text: string;
  /** The error behind it, when there is one. */
  detail?: string;
}

/** GET /api/health. */
export interface Health {
  database: { ok: boolean; error: string | null };
  lastCopy: { at: string | null; ageHours: number | null };
  drive: DriveStatus;
  sync: Record<SourceKey, SyncStatus & { on: boolean; everyMinutes: number }>;
  warnings: HealthWarning[];
}

export interface GoogleInfo {
  /** GOOGLE_CLIENT_ID/SECRET are set on the server. */
  configured: boolean;
  connected: boolean;
  email?: string;
  name?: string;
  /** Set when Google stopped accepting the sign-in and Launchpad disconnected itself: why, and when. */
  signedOut?: { reason: string; at: string };
  /** Scopes added since this sign-in was made (e.g. drive.file); everything else keeps working until it's reconnected. */
  missingScopes?: string[];
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
  digest: DigestState;
  newsLists: NewsLists;
  /** ANTHROPIC_API_KEY is set, so there's a daily digest and the inbox gets summaries and not just lists. */
  newsSummaries: boolean;
  inbox: InboxState;
  /** Latest reading for prefs.weatherArea, and the areas Settings can offer. */
  weather: { areas: string[]; now: Weather | null };
  /** Shown in the photo panels, in display order. The files are at /api/photos/:id. */
  photos: Photo[];
  countdowns: Countdown[];
  /** When each cigarette was logged (ISO), oldest first, for the last 60 days. */
  smokes: string[];
  /** Cigarettes a day for the days `smokes` doesn't cover, for costs over the year and past weeks. */
  smokeDays: SmokeDays;
  /** Cravings not acted on, oldest first. */
  cravings: Craving[];
  /** Keyed by YYYY-MM-DD. */
  moods: Record<string, Mood>;
  money: Money;
  training: Training;
  /** What each exercise trains, by name, as Claude read it. Names missing here fall back to rules in shared/training.ts. */
  exerciseMuscles: Record<string, ExerciseMuscles>;
  /** Body weight in kg, keyed by YYYY-MM-DD. */
  weights: Record<string, number>;
  learn: Learn;
  /** null before the first note, or without an Anthropic API key. */
  learnNote: { note: LearnNote | null; error: string | null };
  /** Claude's weekly recaps, keyed by the week's Monday (YYYY-MM-DD); empty without an Anthropic API key. */
  reviewNotes: { notes: Record<string, ReviewNote>; error: string | null };
  /** Packages delivered in the last year, archived ones included, for the Review. */
  delivered: { label: string; at: string }[];
  /** What Claude has cost this month so far, estimated in US dollars (Server › Claude usage). Missing in older cached copies. */
  claudeSpend?: number;
  /** Copying the daily copies to Google Drive; missing in copies cached by older versions. */
  drive?: DriveStatus;
  /** Bills and receipts found in Gmail, waiting for Keep or Dismiss; missing in copies cached by older versions. */
  bills?: BillSuggestion[];
  /** What the health check found wrong (see GET /api/health); missing in copies cached by older versions. */
  health?: HealthWarning[];
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
  cravings?: Craving[];
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
  /** Every day's lessons in the daily digest, with stars, ratings and recall answers. */
  digest?: DigestStore;
  /** How often each bookmark's been opened, for ranking. */
  bookmarkOpens?: BookmarkOpens;
  /** Earlier versions of each notepad, by its id. The images notes show come in a .zip backup. */
  noteHistory?: Record<string, NoteVersion[]>;
  /** The terminal's saved commands. */
  snippets?: Snippet[];
  /** The Minecraft servers saved in the Server view. */
  minecraft?: McServer[];
  /** The busking locations Music › Busking slots checks, in order. */
  nacPlaces?: NacPlace[];
  /** The busking slots being watched for a cancellation. */
  nacWatches?: NacWatch[];
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

// ---------- NAC Slot Finder (server/src/nac.ts; docs/nac-slot-finder-spec.md §6) ----------
// The field names follow the spec's JSON. Times are Singapore time: dates YYYY-MM-DD,
// times "HH:MM", moments ISO with +08:00. No busker's name or profile ID is ever in here.

/** A run of free 1-hour blocks at one location on one day. */
export interface NacFree {
  start: string;
  end: string;
  /** Wasn't free at the check before (a cancellation, or a date newly open for booking). */
  new: boolean;
}

/** A run of booked 1-hour blocks with one status. */
export interface NacBooked {
  start: string;
  end: string;
  /** NAC's word for the booking ("Published", "Confirmed"); any other word still counts as taken. */
  status: string;
}

export interface NacDay {
  date: string;
  free: NacFree[];
  /** Your own bookings (matched by NAC_BUSKER_ID). */
  mine: NacBooked[];
  taken: NacBooked[];
  /**
   * The Music-only page's busker's bookings (config's nac.guestBuskerId), kept apart in the saved
   * result so that page can show them as theirs; /api/nac counts them as taken. Missing in results
   * saved before it was added.
   */
  guest?: NacBooked[];
}

export interface NacLocation {
  key: string;
  /** Display name, e.g. "Paya Lebar Square". */
  name: string;
  /** For tight rows, e.g. "Paya Lebar". */
  short: string;
  /** NAC's own name for it, read from its page. */
  nac_name: string;
  /** Its public page on the NAC portal. */
  url: string;
  /** Open hours, read from its page on every check. */
  open: string;
  close: string;
  /** The latest booking date seen there; later days are unknown, not free. Null when no bookings were seen at all. */
  horizon_end: string | null;
  /** Bookings read from its page on that check, past ones included. */
  bookings: number;
  /** From the day of the check to horizon_end. That day only has the blocks that hadn't ended. */
  days: NacDay[];
}

/** The Slot Finder's result, kept in DATA_DIR/nac/snapshot.json. */
export interface NacSlots {
  /** When NAC was last asked; null before the first check. */
  checked_at: string | null;
  /** That check worked. When false, `locations` is still the last good data (from `last_good_at`). */
  ok: boolean;
  /** Why it failed. */
  error: string | null;
  /** When `locations` was read; null until a check has worked. */
  last_good_at: string | null;
  /** When the next check is due: :05, :15 … :55, later after failures. */
  next_check: string | null;
  /** Checks that failed in a row; each one waits longer before the next. */
  failures: number;
  /** Statuses on that check that aren't Published, Confirmed or Passed. They count as taken. */
  unknown_statuses: string[];
  /** NAC_BUSKER_ID was set, so your own bookings were told apart. */
  mine_on: boolean;
  /** The Music-only page's busker's bookings were told apart too (`guest` on each day). Only in the saved result. */
  guest_on?: boolean;
  locations: NacLocation[];
}

/**
 * A busking location the Slot Finder checks. The four in server/src/config.ts are where it
 * starts; Music › Busking slots › Locations adds, renames, orders and removes them (store key
 * `nacPlaces`). `nac` is NAC's name for it; `name` and `short` are yours.
 */
export interface NacPlace {
  /** Stays the same through renames; the snapshot matches locations by it. */
  key: string;
  /** The id in the location page's address. */
  id: string;
  nac: string;
  name: string;
  short: string;
}

/**
 * A slot watched in Music › Busking slots: when any of it frees up (a cancellation, or the day
 * opening for booking), the phone is told once, through Settings › Alerts (kind 'busking').
 */
export interface NacWatch {
  id: string;
  /** The location's key. */
  place: string;
  /** YYYY-MM-DD, Singapore. */
  date: string;
  /** The hours watched, "HH:MM"; a location's open hours for the whole day. */
  start: string;
  end: string;
  /** ISO time it was set. */
  created: string;
  /** ISO time it freed up and the phone was told, or null while it's still being watched. */
  freed: string | null;
  /** What freed up, within the hours watched. */
  found: { start: string; end: string }[];
}

/** POST /api/nac/lookup: what a location's NAC page says, before it's added. */
export interface NacLookup {
  id: string;
  /** NAC's own name for it. */
  nac: string;
  url: string;
  open: string;
  close: string;
  /** Names to start from, tidied from NAC's. */
  name: string;
  short: string;
  /** Already on the list, under this name. */
  watched: string | null;
}

/** GET /api/nac: the result, plus what the page needs before there is one. */
export interface NacStatus extends NacSlots {
  /** The locations it checks, in order. `locations` only holds these, named as they are now. */
  watching: { key: string; name: string; short: string; nac: string; url: string }[];
  /** At most this many locations: each one adds a request to every check. */
  max_places: number;
  /** Slots watched for a cancellation, from today on, at locations on the list. */
  watches: NacWatch[];
  /** Whether a watched slot freeing up reaches the phone: alerts set up and on, no topic yet, or Busking alerts switched off. */
  watch_alerts: 'ok' | 'no-topic' | 'off';
  /** Read from saved test pages (NAC_FIXTURES), not from NAC. */
  fixtures: boolean;
  /** A check is running now. */
  running: boolean;
  /** When a check asked for (or the first one) will start, waiting for schedule-sync's :00 or :30 to pass; null when none is waiting. */
  queued_at: string | null;
  /** Why Check now can't be used at the moment (one's running, the last was under 5 minutes ago, or it's backing off, or there are no locations), or null when it can. */
  can_check: string | null;
}

/**
 * GET /api/guest/nac: Music's busking slots for a music-only sign-in (server/src/access.ts).
 * The same slots as /api/nac, without the owner's bookings (they show as taken) or watches, and
 * with the owner's look so the page matches the app.
 */
export interface GuestMusic {
  nac: NacStatus;
  look: { design: DesignKey; accent: AccentKey; theme: ThemeMode };
}
