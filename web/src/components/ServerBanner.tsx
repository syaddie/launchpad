import type { ServerError } from '../api';
import { hm } from '../util';

export type ServerIssue = { kind: ServerError['kind']; status: number; since: Date };

/** "3 changes waiting to save", for edits made while the server couldn't be reached. */
const waitingLine = (n: number) => (n ? <strong>{n === 1 ? '1 change' : `${n} changes`} waiting to save.</strong> : null);

/** Shown while the page can't load from the server: what's wrong, what to check, and a retry. */
export function ServerBanner({ issue, waiting, onRetry }: { issue: ServerIssue; waiting: number; onRetry: () => void }) {
  if (issue.kind === 'access') {
    return (
      <div className="server-banner" role="alert">
        <i className="ph-duotone ph-lock-key" aria-hidden="true" />
        <div>
          <strong>Your Cloudflare Access sign-in has expired.</strong> Reload the page to sign in again; until then nothing you change here is saved.{' '}
          {waitingLine(waiting)}{waiting ? ' They’re kept in this browser and sent once you’re signed in.' : null}
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
        This page shows what it last loaded.{' '}
        {waitingLine(waiting)} Notes, bookmarks, Money, Learn, settings, the trackers and ticked-off tasks are kept in this browser and saved in order once it answers; other changes may not save.{' '}
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
