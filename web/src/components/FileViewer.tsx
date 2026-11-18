import { useEffect, useRef, useState } from 'react';
import { previewOf } from '../../../shared/files';
import { downloadUrl } from '../api';
import { previewUrl } from '../filesApi';

const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/';
const nameOf = (p: string) => p.split('/').pop() || p;

/**
 * An image, audio or video file from the server, shown in the panel. The arrows
 * (on screen or the keyboard) step through the folder's other previewable files.
 */
export function FileViewer({ path, siblings, hidden, onStep, onClose }: {
  path: string;
  /** Previewable files in the same folder, in the listing's order. */
  siblings: string[];
  hidden: boolean;
  onStep: (path: string) => void;
  onClose: () => void;
}) {
  const kind = previewOf(nameOf(path))?.kind;
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const at = siblings.indexOf(path);
  const prev = at > 0 ? siblings[at - 1] : null;
  const next = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : null;

  useEffect(() => {
    setFailed(false);
    setZoom(false);
  }, [path]);

  useEffect(() => {
    if (hidden) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      // Typing somewhere else, or a player's own keys.
      if (t && (t.closest('input, textarea, [contenteditable]') || ((t.tagName === 'VIDEO' || t.tagName === 'AUDIO') && e.key !== 'Escape'))) return;
      if (t && !ref.current?.contains(t) && t !== document.body) return;
      if (e.key === 'Escape') {
        // Esc would leave the view; here it closes the viewer.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowLeft' && prev) onStep(prev);
      else if (e.key === 'ArrowRight' && next) onStep(next);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [hidden, prev, next, onStep, onClose]);

  const src = previewUrl(path);
  const cant = (
    <div className="empty">
      <p>Your browser can’t show this one. Download it to open it on your device.</p>
      <a className="btn btn-secondary btn-small" href={downloadUrl(path)}>
        <i className="ph-duotone ph-download-simple" /> Download
      </a>
    </div>
  );

  return (
    <section ref={ref} className="panel srv-panel files-panel" aria-label={`Preview of ${nameOf(path)}`} style={hidden ? { display: 'none' } : undefined} tabIndex={-1}>
      <div className="panel-head files-head">
        <h2 className="panel-title mono files-title" title={path}>
          {nameOf(path)}
        </h2>
        <div className="files-tools">
          <span className="meta mono files-path">{parentOf(path)}</span>
          {siblings.length > 1 && at >= 0 && (
            <>
              <button className="icon-btn" title="Previous (←)" aria-label="Previous" disabled={!prev} onClick={() => prev && onStep(prev)}>
                <i className="ph-duotone ph-caret-left" />
              </button>
              <span className="meta tnum">
                {at + 1} / {siblings.length}
              </span>
              <button className="icon-btn" title="Next (→)" aria-label="Next" disabled={!next} onClick={() => next && onStep(next)}>
                <i className="ph-duotone ph-caret-right" />
              </button>
            </>
          )}
          <a className="icon-btn" href={downloadUrl(path)} title="Download" aria-label="Download">
            <i className="ph-duotone ph-download-simple" />
          </a>
          <button className="btn btn-secondary btn-small" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className={'files-viewer' + (kind === 'image' && zoom ? ' zoomed' : '') + (kind === 'audio' ? ' audio' : '')}>
        {failed ? (
          cant
        ) : kind === 'image' ? (
          <img
            key={path}
            src={src}
            alt={nameOf(path)}
            title={zoom ? 'Fit to the panel' : 'Actual size'}
            onClick={() => setZoom(!zoom)}
            onError={() => setFailed(true)}
          />
        ) : kind === 'video' ? (
          <video key={path} src={src} controls playsInline preload="metadata" onError={() => setFailed(true)} />
        ) : kind === 'audio' ? (
          <>
            <i className="ph-duotone ph-music-notes files-viewer-icon" />
            <audio key={path} src={src} controls preload="metadata" onError={() => setFailed(true)} />
          </>
        ) : (
          cant
        )}
      </div>
    </section>
  );
}
