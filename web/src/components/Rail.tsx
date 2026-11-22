import type { ViewKey } from '../../../shared/types';
import { useActiveTabInView } from '../hooks/useActiveTabInView';
import { useGlide, Readout } from './Motion';
import { hashFor } from '../util';
import { menuProps } from './ContextMenu';

export const VIEWS: { key: ViewKey; name: string; icon: string; letter: string }[] = [
  { key: 'home', name: 'Home', icon: 'ph-house', letter: 'H' },
  { key: 'digest', name: 'Digest', icon: 'ph-lightbulb', letter: 'D' },
  { key: 'inbox', name: 'Inbox', icon: 'ph-envelope-simple', letter: 'I' },
  { key: 'you', name: 'You', icon: 'ph-heart', letter: 'Y' },
  { key: 'training', name: 'Training', icon: 'ph-barbell', letter: 'T' },
  { key: 'learn', name: 'Learn', icon: 'ph-graduation-cap', letter: 'L' },
  { key: 'money', name: 'Money', icon: 'ph-wallet', letter: 'M' },
  { key: 'server', name: 'Server', icon: 'ph-hard-drives', letter: 'S' },
  { key: 'review', name: 'Review', icon: 'ph-calendar-check', letter: 'R' },
  // Last, so Console's F-keys for the others stay where they were.
  { key: 'music', name: 'Music', icon: 'ph-music-notes', letter: 'U' },
];

/** The view switcher down the left edge (across the top on a phone). Hidden views stay reachable from ⌘K.
 * The designs restyle it: Console's F-key bar, Bento's dock, Horizon's row of tabs. */
export function Rail({ view, hidden, badges, onView, onHide, onPalette, onSettings }: {
  view: ViewKey;
  hidden: string[];
  /** A count on a view's button, e.g. inbox items that need you. */
  badges: Partial<Record<ViewKey, number>>;
  onView: (v: ViewKey) => void;
  /** Hide a view from the rail (Settings › Panels brings it back). */
  onHide?: (v: ViewKey) => void;
  onPalette: () => void;
  onSettings: () => void;
}) {
  const views = VIEWS.filter((v) => v.key === 'home' || v.key === view || !hidden.includes(`view:${v.key}`));
  // On a phone the rail (Bento's dock, Console's F-key bar) scrolls sideways: keep the view you're on in sight.
  const ref = useActiveTabInView<HTMLElement>(view, '.rail-btn.on', true);
  // The view you're on is lit by one highlight that glides from button to button (motion.css).
  useGlide(ref, `${view}:${views.length}`, '.rail-btn.on');
  return (
    <nav ref={ref} className="rail" aria-label="Views">
      <span className="glide" aria-hidden="true" />
      {views.map((v) => (
        <button
          key={v.key}
          data-view={v.key}
          className={'rail-btn' + (v.key === view ? ' on' : '')}
          aria-current={v.key === view ? 'page' : undefined}
          title={`${v.name} (G then ${v.letter})`}
          onClick={() => onView(v.key)}
          {...menuProps(
            () => [
              { label: `Open ${v.name}`, icon: v.icon, onSelect: () => onView(v.key) },
              { label: 'Open in new tab', icon: 'ph-arrow-square-out', href: location.pathname + (hashFor(v.key) || ''), newTab: true },
              v.key !== 'home' && onHide && 'sep',
              v.key !== 'home' && onHide && { label: 'Hide from the rail', icon: 'ph-eye-slash', onSelect: () => onHide(v.key) },
            ],
            v.name,
          )}
        >
          <i className={'ph-duotone ' + v.icon} aria-hidden="true" />
          <kbd className="rail-fkey" aria-hidden="true">F{VIEWS.indexOf(v) + 1}</kbd>
          <span className="rail-dot" aria-hidden="true" />
          {!!badges[v.key] && (
            <b className="rail-badge" aria-label={`${badges[v.key]} need you`}>
              <Readout text={String(badges[v.key])} id={`badge-${v.key}`} />
            </b>
          )}
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
        <kbd className="rail-fkey" aria-hidden="true">F{VIEWS.length + 1}</kbd>
        <span>Settings</span>
      </button>
    </nav>
  );
}
