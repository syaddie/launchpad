# Launchpad

A self-hosted personal dashboard for my browser's new-tab page. It shows:

- **Today**: Google Calendar agenda (auto-synced, read-only)
- **Tasks**: Google Tasks (two-way: complete and add from the dashboard)
- **Notes**: multiple notepads, edited in place
- **Packages**: tracking for SingPost and other carriers, added by hand or detected automatically from shipping emails in Gmail
- **Bookmarks**: grouped launcher tiles, edited in place

**Status:** design phase. The visual design is being worked out in Claude Design using [`design/claude-design-prompt.md`](design/claude-design-prompt.md).

## Goals

1. **Content is data, not code.** Bookmarks, notes, task lists and packages are edited in the UI and stored in a database on a mounted volume. Changing them never means touching the repo or rebuilding the container.
2. **Everything else syncs by itself.** A background worker pulls Calendar, Tasks and Gmail on a schedule and refreshes package tracking.
3. **Deploys without manual rebuilds.** Pushing to `main` builds the image in GitHub Actions and publishes it to GHCR, and the host pulls the new image automatically. No `git pull && docker build` on the server.
4. **Private.** It's only reachable through Cloudflare, behind Cloudflare Access.

## Planned architecture

```
 Browser (new tab)
      │  https://launchpad.<my-domain>
      ▼
 Cloudflare  ── Access (only my login gets through)
      │  Cloudflare Tunnel
      ▼
 Home server: Docker
 ┌─────────────────────────────────────────────┐
 │ launchpad container                         │
 │  • web UI (static SPA)                      │
 │  • API: bookmarks / notes / packages / tasks│
 │  • sync worker (cron-style jobs)            │
 │      - Google Calendar   every ~5 min       │
 │      - Google Tasks      every ~2 min       │
 │      - Gmail shipping    every ~15 min      │
 │      - Carrier tracking  every ~30–60 min   │
 │  • SQLite at /data/launchpad.db  ◄── volume │
 └─────────────────────────────────────────────┘
 cloudflared container (tunnel)
 watchtower (auto-pulls new images from GHCR)
```

- **Google:** a single OAuth sign-in with scopes for Calendar (read-only), Tasks (read/write) and Gmail (read-only). The refresh token is stored on the data volume.
- **Packages:** carrier is detected from the tracking-number format. Status comes from each carrier's public tracking (starting with SingPost), with a tracking-aggregator API as a possible fallback. Gmail detection searches shipping and order emails for tracking numbers and offers them as "Keep / Dismiss".
- **Backups:** the whole state lives in one SQLite file, plus JSON export/import from Settings.

Stack choices (framework, language) will be decided after the design is settled.

## Roadmap

- [ ] Finalise the visual design in Claude Design
- [ ] Scaffold the app, Dockerfile and docker-compose (app + cloudflared + watchtower)
- [ ] Bookmarks + notes (local data, editable)
- [ ] Google OAuth → Calendar + Tasks
- [ ] Packages: manual add + SingPost tracking
- [ ] Packages: Gmail auto-detection + more carriers
- [ ] GitHub Actions → GHCR image, auto-update on host
- [ ] Cloudflare Tunnel + Access setup guide
