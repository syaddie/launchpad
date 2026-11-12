import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { BookmarkGroup, DesignKey, ViewKey } from '../../../shared/types';
import { VIEWS } from '../components/Rail';

export interface ShortcutState {
  view: ViewKey;
  setView: Dispatch<SetStateAction<ViewKey>>;
  design: DesignKey;
  palette: boolean;
  setPalette: Dispatch<SetStateAction<boolean>>;
  shortcuts: boolean;
  setShortcuts: (v: boolean) => void;
  /** A drawer is open. */
  drawer: boolean;
  closeDrawer: () => void;
  openSettings: () => void;
  focus: boolean;
  closeFocus: () => void;
  search: string;
  searchRef: RefObject<HTMLInputElement | null>;
  editBookmarks: boolean;
  bookmarks: BookmarkGroup[];
  logSmoke: () => void;
  logCraving: () => void;
}

/** Every key on the `?` page: ⌘K, Esc, G then a letter, /, ?, N, C, Shift C, M, 1–9 and Console's F1–F10. */
export function useShortcuts(state: ShortcutState) {
  const s = useRef(state);
  s.current = state;
  const gAt = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { view, setView, palette, setPalette, shortcuts, drawer, focus } = s.current;
      // Keys typed into the server terminal belong to the shell: Esc for vim, Ctrl K to cut a line.
      if ((e.target as HTMLElement).closest?.('.xterm')) return;
      // ⌘K / Ctrl K works everywhere, even while typing.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (palette) setPalette(false);
        else if (drawer) s.current.closeDrawer();
        else if (focus) s.current.closeFocus();
        else if (view !== 'home') setView('home');
        return;
      }
      // Console: F1–F9 open the views in rail order, F10 Settings.
      if (s.current.design === 'console' && /^F([1-9]|10)$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const n = Number(e.key.slice(1));
        if (n === VIEWS.length + 1) s.current.openSettings();
        else if (VIEWS[n - 1]) {
          setPalette(false);
          s.current.closeDrawer();
          setView(VIEWS[n - 1].key);
        }
        return;
      }
      const t = e.target as HTMLElement;
      const typing = /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey || palette || shortcuts) return;
      const key = e.key.toLowerCase();
      // G then a letter jumps to a view.
      if (Date.now() - gAt.current < 1500) {
        gAt.current = 0;
        const v = VIEWS.find((x) => x.letter.toLowerCase() === key);
        if (v && !drawer && !focus) {
          setView(v.key);
          return;
        }
      }
      if (key === 'g' && !e.shiftKey) {
        gAt.current = Date.now();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        s.current.searchRef.current?.focus();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        s.current.setShortcuts(true);
        return;
      }
      if (drawer || focus) return;
      if (key === 'n') {
        setView((v) => (v === 'news' ? 'home' : 'news'));
        return;
      }
      if (key === 'c') {
        if (e.shiftKey) s.current.logCraving();
        else s.current.logSmoke();
        return;
      }
      if (key === 'm' && !e.shiftKey) {
        setView('you');
        return;
      }
      if (/^[1-9]$/.test(e.key) && !s.current.search && !s.current.editBookmarks && view === 'home') {
        const daily = s.current.bookmarks.find((g) => g.name === 'Daily');
        const b = daily?.items[Number(e.key) - 1];
        if (b) window.open(b.url, '_blank', 'noopener');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
