// Grid areas for the home view, built from the panels that are switched on.
// Desktop and wide layouts are columns of one or two stacked panels over the
// bookmarks row; a column with one panel spans both rows.
// Each design (Settings › Layout) arranges the columns its own way. Horizon's
// home isn't a grid at all (see components/Horizon.tsx).

import type { DesignKey } from '../../shared/types';

export type Layout = 'narrow' | 'desktop' | 'wide';
/** `hero` is Bento's clock-and-next tile; `wx` the weather and air panel Console and Bento print in full. */
export type Area = 'today' | 'tasks' | 'notes' | 'pkgs' | 'photo' | 'photo2' | 'bm' | 'hero' | 'wx';

type Columns = { w: string; items: Area[] }[];

const BROADSHEET: Record<Exclude<Layout, 'narrow'>, Columns> = {
  desktop: [
    { w: '1fr', items: ['today', 'photo2'] },
    { w: '1.08fr', items: ['tasks', 'notes'] },
    { w: '1fr', items: ['photo', 'pkgs'] },
  ],
  wide: [
    { w: '1fr', items: ['today', 'photo2'] },
    { w: '1fr', items: ['tasks'] },
    { w: '1fr', items: ['notes'] },
    { w: '1fr', items: ['photo', 'pkgs'] },
  ],
};

/** Console: a long agenda on the left, tasks over notes, packages over the weather, and a slim column of photos. */
const CONSOLE: Columns = [
  { w: '0.95fr', items: ['today'] },
  { w: '1fr', items: ['tasks', 'notes'] },
  { w: '1.15fr', items: ['pkgs', 'wx'] },
  { w: '0.42fr', items: ['photo', 'photo2'] },
];

/** Bento: the clock-and-next tile first, then tiles that lead with a number. */
const BENTO: Columns = [
  { w: '1fr', items: ['hero', 'wx'] },
  { w: '1fr', items: ['today', 'photo2'] },
  { w: '1fr', items: ['tasks', 'notes'] },
  { w: '1fr', items: ['pkgs', 'photo'] },
];

const NARROW_ORDER: Area[] = ['hero', 'today', 'tasks', 'photo', 'pkgs', 'wx', 'notes', 'photo2', 'bm'];

export function gridLayout(layout: Layout, shown: Set<Area>, design: DesignKey = 'broadsheet'): { areas: string; columns: string; rows: string } {
  const q = (row: string[]) => `'${row.join(' ')}'`;
  if (layout === 'narrow') {
    const order = NARROW_ORDER.filter((a) => shown.has(a));
    return { areas: order.map((a) => q([a])).join(' '), columns: 'minmax(0, 1fr)', rows: 'auto' };
  }
  const base = design === 'console' ? CONSOLE : design === 'bento' ? BENTO : BROADSHEET[layout];
  const cols = base.map((c) => ({ ...c, items: c.items.filter((a) => shown.has(a)) })).filter((c) => c.items.length);
  const rows: string[][] = [];
  if (cols.length) {
    rows.push(cols.map((c) => c.items[0]));
    rows.push(cols.map((c) => c.items[1] ?? c.items[0]));
  }
  const bm = shown.has('bm');
  if (bm) rows.push(cols.length ? cols.map(() => 'bm') : ['bm']);
  const even = design === 'bento' || (layout === 'wide' && cols.every((c) => c.items.length === 1));
  const top = even ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1.2fr) minmax(0, 0.8fr)';
  return {
    areas: rows.map(q).join(' '),
    columns: cols.length ? cols.map((c) => `minmax(0, ${c.w})`).join(' ') : 'minmax(0, 1fr)',
    rows: [cols.length ? top : '', bm ? 'auto' : ''].filter(Boolean).join(' '),
  };
}
