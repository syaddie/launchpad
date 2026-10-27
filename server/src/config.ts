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
  /** Optional: Anthropic API key for the News tab's summaries. Without it the tab shows plain headlines. */
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  /** Claude model that writes the news summaries. */
  newsModel: env.NEWS_MODEL || 'claude-haiku-5-5',
  /** Optional: data.gov.sg API key for the weather. It works without one, at a lower rate limit. */
  dataGovKey: env.DATA_GOV_SG_API_KEY || '',
  /** Optional: verify Cloudflare Access JWTs so only your Access login can reach the app. */
  access: {
    teamDomain: (env.CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    aud: env.CF_ACCESS_AUD || '',
  },
};

export const googleConfigured = () => !!(config.google.clientId && config.google.clientSecret);
