import { useRef, useState } from 'react';
import type { Photo } from '../../../shared/types';
import { localGet, localSet, photoUrl } from '../api';

/** Long edge of an uploaded photo. Panels are at most ~900px wide on a 4K screen. */
const MAX_EDGE = 2400;

/** Shrinks big photos to a JPEG so new tabs load fast. GIFs and small files go up as they are. */
export async function shrinkImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file; // The server says whether it can use it.
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 2_000_000) {
    bmp.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.88));
}

const focusPos = (p: Photo) => `${p.focus.x}% ${p.focus.y}%`;

const wrap = (i: number, n: number) => ((i % n) + n) % n;

/**
 * Which photo each panel shows. Each new tab starts two photos further on, and
 * a panel's arrows skip the photo the other panel is showing.
 */
export function usePhotoSlots(count: number) {
  const [slots, setSlots] = useState(() => {
    const k = Number(localGet('photoStart')) || 0;
    localSet('photoStart', String(k + 2));
    return [k, k + 1];
  });
  const shown = count ? slots.map((s) => wrap(s, count)) : slots;
  const step = (slot: 0 | 1, dir: 1 | -1) => {
    let i = wrap(shown[slot] + dir, count);
    if (count > 2 && i === shown[1 - slot]) i = wrap(i + dir, count);
    setSlots(slot ? [shown[0], i] : [i, shown[1]]);
  };
  return { shown, step };
}

interface PanelProps {
  photos: Photo[];
  area: 'photo' | 'photo2';
  index: number;
  onStep: (dir: 1 | -1) => void;
}

export function PhotoPanel({ photos, area, index: i, onStep }: PanelProps) {
  const n = photos.length;
  const p = photos[i];

  return (
    <section className="photo-panel" style={{ gridArea: area }} aria-label={area === 'photo' ? 'Photos' : 'More photos'}>
      <img key={p.id} src={photoUrl(p.id)} alt={`Photo ${i + 1} of ${n}`} style={{ objectPosition: focusPos(p) }} />
      {n > 1 && (
        <div className="photo-bar">
          <span className="mono tnum">
            {i + 1} / {n}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="photo-btn" aria-label="Previous photo" onClick={() => onStep(-1)}>
              <i className="ph-duotone ph-caret-left" />
            </button>
            <button className="photo-btn" aria-label="Next photo" onClick={() => onStep(1)}>
              <i className="ph-duotone ph-caret-right" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

interface SettingsProps {
  photos: Photo[];
  onAdd: (files: File[]) => Promise<string>;
  onRemove: (id: string) => void;
  onFocus: (id: string, focus: Photo['focus']) => void;
}

const HINT = 'Shown in two panels on the dashboard. Click a photo to pick the part that stays in frame.';

export function PhotoSettings({ photos, onAdd, onRemove, onFocus }: SettingsProps) {
  const [msg, setMsg] = useState(HINT);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const add = async (files: File[]) => {
    setBusy(true);
    setMsg(files.length > 1 ? `Adding ${files.length} photos…` : 'Adding photo…');
    setMsg(await onAdd(files));
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const pickFocus = (p: Photo, e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const pct = (v: number) => Math.round(Math.min(100, Math.max(0, v * 100)));
    onFocus(p.id, { x: pct((e.clientX - r.left) / r.width), y: pct((e.clientY - r.top) / r.height) });
  };

  return (
    <div className="drawer-section">
      <div className="drawer-label">Photos</div>
      {photos.length > 0 && (
        <div className="photo-grid">
          {photos.map((p, i) => (
            <div key={p.id} className="photo-thumb">
              <button className="photo-pick" title="Click the part to keep in frame" aria-label={`Set the focus point of photo ${i + 1}`} onClick={(e) => pickFocus(p, e)}>
                <img src={photoUrl(p.id)} alt="" />
                <span className="photo-focus" style={{ left: `${p.focus.x}%`, top: `${p.focus.y}%` }} />
              </button>
              <button className="photo-x" aria-label={`Remove photo ${i + 1}`} title="Remove" onClick={() => onRemove(p.id)}>
                <i className="ph-duotone ph-x" />
              </button>
            </div>
          ))}
        </div>
      )}
      <label className={'btn btn-secondary' + (busy ? ' disabled' : '')} style={{ alignSelf: 'flex-start', padding: '7px 12px', gap: 5, fontWeight: 400 }}>
        <i className="ph-duotone ph-image" />
        Add photos
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/gif"
          disabled={busy}
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.length && add([...e.target.files])}
        />
      </label>
      <div style={{ fontSize: 12, color: 'var(--t3)' }}>{msg}</div>
    </div>
  );
}
