# Launchpad

A self-hosted new-tab dashboard. It shows:

- **Today**: Google Calendar agenda (read-only, synced every 5 min), with a Join button for the next Meet/Zoom call
- **Tasks**: Google Tasks, two-way. Add with natural dates ("call bank fri"), tick off with a 5-second undo
- **Notes**: multiple notepads with light Markdown (checklists, bullets, bold), autosaved
- **Packages**: tracking numbers added by hand or picked up automatically from shipping emails in Gmail. SingPost status is fetched directly; other carriers through 17TRACK (optional)
- **Bookmarks**: grouped launcher tiles, edited in place (drag to reorder, rename, add groups). `/` searches, `1`–`9` open the Daily bookmarks
- **Weather**: beside the clock, the 2-hour forecast for your area and the temperature at the nearest weather station, from the Meteorological Service Singapore (data.gov.sg, free, no key needed). Hover for details; pick the area or turn it off in Settings
- **Photos**: your own pictures in two photo panels, one at the top right and one under a shorter Today. Add them in Settings › Photos (big ones are shrunk to 2400 px before upload) and click a thumbnail to choose the part that stays in frame. Each new tab moves on two photos; the arrows appear on hover. With one photo there's a single panel, and with none the dashboard keeps its usual layout
- **Air quality, UV and rain**: a PSI chip beside the weather (it turns orange from Unhealthy up), and in the weather details the 24-hour PSI for your region, the UV index and today's peak, the last hour of rain at the nearest rain gauge and the 4-day outlook. All from data.gov.sg
- **News**: a view with a short digest per topic you follow, written by Claude from the last two days of Google News headlines. Add and remove topics right there. Without an Anthropic API key it shows the plain headlines
- **Inbox**: a digest of your Gmail from the last two days or week, written by Claude Haiku. A short overview up top, then what needs you (with any deadline), what's worth knowing and what's in passing, each linking to the emails in Gmail. Promotions and newsletters are summed up in one line. The rail shows how many to-dos are still unread; `G` then `I` opens it. Without an Anthropic API key it lists the emails
- **You**: countdowns (one-off or every year; the nearest also shows under the greeting), a cigarette log with a daily limit, today's timeline and the last 14 days, and a 1–5 mood for each day with an optional note and a month calendar (click an earlier day to backlog or change its mood). Press `C` anywhere to log a cigarette (with undo), or use the button in the top bar
- **Training**: your workouts from Hevy. Export them in the Hevy app (Settings › Export & Import Data), then press Import Hevy .csv in the view; importing again replaces what's there, so newer workouts come in. With an Anthropic API key, Claude Haiku reads what each exercise trains (main and secondary muscles, once per new exercise) and writes a short note on your training after each import, with a refresh button. The view has this week day by day, sessions a week for the last 12 weeks and the run of weeks with one, working sets per muscle over 7 days or 4 weeks against your weekly target (Settings › Trackers; secondary muscles count half), your lifts with their estimated 1-rep max over 12 weeks (pinned ones first, PRs marked), recent sessions with the top set of each exercise, what each gym session cost this month (set the monthly fee in Settings › Trackers), and your body weight: log it in the view or type `weight 72.4` in ⌘K, and see each day as a dot and the 7-day average as a line over 30 days, 90 days or a year. The note mentions the weight trend too. Click a lift or exercise for every session of it, and to pin it. A button beside the cigarette one says how long since you trained (orange after 4 days), and gym blocks in Today show the workout logged for them. Without a key, muscles come from the exercise names and there's no note. `G` then `T` opens it
- **Learn**: school and study. Add each course with its assignments, quizzes and exams, how much of the grade each is worth, and the score once marked. Due soon groups open work into overdue, today, this week, next week and later (filter by course, tick off what you've handed in, with undo). Today lists your classes from Google Calendar (events naming a course's code or name, or every event in a calendar you pick) and counts down to each exam. Each course card shows the grade so far against your target, how much of the grade is marked, study time against a weekly goal and what's next; the course drawer has every assessment, the average you need on the rest to hit your target, links, and topics to revise rated by how sure you feel. Study time comes from a start/stop timer (it keeps running across tabs, and shows in the top bar) or `study 45 cs210` in ⌘K, with this week by day and course, the streak and the last 12 weeks. On the side tracks books, online courses and anything else you're learning, with +1 and how long since the last bit of progress. With an Anthropic API key, Claude Haiku writes a short note on the week ahead once a day. `G` then `L` opens it
- **Money**: plan the month's money in and out, then tick, change or delete each entry as the days go by. Entries are planned or done, with an optional category, and can repeat weekly, fortnightly or monthly. The Month tab is a list or a calendar; the calendar shows each day's money in, money out and the balance at the end of the day, so you can see what you'll probably have on any date. Click a day to add to it. Overview has today's balance from what's done, the month-end forecast, the lowest balance ahead, planned entries that have passed, a month-by-month summary (opening, in, out, net, closing, lowest, days below $0), the balance by day and in vs out. The Wishlist shows when each item fits in the forecast. Import .xlsx reads the old Money tracker workbook, month 1 as a month you pick. `G` then `M` opens it
- **Server**: CPU, memory, disk and live network traffic for the machine Launchpad runs on, internet speed tests every few hours with a 24-hour, 7-day and 30-day chart, your Docker containers and when each sync last ran. See [`docs/setup.md`](docs/setup.md) step 8
- **Views and ⌘K**: the rail on the left switches views (or `G` then `H`, `N`, `I`, `Y`, `T`, `L`, `M`, `S`). `⌘K`/`Ctrl K` opens a command palette for actions (log a cigarette, log your weight, start studying, add a deliverable, add a countdown, run a speed test…), views, showing or hiding panels, bookmarks and web searches
- **Search fallbacks**: when no bookmark matches, the search box offers Google, YouTube, GitHub, Maps and Wikipedia. Start with a prefix and a space (`yt lofi`) to search one directly. Engines and prefixes are edited in Settings › Search
- **Show or hide panels**: Settings › Panels switches each home panel, top-bar item and view on or off; the home grid closes up around what's hidden

Bookmarks, notes, packages, news topics, photos, countdowns, the cigarette, mood and weight logs, courses and study time, the money tracker, workouts and settings are edited in the page and stored on the server. Changing them never needs a code change or a rebuild.

**Setting it up on the server:** see [`docs/setup.md`](docs/setup.md).

## How it fits together

```
 Browser (new tab) → https://launchpad.<domain>
      │
 Cloudflare Access (only your login) → Cloudflare Tunnel
      │
 Home server, Docker
 ┌───────────────────────────────────────────────────┐
 │ launchpad container  (port 8090 → 8080)           │
 │   • web app (React, built with Vite)              │
 │   • API + sync worker (Node, Hono)                │
 │       Google Calendar   every 5 min               │
 │       Google Tasks      every 2 min + on tab focus│
 │       Gmail shipping    every 10 min              │
 │       Carrier status    every 20 min              │
 │       News headlines    every hour                │
 │       Gmail inbox       every 15 min              │
 │       Weather and air   every 10 min              │
 │       Speed test        every 3 h (Settings)      │
 │       Server health     sampled every 5 s         │
 │   • SQLite at /data/launchpad.db  ◄── volume      │
 │   • Photos in /data/photos                        │
 └───────────────────────────────────────────────────┘
```

- **Deploys:** pushing to `main` builds `ghcr.io/syaddie/launchpad:latest` in GitHub Actions. A cron job on the server runs `deploy/update.sh`, which pulls the new image and restarts the container only if it changed.
- **Instant paint:** the page renders from a localStorage copy first, then refreshes from the server, so a new tab never waits on the network.
- **Inbox digests:** the last 7 days of mail (up to 150 emails) are checked every 15 minutes; only new emails are downloaded. A digest goes to Claude again only when new mail has arrived in its range, at most every 90 minutes for two days and every 6 hours for the week.
- **Gmail detection:** scans recent shipping and order emails for tracking-number formats (SingPost, Ninja Van, J&T, UPS, Qxpress, plus DHL/FedEx numbers next to the word "tracking"). New finds appear with a "Keep / Dismiss" prompt.
- **Delivered** packages move to a collapsed section and archive after 3 days.
- **News summaries:** headlines are fetched every hour. A topic goes to Claude again only when new headlines have appeared, and at most every 3 hours (refresh in the News view skips the wait), so two topics make at most 16 small requests a day.

## Project layout

| Path | What's there |
|---|---|
| `web/src/` | The dashboard (React). `components/` has one file per panel, view (`You`, `Training`, `Money`, `Server`, `News`, `Inbox`), the rail, the ⌘K palette and the drawers; `layout.ts` builds the home grid from the panels that are on |
| `server/src/` | API (`index.ts`), Google calls (`google.ts`), carrier tracking (`tracking.ts`), the Claude call the summaries share (`claude.ts`), news headlines and their summaries (`news.ts`), inbox digests (`inbox.ts`), exercise muscles and the training note (`training.ts`), weather, air quality, UV and rain (`weather.ts`), server health and Docker (`system.ts`), speed tests (`speedtest.ts`), background sync (`sync.ts`), storage (`store.ts`), photo files (`photos.ts`) |
| `shared/` | Types, defaults, carrier detection, date helpers, countdown/cigarette/mood/search helpers (`trackers.ts`), the money tracker (`money.ts`) and Hevy workouts (`training.ts`) used by both sides |
| `test/` | Unit tests for date parsing, carrier detection, Gmail extraction, inbox parsing and digests, tracking status, weather, air quality, UV and rain parsing, photo upload checks, countdowns, the cigarette and mood helpers, reading the Hevy export and the training numbers, search prefixes, the home grid and server-health parsing |
| `design_handoff_launchpad/` | The Claude Design handoff this was built from |
| `deploy/update.sh` | Auto-update script for cron |

## Development

```bash
npm install
npm run dev      # web on http://localhost:5173, API on :8787
npm test
npm run build    # typecheck + production bundles in dist/
```
