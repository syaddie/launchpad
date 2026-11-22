// The right-click menus on Music › Busking slots (web/src/components/music/SlotWatch.tsx): a location's
// row on a day, and a watched slot. Only what's offered is checked here; the clicks were tried in the app.
import { describe, expect, it, vi } from 'vitest';
import type { SlotRow } from '../shared/nac';
import type { NacWatch } from '../shared/types';
import { tidy, type MenuAction } from '../web/src/components/ContextMenu';
import { rowMenu, watchMenu, type WatchProps } from '../web/src/components/music/SlotWatch';

const row = (o: Partial<SlotRow> = {}): SlotRow => ({
  key: 'paya-lebar',
  short: 'PLQ',
  name: 'Paya Lebar Quarter',
  url: 'https://example.test/plq',
  kind: 'full',
  free: [],
  mine: [],
  taken: [
    { start: '14:00', end: '16:00', status: 'Published' },
    { start: '18:00', end: '20:00', status: 'Published' },
  ],
  open: '12:00',
  close: '22:00',
  ...o,
});

const watch = (o: Partial<NacWatch> = {}): NacWatch => ({ id: 'w1', place: 'paya-lebar', date: '2026-11-24', start: '14:00', end: '16:00', created: '2026-11-22T00:00:00.000Z', freed: null, found: [], ...o });

const props = (o: Partial<WatchProps> = {}): WatchProps => ({
  date: '2026-11-24',
  fromMin: null,
  watches: [],
  alerts: 'ok',
  busy: false,
  now: new Date('2026-11-22T10:00:00+08:00'),
  onAdd: vi.fn(async () => true),
  onRemove: vi.fn(async () => {}),
  ...o,
});

const labels = (items: ReturnType<typeof rowMenu>) => tidy(items).map((i) => (i === 'sep' ? '—' : i.label));
const find = (items: ReturnType<typeof rowMenu>, label: string) => tidy(items).find((i): i is MenuAction => i !== 'sep' && i.label === label)!;

describe('a location row’s menu', () => {
  it('offers the form, the whole day and each time booked by others', () => {
    expect(labels(rowMenu(row(), props(), { canWatch: true, openForm: () => {} }))).toEqual([
      'Open on NAC',
      '—',
      'Watch a slot here…',
      'Watch any time this day',
      'Watch 2 PM – 4 PM',
      'Watch 6 PM – 8 PM',
    ]);
  });

  it('watches the whole day as the location’s open hours', () => {
    const w = props();
    find(rowMenu(row(), w, { canWatch: true, openForm: () => {} }), 'Watch any time this day').onSelect!();
    expect(w.onAdd).toHaveBeenCalledWith({ place: 'paya-lebar', date: '2026-11-24', start: '12:00', end: '22:00' });
  });

  it('today starts the whole day at the block still going', () => {
    const w = props({ fromMin: 15 * 60 + 30 });
    find(rowMenu(row(), w, { canWatch: true, openForm: () => {} }), 'Watch any time this day').onSelect!();
    expect(w.onAdd).toHaveBeenCalledWith(expect.objectContaining({ start: '15:00', end: '22:00' }));
  });

  it('leaves out what’s watched already, and offers to stop', () => {
    const w = props({ watches: [watch()] });
    expect(labels(rowMenu(row(), w, { canWatch: true, openForm: () => {} }))).toEqual(['Open on NAC', '—', 'Watch a slot here…', 'Watch any time this day', 'Watch 6 PM – 8 PM', '—', 'Stop watching']);
  });

  it('leaves out times a wider watch covers', () => {
    const wide = props({ watches: [watch({ start: '13:00', end: '22:00' })] });
    expect(labels(rowMenu(row(), wide, { canWatch: true, openForm: () => {} }))).toEqual(['Open on NAC', '—', 'Watch a slot here…', 'Watch any time this day', '—', 'Stop watching']);
    const all = props({ watches: [watch({ start: '12:00', end: '22:00' })] });
    expect(labels(rowMenu(row(), all, { canWatch: true, openForm: () => {} }))).toEqual(['Open on NAC', '—', 'Watch a slot here…', '—', 'Stop watching']);
  });

  it('a freed watch doesn’t count as watching', () => {
    const w = props({ watches: [watch({ freed: '2026-11-22T09:00:00.000Z', found: [{ start: '14:00', end: '16:00' }] })] });
    const l = labels(rowMenu(row(), w, { canWatch: true, openForm: () => {} }));
    expect(l).toContain('Watch 2 PM – 4 PM');
    expect(l).not.toContain('Stop watching');
  });

  it('stops several one after another, so the last answer is the list as it ends up', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const w = props({ watches: [watch(), watch({ id: 'w2', start: '18:00', end: '20:00' })], onRemove: vi.fn((id: string) => (order.push(id), id === 'w1' ? first : Promise.resolve())) });
    find(rowMenu(row(), w, { canWatch: true, openForm: () => {} }), 'Stop watching all 2').onSelect!();
    await Promise.resolve();
    expect(order).toEqual(['w1']);
    release();
    await vi.waitFor(() => expect(order).toEqual(['w1', 'w2']));
  });

  it('a day that’s over only opens NAC', () => {
    expect(labels(rowMenu(row({ kind: 'done' }), props(), { canWatch: false, openForm: () => {} }))).toEqual(['Open on NAC']);
  });
});

describe('a watched slot’s menu', () => {
  it('while watching: its day, NAC and stopping', () => {
    const items = watchMenu(watch(), { url: 'https://example.test/plq', onAdd: async () => true, onRemove: async () => {}, onPick: () => {} });
    expect(labels(items)).toEqual(['Show the day', 'Open on NAC', '—', 'Stop watching']);
    expect(find(items, 'Stop watching').danger).toBe(true);
  });

  it('once freed: book it, watch it again (clearing the freed one), or clear it', async () => {
    const onAdd = vi.fn(async () => true);
    const onRemove = vi.fn(async () => {});
    const items = watchMenu(watch({ freed: '2026-11-22T09:00:00.000Z', found: [{ start: '14:00', end: '15:00' }] }), { url: 'https://example.test/plq', onAdd, onRemove });
    expect(labels(items)).toEqual(['Book it on NAC', 'Watch it again', '—', 'Clear']);
    find(items, 'Watch it again').onSelect!();
    await vi.waitFor(() => expect(onRemove).toHaveBeenCalledWith('w1'));
    expect(onAdd).toHaveBeenCalledWith({ place: 'paya-lebar', date: '2026-11-24', start: '14:00', end: '16:00' });
  });

  it('keeps the freed one when watching again fails', async () => {
    const onRemove = vi.fn(async () => {});
    find(watchMenu(watch({ freed: '2026-11-22T09:00:00.000Z' }), { onAdd: async () => false, onRemove }), 'Watch it again').onSelect!();
    await new Promise((r) => setTimeout(r, 0));
    expect(onRemove).not.toHaveBeenCalled();
  });
});
