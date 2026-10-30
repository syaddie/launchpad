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
  /** Optional: Anthropic API key for the News and Inbox summaries and the Training and Learn notes. Without it they show plain lists. */
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  /** Claude model that writes the news summaries. */
  newsModel: env.NEWS_MODEL || 'claude-haiku-5-5',
  /** Claude model that writes the inbox digests. */
  inboxModel: env.INBOX_MODEL || 'claude-haiku-5-5',
  /** Claude model that labels exercises and writes the training note. */
  trainingModel: env.TRAINING_MODEL || 'claude-haiku-5-5',
  /** Claude model that writes the note on the week ahead in Learn. */
  learnModel: env.LEARN_MODEL || 'claude-haiku-5-5',
  /** Optional: data.gov.sg API key for the weather. It works without one, at a lower rate limit. */
  dataGovKey: env.DATA_GOV_SG_API_KEY || '',
  /** Optional: where the host's /proc is mounted (e.g. /host/proc), so the Server view sees the host's network traffic. */
  hostProc: env.HOST_PROC || '',
  /** Optional: Docker API for the container list, e.g. tcp://docker-proxy:2375 or unix:///var/run/docker.sock. */
  dockerHost: env.DOCKER_HOST || '',
  /** Optional: verify Cloudflare Access JWTs so only your Access login can reach the app. */
  access: {
    teamDomain: (env.CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    aud: env.CF_ACCESS_AUD || '',
  },
};

export const googleConfigured = () => !!(config.google.clientId && config.google.clientSecret);
