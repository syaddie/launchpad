import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Photo } from '../../../../shared/types';
import { photoUrl } from '../../api';
import { apron } from '../../mission';
import { menuProps } from '../ContextMenu';

const focusPos = (p: Photo) => `${p.focus.x}% ${p.focus.y}%`;
const wrap = (i: number, n: number) => ((i % n) + n) % n;
/** How long each photo stays before the next comes in, unless you're pointing at it. */
export const DWELL_MS = 18_000;

/** The photo shown now, moving on by itself every DWELL_MS (not while held, nor with less motion). */
function usePhotoClock(n: number, start: number) {
  const [i, setI] = useState(start);
  const [held, setHeld] = useState(false);
  // Bumped by a step by hand, so the next photo waits a whole dwell after it.
  const [lap, setLap] = useState(0);
  const still = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    if (n < 2 || held || still) return;
    const t = window.setTimeout(() => setI((x) => wrap(x + 1, n)), DWELL_MS);
    return () => window.clearTimeout(t);
  }, [n, i, held, still, lap]);
  const step = (d: number) => {
    setI((x) => wrap(x + d, n));
    setLap((l) => l + 1);
  };
  return { i: n ? wrap(i, n) : 0, step, moving: !(held || still || n < 2), setHeld };
}

/**
 * The ground with no photos: the launch site's apron, lit. Rows of lights in perspective run from your feet to the
 * horizon, and the runway's flash in sequence toward it, one row after another, then rest (mission-home.css). Only the
 * lights' own opacity changes, in steps, so little is redrawn for it; with less motion they burn steady.
 */
function Apron() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = { w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) };
      setBox((b) => (b && b.w === next.w && b.h === next.h ? b : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const site = useMemo(() => (box ? apron(box.w, box.h) : null), [box]);
  return (
    <div ref={ref} className="msh-land msh-apron" aria-hidden="true">
      {box && site && (
        <>
          <svg className="msh-paint" viewBox={`0 0 ${box.w} ${box.h}`}>
            <path className="msh-paint-lines" d={site.paint} />
            <path className="msh-paint-dashes" d={site.dashes} />
          </svg>
          {site.lamps.map((l) => (
            <i key={`${l.row}:${l.x}`} className={'msh-lamp' + (l.seq ? ' msh-lamp--seq' : '')} style={{ left: l.x, top: l.y, '--r': `${l.r}px`, '--row': l.row } as CSSProperties} />
          ))}
        </>
      )}
    </div>
  );
}

interface Props {
  photos: Photo[];
  /** Photos switched off in Settings › Panels: no ground and no invitation to add some; the panels share the room. */
  photosOff: boolean;
  /** Where the photos start (each new tab starts further on). */
  start: number;
  today: ReactNode | false;
  notes: ReactNode | false;
  onManagePhotos: () => void;
  onHidePhotos: () => void;
  /** Shown when Today, the Notepad and the photos are all switched off. */
  empty: ReactNode;
}

/**
 * Mission's home. Your photos are the land under the sky, edge to edge, and Today and the
 * Notepad stand on it as glass. The open ground between them is the photo's own: its frame
 * number, its arrows, and a line that fills while it stays. On a phone the land is a band right
 * under the sky, above Today and the Notepad.
 */
export function MissionHome({ photos: all, photosOff, start, today, notes, onManagePhotos, onHidePhotos, empty }: Props) {
  const photos = photosOff ? [] : all;
  const n = photos.length;
  const clock = usePhotoClock(n, start);
  if (!today && !notes && (photosOff || !n)) return <main className="lp-grid msh">{empty}</main>;
  const menu = menuProps(
    () => [
      n > 1 && { label: 'Previous photo', icon: 'ph-caret-left', onSelect: () => clock.step(-1) },
      n > 1 && { label: 'Next photo', icon: 'ph-caret-right', onSelect: () => clock.step(1) },
      'sep',
      { label: n ? 'Manage photos…' : 'Add photos…', icon: 'ph-images', onSelect: onManagePhotos },
      n > 0 && { label: 'Hide photos', icon: 'ph-eye-slash', onSelect: onHidePhotos },
    ],
    'Photos',
  );
  // Pointing at the photo, or a button of its in focus, holds it.
  const hold = {
    onPointerEnter: (e: React.PointerEvent) => e.pointerType === 'mouse' && clock.setHeld(true),
    onPointerLeave: () => clock.setHeld(false),
    onFocus: () => clock.setHeld(true),
    onBlur: () => clock.setHeld(false),
  };
  const frame = String(clock.i + 1).padStart(2, '0');
  return (
    <main className={'msh' + (n ? '' : ' msh--nophoto') + (photosOff ? ' msh--photosoff' : '') + (today ? '' : ' msh--notoday') + (notes ? '' : ' msh--nonotes')}>
      {/* No photos yet: the ground is the site's apron, under the invitation to add some. */}
      {n === 0 && !photosOff && <Apron />}
      {n > 0 && (
        <div className="msh-land" aria-hidden="true">
          {photos.map((x, k) => (
            <img key={x.id} src={photoUrl(x.id)} alt="" className={'msh-img' + (k === clock.i ? ' on' : '')} style={{ objectPosition: focusPos(x) }} loading={Math.abs(k - clock.i) <= 1 || (clock.i === n - 1 && k === 0) ? 'eager' : 'lazy'} />
          ))}
        </div>
      )}
      {today && <div className="msh-card msh-card--today">{today}</div>}
      {!photosOff && (
        <section className="msh-window" aria-label={n ? `Photo ${clock.i + 1} of ${n}` : 'Photos'} data-hide="panel:photos" {...menu} {...hold}>
          {n > 0 ? (
            <>
              <span className="msh-caption mono" aria-hidden="true">
                <i className={'msh-rec' + (clock.moving ? '' : ' held')} />
                FRAME {frame}
                {n > 1 && <b> / {String(n).padStart(2, '0')}</b>}
              </span>
              {n > 1 && (
                <div className="msh-ctl">
                  <button className="photo-btn" aria-label="Previous photo" onClick={() => clock.step(-1)}>
                    <i className="ph-duotone ph-caret-left" />
                  </button>
                  <button className="photo-btn" aria-label="Next photo" onClick={() => clock.step(1)}>
                    <i className="ph-duotone ph-caret-right" />
                  </button>
                </div>
              )}
              {/* The dwell: a line that fills while the photo stays, so the change never comes as a surprise. */}
              {clock.moving && <span key={`${clock.i}`} className="msh-dwell" style={{ animationDuration: `${DWELL_MS}ms` }} aria-hidden="true" />}
            </>
          ) : (
            <div className="msh-add">
              <i className="ph-duotone ph-images" aria-hidden="true" />
              <p>Your photos become the ground here.</p>
              <button className="btn btn-secondary" onClick={onManagePhotos}>
                Add photos
              </button>
            </div>
          )}
        </section>
      )}
      {notes && <div className="msh-card msh-card--notes">{notes}</div>}
    </main>
  );
}
