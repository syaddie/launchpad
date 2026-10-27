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
- **You**: countdowns (one-off or every year; the nearest also shows under the greeting), a cigarette log with a daily limit, today's timeline and the last 14 days, and a 1–5 mood for each day with an optional note and a month calendar. Press `C` anywhere to log a cigarette (with undo), or use the button in the top bar
- **Server**: CPU, memory, disk and live network traffic for the machine Launchpad runs on, internet speed tests every few hours with a 24-hour, 7-day and 30-day chart, your Docker containers and when each sync last ran. See [`docs/setup.md`](docs/setup.md) step 8
- **Views and ⌘K**: the rail on the left switches views (or `G` then `H`, `N`, `I`, `Y`, `S`). `⌘K`/`Ctrl K` opens a command palette for actions (log a cigarette, add a countdown, run a speed test…), views, showing or hiding panels, bookmarks and web searches
- **Search fallbacks**: when no bookmark matches, the search box offers Google, YouTube, GitHub, Maps and Wikipedia. Start with a prefix and a space (`yt lofi`) to search one directly. Engines and prefixes are edited in Settings › Search
- **Show or hide panels**: Settings › Panels switches each home panel, top-bar item and view on or off; the home grid closes up around what's hidden

Bookmarks, notes, packages, news topics, photos, countdowns, the cigarette and mood logs and settings are edited in the page and stored on the server. Changing them never needs a code change or a rebuild.

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
| `web/src/` | The dashboard (React). `components/` has one file per panel, view (`You`, `Server`, `News`, `Inbox`), the rail, the ⌘K palette and the drawers; `layout.ts` builds the home grid from the panels that are on |
| `server/src/` | API (`index.ts`), Google calls (`google.ts`), carrier tracking (`tracking.ts`), the Claude call both summaries share (`claude.ts`), news headlines and their summaries (`news.ts`), inbox digests (`inbox.ts`), weather, air quality, UV and rain (`weather.ts`), server health and Docker (`system.ts`), speed tests (`speedtest.ts`), background sync (`sync.ts`), storage (`store.ts`), photo files (`photos.ts`) |
| `shared/` | Types, defaults, carrier detection, date helpers, and countdown/cigarette/mood/search helpers (`trackers.ts`) used by both sides |
| `test/` | Unit tests for date parsing, carrier detection, Gmail extraction, inbox parsing and digests, tracking status, weather, air quality, UV and rain parsing, photo upload checks, countdowns, the cigarette and mood helpers, search prefixes, the home grid and server-health parsing |
| `design_handoff_launchpad/` | The Claude Design handoff this was built from |
| `deploy/update.sh` | Auto-update script for cron |

## Development

```bash
npm install
npm run dev      # web on http://localhost:5173, API on :8787
npm test
npm run build    # typecheck + production bundles in dist/
```
