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
export type SourceKey = GoogleSource | 'carriers' | 'news';

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
  /** ANTHROPIC_API_KEY is set, so topics get summaries and not just headlines. */
  newsSummaries: boolean;
}

export interface Backup {
  version: 1;
  exported: string;
  bookmarks: BookmarkGroup[];
  notes: Note[];
}
