// Settings › Layout: the home panels put in order by hand (prefs.homeLayouts). Grid designs get
// their columns, left to right, each stacking one or two panels; the phone gets one list shared by
// every grid design; Focus gets its tabs. Up and down buttons, a ⋯ menu (also a right-click or long
// press on the row) and dragging all do the same moves. What's saved is fitted to the design in
// layout.ts, so nothing here can leave Home short of a panel.
import { useState, type DragEvent } from 'react';
import type { DesignKey, HomeLayouts, Prefs } from '../../../shared/types';
import { AREA_NAMES, COLUMN_MAX, COLUMNS_MAX, arrangeColumns, columnsFor, designAreas, focusOrder, narrowOrder, type Area } from '../layout';
import { closeMenu, menuProps, openMenu, type MenuItem } from './ContextMenu';

type Key = DesignKey | 'narrow';

/** The Settings › Panels switch that hides each one; the clock tile has none of its own. */
const HIDE_KEY: Partial<Record<Area, string>> = {
  today: 'panel:today',
  notes: 'panel:notes',
  photo: 'panel:photos',
  photo2: 'panel:photos',
};

/** When a panel only shows some of the time. */
const NOTE: Partial<Record<Area, string>> = {
  photo: 'Shows once there’s a photo',
  photo2: 'Shows once there are two photos',
};

export function HomeArrangement({ prefs, onPrefs, design, designName }: { prefs: Prefs; onPrefs: (p: Prefs) => void; design: DesignKey; designName: string }) {
  const saved = prefs.homeLayouts ?? {};
  /** What a "Reset to default" replaced, until the next change. */
  const [undo, setUndo] = useState<{ key: Key; layouts: HomeLayouts } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** The panel being dragged and the list it's from; drops only land in the same list. */
  const [dragging, setDragging] = useState<{ a: Area; list: string } | null>(null);
  // Dragging is for a mouse: on a touch screen a long press opens the menu, and the arrows move.
  const canDrag = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;

  const save = (key: Key, cols: Area[][] | null) => {
    const next: HomeLayouts = { ...saved };
    if (cols) next[key] = cols;
    else delete next[key];
    setUndo(null);
    onPrefs({ ...prefs, homeLayouts: next });
  };
  const reset = (key: Key) => {
    save(key, null);
    setUndo({ key, layouts: saved });
  };

  const hidden = new Set(prefs.hidden);
  const isHidden = (a: Area) => !!HIDE_KEY[a] && hidden.has(HIDE_KEY[a]!);
  const hideItem = (a: Area): MenuItem => {
    const k = HIDE_KEY[a];
    if (!k) return null;
    const name = k === 'panel:photos' ? 'Photos' : AREA_NAMES[a];
    return isHidden(a)
      ? { label: `Show ${name}`, icon: 'ph-eye', onSelect: () => onPrefs({ ...prefs, hidden: prefs.hidden.filter((h) => h !== k) }) }
      : { label: `Hide ${name}`, icon: 'ph-eye-slash', onSelect: () => onPrefs({ ...prefs, hidden: [...prefs.hidden, k] }) };
  };

  /** One panel's row: the buttons, its ⋯ and right-click menu, and dragging. */
  /** `dropOn` gets the panel dropped onto this row. */
  const row = (a: Area, i: number, count: number, items: MenuItem[], moves: { up: () => void; down: () => void; dropOn: (dropped: Area) => void }, listKey: string) => {
    const name = AREA_NAMES[a];
    const id = `${listKey}:${a}`;
    const other = dragging && dragging.list === listKey && dragging.a !== a ? dragging.a : null;
    return (
      <li
        key={a}
        className={'arrange-row' + (isHidden(a) ? ' off' : '') + (dragging?.list === listKey && dragging.a === a ? ' dragging' : '') + (other ? ' can-drop' : '')}
        draggable={canDrag}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', a);
          setDragging({ a, list: listKey });
        }}
        onDragEnd={() => setDragging(null)}
        onDragOver={(e) => other && (e.preventDefault(), e.stopPropagation())}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (other) moves.dropOn(other);
          setDragging(null);
        }}
        {...menuProps(() => items, name)}
      >
        {canDrag && <i className="ph-duotone ph-dots-six-vertical arrange-grip" aria-hidden="true" />}
        <span className="arrange-name">
          <span>
            {name}
            {isHidden(a) && <span className="chip">Hidden</span>}
          </span>
          {NOTE[a] && <span className="meta">{NOTE[a]}</span>}
        </span>
        <span className="arrange-acts">
          <button type="button" className="icon-btn" title="Move up" aria-label={`Move ${name} up`} disabled={i === 0} onClick={moves.up}>
            <i className="ph-duotone ph-arrow-up" />
          </button>
          <button type="button" className="icon-btn" title="Move down" aria-label={`Move ${name} down`} disabled={i === count - 1} onClick={moves.down}>
            <i className="ph-duotone ph-arrow-down" />
          </button>
          <button
            type="button"
            className={'icon-btn' + (menuFor === id ? ' on' : '')}
            title="More"
            aria-label={`More for ${name}`}
            aria-haspopup="menu"
            onClick={(e) => {
              if (menuFor === id) return closeMenu();
              if (openMenu({ items, label: `More for ${name}`, anchor: e.currentTarget.getBoundingClientRect(), keyboard: e.detail === 0, onClose: () => setMenuFor(null) })) setMenuFor(id);
            }}
          >
            <i className="ph-duotone ph-dots-three" />
          </button>
        </span>
      </li>
    );
  };

  /** One ordered list (the phone, Focus's tabs): `list` is what this design shows, `all` the whole saved order it sits in. */
  const orderList = (key: Key, list: Area[], all: Area[], what: string) => {
    const put = (a: Area, before: Area | null) => {
      const rest = all.filter((x) => x !== a);
      const at = before ? rest.indexOf(before) : rest.length;
      save(key, [[...rest.slice(0, at), a, ...rest.slice(at)]]);
    };
    /** Trade places with another in the list. */
    const swap = (a: Area, b: Area) => {
      const next = all.map((x) => (x === a ? b : x === b ? a : x));
      save(key, [next]);
    };
    const after = (a: Area) => all[all.indexOf(a) + 1] ?? null;
    return (
      <ol className="arrange-list" aria-label={what}>
        {list.map((a, i) => {
          const items: MenuItem[] = [
            { label: 'Move up', icon: 'ph-arrow-up', disabled: i === 0, onSelect: () => swap(a, list[i - 1]) },
            { label: 'Move down', icon: 'ph-arrow-down', disabled: i === list.length - 1, onSelect: () => swap(a, list[i + 1]) },
            { label: 'Move to the top', icon: 'ph-arrow-line-up', disabled: i === 0, onSelect: () => put(a, list[0]) },
            { label: 'Move to the bottom', icon: 'ph-arrow-line-down', disabled: i === list.length - 1, onSelect: () => put(a, after(list[list.length - 1])) },
            'sep',
            hideItem(a),
          ];
          return row(a, i, list.length, items, { up: () => swap(a, list[i - 1]), down: () => swap(a, list[i + 1]), dropOn: (d) => swap(d, a) }, key);
        })}
      </ol>
    );
  };

  const resetButton = (key: Key, custom: boolean) => (
    <span className="arrange-foot">
      {undo?.key === key && !custom ? (
        <>
          <span className="meta">Back to the default.</span>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => (onPrefs({ ...prefs, homeLayouts: undo.layouts }), setUndo(null))}>
            Undo
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-ghost btn-small" disabled={!custom} onClick={() => reset(key)}>
          <i className="ph-duotone ph-arrow-counter-clockwise" aria-hidden="true" />
          Reset to default
        </button>
      )}
    </span>
  );

  if (design === 'mission') {
    return (
      <div className="drawer-section">
        <div className="drawer-label">Panels on Home</div>
        <p className="meta" style={{ margin: 0 }}>
          Mission makes your photos the ground under the sky, with Today on the left and the Notepad on the right, so there’s nothing to put in order. On a phone the photos come first, under the sky, then Today and the Notepad. Settings › Panels switches each one off; the other layouts can be arranged here.
        </p>
      </div>
    );
  }

  if (design === 'focus') {
    const tabs = focusOrder(saved);
    return (
      <div className="drawer-section">
        <div className="drawer-label">Tabs on Home</div>
        <p className="meta" style={{ margin: 0 }}>
          Focus’s tabs, left to right. The first one that’s switched on opens when Home does.
        </p>
        {orderList('focus', tabs, tabs, 'Focus tabs')}
        {resetButton('focus', !!saved.focus)}
      </div>
    );
  }

  const cols = columnsFor(design, saved);
  const custom = !!arrangeColumns(design, saved[design]);
  const flat = cols.flat();
  const colOf = (a: Area) => cols.findIndex((c) => c.includes(a));
  /** Columns keep their sizes; the panels trade places. */
  const swap = (a: Area, b: Area) => {
    const next = flat.map((x) => (x === a ? b : x === b ? a : x));
    let k = 0;
    save(design, cols.map((c) => next.slice(k, (k += c.length))));
  };
  /** Into column `to` (a new one at the end when it's `cols.length`), under what's there. */
  const moveTo = (a: Area, to: number) => {
    const next = cols.map((c) => c.filter((x) => x !== a));
    if (to >= next.length) next.push([a]);
    else next[to].push(a);
    save(design, next.filter((c) => c.length));
  };
  const room = (k: number) => cols[k].length < COLUMN_MAX;
  /** The panel being dragged, when it's one of these columns'. */
  const drag = dragging?.list === design ? dragging.a : null;
  const dropOnColumn = (e: DragEvent, k: number) => {
    e.preventDefault();
    if (drag && (k >= cols.length || (colOf(drag) !== k && room(k)))) moveTo(drag, k);
    setDragging(null);
  };

  const phoneAreas = new Set<Area>(designAreas(design));
  const phoneAll = narrowOrder(saved);

  return (
    <>
      <div className="drawer-section">
        <div className="drawer-label">Panels on Home · {designName}</div>
        <p className="meta" style={{ margin: 0 }}>
          Columns left to right, each with one or two panels stacked. Drag a panel, use the arrows, or ⋯ to move it to another column.
        </p>
        <div className="arrange-map" aria-hidden="true">
          {cols.map((c, k) => (
            <span key={k} className="arrange-map-col">
              {c.map((a) => (
                <span key={a} className={isHidden(a) ? 'off' : ''}>
                  {AREA_NAMES[a]}
                </span>
              ))}
            </span>
          ))}
        </div>
        <div className="arrange-cols">
          {cols.map((c, k) => (
            <section
              key={k}
              className={'arrange-col' + (drag && colOf(drag) !== k && room(k) ? ' can-drop' : '')}
              aria-label={`Column ${k + 1}`}
              onDragOver={(e) => drag && colOf(drag) !== k && room(k) && e.preventDefault()}
              onDrop={(e) => dropOnColumn(e, k)}
            >
              <div className="arrange-col-head">
                Column {k + 1}
                {k === 0 && <span className="meta">left</span>}
                {k === cols.length - 1 && k > 0 && <span className="meta">right</span>}
              </div>
              <ol className="arrange-list">
                {c.map((a) => {
                  const i = flat.indexOf(a);
                  const items: MenuItem[] = [
                    { label: 'Move up', icon: 'ph-arrow-up', disabled: i === 0, onSelect: () => swap(a, flat[i - 1]) },
                    { label: 'Move down', icon: 'ph-arrow-down', disabled: i === flat.length - 1, onSelect: () => swap(a, flat[i + 1]) },
                    'sep',
                    ...cols.map((_, t): MenuItem => t !== k && room(t) && { label: `Move to column ${t + 1}`, icon: 'ph-columns', onSelect: () => moveTo(a, t) }),
                    c.length > 1 && cols.length < COLUMNS_MAX && { label: 'Move to a new column', icon: 'ph-plus-square', onSelect: () => moveTo(a, cols.length) },
                    'sep',
                    hideItem(a),
                  ];
                  return row(a, i, flat.length, items, { up: () => swap(a, flat[i - 1]), down: () => swap(a, flat[i + 1]), dropOn: (d) => swap(d, a) }, design);
                })}
              </ol>
            </section>
          ))}
          {drag && cols.length < COLUMNS_MAX && cols[colOf(drag)]?.length > 1 && (
            <div className="arrange-col arrange-new can-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropOnColumn(e, cols.length)}>
              <i className="ph-duotone ph-plus" aria-hidden="true" /> Drop here for a new column
            </div>
          )}
        </div>
        {resetButton(design, custom)}
      </div>
      <div className="drawer-section">
        <div className="drawer-label">On a phone</div>
        <p className="meta" style={{ margin: 0 }}>
          One column, top to bottom. Vista and Poster use this order on a narrow screen.
        </p>
        {orderList('narrow', phoneAll.filter((a) => phoneAreas.has(a)), phoneAll, 'Phone order')}
        {resetButton('narrow', !!saved.narrow)}
      </div>
    </>
  );
}
