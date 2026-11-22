// Launchpad's right-click menu. One menu is open at a time, drawn by <ContextMenuHost /> (mounted once
// in App). Anything gets a menu by spreading menuProps() on it:
//
//   <div {...menuProps(() => [{ label: 'Open', icon: 'ph-arrow-square-out', onSelect: open }, 'sep', …], `Actions for ${name}`)}>
//
// The browser's own menu is kept everywhere else, and on fields, on selected text and with Shift held,
// so copy and paste still work. On a touch screen a long press opens the same menu.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
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

/** Places the browser's menu is more use: fields, text that's selected, and Shift held. */
function keepNative(e: { target: EventTarget; currentTarget: Element; shiftKey: boolean }) {
  if (e.shiftKey || editable(e.target)) return true;
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.toString().trim() !== '' && sel.getRangeAt(0).intersectsNode(e.currentTarget);
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
 * so it always reflects the current state. `only` limits it to some targets (a background, not what's on it).
 */
export function menuProps(items: () => MenuItem[], label: string, opts: { only?: (target: Element, el: Element) => boolean } = {}) {
  const allowed = (target: EventTarget, el: Element) => !opts.only || (target instanceof Element && opts.only(target, el));
  return {
    // Marks it for CSS: no iOS link preview or text selection on a long press.
    ...(opts.only ? {} : { 'data-menu': '' }),
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      // An element inside with its own menu got there first.
      if (e.defaultPrevented || !allowed(e.target, e.currentTarget) || keepNative(e)) return;
      const touch = (e.nativeEvent as PointerEvent).pointerType === 'touch';
      // The ContextMenu key or Shift+F10: no pointer position (Chrome reports '' as the pointer type).
      const keyboard = (e.nativeEvent as PointerEvent).pointerType === '' || (e.clientX === 0 && e.clientY === 0);
      const r = e.currentTarget.getBoundingClientRect();
      const opened = openMenu({ items: items(), label, x: keyboard ? r.left : e.clientX, y: keyboard ? r.bottom : e.clientY, keyboard });
      if (!opened) return;
      e.preventDefault();
      // Android fires this for a long press too; the timer below mustn't open it a second time.
      if (touch && press) {
        clearTimeout(press.timer);
        press.fired = true;
      }
    },
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'touch' || !e.isPrimary || press?.ev === e.nativeEvent || !allowed(e.target, e.currentTarget) || editable(e.target)) return;
      cancelPress();
      const { clientX: x, clientY: y } = e;
      const p = {
        x,
        y,
        fired: false,
        ev: e.nativeEvent,
        timer: window.setTimeout(() => {
          if (press !== p || !openMenu({ items: items(), label, x, y })) return;
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
  // Shift+F10 and the Menu key, on whatever has focus. Browsers don't all turn these into a
  // right-click, so do it here; one with no menu of ours still gets the browser's.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      const el = document.activeElement;
      if (current || !(el instanceof HTMLElement) || el === document.body || editable(el)) return;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      if (ev.defaultPrevented) e.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
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
          <button key={i} type="button" role="menuitem" tabIndex={-1} className={it.danger ? 'danger' : undefined} disabled={it.disabled} onClick={() => choose(it)} onPointerMove={hover}>
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
