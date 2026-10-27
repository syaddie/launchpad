import type { BookmarkGroup, Note, Prefs } from './types';

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

export const DEFAULT_PREFS: Prefs = {
  name: 'Syaddie',
  theme: 'system',
  accent: 'sage',
  hiddenCalendars: [],
  sources: { calendar: true, tasks: true, gmail: true },
  newsTopics: ['K-pop', 'Video games'],
  weatherArea: 'City',
};
