import { DOW, MON, dayDiff, pad2, parseYmd } from '../../shared/dates';
import type { Bookmark, Package } from '../../shared/types';

export const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** "Tue 27 Oct" */
export const fmtDay = (d: Date) => `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;

/** "27 Oct 08:12" */
export const fmtStamp = (d: Date) => `${d.getDate()} ${MON[d.getMonth()]} ${hm(d)}`;

/** Label for a date relative to today: Today / Tomorrow / Fri / Mon 9 Nov. */
export function shortDay(d: Date, today: Date): string {
  const o = dayDiff(today, d);
  if (o === 0) return 'Today';
  if (o === 1) return 'Tomorrow';
  if (o > 1 && o < 7) return DOW[d.getDay()];
  return fmtDay(d);
}

/** "in 28 min", "in 1 h 05 min", "in 2 h" */
export function inMinutes(m: number): string {
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `in ${h} h${r ? ` ${pad2(r)} min` : ''}`;
}

/** "just now", "2 min ago", "2 h ago", "26 Oct" */
export function ago(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const mins = Math.floor((now.getTime() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = new Date(iso);
  return `${d.getDate()} ${MON[d.getMonth()]}`;
}

export function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const isLocal = (url: string) => /^(\d+\.){3}\d+$|\.local$|^localhost$/.test(host(url).split(':')[0]);

export function favicon(b: Bookmark): string {
  return isLocal(b.url) ? '' : `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host(b.url))}&sz=64`;
}

export const STEP_LABELS = ['Info received', 'In transit', 'Out for delivery', 'Delivered'];

export function chipOf(p: Package): { text: string; cls: string } {
  if (p.exception) return { text: 'Exception', cls: 'chip-warn' };
  return [
    { text: 'Info received', cls: 'chip-neutral' },
    { text: 'In transit', cls: 'chip-neutral' },
    { text: 'Out for delivery', cls: 'chip-accent' },
    { text: 'Delivered', cls: 'chip-muted' },
  ][p.stage];
}

export function segColor(p: Package, i: number): string {
  if (i > p.stage) return 'var(--ln)';
  if (p.exception && i === p.stage) return 'var(--wn)';
  if (p.stage === 2 && !p.exception) return 'var(--ac)';
  return 'var(--t3)';
}

/** Status line under the package label. */
export function statusText(p: Package, today: Date): string {
  if (p.stage === 3 && p.deliveredAt) {
    const d = new Date(p.deliveredAt);
    const o = dayDiff(d, today);
    const day = o === 0 ? 'today' : o === 1 ? 'yesterday' : fmtDay(d);
    return `Delivered ${day} ${hm(d)}`;
  }
  if (p.trackingError && !p.timeline.length) return p.trackingError;
  return p.statusText;
}

export function newId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10);
}

export { parseYmd, dayDiff };

/** Phosphor icon for a Meteorological Service Singapore forecast. */
export function weatherIcon(forecast: string, night: boolean): string {
  const f = forecast.toLowerCase();
  if (f.includes('thunder')) return 'ph-cloud-lightning';
  if (f.includes('rain') || f.includes('shower') || f.includes('drizzle')) return 'ph-cloud-rain';
  if (f.includes('haz') || f.includes('mist') || f.includes('fog')) return 'ph-cloud-fog';
  if (f.includes('wind')) return 'ph-wind';
  if (f.includes('partly')) return night ? 'ph-cloud-moon' : 'ph-cloud-sun';
  if (f.includes('cloud') || f.includes('overcast')) return 'ph-cloud';
  if (f.includes('fair') || f.includes('sunny') || f.includes('clear')) return night ? 'ph-moon' : 'ph-sun';
  return 'ph-cloud';
}

/** "Partly Cloudy (Night)" → "Partly cloudy". */
export function weatherLabel(forecast: string): string {
  const s = forecast.replace(/\s*\((day|night)\)\s*$/i, '').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
