import type { ReactNode } from 'react';
import type { FocusTab } from '../layout';

export interface FocusTabInfo {
  key: FocusTab;
  name: string;
  icon: string;
  /** What's waiting behind the tab: events left today, open tasks, packages on the way. */
  count?: number;
  /** The count needs attention (something overdue, a failed delivery). */
  warn?: boolean;
}

/**
 * Focus's home: the clock and what's next down the left, and one panel at a time on the
 * right, picked from a row of tabs that each say how much is waiting. Bookmarks stay
 * underneath. On a phone it's one column: the clock, the tabs and their panel, the rest.
 */
export function FocusHome({ tabs, active, onTab, hero, photo, panel, bookmarks, empty }: {
  tabs: FocusTabInfo[];
  active: FocusTab | null;
  onTab: (t: FocusTab) => void;
  hero: ReactNode;
  photo: ReactNode;
  /** The active tab's panel. */
  panel: ReactNode;
  bookmarks: ReactNode;
  /** Shown when every tab's panel is switched off. */
  empty: ReactNode;
}) {
  // Left and Right move along the tabs, as a tab list should.
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir || !tabs.length) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.key === active);
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    onTab(next.key);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next.key}"]`)?.focus();
  };
  return (
    <main className="fx-home">
      <div className="fx-side">
        {hero}
        {photo}
      </div>
      <div className="fx-work">
        {tabs.length > 0 && (
          <div className="fx-tabs" role="tablist" aria-label="Home panels" onKeyDown={onKey}>
            {tabs.map((t) => (
              <button
                key={t.key}
                role="tab"
                data-tab={t.key}
                id={`fx-tab-${t.key}`}
                aria-selected={t.key === active}
                aria-controls="fx-panel"
                tabIndex={t.key === active ? 0 : -1}
                className={'fx-tab' + (t.key === active ? ' on' : '')}
                onClick={() => onTab(t.key)}
              >
                <i className={'ph-duotone ' + t.icon} aria-hidden="true" />
                <span>{t.name}</span>
                {!!t.count && <b className={'fx-count tnum' + (t.warn ? ' warn' : '')}>{t.count}</b>}
              </button>
            ))}
          </div>
        )}
        <div className="fx-panel" id="fx-panel" role={active ? 'tabpanel' : undefined} aria-labelledby={active ? `fx-tab-${active}` : undefined}>
          {active ? panel : empty}
        </div>
        {bookmarks}
      </div>
    </main>
  );
}
