import type { BookmarkGroup, Note, Prefs, SearchEngine } from './types';

export const STARTER_BOOKMARKS: BookmarkGroup[] = [
  {
    id: 'g1', name: 'Daily', items: [
      { id: 'b1', name: 'Gmail', url: 'https://mail.google.com' },
      { id: 'b2', name: 'Calendar', url: 'https://calendar.google.com' },
      { id: 'b3', name: 'YouTube', url: 'https://youtube.com' },
    ],
  },
  { id: 'g2', name: 'Work', items: [{ id: 'b4', name: 'GitHub', url: 'https://github.com' }] },
];

export const STARTER_NOTES: Note[] = [{ id: 'n1', name: 'Scratch', text: '' }];

export const DEFAULT_ENGINES: SearchEngine[] = [
  { prefix: 'g', name: 'Google', url: 'https://www.google.com/search?q=%s' },
  { prefix: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' },
  { prefix: 'gh', name: 'GitHub', url: 'https://github.com/search?q=%s' },
  { prefix: 'm', name: 'Google Maps', url: 'https://www.google.com/maps/search/%s' },
  { prefix: 'w', name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search=%s' },
];

export const DEFAULT_PREFS: Prefs = {
  name: 'Syaddie',
  theme: 'system',
  accent: 'sage',
  hiddenCalendars: [],
  sources: { calendar: true, tasks: true, gmail: true },
  newsTopics: ['K-pop', 'Video games'],
  weatherArea: 'City',
  hidden: [],
  searchEngines: DEFAULT_ENGINES,
  cigaretteLimit: 0,
  speedTestHours: 3,
  speedPlanMbps: 0,
  setsPerWeek: 10,
  pinnedLifts: [],
  gymMonthly: 0,
};

/** Everything Settings › Panels can switch off. */
export const HIDEABLE = {
  panel: ['today', 'tasks', 'notes', 'packages', 'photos', 'bookmarks'],
  top: ['weather', 'air', 'cig', 'training', 'countdown'],
  view: ['news', 'inbox', 'you', 'training', 'money', 'server'],
} as const;

export const HIDEABLE_KEYS: string[] = Object.entries(HIDEABLE).flatMap(([k, v]) => v.map((x) => `${k}:${x}`));
