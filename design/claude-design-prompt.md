# Claude Design prompt — Launchpad

Copy everything below the line into Claude Design.

---

Design **Launchpad**, a personal dashboard I'll use as my browser's new-tab page. It's self-hosted, for me only, and opens dozens of times a day, so it has to be calm and fast to scan: I should see what's next in under two seconds, and anything I need to change should be editable right on the page.

## Feel

- **Calm and minimal.** Lots of space, soft warm neutrals, one muted accent color (sage, slate blue or terracotta: show me which works best). Quiet type: a clean sans for UI, tabular numerals for times. Thin dividers or very light card surfaces instead of heavy borders and shadows.
- **Light and dark themes**, following the system setting. Dark should be a soft charcoal, not pure black.
- Nothing should shout. Color only for meaning: the next event, an overdue task, a package out for delivery.
- Subtle motion only (fades, gentle expand/collapse). No spinners where a skeleton or "last updated" timestamp works.

## Canvas

- Primary: desktop browser at **1440×900**. Everything important fits above the fold with no page scroll; individual panels can scroll inside themselves.
- Also show **2560×1440** (more breathing room, not just bigger) and a narrow **~420px** fallback where panels stack in one column.

## Layout

A top bar and a grid of five panels. Suggested arrangement, but improve it if you have a better idea:

```
┌──────────────────────────────────────────────────────────────┐
│  Good afternoon, Syaddie        Tue 27 Oct · 14:32   [search]│
├───────────────────┬──────────────────────┬───────────────────┤
│  TODAY            │  TASKS               │  PACKAGES         │
│  (calendar)       │                      │                   │
│                   ├──────────────────────┤                   │
│                   │  NOTES               │                   │
├───────────────────┴──────────────────────┴───────────────────┤
│  BOOKMARKS (grouped rows of tiles)                           │
└──────────────────────────────────────────────────────────────┘
```

### 1. Top bar
- Time-of-day greeting, large clock (24h, Singapore time) and date.
- A small search box: Enter searches the web, but typing also filters my bookmarks live so I can jump to one with the keyboard. Keep it understated.
- A tiny sync indicator: a dot that's quiet when everything is fresh and shows "Calendar last synced 2h ago" on hover when something is stale or broken.

### 2. Today: Google Calendar (read-only, auto-synced)
- Agenda for **today**, then a lighter "Tomorrow" section, then the rest of the week collapsed.
- The **next/current event** is emphasised: a "in 25 min" or "now · ends 15:00" label, and a one-click **Join** button when there's a Meet/Zoom link.
- All-day events sit in a slim strip at the top.
- Each event shows a small dot in its calendar's color (I have a few calendars: Personal, Work, Family).
- Past events today are dimmed, not hidden.
- Clicking an event expands it in place (location, video link, description) and has an "Open in Google Calendar" link.

### 3. Tasks: Google Tasks (two-way sync)
- Shows pending tasks grouped **Overdue → Today → Upcoming → No date**.
- Checkbox to complete (strike-through + fade, with a brief undo).
- Inline "Add a task…" row at the top; typing a date like "fri" or "tomorrow" sets the due date.
- A small switcher for my task lists (e.g. Personal / Errands / Work).
- Overdue dates in the accent/warning color; everything else neutral.

### 4. Notes: editable notepads
- **Multiple notepads as tabs** (e.g. "Scratch", "Groceries", "Ideas"), with a "+" to add one, and rename/delete on right-click or a small menu.
- Click into the text and type: plain text with light Markdown (checklists, bullets, bold). No save button: show a subtle "Saved" that fades out.
- Can be expanded to a larger focus view (overlay or full panel) for longer writing.

### 5. Packages: tracking
- One row per package: my **label** ("New keyboard"), carrier, tracking number in small monospace, latest status in plain words ("Out for delivery", "In transit · Singapore", "Delivered yesterday"), and a status chip.
- Status stages: *Info received → In transit → Out for delivery → Delivered* (+ *Exception/Failed attempt*). Show this as a slim progress line or step dots.
- Packages come from two places; mark which with a small tag:
  - **Added manually**: an "Add package" button opens a compact form: tracking number, optional label, carrier auto-detected (SingPost, Ninja Van, J&T, DHL, etc.) with an override dropdown.
  - **Detected from Gmail**: automatically found in shipping emails. Show these with a small "from Gmail" tag and, when it's new, a quiet "Keep / Dismiss" prompt.
- Clicking a package opens a detail drawer with the full tracking timeline (timestamp + location + event), a link to the carrier's tracking page, edit label, and archive.
- Delivered packages auto-move to a collapsed "Delivered" section and archive after a few days.

### 6. Bookmarks: editable
- Grouped rows of compact tiles (favicon + short name), e.g. groups "Daily", "Work", "Finance", "Tools".
- An **Edit** toggle on the panel puts it into edit mode: drag to reorder tiles and groups, click a tile to rename or change its URL, "+" tile to add, a remove button on each tile, add/rename/delete groups.
- Outside edit mode it's purely a launcher: clean, no clutter.
- Keyboard: pressing a number key 1–9 when the search box is empty opens the first nine "Daily" bookmarks (show the number subtly on hover).

## Screens and states to design

1. **Main dashboard, light** with the sample data below.
2. **Main dashboard, dark**, same data.
3. **Bookmarks in edit mode** (one tile being edited in a small popover).
4. **Package detail drawer** for the SingPost package.
5. **Add package** form.
6. **Notes focus view.**
7. **Empty / first-run state**: no Google account connected yet, no packages, one empty note, a few starter bookmarks. Each panel shows a friendly one-line prompt and a single action ("Connect Google").
8. **Error/stale state**: calendar sync failing (panel still shows the last data, with a quiet "Couldn't sync · retry" line), and one package with a tracking exception.
9. **Settings** (gear icon, opens a simple page or sheet): connected Google account with Calendar/Tasks/Gmail toggles and last-sync times, which calendars to show, theme (System/Light/Dark), accent color, and export/import of my bookmarks + notes as JSON.

## Sample data (today is Tuesday 27 October 2026, 14:32 SGT)

**Calendar**
- All day: "Deepavali (public holiday)", Thu 29 Oct · Family
- 09:00–09:30 Standup · Work · (past)
- 12:30–13:30 Lunch with Wei Ling · Personal · Tiong Bahru Market (past)
- 15:00–15:45 Design review · Work · Google Meet link
- 17:30–18:30 Gym · Personal
- 20:00–21:00 Call with Mum · Family
- Tomorrow: 10:00 Dentist (Personal, Novena), 14:00 1:1 with Arjun (Work, Zoom)
- Rest of week: Fri 19:00 Dinner at Burnt Ends, Sat 09:00 Badminton

**Tasks**
- Overdue: "Renew passport photos" (due Mon 26 Oct)
- Today: "Pay credit card bill", "Reply to landlord about aircon servicing"
- Upcoming: "Book flights for December" (Fri), "Return library books" (Sat)
- No date: "Research standing desks"

**Notes**
- Scratch: "Wi-Fi for guests: BlueFern-5G / pw on fridge\n- call Shopee re: refund\n- ask Arjun for Q4 deck"
- Groceries: checklist: eggs, oat milk, kangkong, rice (10kg), dish soap ✓
- Ideas: a few lines of loose thoughts

**Packages**
- "New mechanical keyboard": SingPost · `SPNSV000000518244` · Out for delivery · added manually
- "Shopee order: phone case": Ninja Van · `NVSGSHOPE0001234567` · In transit, sorting facility · from Gmail
- "Amazon: USB-C hub": DHL · `1234567890` · Delivered yesterday 16:10 · from Gmail
- Exception example: "Lazada: desk lamp": J&T · `JT0001234567SG` · Failed delivery attempt, will retry tomorrow

**Bookmarks**
- Daily: Gmail, Calendar, YouTube, Reddit, ChatGPT/Claude, WhatsApp Web
- Work: GitHub, Linear, Figma, Notion
- Finance: DBS, Syfe, Endowus
- Tools: Cloudflare, Portainer, Home Assistant, Router

## Deliverables

- The screens above, with a short note on spacing scale, type scale and color tokens (light + dark) so the design can be rebuilt in code.
- Keep components simple and reusable: one panel/card style, one list-row style, one chip style, one drawer style.
