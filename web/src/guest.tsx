// The Music-only page (web/guest.html): Music's busking slots for a music-only sign-in
// (server/src/access.ts), or for you at /guest to see what they see. Only the slots and Check now:
// none of Launchpad's other views are in its bundle, and the server answers nothing else to them.
import { StrictMode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import '@phosphor-icons/web/duotone/style.css';
import './styles.css';
import './designs.css';
import './motion.css';
import './mission.css';
import { knownDesign, type GuestMusic } from '../../shared/types';
import { api, cachedGuest, cacheGuest } from './api';
import { ContextMenuHost, copyText, menuProps, placeOf } from './components/ContextMenu';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Presence } from './components/Motion';
import { GuestGuide } from './components/music/GuestGuide';
import { MusicView } from './components/music/MusicView';
import type { SlotSource } from './components/music/SlotFinder';
import { useLayout, useMinuteNow, useSystemDark } from './hooks/useDevice';
import { useToast } from './hooks/useToast';

const PORTAL = 'https://eservices.nac.gov.sg/Busking';

// ---------- the owner's look, as the server last gave it ----------

let look: GuestMusic['look'] | null = cachedGuest()?.look ?? null;
const lookListeners = new Set<() => void>();
const lookStore = {
  subscribe: (f: () => void) => (lookListeners.add(f), () => void lookListeners.delete(f)),
  get: () => look,
};
function setLook(next: GuestMusic['look']) {
  if (look && look.design === next.design && look.accent === next.accent && look.theme === next.theme) return;
  look = next;
  for (const f of lookListeners) f();
}

/** The same object on every render, so the panel's polling isn't restarted. */
const GUEST: SlotSource = {
  initial: () => cachedGuest()?.nac ?? null,
  load: () =>
    api.guestMusic().then((g) => {
      cacheGuest(g);
      setLook(g.look);
      return g.nac;
    }),
  check: () => api.guestCheckNac(),
};

/** The one-page guide is at #help; any other address is the slots. A hash, so it works at /guest and on the Music-only address alike. */
const onGuide = () => location.hash === '#help';
function useGuide(): boolean {
  const [guide, setGuide] = useState(onGuide);
  useEffect(() => {
    const f = () => setGuide(onGuide());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return guide;
}

function GuestApp() {
  const rootRef = useRef<HTMLDivElement>(null);
  const layout = useLayout(rootRef);
  const now = useMinuteNow();
  const systemDark = useSystemDark();
  const l = useSyncExternalStore(lookStore.subscribe, lookStore.get);
  const { toast, showToast, holdToast } = useToast();
  const guide = useGuide();
  // The guide names the locations by their codes; opened first (a link straight to #help), it asks for them, and for the look, itself.
  const [places, setPlaces] = useState(() => cachedGuest()?.nac.watching ?? []);
  useEffect(() => {
    if (guide) GUEST.load().then((n) => setPlaces(n.watching), () => {});
  }, [guide]);

  const design = knownDesign(l?.design);
  const theme = l?.theme ?? 'system';
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.mode = dark ? 'dark' : 'light';
    root.dataset.accent = l?.accent ?? 'sage';
    root.dataset.design = design;
    root.dataset.layout = layout;
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (bg) for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = bg;
  }, [dark, l?.accent, design, layout]);

  // The page-wide menu: a link's own items, then what the panel's header offers (Check now), then the portal.
  const backgroundMenu = menuProps(
    (t) => {
      const place = placeOf(t);
      const link = t.closest('a[href]');
      // Links to other sites only: the guide's own links (#help, #slots) are this page.
      const url = link instanceof HTMLAnchorElement && !link.getAttribute('href')?.startsWith('#') ? link.href : '';
      return [
        url && { label: 'Open link', icon: 'ph-arrow-square-out', href: url, newTab: true },
        url && { label: 'Copy link', icon: 'ph-link', onSelect: () => copyText(url, showToast, 'Link copied') },
        'sep',
        ...(place?.items ?? []),
        'sep',
        (guide ? { label: 'Back to the slots', icon: 'ph-arrow-left', onSelect: () => (location.hash = 'slots') } : { label: 'How to read this', icon: 'ph-question', onSelect: () => (location.hash = 'help') }),
        url !== PORTAL && { label: 'Open the NAC portal', icon: 'ph-arrow-square-out', href: PORTAL, newTab: true },
        { label: 'Reload', icon: 'ph-arrow-clockwise', onSelect: () => location.reload() },
      ];
    },
    (t) => placeOf(t)?.name || 'Busking slots',
    { root: true },
  );

  return (
    <div ref={rootRef} className="lp-root lp-guest" data-layout={layout} data-design={design} data-view="music" {...backgroundMenu}>
      {design === 'vista' && <div className="wallpaper plain" aria-hidden="true" />}
      {/* Mission's sky, standing still: this page has no launch site of its own. */}
      {design === 'mission' && <div className="ms-scene ms-scene--plain" aria-hidden="true"><div className="ms-sky" /><div className="ms-ground" /></div>}
      <div className="lp-inner">
        <header className="topbar">
          <div className="top-left">
            <h1 className="serif greeting">Music</h1>
            <div className="subline">Free NAC busking slots, checked every 10 minutes.</div>
          </div>
          <div className="top-right">
            {guide ? (
              <a className="btn btn-ghost btn-small" href="#slots">
                <i className="ph-duotone ph-arrow-left" aria-hidden="true" />
                Back to the slots
              </a>
            ) : (
              <a className="btn btn-ghost btn-small" href="#help">
                <i className="ph-duotone ph-question" aria-hidden="true" />
                How to read this
              </a>
            )}
          </div>
        </header>
        <ErrorBoundary resetKey={guide ? 'guide' : 'music'}>
          {guide ? <GuestGuide places={places} /> : <MusicView now={now} notify={showToast} guest={GUEST} />}
        </ErrorBoundary>
      </div>

      <ContextMenuHost />

      <Presence show={!!toast}>
        {toast && (
          <div
            key={toast.id}
            className="popover toast"
            role="status"
            style={{ '--toast-life': `${toast.life}ms` } as CSSProperties}
            onMouseEnter={() => holdToast(true)}
            onMouseLeave={() => holdToast(false)}
          >
            {toast.msg}
          </div>
        )}
      </Presence>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GuestApp />
  </StrictMode>,
);
