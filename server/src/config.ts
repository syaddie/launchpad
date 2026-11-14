import path from 'node:path';

const env = process.env;

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
  /** Optional: Anthropic API key for the News and Inbox summaries, the Training and Learn notes, and ⌘K's Ask Launchpad. Without it they show plain lists or nothing. */
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  /** Claude model that writes the news summaries. */
  newsModel: env.NEWS_MODEL || 'claude-haiku-5-5',
  /** Claude model that writes the inbox digests. */
  inboxModel: env.INBOX_MODEL || 'claude-haiku-5-5',
  /** Claude model that labels exercises and writes the training note. */
  trainingModel: env.TRAINING_MODEL || 'claude-haiku-5-5',
  /** Claude model that writes the note on the week ahead in Learn. */
  learnModel: env.LEARN_MODEL || 'claude-haiku-5-5',
  /** Claude model that turns what's typed in ⌘K into an action ("Ask Launchpad"). */
  askModel: env.ASK_MODEL || 'claude-haiku-5-5',
  /** Claude model that writes the weekly recap in Review. */
  reviewModel: env.REVIEW_MODEL || 'claude-haiku-5-5',
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
  /** Optional: verify Cloudflare Access JWTs so only your Access login can reach the app. */
  access: {
    teamDomain: (env.CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    aud: env.CF_ACCESS_AUD || '',
  },
};

export const googleConfigured = () => !!(config.google.clientId && config.google.clientSecret);
