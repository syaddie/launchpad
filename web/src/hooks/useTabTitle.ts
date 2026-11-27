// Puts tabTitle.ts's title and icon on the page. Cheap for a tab left open all day: the title is written at most once a
// second, and only while it's counting (an event inside the hour, or studying), on the second so it keeps time with the
// launch clock; otherwise it's looked at once a minute, as the page's clock ticks. The icon is swapped only when it
// changes, between the app's icon and the same with its engine lit.

import { useEffect } from 'react';
import { MAX_SESSION_MIN } from '../../../shared/learn';
import type { AppState } from '../../../shared/types';
import { todayAgenda } from '../components/Today';
import { BASE_TITLE, tabState } from '../tabTitle';

const ICON = '/favicon.svg';
const ICON_LIT = '/favicon-lit.svg';
let litNow = false;

function showIcon(lit: boolean): void {
  if (lit === litNow) return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  litNow = lit;
  link.href = lit ? ICON_LIT : ICON;
}

export function useTabTitle(data: AppState, now: Date): void {
  const calOn = data.google.connected && data.prefs.sources.calendar;
  const next = calOn ? todayAgenda(data, now).next : undefined;
  const timer = data.learn.timer && !data.prefs.hidden.includes('view:learn') ? data.learn.timer : null;
  const course = timer ? data.learn.courses.find((c) => c.id === timer.courseId)?.name : undefined;
  const nextAt = next ? next.s.getTime() : null;
  const nextTitle = next?.title ?? '';
  const timerAt = timer ? Date.parse(timer.start) : null;
  const what = course ? `Studying ${course}` : 'Studying';
  const minute = now.getTime();

  useEffect(() => {
    const apply = () => {
      // An invoice being printed names the PDF by the title: leave it be until it's done (InvoicePage.tsx).
      if (document.documentElement.classList.contains('inv-printing')) return true;
      const st = tabState(new Date(), nextAt === null ? null : { s: new Date(nextAt), title: nextTitle }, timerAt === null ? null : { start: new Date(timerAt), what, maxMs: MAX_SESSION_MIN * 60_000 });
      if (document.title !== st.title) document.title = st.title;
      showIcon(st.lit);
      return st.ticking;
    };
    if (!apply()) return;
    let iv = 0;
    const t = window.setTimeout(() => {
      apply();
      iv = window.setInterval(apply, 1000);
    }, 1000 - (Date.now() % 1000) + 20);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
    };
  }, [nextAt, nextTitle, timerAt, what, minute]);

  // The page going away (never, in practice): leave the tab as it found it.
  useEffect(
    () => () => {
      document.title = BASE_TITLE;
      showIcon(false);
    },
    [],
  );
}
