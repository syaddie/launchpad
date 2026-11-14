import { addDays, startOfDay, ymd } from '../../../shared/dates';
import { balanceOn, fmtMoney } from '../../../shared/money';
import type { AppState } from '../../../shared/types';

/**
 * The key figures at the top of Today: the same few numbers every day, counted here from
 * what's already loaded (no Claude, no cost). A figure is left out when its source is
 * switched off, and the whole row when the panel is hidden in Settings › Panels.
 */
export function KeyFigures({ data, now }: { data: AppState; now: Date }) {
  const hidden = data.prefs.hidden;
  if (hidden.includes('panel:briefing')) return null;
  const on = (view: string) => !hidden.includes(`view:${view}`);
  const todayKey = ymd(now);
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const google = data.google.connected;
  const figures: { label: string; value: string; warn?: boolean }[] = [];

  if (google && data.prefs.sources.calendar && !hidden.includes('panel:today')) {
    const skip = new Set(data.prefs.hiddenCalendars);
    const left = data.events.filter((e) => !e.allDay && !skip.has(e.calendarId) && new Date(e.start) < tomorrow && new Date(e.end) > now).length;
    figures.push({ label: 'Events left', value: String(left) });
  }
  if (google && data.prefs.sources.tasks && !hidden.includes('panel:tasks')) {
    const due = data.tasks.filter((t) => t.due && t.due <= todayKey);
    figures.push({ label: 'Tasks due', value: String(due.length), warn: due.some((t) => t.due! < todayKey) });
  }
  if (google && data.prefs.sources.gmail && on('inbox')) {
    figures.push({ label: 'Unread', value: String(data.inbox.emails.filter((e) => e.unread).length) });
  }
  if (!hidden.includes('panel:packages')) {
    const arriving = data.packages.filter((p) => !p.archived && (p.stage === 2 || (p.exception && p.stage < 3))).length;
    figures.push({ label: 'Arriving', value: String(arriving) });
  }
  if (on('money') && data.money.entries.length) {
    figures.push({ label: 'Balance', value: fmtMoney(balanceOn(data.money, todayKey, true)) });
  }

  if (!figures.length) return null;
  return (
    <div className="key-figures" aria-label="Today’s key figures">
      {figures.map((f) => (
        <div key={f.label} className="key-figure">
          <span className={'tnum key-figure-value' + (f.warn ? ' warn' : '')}>{f.value}</span>
          <span className="key-figure-label">{f.label}</span>
        </div>
      ))}
    </div>
  );
}
