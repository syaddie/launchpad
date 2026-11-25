import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { ViewKey } from '../../../shared/types';
import { VIEWS } from '../components/Rail';

export interface ShortcutState {
  view: ViewKey;
  /** Changes the view, with its motion (App). */
  setView: (v: ViewKey) => void;
  palette: boolean;
  setPalette: Dispatch<SetStateAction<boolean>>;
  shortcuts: boolean;
  setShortcuts: (v: boolean) => void;
  /** A drawer is open. */
  drawer: boolean;
  closeDrawer: () => void;
  focus: boolean;
  closeFocus: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  logSmoke: () => void;
}

/** Every key on the `?` page: ⌘K, Esc, G then a letter, /, ?, D, C and M. */
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
      if (key === 'd') {
        setView(view === 'digest' ? 'home' : 'digest');
        return;
      }
      if (key === 'c' && !e.shiftKey) {
        s.current.logSmoke();
        return;
      }
      if (key === 'm' && !e.shiftKey) {
        setView('you');
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
