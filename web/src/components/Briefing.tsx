import { useState } from 'react';
import { ymd } from '../../../shared/dates';
import type { AppState } from '../../../shared/types';
import { api, localGet, localSet } from '../api';
import { ago } from '../util';

type BriefingState = NonNullable<AppState['briefing']>;

/**
 * The daily briefing at the top of Today: Claude's two to four sentences on the day,
 * written each morning from 6:00. Shows today's only; nothing without an API key, before
 * the first one, or when it's switched off in Settings › Panels. Collapsing it lasts
 * until tomorrow's.
 */
export function Briefing({ data, now }: { data: AppState; now: Date }) {
  // What a refresh sent back, until the change stream brings the same (or newer) into `data`.
  const [fresh, setFresh] = useState<BriefingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const today = ymd(now);
  const [collapsedOn, setCollapsedOn] = useState(() => localGet('briefingCollapsed') || '');

  const stored = data.briefing ?? { note: null, error: null };
  const newer = fresh && (!stored.note || (fresh.note && fresh.note.writtenAt > stored.note.writtenAt)) ? fresh : stored;
  const note = newer.note && ymd(new Date(newer.note.writtenAt)) === today ? newer.note : null;
  const error = refreshError || (newer.error && !busy ? newer.error : '');

  if (!data.newsSummaries || data.prefs.hidden.includes('panel:briefing')) return null;
  if (!note && !error && !busy) return null;

  const collapsed = collapsedOn === today && !!note;
  const setCollapsed = (v: boolean) => {
    const day = v ? today : '';
    setCollapsedOn(day);
    localSet('briefingCollapsed', day);
  };

  const refresh = () => {
    setBusy(true);
    setRefreshError('');
    api
      .refreshBriefing(true)
      .then((s) => s.briefing && setFresh(s.briefing))
      .catch((e) => setRefreshError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className={'briefing' + (collapsed ? ' collapsed' : '')} aria-label="Today’s briefing" aria-busy={busy}>
      <div className="briefing-body">
        {note ? (
          <p className="briefing-text" onClick={collapsed ? () => setCollapsed(false) : undefined} title={collapsed ? note.text : undefined}>
            {note.text}
          </p>
        ) : (
          <p className="briefing-text" style={{ color: 'var(--t3)' }}>{busy ? 'Reading your day and writing the briefing…' : 'No briefing yet today.'}</p>
        )}
        {!collapsed && (
          <span className={'briefing-meta' + (error ? ' briefing-error' : '')}>
            {error ? `Couldn’t write a new briefing: ${error}` : busy ? (note ? 'Writing a new one…' : '') : note ? `Written by Claude ${ago(note.writtenAt, now)}` : ''}
          </span>
        )}
      </div>
      <div className="briefing-btns">
        {!collapsed && (
          <button className="icon-btn" title="Write it again with what’s on now" aria-label="Write the briefing again" disabled={busy} onClick={refresh}>
            <i className={'ph-duotone ph-arrows-clockwise' + (busy ? ' spin' : '')} />
          </button>
        )}
        {note && (
          <button className="icon-btn" title={collapsed ? 'Show the briefing' : 'Fold it away until tomorrow'} aria-label={collapsed ? 'Show the briefing' : 'Collapse the briefing'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
            <i className={'ph-duotone ' + (collapsed ? 'ph-caret-down' : 'ph-caret-up')} />
          </button>
        )}
      </div>
    </div>
  );
}
