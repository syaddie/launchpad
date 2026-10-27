# Handoff: Launchpad (personal new-tab dashboard)

## Overview
Launchpad is a self-hosted, single-user dashboard used as the browser's new-tab page. It must be calm and scannable in under two seconds. It has a top bar (greeting, clock, search, sync dot, settings) and five panels: Today (Google Calendar, read-only), Tasks (Google Tasks, two-way), Notes (local notepads), Packages (tracking, manual + Gmail-detected) and Bookmarks (editable launcher).

## About the design files
The files here are **design references built in HTML**. They show the intended look and behaviour; they are not production code to copy. Rebuild them in the target codebase's environment. If none exists, a good fit is a small Vite + React (or SvelteKit) app with a tiny Node/Go backend that handles Google OAuth, carrier polling and persistence (SQLite or JSON on disk).

- `Launchpad.dc.html`: the whole dashboard as one interactive component. The `screen` prop (`main`, `editBookmarks`, `packageDrawer`, `addPackage`, `notesFocus`, `empty`, `error`, `settings`), `theme` (`system|light|dark`) and `accent` (`sage|slate|terracotta`) select the states. All logic (date parsing, carrier detection, Markdown rendering, drag reorder, undo) is in the `class Component` script block. Read it as a spec.
- `Launchpad Board.dc.html`: canvas showing every state at 1440×900, plus 2560×1440 and 420px, and a token summary.
- `support.js`: runtime needed to open the `.dc.html` files in a browser. Not part of the build.

Open the files from a local web server (e.g. `npx serve .`) so relative paths resolve.

## Fidelity
**High fidelity.** Colours, type, spacing and interactions are final. Match them closely.

## Global
- Fonts: **Source Serif 4** (greeting, clock, panel titles, focus-view writing) and **Geist** (all UI text). **Geist Mono** for tracking numbers and key hints. All times use `font-variant-numeric: tabular-nums`.
- Icons: Phosphor, duotone weight (`@phosphor-icons/web` duotone).
- Base UI text: 14px / 20px line height. Meta: 12px / 16px. Chips: 11px / 600.
- Theme follows `prefers-color-scheme` unless overridden in Settings. Transitions on theme change: background/colour 0.3s.
- Colour carries meaning only: the next/current event, the out-for-delivery package, overdue dates and exceptions. Everything else is neutral.
- Motion: fades 150–220ms ease-out; drawer slides in 16px + fade 220ms; popovers rise 6px + fade 150ms. No spinners; use "Synced 2 min ago" text and "Syncing…" labels.
- Time zone: Asia/Singapore, 24h clock.

## Layout and breakpoints (measure the root's width, not the viewport)
- **Desktop (760–1999px), designed at 1440×900.** No page scroll; panels scroll internally. Page padding 30px 40px. Gap 20px. Grid:
  - columns `minmax(0,1fr) minmax(0,1.08fr) minmax(0,1fr)`
  - rows `minmax(0,1.2fr) minmax(0,0.8fr) auto`
  - areas `"today tasks pkgs" "today notes pkgs" "bm bm bm"`
- **Wide (≥2000px), designed at 2560×1440.** Four columns `"today tasks notes pkgs" "bm bm bm bm"`, rows `minmax(0,1fr) auto`. Padding 64px 96px, gap 30px, max-width 2200px centred. Panel padding 30px 20px. Clock 60px, greeting 36px. "Later this week" is always expanded. Bookmark tiles 88px wide, group gap 60px.
- **Narrow (<760px), designed at 420px.** One column: today, tasks, packages, notes, bookmarks. The page scrolls. Padding 20px 15px 30px, gap 15px. Clock 36px, greeting 24px. Search spans the width. Drawers are full width.

## Shared components (keep these four reusable)
1. **Panel.** Background `--sf`, radius 4px, no border or shadow, padding 20px 10px (inner rows add 10px horizontal). Header row: serif 18px/600 title at left, 12px `--t3` meta or action at right, 10px below.
2. **List row.** Padding 8px 10px (events, tasks 6px 10px, packages 12px 10px), radius 4px, hover background `--hv`. Used for events, tasks, packages, search results and delivered items.
3. **Chip.** Pill (radius 10px), padding 1px 8px, 11px/600. Neutral: `--hv` bg, `--t2` text. Accent: `--act` bg, `--acd` text. Warning: `--wnt` bg, `--wn` text.
4. **Drawer.** Right sheet, 440px wide (100% on narrow), background `--rz`, shadow `--sh`, over a scrim `--scrim`. Header padding 20px 30px 10px, serif 20px/600 title, close button. Body padding 10px 30px 30px, sections 30px apart. Used for package detail, add package and settings. Close it by clicking the scrim, pressing Esc or the × button.
- **Popover** (bookmark editor, note menu, sync tooltip, search results): `--rz` background, `--sh` shadow, radius 4px.
- **Buttons.** Primary: `--ac` background, `--on` text, 13px/600, padding 8px 15px, radius 4px, hover `filter: brightness(0.94)`. Secondary: 1px `--ln` border, transparent. Ghost: transparent, hover `--hv`. Icon: 26–34px square.
- **Inputs.** Height 32–36px, 1px `--ln` border, radius 4px, `--bg` fill, focus border `--ac`, no outline. Keyboard focus on everything else: `outline: 2px solid var(--ac); outline-offset: 2px`.
- **Checkbox.** 16px (14px in notes), radius 4px, 1.5px `--t3` border; when checked it fills with `--ac` and shows a check icon in `--on`.

## Screens

### Top bar
- Left: greeting (serif 28px, "Good morning/afternoon/evening, Syaddie"; morning 05–12, afternoon 12–18, evening otherwise). Below it, a 13px `--t2` summary line: "Next: Design review in 28 min · Google Meet · 1 overdue task · 1 package out for delivery" (or "X now · ends HH:MM", or "Nothing else on today").
- Right: clock (serif 46px, tabular) + "Tue 27 Oct · SGT" (13px `--t2`). Then search (230×34, `--sf` fill, magnifier icon, "/" hint), sync dot (7px circle) and settings gear.
- **Search.** "/" focuses it. Typing filters bookmarks by name or URL and shows up to 6 results in a dropdown (300px). The last row is "Search the web for “q”". ↑/↓ move the highlight. Enter opens the highlighted bookmark or runs the Google search. Esc clears. Bookmarks that don't match dim to 30% in the panel.
- **Sync dot.** `--t3` when fresh, `--wn` when any source fails, `--ln` when not connected. On hover a tooltip lists Calendar / Tasks / Gmail packages / Carriers with their last-sync text, with failures in `--wn` (e.g. "Couldn’t sync · last synced 2 h ago").
- **Number keys 1–9** open the first nine Daily bookmarks when focus isn't in a field, search is empty, no overlay is open and bookmark edit mode is off.

### Today (calendar)
- Optional all-day strip at the top: `--hv` pill row, 12px, with the calendar dot, "Thu 29", the title and "All day" at right.
- Rows: grid `44px 8px 1fr auto`. The time column shows the start (13px `--t2`) with the end below it (12px `--t3`). Then an 8px calendar dot, the title (14px) with meta below (12px `--t3`: "Work · Google Meet"), and a right column.
- Past events: opacity 0.5. The next event (or the current one) gets an `--act` background, a 600-weight title, a 12px/600 `--acd` label ("in 28 min", "in 1 h 05 min", "now · ends 15:00"), and a **Join** primary button (12px, video icon) when there's a Meet/Zoom link.
- Clicking a row expands it in place, indented to the title: location (map-pin icon), video link (`--acd`), description and "Open in Google Calendar ↗".
- Sections: today (no header), "Tomorrow  Wed 28 Oct" (titles in `--t2`), and "Later this week  2 events ▾" collapsed by default (always open on wide). Header labels are 12px, with the title in 600 `--t2`.
- Calendar colours: Personal `#5f8fa3`, Work `#b08844`, Family `#a06a8c`. Settings filters which calendars show.
- **Error state.** The header meta clears. Under the header a 12px `--wn` line reads "☁ Couldn’t sync · showing data from 12:31 · Retry" (underlined link). The list stays visible at 0.85 opacity. Retry shows "Syncing…" and then clears.
- **Empty state.** "Connect your Google account to see today’s agenda here." plus a primary "Connect Google" button (Google icon).

### Tasks
- Header list switcher: All / Personal / Errands / Work. These are small text tabs; the active one has `--hv` background and 600 weight.
- Add row at the top: plus icon and input "Add a task… try “call bank fri”". A trailing date word is parsed: today/tod, tomorrow/tmr/tmrw, a weekday name (mon…sunday → next occurrence, never today), or "next week" (next Monday). While typing, a 12px `--acd` hint shows "Due Fri 30 Oct". Enter adds the task to the current list (Personal when All is selected).
- Groups, in order: **Overdue** (label in `--wn`), Today, Upcoming, No date. Labels are 12px/600, empty groups are hidden. The due date sits on the right in 12px: overdue shows the full date in `--wn` ("Mon 26 Oct"); upcoming shows the weekday ("Fri") in `--t3`; today shows nothing.
- Completing a task: the check fills, the title strikes through and fades to 0.45 (0.35s). An undo bar appears at the bottom of the panel ("Completed “…”  Undo", `--hv` background). After 5s the task is removed and the change syncs to Google. Completing another task finalises the previous one.
- Empty (not connected): "Your Google Tasks will show up here once you connect." plus a secondary Connect Google button.

### Notes
- Header: "Notes" title, then the notepad tabs (13px; the active tab has `--hv` and 600 weight), "+" to add (the new tab is named "Untitled" and opens straight into rename), "Saved" (12px `--t3`, which fades in after a 500ms debounce and out after 1.5s), a "⋯" menu (Rename, Delete; Delete is disabled when only one notepad is left) and a focus-view button. Right-clicking a tab opens the same menu; double-click renames.
- Body: a rendered view by default. Clicking it switches to a plain textarea (14px/22px); blur goes back to the rendered view. Light Markdown: `- [ ] item` / `- [x] item` render as clickable checkboxes (checked items are struck through at 0.5 opacity), `- ` / `* ` render as bullets, and `**bold**` renders at 600. Autosave on every change.
- **Focus view.** Full-panel overlay over the whole dashboard (`--bg`), centred column max 760px, padding 40px 30px. Top: tabs, Saved, word count and a close button. Then the note name in serif 32px, a textarea in serif 19px/1.65, and a footer hint of Markdown syntax plus "Esc to close".

### Packages
- Header action "+ Add package" (ghost, 12px).
- Row: label (14px/500) with the status chip on the right; status text (13px; `--acd` for out for delivery, `--wn` for exceptions, `--t2` otherwise); a 4-segment progress line (3px tall, 3px gaps); a meta row with the carrier, the tracking number (Geist Mono 11px, ellipsis) and a source tag at the right (1px `--ln` outlined, 11px, icon + "from Gmail" or "Added manually").
- Stages are 0 Info received, 1 In transit, 2 Out for delivery, 3 Delivered, plus an `exception` flag. Filled segments are `--ac` when out for delivery and `--t3` otherwise. On an exception, the segment at the current stage is `--wn`; unfilled segments are `--ln`.
- A newly detected Gmail package shows "New from Gmail. Keep tracking?" with Keep (accent tint chip button) and Dismiss (ghost) buttons.
- Delivered packages move to a collapsed "Delivered 1 ▾ … Archived after 3 days" section and auto-archive 3 days after delivery.
- **Detail drawer.** Editable label input (15px/500); a row with the carrier, the mono tracking number, a copy button (the icon becomes a check for 1.4s) and the chip; a 4-step bar with labels (the current step is 600 weight; on an exception it reads "Failed attempt" in `--wn`); "Tracking history" as a vertical timeline (8px dots, 1px connecting line; the newest entry is 500 weight with a coloured dot) showing event, then "27 Oct 08:12 · Singapore Post Centre"; actions "Track on SingPost ↗" (primary, links to the carrier tracking URL) and Archive (secondary), with the source line at right.
- **Add package drawer.** Tracking number (mono, autofocus), Label (optional) and a Carrier select whose first option is "Auto-detected: SingPost". A helper line under the select explains the detection; it turns `--wn` when the format isn't recognised and no carrier is chosen. Cancel / "Track package" (disabled at 45% until there's a number and a carrier). Enter submits.
- Detection rules: `^NV` → Ninja Van; `^JT` → J&T Express; `^SP` or `^[A-Z]{2}\d{9}SG$` → SingPost; `^1Z` → UPS; 10 digits → DHL; 12 digits → FedEx; `^QX` → Qxpress.
- Carrier tracking URLs are listed in the `TRACK` map in `Launchpad.dc.html`.
- Empty: "No packages on the way. Paste a tracking number to follow one." plus a secondary Add package button.

### Bookmarks
- Groups sit side by side, wrapping, 25px apart (60px on wide). Each group has a 12px/600 `--t3` name above its tiles.
- Tile: 64px wide (88px on wide), a 30px rounded (6px) `--rz` favicon square containing a 16px favicon (from `https://www.google.com/s2/favicons?domain=…&sz=64`, falling back to the first letter for local/IP hosts), and a 12px `--t2` name below with ellipsis. Hover gives `--hv`. Daily tiles 1–9 show their number (Geist Mono 10px `--t3`) in the top-right on hover.
- **Edit toggle** (header right). "Edit" is a ghost button; "Done" is a primary accent fill. In edit mode:
  - Tiles get a dashed `--ln` outline, a grab cursor and an 18px round × remove button at the top right.
  - Tiles drag to reorder within and across groups. Groups drag by a ⋮⋮ handle.
  - Group names become inline inputs, each with a trash button. A "+ Group" button appears in the header, and each group gets a "+ Add" tile at the end.
  - Clicking a tile opens a 260px popover above it with Name and URL (mono) fields, Remove (`--wn` text), Cancel and Save. Enter saves; Esc cancels.
- Outside edit mode tiles are plain links opening in a new tab.

### Settings drawer
- Google account: avatar initial on `--act`, name and email, and a Disconnect link. Toggles (34×20 switch, `--ac` when on) for Google Calendar, Google Tasks and Gmail (package detection), each with its last-sync line ("Last synced 14:30"; when failing, "Failing · last synced 12:31" in `--wn`).
- Calendars to show: checkboxes tinted with each calendar's colour.
- Theme: segmented System / Light / Dark.
- Accent: three 18px swatches with labels (Sage, Slate blue, Terracotta); the selected one gets a ring.
- Bookmarks and notes: Export JSON (downloads `launchpad-backup.json` as `{version, exported, bookmarks, notes}`) and Import JSON (file input, followed by a result message).

### Empty / first run
Not connected. Today and Tasks show their connect prompts, there are no packages, there's one empty "Scratch" note ("Click to start writing. Use “- [ ]” for a checklist."), and four starter bookmarks (Gmail, Calendar, YouTube, GitHub).

## State model
- `bookmarks: Group[]` where `Group = {id, name, items: {id, name, url}[]}`
- `notes: {id, name, text}[]` and `activeNoteId`
- `tasks: {id, title, due: dayOffset|null|ISO date, list, done}`, synced to Google Tasks
- `events`, read-only from Google Calendar (today, tomorrow, rest of week, all-day), with `calendarId`, `color`, `location`, `conferenceUrl`, `description`
- `packages: {id, label, carrier, number, stage 0–3, exception, statusText, source: 'manual'|'gmail', isNew, timeline: {at, location, event}[], deliveredAt}`
- `sync: {calendar|tasks|gmail|carriers: {enabled, lastSuccess, lastError}}`
- `prefs: {theme, accent, visibleCalendars}`
- UI-only state: search query and highlight, expanded event, week section open, list filter, undo pending, note editing/renaming/menu, focus view, open drawer, bookmark edit mode and tile draft, drag source.
- Persist bookmarks, notes and prefs server-side (self-hosted) and mirror them to localStorage for instant paint. Paint from cache first, then refresh; never block render on the network.

## Design tokens
Spacing (Broadsheet scale): 5, 10, 15, 20, 30, 40 px (plus 64/96 page margins on wide). Radius: 4px for panels, rows, inputs and buttons; 3px for small tab buttons; 6px for favicon squares; 10px for pills.

| Token | Light | Dark |
|---|---|---|
| `--bg` page | #f1efeb | #1d1c1a |
| `--sf` panel | #f8f7f4 | #252422 |
| `--rz` raised (drawers, popovers) | #fffefc | #2e2d2a |
| `--tx` text | #22201e | #ebe7e1 |
| `--t2` secondary | #5c5853 | #b3ada5 |
| `--t3` tertiary | #77716a | #8d877f |
| `--ln` line | rgba(34,32,30,.10) | rgba(235,231,225,.10) |
| `--hv` hover | rgba(34,32,30,.045) | rgba(235,231,225,.05) |
| `--scrim` | rgba(34,32,30,.16) | rgba(0,0,0,.42) |
| `--wn` warning | #ad432c | #e5957c |
| `--wnt` warning tint | #f6e3dc | rgba(229,149,124,.14) |
| `--sh` shadow | 0 12px 32px rgba(45,43,43,.14), 0 0 0 1px rgba(34,32,30,.04) | 0 14px 36px rgba(0,0,0,.45), 0 0 0 1px rgba(235,231,225,.06) |

Accents (`--ac` base / `--acd` deep text / `--act` tint / `--on` text on the accent):
- Sage (default): light #5a7a5c / #43604a / #e2eadf / #fff; dark #9cb99a / #b6cfb3 / rgba(156,185,154,.15) / #1d1c1a
- Slate blue: light #4e6a8d / #3c5575 / #e0e7ef / #fff; dark #a0b5d2 / #bdcce2 / rgba(160,181,210,.15) / #1d1c1a
- Terracotta: light #ad603f / #8c492d / #f3e4da / #fff; dark #dd9b7b / #eab69c / rgba(221,155,123,.15) / #1d1c1a

Type scale: 60/46/36 clock (wide/desktop/narrow); 36/28/24 greeting; 32 focus title; 20 drawer title; 19 focus body; 18 panel title; 15 drawer label input; 14 body; 13 secondary; 12 meta; 11 chips and mono.

## Assets
- No bitmap assets. Favicons come from Google's favicon service at runtime (self-hosted builds may prefer to cache them or fetch `/favicon.ico` server-side).
- Phosphor duotone icons used: magnifying-glass, gear-six, globe-simple, cloud-slash, caret-up/down, video-camera, map-pin, arrow-up-right, google-logo, plus, check, dots-three, arrows-out-simple, arrows-in-simple, pencil-simple, trash, envelope-simple, hand-pointing, copy, archive, x, dots-six-vertical, calendar-blank, check-square, download-simple, upload-simple.

## Integrations (implementation notes)
- Google OAuth scopes: `calendar.readonly`, `tasks`, `gmail.readonly` (to detect shipping emails: search for carrier senders and tracking-number patterns).
- Carrier status: poll carrier APIs or an aggregator (e.g. AfterShip / 17TRACK) every 15–30 min, and map responses to stages 0–3 plus exception.
- Sync cadence: calendar every 5 min, tasks on focus plus every 2 min, Gmail every 10 min. Store `lastSuccess` per source; mark a source stale after 30 min.

## Files
- `Launchpad.dc.html`: the interactive reference for all states (see the `renderVals()` and helper functions for exact behaviour).
- `Launchpad Board.dc.html`: overview canvas of every screen and size, plus the token summary.
- `support.js`: runtime needed only to open the references.
