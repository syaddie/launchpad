import type { ViewKey } from '../../../shared/types';

export const VIEWS: { key: ViewKey; name: string; icon: string; letter: string }[] = [
  { key: 'home', name: 'Home', icon: 'ph-house', letter: 'H' },
  { key: 'news', name: 'News', icon: 'ph-newspaper', letter: 'N' },
  { key: 'you', name: 'You', icon: 'ph-heart', letter: 'Y' },
  { key: 'server', name: 'Server', icon: 'ph-hard-drives', letter: 'S' },
];

/** The view switcher down the left edge (across the top on a phone). Hidden views stay reachable from ⌘K. */
export function Rail({ view, hidden, onView, onPalette, onSettings }: {
  view: ViewKey;
  hidden: string[];
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
          className={'rail-btn' + (v.key === view ? ' on' : '')}
          aria-current={v.key === view ? 'page' : undefined}
          title={`${v.name} (G then ${v.letter})`}
          onClick={() => onView(v.key)}
        >
          <i className={'ph-duotone ' + v.icon} aria-hidden="true" />
          <span>{v.name}</span>
        </button>
      ))}
      <span className="rail-sep" aria-hidden="true" />
      <button className="rail-btn" title="Command palette (Ctrl K)" onClick={onPalette}>
        <i className="ph-duotone ph-command" aria-hidden="true" />
        <span className="mono">⌘K</span>
      </button>
      <button className="rail-btn" title="Settings" onClick={onSettings}>
        <i className="ph-duotone ph-gear-six" aria-hidden="true" />
        <span>Settings</span>
      </button>
    </nav>
  );
}
