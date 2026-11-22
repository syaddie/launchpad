# Batch 4: layout pass (arrange panels, less clutter, less empty space)

Three items from the owner's lists, done together because they all change how the home screen is laid out:

- **I1:** rearrange panels based on what the owner looks at most.
- **I3:** now that right-click / long-press menus exist, remove on-screen controls the menu already covers.
- **P5:** too much empty space; use it to show things bigger and clearer.

**Do batch 2 first** (`docs/batch-2-context-menu-spec.md`). Removing buttons (I3) is only safe once the menu opens everywhere with a right-click and a long press. Branch from `main` (e.g. `claude/layout-pass`).

## Ask the owner first

Don't guess these; ask before building:

1. **Which designs do you actually use**, on desktop and on your phone? (`DESIGN_KEYS` in `shared/types.ts`: Broadsheet, Console, Bento, Horizon, Vista, Focus, Poster.) Spend the effort there; the rest only need to keep working.
2. **"Rearrange by what I see most": by hand, or automatic?** Recommended: by hand. Settings › Layout lets you order the panels (and maybe make one wider or taller) per design. At most, it offers a one-time "suggested order" based on what you click. A layout that reshuffles itself is disorienting, and what you *look at* can't really be measured.
3. **Which panels matter most**, and which could be smaller or hidden by default?
4. Screenshots or a description of where the empty space bothers you.

### The owner's answers (2026-11-22)

1. **Designs used, most first:** Vista, Focus, Broadsheet, Bento. The others only need to keep working.
2. **By hand.** No automatic reordering.
3. **All panels matter** (Today, Tasks, Weather, Hero, Notepad, Bookmarks, Photos, Packages). Nothing gets hidden by default.
4. **Wide desktop screens** are where the empty space bothers them most.

## Where things are

- `web/src/layout.ts`: grid columns per design (`BROADSHEET`, `CONSOLE`, `BENTO`, `VISTA`, `POSTER`), `NARROW_ORDER` for phones, `gridLayout()`. Horizon and Focus have their own homes (`components/Horizon.tsx`, `components/FocusHome.tsx`).
- `web/src/App.tsx`: which panels are shown (`shown`, `prefs.hidden`), the home grid.
- `web/src/designs.css`, `web/src/styles.css`: per-design styling and spacing.
- Prefs live in `AppState.prefs` (`shared/types.ts`, defaults in `shared/defaults.ts`).

## I1: panel order (assuming "by hand")

- Store a per-design order (and optional size) in prefs, e.g. `prefs.layout[design] = { columns: Area[][] }`. **Add new keys only.** Don't rename or rewrite existing store keys. Missing or invalid values fall back to today's built-in layout, so nothing existing is lost.
- `gridLayout()` takes the saved arrangement when there is one and still filters out hidden panels.
- UI in Settings › Layout: a list per column you can reorder (drag, plus up/down buttons for keyboard and touch), and "Reset to default". Every row gets a context menu (Move up / Move down / Move to column… / Hide) per `CLAUDE.md`.
- Phone order (`NARROW_ORDER`) is editable the same way.
- Unit-test `gridLayout()` with saved arrangements: empty, every panel hidden, unknown area names, a column emptied out.

## I3: declutter

- Go panel by panel and list each on-screen button/icon whose action is also in that thing's context menu. Propose to the owner which go (with before/after screenshots) **before** removing them.
- Keep anything that's the main action of a thing (e.g. checking off a task), and keep at least one visible way into each feature, since long press isn't discoverable on a phone. Moving a cluster of icons into a single "⋯" button that opens the same menu is a good middle ground.
- Keyboard users must still reach every action (Shift+F10 on the item, or the ⋯ button).

### The list (agreed with the owner, 2026-11-22)

Check it again once batch 2 is merged, in case its menus changed.

**Remove or merge:**

| Where | Button now | Replaced by |
|---|---|---|
| Notepad header | Focus view icon | "Focus view" in the tab's menu (already there) and in ⋯ |
| Notepad header | Search every notepad icon | "Search every notepad" in ⋯ (**new item**). ⌘K already searches notepad text. |
| Notepad header | "+" New notepad (at the end of the tabs, scrolls out of view) | "New notepad" in ⋯ and in the tab menu (**new item**) |
| Notepad header | ⋯ opens its own custom dropdown | ⋯ opens the shared menu (`openMenu` with an anchor, like Files): New notepad, Search every notepad, Show a tag… (**new**), sep, Rename, Pin to the front / Unpin, Tags…, History…, Focus view, sep, Delete (`danger` + `confirm`) |
| Terminal › Snippets rows | Edit and Delete icons | One ⋯ opening the snippet's menu (already has Edit and Delete). Keep Insert and Run. |
| Server › Containers rows *(owner's call)* | Restart icon | "Restart" in the row menu (already there, with a confirm). Keep Logs. |

The Notepad header goes from 4 icons to 1, which also gives the tab row more room.

**Keep:**

- Main actions: task checkboxes, Join on a meeting that's on now, Insert/Run on snippets, Cancel/Try again on downloads.
- Packages' Keep / Dismiss bar on new Gmail finds: it's the decision to make, and nobody thinks to long-press for it on a phone.
- "Add package", Bookmarks' "Edit", the rail's ⌘K and Settings: each is the only visible way in on a phone.
- Photo arrows: hover-only overlays, they take no space.
- Top-bar chips (cigarette, studying, trained): no menu has them, and they're one-tap.
- Today's Tomorrow / This week toggles and the Tasks list tabs: navigation, not actions.
- Files rows: already decluttered (hover-only on desktop, just ⋯ on a phone).

**Gaps to fill in the same change:**

- Add "New notepad", "Search every notepad" and "Show a tag…" to the Notepad menus before their buttons go.
- Photos has no context menu at all: add one (Previous, Next, Manage photos).

Expect a modest space saving from this; P5 is where most of the room comes from.

## P5: empty space

- For each design the owner uses, at desktop, wide and phone sizes: screenshot it with typical data *and* with little data (empty panels), and mark where space is wasted.
- Fixes to consider: panels that shrink to their content when nearly empty, bigger text and photos where there's room, fewer fixed heights, tighter padding at wide sizes. Don't just stretch everything.
- Empty states still have to look intentional, not like a broken panel.

## Done when

- The owner's answers above are in, and the result matches them.
- Every design still works at desktop, wide and phone sizes: nothing cut off, overlapping, squashed or unreachable, with a lot of data and with none.
- Saved layouts survive a reload and a backup/restore, and "Reset to default" works.
- Every removed button's action is still reachable by right-click, long press, keyboard, or a ⋯ button.
- `npm run typecheck` and tests pass (on Windows: `TZ=Asia/Singapore npx vitest run` from Git Bash; the `backup.test.ts` EPERM is expected).
- This batch is full of judgement calls, so **show the owner screenshots and get a yes before merging to `main`.**
