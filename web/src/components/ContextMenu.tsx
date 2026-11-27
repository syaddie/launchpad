// Launchpad's right-click menu. One menu is open at a time, drawn by <ContextMenuHost /> (mounted once
// in App). Anything gets a menu by spreading menuProps() on it:
//
//   <div {...menuProps(() => [{ label: 'Open', icon: 'ph-arrow-square-out', onSelect: open }, 'sep', …], `Actions for ${name}`)}>
//
// App puts one more on its root ({ root: true }): whatever has no menu of its own gets the app-wide one,
// so a right-click anywhere opens ours. Drawers, the palette and popovers drawn into document.body are
// outside the root on the page, but React passes their events up to it all the same, so they're covered too.
// The browser's own menu is kept on fields, on selected text, with Shift held, and on plain links,
// so copy, paste and "Open in new tab" still work. On a touch screen a long press opens the same menu;
// text there isn't selectable, except fields and what's marked to copy from (styles.css, `selectable`).
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export interface MenuAction {
  label: string;
  /** A Phosphor icon class, e.g. 'ph-copy'. */
  icon?: string;
  onSelect?: () => void;
  /** A link instead of an action; `newTab` opens it in another tab, `download` saves it. */
  href?: string;
  newTab?: boolean;
  download?: boolean;
  disabled?: boolean;
  /** Drawn in the warning colour: it removes or stops something. */
  danger?: boolean;
  /** Asked first (OK / Cancel); for what can't be undone. */
  confirm?: string;
}

/** An action, a separator, or nothing (so a list can say `cond && {...}`). */
export type MenuItem = MenuAction | 'sep' | false | null | undefined | 0 | '';

type Entry = MenuAction | 'sep';

interface OpenMenu {
  id: number;
  items: Entry[];
  label: string;
  /** Where it opens: the pointer, or under a button (`anchor`). */
  x: number;
  y: number;
  anchor?: DOMRect;
  /** Opened from the keyboard: the first item takes focus. */
  keyboard: boolean;
  /** Focus goes back here when it closes. */
  returnTo: HTMLElement | null;
  onClose?: () => void;
}

const LONG_PRESS_MS = 500;
/** A finger that moves further than this is scrolling, not pressing. */
const PRESS_SLOP = 10;

// ---------- the one open menu ----------

let current: OpenMenu | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};

/** Separators only between actions: none first, last, or two together. */
export function tidy(items: MenuItem[]): Entry[] {
  const out: Entry[] = [];
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep' && (!out.length || out[out.length - 1] === 'sep')) continue;
    out.push(it);
  }
  while (out[out.length - 1] === 'sep') out.pop();
  return out;
}

/** Open a menu; one already open closes first. Returns false when there was nothing to show. */
export function openMenu(o: { items: MenuItem[]; label: string; x?: number; y?: number; anchor?: DOMRect; keyboard?: boolean; onClose?: () => void }): boolean {
  const items = tidy(o.items);
  if (!items.length) return false;
  closeMenu();
  const active = document.activeElement;
  current = { id: nextId++, items, label: o.label, x: o.x ?? 0, y: o.y ?? 0, anchor: o.anchor, keyboard: !!o.keyboard, returnTo: active instanceof HTMLElement ? active : null, onClose: o.onClose };
  emit();
  return true;
}

export function closeMenu() {
  const c = current;
  if (!c) return;
  // Hand focus back when it was in the menu (keyboard use); a mouse user's focus stays where it is.
  if (document.activeElement?.closest('.ctx-menu') && c.returnTo?.isConnected) c.returnTo.focus({ preventScroll: true });
  current = null;
  emit();
  c.onClose?.();
}

// ---------- opening from an element ----------

const editable = (t: EventTarget | null) => t instanceof Element && !!t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');

/**
 * Text worth copying on a phone, where text otherwise isn't selectable: a long press there selects
 * as usual rather than opening a menu. Matches the list in styles.css.
 */
export const SELECTABLE = '[data-selectable], pre, code';
const selectableArea = (t: EventTarget | null) => t instanceof Element && !!t.closest(SELECTABLE);

/** A link with no menu of ours keeps the browser's (open in a new tab, copy the address). */
const plainLink = (t: EventTarget | null) => t instanceof Element && !!t.closest('a[href]');

/** Whether the point is on any of the boxes (a selection's lines), give or take a pixel. */
export function onRects(x: number, y: number, rects: ArrayLike<{ left: number; right: number; top: number; bottom: number }>) {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return true;
  }
  return false;
}

const selectedRange = () => {
  const sel = window.getSelection();
  return sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.toString().trim() !== '' ? sel.getRangeAt(0) : null;
};

// The selection as it was when the latest press began. A Mac selects the word under a right-click
// before the menu event arrives; that word isn't text the owner selected, so it's judged by this.
let pressedOn: { at: number; range: Range | null } | null = null;
const PRESS_FRESH_MS = 2000;
const notePress = () => void (pressedOn = { at: performance.now(), range: selectedRange()?.cloneRange() ?? null });
const freshPress = () => (pressedOn && performance.now() - pressedOn.at < PRESS_FRESH_MS ? pressedOn : null);

/** Right-clicked on text that was already selected (or, from the keyboard, with text selected in it). */
function onSelection(target: Element, x: number, y: number, keyboard: boolean) {
  if (keyboard) return !!selectedRange()?.intersectsNode(target);
  const p = freshPress();
  const range = p ? p.range : selectedRange();
  return !!range && onRects(x, y, range.getClientRects());
}

/** Undo a selection the right-click itself made (a Mac's word), once our menu has opened instead. */
function undoPressSelection() {
  const p = freshPress();
  const sel = window.getSelection();
  const now = selectedRange();
  if (!p || !sel || !now) return;
  const was = p.range;
  if (was && now.compareBoundaryPoints(Range.START_TO_START, was) === 0 && now.compareBoundaryPoints(Range.END_TO_END, was) === 0) return;
  sel.removeAllRanges();
  if (was) sel.addRange(was);
}

/**
 * Where a menu opened from the keyboard goes: under the focused thing, or at its top when it's big
 * (the page itself, a long list) or its bottom is off screen.
 */
export function keyboardSpot(r: { left: number; top: number; bottom: number }, vh: number) {
  const big = r.bottom > vh || r.bottom - r.top > vh / 2;
  return { x: Math.max(r.left, 0), y: big ? Math.max(r.top, 0) : r.bottom };
}

let press: { timer: number; x: number; y: number; fired: boolean; ev: Event } | null = null;

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

/** The tap that ends a long press would also click what's under the finger; this eats that one click. */
function swallowNextClick() {
  const stop = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
    done();
  };
  const done = () => {
    window.removeEventListener('click', stop, true);
    clearTimeout(timer);
  };
  window.addEventListener('click', stop, true);
  const timer = window.setTimeout(done, 400);
}

/**
 * Handlers that give an element a right-click (and long-press) menu. `items` is called when it opens,
 * with what was clicked, so it always reflects the current state. `root` is for App's own: it takes
 * whatever nothing inside claimed, except plain links and our open menu.
 */
export function menuProps(items: (target: Element) => MenuItem[], label: string | ((target: Element) => string), opts: { root?: boolean } = {}) {
  const name = (t: Element) => (typeof label === 'string' ? label : label(t));
  // Events from our own menu reach the root too, through React (it's drawn from inside the app).
  // A plain link keeps the browser's menu for a mouse; a long press on one gets ours (App adds its items).
  const allowed = (t: EventTarget, touch: boolean): t is Element => t instanceof Element && !t.closest('.ctx-menu') && !(opts.root && !touch && plainLink(t));
  return {
    // Marks it for CSS: no iOS link preview or text selection on a long press.
    ...(opts.root ? { 'data-menu-root': '' } : { 'data-menu': '' }),
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      const touch = (e.nativeEvent as PointerEvent).pointerType === 'touch';
      // Android fires this for a long press too, sometimes after the timer below has opened the menu.
      if (touch && press?.fired && !e.defaultPrevented) return e.preventDefault();
      // An element inside with its own menu got there first.
      const t = e.target;
      if (e.defaultPrevented || !allowed(t, touch) || e.shiftKey || editable(t) || (touch && selectableArea(t))) return;
      // The ContextMenu key or Shift+F10: no pointer position (Chrome reports '' as the pointer type).
      const keyboard = (e.nativeEvent as PointerEvent).pointerType === '' || (e.clientX === 0 && e.clientY === 0);
      if (onSelection(t, e.clientX, e.clientY, keyboard)) return;
      const at = keyboard ? keyboardSpot(t.getBoundingClientRect(), document.documentElement.clientHeight) : { x: e.clientX, y: e.clientY };
      if (!openMenu({ items: items(t), label: name(t), ...at, keyboard })) return;
      e.preventDefault();
      if (!keyboard) undoPressSelection();
      if (touch && press) {
        clearTimeout(press.timer);
        press.fired = true;
      }
    },
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      const t = e.target;
      if (e.pointerType !== 'touch' || !e.isPrimary || press?.ev === e.nativeEvent || !allowed(t, true) || editable(t) || selectableArea(t)) return;
      cancelPress();
      const { clientX: x, clientY: y } = e;
      const p = {
        x,
        y,
        fired: false,
        ev: e.nativeEvent,
        timer: window.setTimeout(() => {
          if (press !== p || !openMenu({ items: items(t), label: name(t), x, y })) return;
          p.fired = true;
          // A little buzz on Android; Chrome refuses (and logs) it before the page's first tap.
          if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(10);
        }, LONG_PRESS_MS),
      };
      press = p;
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (press && !press.fired && press.ev !== e.nativeEvent && Math.hypot(e.clientX - press.x, e.clientY - press.y) > PRESS_SLOP) cancelPress();
    },
    onPointerUp: () => {
      if (press?.fired) swallowNextClick();
      cancelPress();
    },
    onPointerCancel: () => {
      // A scroll that starts takes the pointer away; a press that already opened the menu stays open.
      if (press && !press.fired) cancelPress();
    },
  };
}

// ---------- the place that was clicked ----------

/** A control's name as a menu label: "Previous (←)" reads "Previous". */
export const actionLabel = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/\s*\([^)]*\)$/, '');
const labelOf = (el: Element) => actionLabel(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');
const iconOf = (el: Element) => [...(el.querySelector('i')?.classList ?? [])].find((c) => c.startsWith('ph-') && c !== 'ph-duotone');
const visible = (el: Element) => el.getClientRects().length > 0;

const PANEL = '.panel, .photo-panel';

/** Pressing one of the page's own controls from the menu, so the two can't fall out of step. */
function asAction(el: HTMLElement, label = labelOf(el)): MenuAction {
  const a = el instanceof HTMLAnchorElement ? el : null;
  return { label, icon: iconOf(el), ...(a ? { href: a.href, newTab: a.target === '_blank', download: a.hasAttribute('download') } : { onSelect: () => el.click() }) };
}

/**
 * The panel or dialog a right-click landed in, for the app-wide menu: its name, its Settings › Panels
 * key when it can be hidden (`data-hide`), and what its header offers (Packages' "Add package", a
 * drawer's Close), as items that press those very buttons.
 */
export function placeOf(target: Element): { name: string; hide?: string; items: MenuAction[] } | null {
  const dialog = target.closest<HTMLElement>('[role="dialog"]');
  const panel = target.closest<HTMLElement>(PANEL);
  // The nearest of the two: a panel inside a drawer is the place, not the drawer.
  const box = panel && (!dialog || dialog.contains(panel)) ? panel : dialog;
  if (!box) return null;
  const title = box.querySelector(box === dialog ? '.drawer-title, h2' : '.panel-title');
  const name = actionLabel(box.getAttribute('aria-label') || (title ? title.textContent ?? '' : ''));
  const items: MenuAction[] = [];
  if (box === dialog) {
    const close = [...box.querySelectorAll<HTMLElement>('button')].find((b) => /^close\b/i.test(b.getAttribute('aria-label') || b.getAttribute('title') || ''));
    const scrim = box.previousElementSibling;
    if (close && visible(close)) items.push({ ...asAction(close, 'Close'), icon: 'ph-x' });
    else if (scrim instanceof HTMLElement && scrim.matches('.scrim')) items.push({ label: 'Close', icon: 'ph-x', onSelect: () => scrim.click() });
  } else {
    const head = [...box.querySelectorAll('.panel-head, .note-head, .photo-bar')].find((h) => h.closest(PANEL) === box);
    const controls = head ? [...head.querySelectorAll<HTMLElement>('button, a[href]')] : [];
    for (const c of controls) {
      if (items.length >= 4) break;
      const label = labelOf(c);
      if (!label || label.length > 40 || !visible(c) || c.matches('.tab, [role="tab"], :disabled, [aria-disabled="true"]') || c.closest(PANEL) !== box) continue;
      items.push(asAction(c, label));
    }
  }
  return { name, hide: box.closest('[data-hide]')?.getAttribute('data-hide') ?? undefined, items };
}

// ---------- closing ----------

/** Closes a popover on a click outside it, Escape, the page scrolling under it, a resize, or the window losing focus. */
export function useDismiss(open: boolean, refs: RefObject<HTMLElement | null>[], close: () => void, opts: { anyResize?: boolean } = {}) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => !refs.some((r) => r.current?.contains(e.target as Node));
    const down = (e: Event) => outside(e) && closeRef.current();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
    };
    const scroll = (e: Event) => outside(e) && closeRef.current();
    // Unless asked, only a change of width counts: a phone's address bar sliding away changes just the height.
    const width = window.innerWidth;
    const resize = () => (opts.anyResize || window.innerWidth !== width) && closeRef.current();
    const blur = () => closeRef.current();
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    if (opts.anyResize) window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', blur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

// ---------- drawing it ----------

/** Mounted once, in App: draws whichever menu is open. */
export function ContextMenuHost() {
  const open = useSyncExternalStore(subscribe, () => current);
  // Shift+F10 and the Menu key, on whatever has focus (the app itself when nothing has). Browsers
  // don't all turn these into a right-click, so do it here; one with no menu of ours still gets the browser's.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      const focused = document.activeElement;
      const el = focused instanceof HTMLElement && focused !== document.body ? focused : document.querySelector('[data-menu-root]');
      if (current || !(el instanceof HTMLElement) || editable(el)) return;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      if (ev.defaultPrevented) e.preventDefault();
    };
    window.addEventListener('keydown', key);
    // Before the press can change the selection (see notePress).
    window.addEventListener('pointerdown', notePress, true);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', notePress, true);
    };
  }, []);
  return open ? <Menu key={open.id} open={open} /> : null;
}

const MARGIN = 8;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
const focusable = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])')];

function Menu({ open }: { open: OpenMenu }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useDismiss(true, [ref], closeMenu, { anyResize: true });

  // Measure, then place it: at the pointer, flipped left or up when it would run off the edge,
  // and shifted to stay on screen when neither way fits.
  useLayoutEffect(() => {
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let left: number;
    let top: number;
    if (open.anchor) {
      const a = open.anchor;
      left = a.right - w;
      top = a.bottom + 4 + h > vh - MARGIN ? a.top - h - 4 : a.bottom + 4;
    } else {
      left = open.x + w > vw - MARGIN ? open.x - w : open.x;
      top = open.y + h > vh - MARGIN ? open.y - h : open.y;
    }
    setPos({ left: clamp(left, MARGIN, vw - w - MARGIN), top: clamp(top, MARGIN, vh - h - MARGIN) });
    if (open.keyboard) focusable(el)[0]?.focus({ preventScroll: true });
    else el.focus({ preventScroll: true });
  }, [open]);

  const choose = (it: MenuAction) => {
    if (it.disabled) return;
    closeMenu();
    if (it.confirm && !window.confirm(it.confirm)) return;
    it.onSelect?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = focusable(ref.current!);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const to = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length].focus({ preventScroll: true });
    };
    if (e.key === 'ArrowDown') to(i + 1);
    else if (e.key === 'ArrowUp') to(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') to(0);
    else if (e.key === 'End') to(-1);
    else if (e.key === 'Tab') {
      e.preventDefault();
      closeMenu();
    }
  };

  // Hovering an item focuses it, so the arrow keys carry on from there.
  const hover = (e: ReactPointerEvent<HTMLElement>) => e.pointerType === 'mouse' && e.currentTarget.focus({ preventScroll: true });

  // Each item's place among the items, so a design can light them one after another as the menu opens (Mission).
  let order = 0;
  // On the page itself: a design whose panels blur what's behind them (Vista) would otherwise pin it to the panel.
  return createPortal(
    <div
      ref={ref}
      className="popover menu ctx-menu"
      role="menu"
      aria-label={open.label}
      tabIndex={-1}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {open.items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : it.href && !it.disabled ? (
          <a
            key={i}
            role="menuitem"
            tabIndex={-1}
            className={it.danger ? 'danger' : undefined}
            style={{ '--i': order++ } as CSSProperties}
            href={it.href}
            target={it.newTab ? '_blank' : undefined}
            rel={it.newTab ? 'noopener' : undefined}
            download={it.download || undefined}
            onClick={() => choose(it)}
            onPointerMove={hover}
          >
            <i className={'ph-duotone ' + (it.icon ?? '')} aria-hidden="true" />
            {it.label}
          </a>
        ) : (
          <button key={i} type="button" role="menuitem" tabIndex={-1} className={it.danger ? 'danger' : undefined} style={{ '--i': order++ } as CSSProperties} disabled={it.disabled} onClick={() => choose(it)} onPointerMove={hover}>
            <i className={'ph-duotone ' + (it.icon ?? '')} aria-hidden="true" />
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Copy text, and say so (or that it couldn't). */
export function copyText(text: string, notify?: (msg: string) => void, what = 'Copied') {
  if (!navigator.clipboard) return notify?.('Copying needs the page on https or localhost');
  navigator.clipboard.writeText(text).then(
    () => notify?.(what),
    () => notify?.('Couldn’t copy'),
  );
}
