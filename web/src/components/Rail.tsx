import type { ViewKey } from '../../../shared/types';

export const VIEWS: { key: ViewKey; name: string; icon: string; letter: string }[] = [
  { key: 'home', name: 'Home', icon: 'ph-house', letter: 'H' },
  { key: 'news', name: 'News', icon: 'ph-newspaper', letter: 'N' },
  { key: 'inbox', name: 'Inbox', icon: 'ph-envelope-simple', letter: 'I' },
  { key: 'you', name: 'You', icon: 'ph-heart', letter: 'Y' },
  { key: 'training', name: 'Training', icon: 'ph-barbell', letter: 'T' },
  { key: 'learn', name: 'Learn', icon: 'ph-graduation-cap', letter: 'L' },
  { key: 'money', name: 'Money', icon: 'ph-wallet', letter: 'M' },
  { key: 'server', name: 'Server', icon: 'ph-hard-drives', letter: 'S' },
];

/** Read the view from `location.hash` (e.g. `#money` → `'money'`); unknown or empty hashes open `'home'`. */
export function viewFromHash(hash: string): ViewKey {
  const key = hash.replace(/^#\/?/, '').trim().toLowerCase();
  const found = VIEWS.find((v) => v.key === key);
  return found ? found.key : 'home';
}

/** The URL hash for a view (`''` for `'home'`, `'#money'` for `'money'`, etc.). */
export function hashForView(view: ViewKey): string {
  return view === 'home' ? '' : `#${view}`;
}

/** The view switcher down the left edge (across the top on a phone). Hidden views stay reachable from ⌘K.
 * The designs restyle it: Console's F-key bar, Bento's dock, Horizon's row of tabs. */
export function Rail({ view, hidden, badges, onView, onPalette, onSettings }: {
  view: ViewKey;
  hidden: string[];
  /** A count on a view's button, e.g. inbox items that need you. */
  badges: Partial<Record<ViewKey, number>>;
  onView: (v: ViewKey) => void;
  onPalette: () => void;
  onSettings: () => void;
}) {
  const views = VIEWS.filter((v) => v.key === 'home' || v.key === view || !hidden.includes(`view:${v.key}`));
  return (
    <nav className="rail" aria-label="Views">
      {views.map((v) => (
        <button
          key={v.key}
          data-view={v.key}
          className={'rail-btn' + (v.key === view ? ' on' : '')}
          aria-current={v.key === view ? 'page' : undefined}
          title={`${v.name} (G then ${v.letter})`}
          onClick={() => onView(v.key)}
        >
          <i className={'ph-duotone ' + v.icon} aria-hidden="true" />
          <kbd className="rail-fkey" aria-hidden="true">F{VIEWS.indexOf(v) + 1}</kbd>
          <span className="rail-dot" aria-hidden="true" />
          {!!badges[v.key] && <b className="rail-badge" aria-label={`${badges[v.key]} need you`}>{badges[v.key]}</b>}
          <span>{v.name}</span>
        </button>
      ))}
      <span className="rail-sep" aria-hidden="true" />
      <button className="rail-btn rail-palette" title="Command palette (Ctrl K)" onClick={onPalette}>
        <i className="ph-duotone ph-command" aria-hidden="true" />
        <span className="mono">⌘K</span>
      </button>
      <button className="rail-btn rail-settings" title="Settings" onClick={onSettings}>
        <i className="ph-duotone ph-gear-six" aria-hidden="true" />
        <kbd className="rail-fkey" aria-hidden="true">F9</kbd>
        <span>Settings</span>
      </button>
    </nav>
  );
}
