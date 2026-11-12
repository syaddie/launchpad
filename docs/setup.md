# Setting up Launchpad on the home server

This assumes the same setup as `streamlit-portfolio`: Ubuntu + CasaOS with Docker, and a Cloudflare account with Zero Trust. Launchpad runs its own Cloudflare Tunnel from this repo's `docker-compose.yml` (step 3). Do the steps in order; each one can be checked before moving on.

You only do this once. After that, pushing to `main` deploys by itself (step 5), and bookmarks and notes are edited in the page.

## 1. Google Cloud: an OAuth client for Calendar, Tasks, Gmail and Drive

1. Go to <https://console.cloud.google.com/> → project picker → **New project** → name it `launchpad`.
2. **APIs & Services → Library**. Enable all four: **Google Calendar API**, **Google Tasks API**, **Gmail API**, **Google Drive API** (Drive holds the off-server copies of the database; see [Backups](#backups)).
3. **APIs & Services → OAuth consent screen** (called **Google Auth Platform** in newer consoles):
   - User type **External**. App name `Launchpad`, your email as support and developer contact.
   - **Data access / Scopes**: add `.../auth/calendar.readonly`, `.../auth/calendar.events`, `.../auth/tasks`, `.../auth/gmail.modify`, `.../auth/drive.file`. `calendar.events` is for adding events, `gmail.modify` for archiving and marking mail read (it covers reading too), and `drive.file` only lets Launchpad see files it made itself. `calendar.readonly` stays because listing your calendars needs it.
   - **Audience / Test users**: add your Gmail address.
   - **Publish the app** (Audience → *Publish app*, status *In production*). Leave it in *Testing* and Google expires the sign-in every 7 days. You do **not** need to submit for verification. Google will show a "Google hasn't verified this app" warning when you connect; click **Advanced → Go to Launchpad**. That's expected for a personal app.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**, name `Launchpad`.
   - **Authorised redirect URI**: `https://launchpad.syaddy.com/api/auth/google/callback` (your real hostname from step 3 below).
   - Copy the **Client ID** and **Client secret**.

## 2. Run the container

On the server:

```bash
git clone https://github.com/syaddie/launchpad.git
cd launchpad
cp .env.example .env
nano .env          # PUBLIC_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
```

The image is built by GitHub Actions and stored privately in GitHub's container registry, so the server needs to log in once:

1. GitHub → Settings → Developer settings → **Personal access tokens (classic)** → Generate new token, scope **`read:packages`** only, no expiry (or a long one).
2. On the server:
   ```bash
   echo <the-token> | docker login ghcr.io -u syaddie --password-stdin
   docker compose pull
   docker compose up -d
   ```

(If you'd rather not create a token, `docker compose up -d --build` builds the image on the server instead. Auto-updates in step 5 need the registry route though.)

Check it from another device on your network: `http://<server-lan-ip>:8090`. You should see the dashboard with starter bookmarks.

> If you normally run `sudo docker …`, run the `docker login` with `sudo` too, and use `sudo crontab -e` in step 5, so the login and the cron job belong to the same user.

## 3. Cloudflare Tunnel: launchpad.syaddy.com

Launchpad has its own tunnel, run by the `cloudflared` service in this repo's `docker-compose.yml`.

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → **Cloudflared** → name it `launchpad` → Save.
2. On the next screen pick **Docker**. Cloudflare shows a `docker run … --token eyJ…` command. Don't run it; copy only the long value after `--token`.
3. Put it in `.env` on the server:
   ```
   TUNNEL_TOKEN=eyJ...
   ```
4. Start it: `docker compose up -d`. The tunnel should show **Healthy** in the dashboard within a few seconds.
5. Back in the tunnel → **Public Hostname** tab → **Add a public hostname**:
   - Subdomain `launchpad`, domain `syaddy.com`
   - Service type **HTTP**, URL **`launchpad:8080`** (the service name and container port, reachable because both run in the same Compose project)
6. Save, then visit `https://launchpad.syaddy.com`.

## 4. Cloudflare Access: lock it to you

Launchpad shows your calendar and reads your Gmail, so it must not be public.

1. **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Application domain: `launchpad.syaddy.com`. Session duration: **1 month** (so the new-tab page doesn't keep asking you to sign in).
3. Add a policy: Action **Allow**, Include **Emails** → your email. Save.
4. Open the app's settings and copy the **Application Audience (AUD) Tag**. Your **team domain** is under Zero Trust → Settings → Custom pages (it looks like `yourteam.cloudflareaccess.com`).
5. Add both to `.env` and restart:
   ```
   CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
   CF_ACCESS_AUD=the-long-aud-tag
   ```
   ```bash
   docker compose up -d
   ```
   With these set, Launchpad itself rejects any request that didn't come through Access, including someone on your LAN hitting port 8090 directly.

Now open `https://launchpad.syaddy.com`, press the gear → **Connect Google**, and approve. Calendar, Tasks and shipping emails sync within a few seconds.

Finally, set it as your new tab: in Chrome, install an extension such as **New Tab Redirect** and point it at the URL; in Firefox, Settings → Home → *New windows and tabs* → Custom URL.

## 5. Automatic updates

Every push to `main` builds a new image (GitHub → Actions → *Build image*). To have the server pick it up on its own, add a cron job:

```bash
crontab -e
```
```
*/5 * * * * /home/<you>/launchpad/deploy/update.sh >> /home/<you>/launchpad/update.log 2>&1
```

`update.sh` pulls the image and recreates the container only when there's a new version. Your data lives in the `launchpad-data` volume, so it survives updates.

You only need to `git pull` on the server when `docker-compose.yml` or `.env.example` changes.

## 6. Optional: other carriers (17TRACK)

SingPost status works out of the box. For Ninja Van, J&T, DHL, UPS, FedEx and Qxpress, Launchpad uses 17TRACK:

1. Sign up at <https://api.17track.net/> and copy your API key (the free plan includes a monthly tracking quota; each new tracking number uses one).
2. Add `SEVENTEEN_TRACK_API_KEY=...` to `.env` and `docker compose up -d`.

Without a key, those packages still appear (manually or from Gmail) with a "Track on …" link to the carrier's site.

## 7. Optional: news, inbox and training summaries (Anthropic API)

The News view (in the rail on the left, or press `N`) works without this and lists headlines for each topic, and the Inbox view (`G` then `I`) lists your last week of email. To get a short digest instead:

1. Create an API key at <https://platform.claude.com/> (Settings → API keys) and add some credit.
2. Add it to `.env` and `docker compose up -d`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Optional: `NEWS_MODEL`, `INBOX_MODEL`, `TRAINING_MODEL`, `LEARN_MODEL`, `BRIEFING_MODEL` (the daily briefing in Today) and `ASK_MODEL` (⌘K’s Ask Launchpad) pick the models. The default for all of them, `claude-haiku-5-5`, costs a few cents a month for news, training, the briefing and ⌘K and at most a dollar or two for the inbox (Server › Claude usage shows the real numbers); `claude-opus-5-5` writes richer summaries at about 40 times the price.

News summaries are written from headlines only, at most every 3 hours per topic and only when new headlines have appeared.

The same key turns on two things in the Training view (`G` then `T`). Claude reads what each exercise in your Hevy export trains, once per new exercise name, and writes a short note on your training after each import that brings in a newer workout, or when you press refresh.

The inbox digest is written from each email's sender, subject and the first 1,000 characters of its text (quoted replies and links removed); promotions and social notifications send only Gmail's one-line snippet. That text goes to the Anthropic API. Gmail is checked every 15 minutes, and a digest is rewritten only when new mail has arrived in its range: the two-day one at most every 90 minutes, the week's at most every 6 hours. The refresh button in the Inbox view skips the wait. To stop it, switch Gmail off in Settings or hide the Inbox view in Settings › Panels.

## 8. Server view: network traffic and containers

The Server view (rail on the left, or `G` then `S`) shows CPU, memory, disk, network traffic, internet speed tests and your containers. CPU, memory, disk and speed tests work with no setup. Three parts need the extras that `docker-compose.yml` already includes:

- **Network traffic for the whole machine.** The host's `/proc` is mounted read-only at `/host/proc` and `HOST_PROC` points at it. Without it, the chart shows only the container's own traffic and says so.
- **The container list and logs.** The `docker-proxy` service gives Launchpad a read-only view of Docker: it answers questions about containers and refuses anything that would change them. `DOCKER_HOST` points Launchpad at it.
- **Restart.** The `docker-restart` service is a second copy of the same proxy that lets through restarts and nothing else, and `DOCKER_RESTART_HOST` points Launchpad at it. It's a separate service so the first one stays read-only. The proxy's own `ALLOW_RESTARTS` setting only takes effect together with `POST=1` (a known bug in the proxy), so this one has `POST=1` but every other part of Docker's API switched off: of all the changes Docker allows, it passes only stop, restart and kill on a container. Launchpad narrows that again: the only change it ever sends is a restart of a container in the list, and never of Launchpad's own container (restart that one on the server with `docker compose restart launchpad`). Starting, stopping, exec, removing and everything else stay out of reach.

If your server copy of the repo is older than this, pick them up once:

```bash
cd ~/launchpad
git pull
docker compose up -d
```

To leave any of them out, delete its lines from `docker-compose.yml` (the `/proc` volume and `HOST_PROC`; the `docker-proxy` service and `DOCKER_HOST`; or the `docker-restart` service and `DOCKER_RESTART_HOST`); that part of the view then explains what's missing, or the Restart buttons don't appear.

**Logs.** The scroll icon on a container opens its log: the last 500 lines by default (100 to 5,000), stdout and stderr together with stderr in orange, each line with its time. **Following** adds new lines every few seconds and stays at the bottom unless you scroll up. The search box filters to matching lines; Esc clears it, then closes the log.

**Restart.** The arrow on a container (or **Restart** in its log) asks once more, then restarts it. Docker gives it 10 seconds to stop before it's killed and started again.

**Speed tests** run from the server against Cloudflare's speed test (the one behind speed.cloudflare.com) every 3 hours by default. Each moves about 130 MB. Change the interval, turn them off or add your plan's speed in Settings › Trackers; the view's **Test now** runs one straight away.

## 9. Optional: terminal and files

The Server view's **Terminal** and **Files** tabs give you a shell on the server and a file explorer for it (browse, upload, download, rename, delete, edit text files, open the terminal in a folder). Launchpad runs in a container, so it reaches the machine over SSH and signs in as your own user. It can do whatever that user can, and nothing more.

**Turn on Cloudflare Access (step 4) first.** Without it, anyone who can open Launchpad gets a shell; the tabs say so while it's off. Also keep port 8090 to your LAN (it is by default).

1. Make sure the server runs an SSH server: `sudo apt install openssh-server` on Ubuntu or Debian.
2. In `~/launchpad/.env`, set `SSH_USER` to your login on the server, and restart:
   ```bash
   cd ~/launchpad
   git pull
   docker compose up -d
   ```
   `docker-compose.yml` sets `SSH_HOST=host.docker.internal`, which reaches the host from inside the container. If sshd listens on a port other than 22, set `SSH_PORT` too.
3. Open Server › Terminal. Launchpad makes its own SSH key the first time (kept in the data volume, never leaves the server) and shows a line to run on the server as that user. It adds the key to `~/.ssh/authorized_keys`:
   ```bash
   mkdir -p -m 700 ~/.ssh && echo 'ssh-ed25519 AAAA… launchpad' >> ~/.ssh/authorized_keys
   ```
4. Press **Try again**. The first connection records the server's host key; if it ever changes (after a reinstall, say), the view stops and shows the new fingerprint to check before you trust it.

**If it can't connect:**

- *Nothing is answering SSH*: sshd isn't running, or a firewall drops connections from Docker's network. With ufw: `sudo ufw allow from 172.16.0.0/12 to any port 22`.
- *Didn't accept Launchpad's key*: the line from step 3 went into a different user's home, or `~/.ssh` has loose permissions (`chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`).

A shell keeps running for 15 minutes after you leave the tab or close the page, so coming back (or reloading) picks it up where it was. **Restart** ends the open tab's shell and starts a fresh one.

**Tabs.** The **+** beside the tabs opens another shell, up to eight per page (and 16 on the server at once, across pages and devices). Each keeps running the same way. Double-click a tab's name to rename it; its **×** (or a middle click) closes it and ends that shell. **Open in terminal** from Files goes to the open tab.

**Snippets.** **Snippets** opens a list of saved commands beside the terminal. **Insert** types one at the prompt so you can change it before pressing Enter; **Run** types it and presses Enter. Add one with **+**, and edit or delete it from its row. They're kept on the server, so every device sees the same list, and they're part of the backup. In the terminal, `Ctrl Shift C` and `Ctrl Shift V` copy and paste; Esc and `Ctrl K` go to the shell, not to Launchpad. Text files up to 1 MB open in the editor (`Ctrl S` saves); anything else downloads. Uploads have no size limit of their own: Cloudflare refuses any single request over 100 MB, so the page sends files in 32 MB pieces into a hidden `.launchpad-upload-….part` file next to the destination, which takes the real name when the last piece lands (and is removed if the upload fails, or swept away a day later if the tab closed before it could say so). A piece that's cut off by a dropped connection is retried a few times before the upload gives up. To turn the tabs off again, empty `SSH_USER` and remove Launchpad's line from `authorized_keys`.

## 10. Optional: disk health (SMART)

The **Disks** panel at the bottom of Server › Overview shows each disk's overall SMART verdict, temperature, how long it has been powered on, and either its reallocated and pending sectors (SATA and SAS disks) or how much of its rated wear is used, media errors and spare blocks (NVMe drives). A disk is flagged when SMART says it's failing, when sectors have been reallocated or are waiting to be, when an NVMe drive is past 80% of its rated wear or reports a critical warning, or when it runs hot (55 °C and up for disks, 70 °C for NVMe).

Reading SMART needs root, so Launchpad runs `sudo -n /usr/sbin/smartctl` over the terminal's SSH connection, which needs step 9 first. It reads the disks at most every 30 minutes; the panel's refresh button reads them again now.

1. Install smartmontools on the server (version 7.0 or later, for its JSON output; Ubuntu 20.04, Debian 11 and anything newer have it):
   ```bash
   sudo apt install smartmontools
   ```
2. Let your SSH user run smartctl as root without a password, and nothing else. As that user, run this. It writes the rule to a file in `/tmp`, has `visudo` check it, and only then moves it into `/etc/sudoers.d` (a broken file there would stop `sudo` working at all):
   ```bash
   echo "$USER ALL=(root) NOPASSWD: /usr/sbin/smartctl --scan -j, /usr/sbin/smartctl -j -a -d *" | sudo tee /tmp/launchpad-smartctl >/dev/null && sudo chmod 440 /tmp/launchpad-smartctl && sudo visudo -cf /tmp/launchpad-smartctl && sudo mv /tmp/launchpad-smartctl /etc/sudoers.d/launchpad-smartctl
   ```
   The rule allows exactly the two commands Launchpad uses: listing the disks (`--scan -j`) and reading one (`-j -a -d <type> /dev/<disk>`). The single `*` at the end means "any further arguments", which both classic sudo and sudo-rs (Ubuntu's sudo from 25.10 on) accept; sudo-rs refuses a wildcard anywhere else.
3. Press refresh on the Disks panel.

Until both are done the panel says which step is missing instead of showing an error. Disks behind a hardware RAID card or some USB enclosures may not show up, or show without figures. To undo it: `sudo rm /etc/sudoers.d/launchpad-smartctl`.

## Backups

Everything is in one SQLite file inside the `launchpad-data` volume, with photos in a `photos` folder beside it, images pasted into notes in `note-images` and bookmark icons in `favicons` (a cache, fetched again when missing). Settings → General → **Backup** has:

- **Download backup**: one JSON file with everything you've entered (bookmarks, notes, settings, countdowns, the cigarette, mood and weight logs, the money tracker, courses and study time, workouts, exercise muscles, packages, the photo list, notepads' earlier versions, the news reading list with hidden headlines and muted sources, how often each bookmark's been opened, and the terminal's snippets). It leaves out what sync fetches again (calendar, tasks, mail, news, weather) and the Google sign-in.
- **With photos (.zip)**: the same backup plus every photo file and every image the notes show, in one .zip.
- **Restore…** takes either file (and the older bookmarks-and-notes files from **Export JSON**). Each part it holds replaces what's there; parts it doesn't hold are kept. From a .zip, photos and note images missing here are put back. Cloudflare refuses uploads over 100 MB, so a bigger .zip has to be restored over the LAN address.
- **Database (.db)**: a consistent copy of the whole SQLite database, safe to take while Launchpad runs. It includes the Google sign-in, so keep it private. To put it back by hand, stop the container, replace `launchpad.db` in the volume (and delete any `launchpad.db-wal` and `launchpad.db-shm` beside it), then start it.

**Automatic copies.** Launchpad also keeps copies of the database by itself, in a `backups` folder beside it: one a day (the last 14), one just before every restore (the last 10), and any you take with **Take a copy now** (the last 10). Settings lists them; **Put back** restores what you'd entered from one, and each can be downloaded as a `.db`.

**Copies in Google Drive.** Those copies are on the same disk as the database, so a dead disk takes both. With Google connected, each daily copy also goes to a **Launchpad backups** folder in your Google Drive, within the hour after it's taken, and the last 14 are kept there; older ones go to Drive's bin, which empties itself after 30 days. **Copy to Drive now** takes a copy and uploads it straight away (the last 10 of those are kept as well). Settings › General › Backup has the switch, when the last copy reached Drive, and the error if it didn't; a failed upload is tried again an hour later. Launchpad uses Drive's `drive.file` permission, so it can only see the files and folder it made itself, and it only ever removes copies it uploaded. The Google sign-in is taken out of the copies in Drive, so a file shared by mistake can't be used to read your mail; after putting one back, connect Google again. To put one back, download it from Drive and replace `launchpad.db` as described for **Database (.db)** above.

If you connected Google before Drive copies existed, Settings › General says **Reconnect Google to allow backups to Drive, creating events and inbox actions**. Everything else keeps working until you do. Before reconnecting, enable the **Google Drive API** in your Google Cloud project (step 1.2) and add the new scopes to the consent screen (step 1.3); then press **Reconnect Google** and leave every box ticked on Google's permission screen.

**Health check.** `/healthz`, which Docker's `HEALTHCHECK` calls every minute, reads the database and answers 503 only when that fails, so Docker restarts Launchpad when the database is unreadable but not when a Google sync is having a bad day. `/api/health` (behind Cloudflare Access like the rest) has the details: whether the database reads, how old the last daily copy is, the last Drive upload or its error, and every sync with its last success and failures in a row. A sync that has failed three times in a row, or last worked more than three of its intervals ago (and at least half an hour), a daily copy over 36 hours old, or a failed Drive upload shows in orange in the Server view's sync list and turns the sync dot in the top bar orange.

**Undo.** Every restore, from a file or a copy, is preceded by a copy, so the message afterwards has **Undo**, and the copy stays in the list if you change your mind later.

**Two devices editing at once.** Notes, bookmarks, the money tracker and Learn are saved whole. If another tab or device saved one since this page last loaded it, the save is refused and the page merges the two: different items, and different fields of one item, both survive. Where both changed the same value, this device's wins, and if both rewrote the same notepad, the other device's text is kept as a copy beside it. A message says when this happened.

Photo files aren't in the database or its copies. To copy everything from the server instead:

```bash
docker run --rm -v launchpad_launchpad-data:/data -v "$PWD":/backup alpine sh -c "apk add -q sqlite && sqlite3 /data/launchpad.db \"VACUUM INTO '/backup/launchpad.db'\" && cp -r /data/photos /backup/"
```

Launchpad tidies up after itself too: photo files no photo uses are removed after a week, and the part files of uploads abandoned without the page saying so (the tab closed mid-upload) are removed once they've sat for a day, both from the folder when you next open it in Files and from a sweep every 6 hours.

## Install it on your phone

Over HTTPS (the Cloudflare URL), Launchpad can be installed as an app: on Android, Chrome's menu → **Install app**; on an iPhone, Safari's Share → **Add to Home Screen**. It opens full-screen; on Android a long press on the icon also offers You, Money and Training directly. On an iPhone the installed app keeps its own cookies, separate from Safari, so you sign in to Cloudflare Access once more inside it. It also keeps a copy of the page, so it opens even when the server or the tunnel is down, showing your last data with a banner saying the server can't be reached. Data itself always comes from the server. Over the plain-HTTP LAN address none of this applies (browsers only allow it over HTTPS), and the page works as before.

If the install option doesn't appear behind Cloudflare Access, sign in once in that browser first; the page asks for the manifest with the Access cookie.

## Running it locally (development)

```bash
npm install
cp .env.example .env    # PUBLIC_URL=http://localhost:5173 for local Google sign-in
npm run dev             # web on :5173, API on :8787
npm test
```

For local Google sign-in, also add `http://localhost:5173/api/auth/google/callback` as a redirect URI on the OAuth client.
