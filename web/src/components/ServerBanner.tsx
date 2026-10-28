import type { ServerError } from '../api';
import { hm } from '../util';

export type ServerIssue = { kind: ServerError['kind']; status: number; since: Date };

/** Shown while the page can't load from the server: what's wrong, what to check, and a retry. */
export function ServerBanner({ issue, onRetry }: { issue: ServerIssue; onRetry: () => void }) {
  if (issue.kind === 'access') {
    return (
      <div className="server-banner" role="alert">
        <i className="ph-duotone ph-lock-key" aria-hidden="true" />
        <div>
          <strong>Your Cloudflare Access sign-in has expired.</strong> Reload the page to sign in again; until then nothing you change here is saved.
        </div>
        <button className="btn btn-secondary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
  return (
    <div className="server-banner" role="alert">
      <i className="ph-duotone ph-plugs" aria-hidden="true" />
      <div>
        <strong>{issue.kind === 'down' ? `The Launchpad server isn’t answering (${issue.status})` : 'Can’t reach the Launchpad server'} since {hm(issue.since)}.</strong>{' '}
        This page shows what it last loaded, and changes may not save.{' '}
        {issue.kind === 'unreachable' && 'Check your own internet connection first. '}
        On the server, check the containers are running with <code>docker compose ps</code>, and look for errors with{' '}
        <code>docker compose logs launchpad</code>
        {issue.kind === 'down' ? <> and <code>docker compose logs cloudflared</code></> : null}. Retrying every minute.
      </div>
      <button className="btn btn-secondary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
