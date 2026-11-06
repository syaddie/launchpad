import { useEffect } from 'react';
import { VIEWS } from './Rail';

type Row = { keys: string[][]; what: string };

/** Each row's `keys` are alternatives; the keys inside one are pressed together or one after another, as written. */
export const SHORTCUT_GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: 'Anywhere',
    rows: [
      { keys: [['⌘', 'K'], ['Ctrl', 'K']], what: 'Command palette: views, actions, bookmarks, “weight 72.4”, “study 45 …”' },
      { keys: [['/']], what: 'Search bookmarks and the web' },
      { keys: [['?']], what: 'This list' },
      { keys: [['Esc']], what: 'Close what’s open, then back to Home' },
      { keys: [['C']], what: 'Log a cigarette (with undo)' },
      { keys: [['M']], what: 'You: today’s mood' },
      { keys: [['N']], what: 'News, and back' },
    ],
  },
  {
    title: 'Go to a view',
    rows: [
      ...VIEWS.map((v) => ({ keys: [['G', v.letter]], what: v.name })),
      { keys: [['F1'], ['F8']], what: 'Console layout: the views in rail order, F1 to F8' },
      { keys: [['F9']], what: 'Console layout: Settings' },
    ],
  },
  {
    title: 'Home',
    rows: [{ keys: [['1'], ['9']], what: 'Open the first nine Daily bookmarks' }],
  },
  {
    title: 'Search and the palette',
    rows: [
      { keys: [['↑'], ['↓']], what: 'Move through the results' },
      { keys: [['Enter']], what: 'Open the one picked' },
      { keys: [['Esc']], what: 'Close' },
    ],
  },
  {
    title: 'Money spreadsheet',
    rows: [
      { keys: [['Enter'], ['↓']], what: 'Next row, same column' },
      { keys: [['Shift', 'Enter'], ['↑']], what: 'Previous row, same column' },
      { keys: [['Esc']], what: 'Leave the cell' },
    ],
  },
  {
    title: 'Server',
    rows: [
      { keys: [['⌘', 'S'], ['Ctrl', 'S']], what: 'Save the file being edited' },
      { keys: [['Ctrl', 'Shift', 'C']], what: 'Terminal: copy the selection' },
      { keys: [['Ctrl', 'Shift', 'V']], what: 'Terminal: paste' },
    ],
  },
];

/** A row's keys: "G then H", "⌘ K or Ctrl K", "F1 – F8" for a range. */
function Keys({ keys }: { keys: string[][] }) {
  const range = keys.length === 2 && keys.every((k) => k.length === 1) && /^(F?\d)$/.test(keys[0][0]) && /^(F?\d)$/.test(keys[1][0]);
  const between = range ? '–' : 'or';
  const sep = (combo: string[]) => (combo[0] === 'G' && combo.length === 2 ? 'then' : '');
  return (
    <span className="shortcut-keys">
      {keys.map((combo, i) => (
        <span key={i} className="shortcut-combo">
          {i > 0 && <span className="shortcut-or">{between}</span>}
          {combo.map((k, j) => (
            <span key={j} className="shortcut-combo">
              {j > 0 && sep(combo) && <span className="shortcut-or">{sep(combo)}</span>}
              <kbd className="kbd">{k}</kbd>
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

/** Every keyboard shortcut in one place, opened with ? (and from ⌘K). */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    // Capture, so Esc closes this before the page's own Esc goes back to Home.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <>
      <div className="scrim palette-scrim" onClick={onClose} />
      <div className="popover palette shortcuts" role="dialog" aria-label="Keyboard shortcuts" aria-modal="true">
        <div className="shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button className="icon-btn md" aria-label="Close" onClick={onClose} autoFocus>
            <i className="ph-duotone ph-x" />
          </button>
        </div>
        <div className="shortcuts-body">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} className="shortcuts-group">
              <h3>{g.title}</h3>
              {g.rows.map((r) => (
                <div key={r.what} className="shortcut-row">
                  <span className="shortcut-what">{r.what}</span>
                  <Keys keys={r.keys} />
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="palette-foot">Single-letter keys work when you’re not typing in a box.</div>
      </div>
    </>
  );
}
