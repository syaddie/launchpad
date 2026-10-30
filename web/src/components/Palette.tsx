import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  sub?: string;
  /** Shortcut hints, e.g. ['G', 'Y']. */
  keys?: string[];
  /** Phosphor icon class, or a single letter (bookmarks). */
  icon: string;
  /** Extra words to match on. */
  words?: string;
  /** Only listed once something is typed (bookmarks would swamp the empty palette). */
  onlyWhenTyping?: boolean;
  /** From what's typed, and listed above the matches, e.g. “Log 72.4 kg” for “weight 72.4”. */
  first?: boolean;
  run: () => void;
}

export function matchItem(it: PaletteItem, q: string): boolean {
  const hay = `${it.label} ${it.sub ?? ''} ${it.group} ${it.words ?? ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** ⌘K: one box for actions, views, panels and bookmarks, with web searches at the end. */
export function Palette({ items, searches, onClose }: {
  items: PaletteItem[];
  /** Items worked out from what's typed: web searches after the matches, and any marked `first` before them. */
  searches: (q: string) => PaletteItem[];
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const t = q.trim();
    const hits = items.filter((it) => (t ? matchItem(it, t) : !it.onlyWhenTyping));
    const extra = t ? searches(t) : [];
    return [...extra.filter((it) => it.first), ...hits.slice(0, 40), ...extra.filter((it) => !it.first)];
  }, [items, searches, q]);
  const cur = Math.min(sel, Math.max(0, shown.length - 1));

  useLayoutEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cur, shown]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  const run = (it: PaletteItem | undefined) => {
    if (!it) return;
    onClose();
    it.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(cur + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(cur - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(shown[cur]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  let lastGroup = '';
  return (
    <>
      <div className="scrim palette-scrim" onClick={onClose} />
      <div className="popover palette" role="dialog" aria-label="Command palette">
        <label className="palette-input">
          <i className="ph-duotone ph-magnifying-glass" aria-hidden="true" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
            placeholder="Type a command, a view or a bookmark"
            aria-label="Command"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
          />
          <span className="kbd">esc</span>
        </label>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {shown.map((it, i) => {
            const head = it.group !== lastGroup ? (lastGroup = it.group) : '';
            return (
              <div key={it.id}>
                {head && <div className="palette-group">{head}</div>}
                <div
                  role="option"
                  aria-selected={i === cur}
                  className={'palette-row' + (i === cur ? ' sel' : '')}
                  onMouseMove={() => i !== cur && setSel(i)}
                  onClick={() => run(it)}
                >
                  <span className="palette-icon">{it.icon.startsWith('ph-') ? <i className={'ph-duotone ' + it.icon} /> : it.icon}</span>
                  <span className="palette-text">
                    <span className="palette-label">{it.label}</span>
                    {it.sub && <span className="palette-sub">{it.sub}</span>}
                  </span>
                  {it.keys?.map((k) => (
                    <span key={k} className="kbd">
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
          {!shown.length && <div className="palette-empty">Nothing matches “{q.trim()}”.</div>}
        </div>
        <div className="palette-foot">
          <span>↑ ↓ to move</span>
          <span>↵ to run</span>
          <span style={{ marginLeft: 'auto' }}>⌘K or Ctrl K anywhere</span>
        </div>
      </div>
    </>
  );
}
