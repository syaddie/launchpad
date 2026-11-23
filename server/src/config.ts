import path from 'node:path';

const env = process.env;

import type { NacPlace } from '../../shared/types';

/** A busking location the Slot Finder checks (shared/types.ts). */
export type { NacPlace };

export const config = {
  port: Number(env.PORT || 8787),
  dataDir: path.resolve(env.DATA_DIR || './data'),
  webDir: path.resolve(env.WEB_DIR || './dist/web'),
  /** Public origin, e.g. https://launchpad.example.com. Used for the Google OAuth redirect. */
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 8787}`).replace(/\/+$/, ''),
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
  },
  /** Optional: 17TRACK API key for carriers other than SingPost. */
  seventeenTrackKey: env.SEVENTEEN_TRACK_API_KEY || '',
  /** Optional: Anthropic API key for the daily digest, the Inbox summaries, Training's exercise muscles, the Learn note, and ⌘K's Ask Launchpad. Without it they show plain lists or nothing. */
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  /** Claude model that writes the daily digest's lessons. Opus by default: they teach, so they have to be right, and it's one call a day. */
  digestModel: env.DIGEST_MODEL || 'claude-opus-5-5',
  /** Claude model that answers follow-up questions on a lesson. Sonnet: quick, and each question is a call of its own. */
  digestAskModel: env.DIGEST_ASK_MODEL || 'claude-sonnet-5-5',
  /** Claude model that writes the inbox digests. */
  inboxModel: env.INBOX_MODEL || 'claude-haiku-5-5',
  /** Claude model that labels exercises with the muscles they train. */
  trainingModel: env.TRAINING_MODEL || 'claude-haiku-5-5',
  /** Claude model that writes the note on the week ahead in Learn. */
  learnModel: env.LEARN_MODEL || 'claude-haiku-5-5',
  /** Claude model that turns what's typed in ⌘K into an action ("Ask Launchpad"). */
  askModel: env.ASK_MODEL || 'claude-haiku-5-5',
  /** Claude model that writes the weekly recap in Review. */
  reviewModel: env.REVIEW_MODEL || 'claude-haiku-5-5',
  /** Claude model that explains a Minecraft server's or a container's log (Explain this log). */
  explainModel: env.EXPLAIN_MODEL || 'claude-haiku-5-5',
  /** Optional: data.gov.sg API key for the weather. It works without one, at a lower rate limit. */
  dataGovKey: env.DATA_GOV_SG_API_KEY || '',
  /** Optional: where the host's /proc is mounted (e.g. /host/proc), so the Server view sees the host's network traffic. */
  hostProc: env.HOST_PROC || '',
  /** Optional: Docker API for the container list, e.g. tcp://docker-proxy:2375 or unix:///var/run/docker.sock. */
  dockerHost: env.DOCKER_HOST || '',
  /** Optional: a second Docker proxy that allows restarts, e.g. tcp://docker-restart:2375. Launchpad sends it nothing but restarts. */
  dockerRestartHost: env.DOCKER_RESTART_HOST || '',
  /** Optional: SSH login on the host for the Server view's terminal and file explorer. Both host and user must be set. */
  ssh: {
    host: env.SSH_HOST || '',
    port: Number(env.SSH_PORT || 22),
    user: env.SSH_USER || '',
  },
  /** Optional: qBittorrent's Web UI, for the Server view's torrents. Empty QBIT_USER: it lets Launchpad in without signing in. */
  qbit: {
    url: (env.QBIT_URL || '').replace(/\/+$/, ''),
    user: env.QBIT_USER || '',
    pass: env.QBIT_PASS || '',
    /** Where qBittorrent saves inside its container, and the same folder on the server, so finished torrents open in Files. */
    saveDir: (env.QBIT_SAVE_DIR || '/downloads').replace(/(.)\/+$/, '$1'),
    hostDir: (env.QBIT_HOST_DIR || '').replace(/(.)\/+$/, '$1'),
  },
  /** Instagram downloads: a Python with instaloader installed. The Docker image sets this to its own; outside it, `python3`. */
  instaloaderPython: env.INSTALOADER_PYTHON || 'python3',
  /** Video downloads: a Python with yt-dlp and yt-dlp-ejs installed, and ffmpeg's path if it isn't on the PATH. The Docker image sets the Python to its own. */
  ytdlpPython: env.YTDLP_PYTHON || 'python3',
  ytdlpFfmpeg: env.YTDLP_FFMPEG || '',
  /** Music › Busking slots: free NAC busking slots (server/src/nac.ts, docs/nac-slot-finder-spec.md). */
  nac: {
    /** Optional: your NAC busker profile ID (the id in your public profile's address, or the whole address), so your own bookings show as yours. Without it they count as taken. */
    buskerId: (env.NAC_BUSKER_ID || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0].toLowerCase() ?? '',
    /**
     * The busker who uses the Music-only page (CF_ACCESS_MUSIC_AUD, server/src/access.ts): their bookings
     * show as theirs there, and as taken in your Music. Their public NAC profile ID, which isn't a secret.
     */
    guestBuskerId: 'd2c0110c-cf3a-4875-8995-cf5b0163a595',
    /** Set, but with no profile ID in it. */
    buskerIdInvalid: !!(env.NAC_BUSKER_ID || '').trim() && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(env.NAC_BUSKER_ID || ''),
    /** Development only: read saved pages from this folder (e.g. test/fixtures/nac) instead of asking NAC. See test/fixtures/nac/README.md. */
    fixtures: env.NAC_FIXTURES ? path.resolve(env.NAC_FIXTURES) : '',
    /**
     * The locations it starts with, one line each. The id is the one in the location page's address;
     * open hours are read from the page. Once the list is changed in Music › Busking slots › Locations,
     * that list (store key `nacPlaces`) is the one it checks, and this one only matters for a fresh install.
     */
    locations: [
      { key: 'tampines', id: '9c962e64-ae46-40d2-9506-eb71639b274d', nac: 'MRT STATION - DTL TAMPINES', name: 'Tampines Interchange', short: 'Tampines' },
      { key: 'pasir-ris', id: '2df197be-cf61-4981-8aef-ebda3f353ec2', nac: 'MRT STATION - EWL PASIR RIS', name: 'Pasir Ris MRT', short: 'Pasir Ris' },
      { key: 'paya-lebar', id: 'c6f63ddc-3926-4a83-b59f-e7904989c7a0', nac: 'PAYA LEBAR SQUARE', name: 'Paya Lebar Square', short: 'Paya Lebar' },
      { key: 'changi-village', id: '8f102e44-7f8d-45bc-a1da-50aa8a6202fc', nac: 'CHANGI VILLAGE - SPACE BETWEEN BLK 2 & 3', name: 'Changi Village', short: 'Changi Village' },
    ] as NacPlace[],
  },
  /** Optional: verify Cloudflare Access JWTs so only your Access login can reach the app. */
  access: {
    teamDomain: (env.CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    aud: env.CF_ACCESS_AUD || '',
    /**
     * Optional: the AUD tag of a second Access application, on its own hostname, for someone who
     * should only see Music's busking slots (server/src/access.ts). Its sign-ins reach nothing else.
     */
    musicAud: env.CF_ACCESS_MUSIC_AUD || '',
  },
};

export const googleConfigured = () => !!(config.google.clientId && config.google.clientSecret);
