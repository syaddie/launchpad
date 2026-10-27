// Grid areas for the home view, built from the panels that are switched on.
// Desktop and wide layouts are columns of one or two stacked panels over the
// bookmarks row; a column with one panel spans both rows.

export type Layout = 'narrow' | 'desktop' | 'wide';
export type Area = 'today' | 'tasks' | 'notes' | 'pkgs' | 'photo' | 'photo2' | 'bm';

const COLUMNS: Record<Exclude<Layout, 'narrow'>, { w: string; items: Area[] }[]> = {
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

const NARROW_ORDER: Area[] = ['today', 'tasks', 'photo', 'pkgs', 'notes', 'photo2', 'bm'];

export function gridLayout(layout: Layout, shown: Set<Area>): { areas: string; columns: string; rows: string } {
  const q = (row: string[]) => `'${row.join(' ')}'`;
  if (layout === 'narrow') {
    const order = NARROW_ORDER.filter((a) => shown.has(a));
    return { areas: order.map((a) => q([a])).join(' '), columns: 'minmax(0, 1fr)', rows: 'auto' };
  }
  const cols = COLUMNS[layout].map((c) => ({ ...c, items: c.items.filter((a) => shown.has(a)) })).filter((c) => c.items.length);
  const rows: string[][] = [];
  if (cols.length) {
    rows.push(cols.map((c) => c.items[0]));
    rows.push(cols.map((c) => c.items[1] ?? c.items[0]));
  }
  const bm = shown.has('bm');
  if (bm) rows.push(cols.length ? cols.map(() => 'bm') : ['bm']);
  const top = layout === 'wide' && cols.every((c) => c.items.length === 1) ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1.2fr) minmax(0, 0.8fr)';
  return {
    areas: rows.map(q).join(' '),
    columns: cols.length ? cols.map((c) => `minmax(0, ${c.w})`).join(' ') : 'minmax(0, 1fr)',
    rows: [cols.length ? top : '', bm ? 'auto' : ''].filter(Boolean).join(' '),
  };
}
