# Setting up Launchpad on the home server

This assumes the same setup as `streamlit-portfolio`: Ubuntu + CasaOS with Docker, and a Cloudflare account with Zero Trust. Launchpad runs its own Cloudflare Tunnel from this repo's `docker-compose.yml` (step 3). Do the steps in order; each one can be checked before moving on.

You only do this once. After that, pushing to `main` deploys by itself (step 5), and bookmarks and notes are edited in the page.

## 1. Google Cloud: an OAuth client for Calendar, Tasks and Gmail

1. Go to <https://console.cloud.google.com/> → project picker → **New project** → name it `launchpad`.
2. **APIs & Services → Library**. Enable all three: **Google Calendar API**, **Google Tasks API**, **Gmail API**.
3. **APIs & Services → OAuth consent screen** (called **Google Auth Platform** in newer consoles):
   - User type **External**. App name `Launchpad`, your email as support and developer contact.
   - **Data access / Scopes**: add `.../auth/calendar.readonly`, `.../auth/tasks`, `.../auth/gmail.readonly`.
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

## Backups

Everything is in one SQLite file inside the `launchpad-data` volume. Two ways to keep a copy:

- Settings → **Export JSON** downloads bookmarks and notes.
- Full copy of the database:
  ```bash
  docker run --rm -v launchpad_launchpad-data:/data -v "$PWD":/backup alpine cp /data/launchpad.db /backup/
  ```

## Running it locally (development)

```bash
npm install
cp .env.example .env    # PUBLIC_URL=http://localhost:5173 for local Google sign-in
npm run dev             # web on :5173, API on :8787
npm test
```

For local Google sign-in, also add `http://localhost:5173/api/auth/google/callback` as a redirect URI on the OAuth client.
