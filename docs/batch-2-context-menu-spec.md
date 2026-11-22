# Batch 2: context menu polish

Two fixes from the owner's problems list. Both live mostly in `web/src/components/ContextMenu.tsx`, `web/src/App.tsx` and `web/src/styles.css`. Branch from `main` (e.g. `claude/menu-everywhere`). Batch 1 (`claude/batch-1-fixes`) touches `sw.js`, `api.ts`, `useAppData.ts`, Notes tabs CSS and "Notes" → "Notepad" labels, so stay out of those files.

## 1. Our menu on every right-click (desktop)

**Problem:** right-clicking empty space often shows the browser's menu. The page-wide menu in `App.tsx` (`backgroundMenu`, around line 712) uses `only:` with a fixed list of classes (`.lp-root, .lp-shell, .lp-inner, .lp-grid, .hz-home, …, main`). Gaps in the top bar, panel padding, panel headers and the other views (Money, Music, Files…) aren't on that list, so they fall through.

**Want:** any right-click in the app opens our menu.
- Inside something with its own menu (task, bookmark, file row…): that menu, as now. Inner handlers already win via `e.defaultPrevented`.
- Anywhere else: the app-wide menu (Command palette, Keyboard shortcuts, Edit bookmarks when relevant, Settings). Where it's cheap, add items for the place you clicked, e.g. inside a panel: "Hide this panel" and the panel's own header actions. Don't go overboard.
- The browser's menu stays on fields (`input, textarea, select, contenteditable`), on selected text, and with Shift held. `keepNative()` already does this. Also keep it on plain `<a href>` links that have no menu of ours, so "Open in new tab" / "Copy link" still work.

**How (suggested):** drop the `only` filter on `backgroundMenu` so it handles anything that bubbles up to `.lp-root`. Then check that portals (drawers, palette, popovers rendered to `document.body`) are covered: they're outside `.lp-root`. Either add a document-level fallback listener in `ContextMenuHost`, or decide drawers keep the browser menu, and write down which you picked.

**Also:** update the rule in `CLAUDE.md` ("Leave fields and plain text alone…"). Plain text now gets our menu unless it's selected. Shift+right-click is the escape hatch.

## 2. Long press on phones opens the menu, not a text selection

**Problem:** `[data-menu]` gets `user-select: none` on touch (`styles.css` ~line 449), but only on elements with their own menu. A long press anywhere else selects text, and the selection can also win over a menu on a nested element.

**Want:** on touch screens (`@media (pointer: coarse)`), text isn't selectable app-wide by default, and a long press on empty space opens the app-wide menu from part 1.
- Keep selection (and the native long-press) in fields, in the note editor/viewer text, and anywhere the owner would plausibly want to copy text that the menu doesn't offer to copy (check: tracking numbers, email bodies in Inbox, file viewer text, terminal output). Prefer adding a "Copy" menu item over leaving text selectable.
- `-webkit-touch-callout: none` app-wide on touch, except on fields and images the owner may want to save. Decide which and note it.
- The long-press listener must work for the background menu too. Today `onPointerDown` is part of `menuProps`, so once `only` is gone it should cover everything that bubbles to `.lp-root`. Check that scrolling lists still scroll (PRESS_SLOP) and that a long press doesn't also click.

## Done when
- Right-click anywhere in every view shows our menu, except fields / selected text / Shift / plain links.
- Long press anywhere on a phone shows our menu, never a selection, except where selection is kept on purpose.
- Keyboard still works: Shift+F10 / Menu key, arrows, Enter, Esc.
- Checked in the browser preview in all designs (`DESIGN_KEYS` in `shared/types.ts`) at desktop, wide and phone sizes, using right-click, keyboard and a touch long press (mobile preset). Nothing selected by accident, nothing cut off.
- `npm run typecheck` and tests pass (on Windows: `TZ=Asia/Singapore npx vitest run` from Git Bash; `backup.test.ts` EPERM is expected). Add to `test/context-menu.test.ts` where behaviour is testable.
- Merge to `main` per `CLAUDE.md`, unless a judgement call needs the owner first (e.g. which text stays selectable).
