# Launchpad

A self-hosted new-tab dashboard. It shows:

- **Today**: Google Calendar agenda (read-only, synced every 5 min), with a Join button for the next Meet/Zoom call
- **Tasks**: Google Tasks, two-way. Add with natural dates ("call bank fri"), tick off with a 5-second undo
- **Notes**: multiple notepads with light Markdown (checklists, bullets, bold), autosaved
- **Packages**: tracking numbers added by hand or picked up automatically from shipping emails in Gmail. SingPost status is fetched directly; other carriers through 17TRACK (optional)
- **Bookmarks**: grouped launcher tiles, edited in place (drag to reorder, rename, add groups). `/` searches, `1`–`9` open the Daily bookmarks
- **News**: a second view (newspaper button in the top bar, or `N`) with a short digest per topic you follow, written by Claude from the last two days of Google News headlines. Add and remove topics right there. Without an Anthropic API key it shows the plain headlines

Bookmarks, notes, packages, news topics and settings are edited in the page and stored on the server. Changing them never needs a code change or a rebuild.

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
 │   • SQLite at /data/launchpad.db  ◄── volume      │
 └───────────────────────────────────────────────────┘
```

- **Deploys:** pushing to `main` builds `ghcr.io/syaddie/launchpad:latest` in GitHub Actions. A cron job on the server runs `deploy/update.sh`, which pulls the new image and restarts the container only if it changed.
- **Instant paint:** the page renders from a localStorage copy first, then refreshes from the server, so a new tab never waits on the network.
- **Gmail detection:** scans recent shipping and order emails for tracking-number formats (SingPost, Ninja Van, J&T, UPS, Qxpress, plus DHL/FedEx numbers next to the word "tracking"). New finds appear with a "Keep / Dismiss" prompt.
- **Delivered** packages move to a collapsed section and archive after 3 days.
- **News summaries:** headlines are fetched every hour. A topic goes to Claude again only when new headlines have appeared, and at most every 3 hours (refresh in the News view skips the wait), so two topics make at most 16 small requests a day.

## Project layout

| Path | What's there |
|---|---|
| `web/src/` | The dashboard (React). `components/` has one file per panel plus the drawers |
| `server/src/` | API (`index.ts`), Google calls (`google.ts`), carrier tracking (`tracking.ts`), news headlines and Claude summaries (`news.ts`), background sync (`sync.ts`), storage (`store.ts`) |
| `shared/` | Types, carrier detection and date helpers used by both sides |
| `test/` | Unit tests for date parsing, carrier detection, Gmail extraction and tracking status |
| `design_handoff_launchpad/` | The Claude Design handoff this was built from |
| `deploy/update.sh` | Auto-update script for cron |

## Development

```bash
npm install
npm run dev      # web on http://localhost:5173, API on :8787
npm test
npm run build    # typecheck + production bundles in dist/
```
