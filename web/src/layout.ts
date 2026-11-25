// Grid areas for the home view, built from the panels that are switched on.
// Desktop and wide layouts are columns of one or two stacked panels; a column with
// one panel spans both rows.
// Each design (Settings › Layout) arranges the columns its own way, and the owner can put
// them in another order there (prefs.homeLayouts); what's saved is fitted to the design here,
// so a bad or old arrangement still gives a whole home. Mission's and Focus's homes aren't this
// grid at all (components/mission/MissionHome.tsx, FocusHome.tsx); Focus only orders its tabs.

import { DEFAULT_DESIGN, HOME_AREAS, type DesignKey, type HomeArea, type HomeLayouts } from '../../shared/types';

export type Layout = 'narrow' | 'desktop' | 'wide';
export type Area = HomeArea;

type Columns = { w: string; items: Area[] }[];

/** Vista: two tall glass panels under the clock. The photos are the wallpaper, so they get no panels. */
const VISTA: Columns = [
  { w: '1.25fr', items: ['today'] },
  { w: '1fr', items: ['notes'] },
];

/** Poster: the agenda as a wide lead column over a photo, then notes over the other photo. */
const POSTER: Columns = [
  { w: '1.35fr', items: ['today', 'photo2'] },
  { w: '1fr', items: ['notes', 'photo'] },
];

const COLUMNS: Partial<Record<DesignKey, Columns>> = { vista: VISTA, poster: POSTER };

export const NARROW_ORDER: Area[] = ['hero', 'today', 'photo', 'notes', 'photo2'];

/** The designs whose home is this grid of columns. */
export const GRID_DESIGNS: DesignKey[] = ['vista', 'poster'];

/** Most panels one column stacks: the grid has two rows. */
export const COLUMN_MAX = 2;

/** Most columns an arrangement can have. */
export const COLUMNS_MAX = 6;

/** The panels Focus keeps behind tabs, in tab order. */
export const FOCUS_TABS = ['today', 'notes'] as const;
export type FocusTab = (typeof FOCUS_TABS)[number];

/** Names for Settings › Layout. */
export const AREA_NAMES: Record<Area, string> = {
  today: 'Today',
  notes: 'Notepad',
  photo: 'Photo',
  photo2: 'Second photo',
  hero: 'Clock and what’s next',
};

/** A design's own columns. Mission's and Focus's homes aren't this grid (MissionHome, FocusHome); they get Poster's. */
const builtIn = (design: DesignKey): Columns => COLUMNS[design] ?? POSTER;

/** Each once, known ones only, in the order given. */
function known<T extends string>(list: unknown, allowed: readonly T[], seen = new Set<T>()): T[] {
  if (!Array.isArray(list)) return [];
  return list.filter((a): a is T => allowed.includes(a) && !seen.has(a) && !!seen.add(a));
}

/** The panels a design puts in its columns (the bookmarks row is apart), in its built-in order. */
export function designAreas(design: DesignKey): Area[] {
  const out = new Set<Area>();
  for (const c of builtIn(design)) c.items.forEach((a) => out.add(a));
  return [...out];
}

/** The design's own columns, as Settings › Layout starts from and "Reset to default" goes back to. */
export function defaultColumns(design: DesignKey): Area[][] {
  return builtIn(design).map((c) => [...c.items]);
}

/**
 * A saved arrangement fitted to the design: its own panels only, each once, at most two to a column
 * (a longer one carries on in a column of its own) and six columns. Any it leaves out go back in their
 * built-in column, or a new one when that's full. Null when nothing usable was saved.
 */
export function arrangeColumns(design: DesignKey, saved: unknown): Area[][] | null {
  if (!Array.isArray(saved)) return null;
  const allowed = designAreas(design);
  const seen = new Set<Area>();
  const cols: Area[][] = [];
  for (const c of saved) {
    const items = known(c, allowed, seen);
    for (let i = 0; i < items.length; i += COLUMN_MAX) cols.push(items.slice(i, i + COLUMN_MAX));
  }
  if (!cols.length) return null;
  const home = defaultColumns(design);
  for (const a of allowed) {
    if (seen.has(a)) continue;
    const at = cols[Math.min(home.findIndex((c) => c.includes(a)), cols.length - 1)];
    if (at && at.length < COLUMN_MAX) at.push(a);
    else cols.push([a]);
  }
  // Too many columns: the extra ones' panels join the first columns with room. There always is
  // some, as six columns of two hold twelve, more than any design has.
  while (cols.length > COLUMNS_MAX) {
    for (const a of cols.pop()!) cols.find((c) => c.length < COLUMN_MAX)?.push(a);
  }
  return cols;
}

/** The columns a design shows: what was saved for it, else its own. */
export function columnsFor(design: DesignKey, saved?: HomeLayouts): Area[][] {
  return arrangeColumns(design, saved?.[design]) ?? defaultColumns(design);
}

/** The phone's one column: what was saved, any panel it leaves out after it in the built-in order. */
export function narrowOrder(saved?: HomeLayouts): Area[] {
  const list = known(saved?.narrow?.[0], HOME_AREAS);
  return [...list, ...NARROW_ORDER.filter((a) => !list.includes(a))];
}

/** Focus's tabs in the order saved, the rest after them. */
export function focusOrder(saved?: HomeLayouts): FocusTab[] {
  const list = known(saved?.focus?.[0], FOCUS_TABS);
  return [...list, ...FOCUS_TABS.filter((t) => !list.includes(t))];
}

/** The tab Focus shows: the one asked for when its panel is switched on, else the first that is; null when none are. */
export function focusTab(want: string | null, shown: Set<Area>, order: readonly FocusTab[] = FOCUS_TABS): FocusTab | null {
  const on = order.filter((t) => shown.has(t));
  return on.find((t) => t === want) ?? on[0] ?? null;
}

/** A column is as wide as the built-in column its top panel came from, so a wide lead stays wide wherever it goes. */
function widthOf(design: DesignKey, top: Area) {
  return builtIn(design).find((c) => c.items.includes(top))?.w ?? '1fr';
}

/**
 * The grid's areas, columns and rows, and `order`: the panels as they read (down each column, left
 * to right), which the page puts them in so Tab and screen readers go that way too.
 */
export function gridLayout(layout: Layout, shown: Set<Area>, design: DesignKey = DEFAULT_DESIGN, saved?: HomeLayouts): { areas: string; columns: string; rows: string; order: Area[] } {
  const q = (row: string[]) => `'${row.join(' ')}'`;
  if (layout === 'narrow') {
    const order = narrowOrder(saved).filter((a) => shown.has(a));
    return { areas: order.map((a) => q([a])).join(' '), columns: 'minmax(0, 1fr)', rows: 'auto', order };
  }
  const mine = arrangeColumns(design, saved?.[design]);
  const base: Columns = mine ? mine.map((items) => ({ w: widthOf(design, items[0]), items })) : builtIn(design);
  const cols = base.map((c) => ({ ...c, items: c.items.filter((a) => shown.has(a)) })).filter((c) => c.items.length);
  const rows: string[][] = [];
  if (cols.length) {
    rows.push(cols.map((c) => c.items[0]));
    rows.push(cols.map((c) => c.items[1] ?? c.items[0]));
  }
  const even = layout === 'wide' && cols.every((c) => c.items.length === 1);
  const top = even ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1.2fr) minmax(0, 0.8fr)';
  return {
    areas: rows.map(q).join(' '),
    columns: cols.length ? cols.map((c) => `minmax(0, ${c.w})`).join(' ') : 'minmax(0, 1fr)',
    rows: cols.length ? top : '',
    order: cols.flatMap((c) => c.items),
  };
}
