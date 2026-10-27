import { useState } from 'react';
import { startOfDay } from '../../../shared/dates';
import type { Package } from '../../../shared/types';
import { chipOf, segColor, statusText } from '../util';

interface Props {
  packages: Package[];
  now: Date;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onKeep: (id: string) => void;
  onDismiss: (id: string) => void;
}

export function Packages({ packages, now, onOpen, onAdd, onKeep, onDismiss }: Props) {
  const [deliveredOpen, setDeliveredOpen] = useState(false);
  const today = startOfDay(now);
  const active = packages.filter((p) => p.stage < 3);
  const delivered = packages.filter((p) => p.stage === 3);

  return (
    <section className="panel" style={{ gridArea: 'pkgs' }} aria-label="Packages">
      <div className="panel-head">
        <h2 className="panel-title">Packages</h2>
        <button className="btn btn-ghost btn-small" onClick={onAdd}>
          <i className="ph-duotone ph-plus" />
          Add package
        </button>
      </div>
      <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {active.map((p) => {
          const chip = chipOf(p);
          return (
            <div key={p.id} className="pkg" onClick={() => onOpen(p.id)}>
              <div className="pkg-top">
                <span className="pkg-label">{p.label}</span>
                <span className={'chip ' + chip.cls}>{chip.text}</span>
              </div>
              <div className="pkg-status" style={{ color: p.exception ? 'var(--wn)' : p.stage === 2 ? 'var(--acd)' : 'var(--t2)' }}>
                {statusText(p, today)}
              </div>
              <div className="segs">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className="seg" style={{ background: segColor(p, i) }} />
                ))}
              </div>
              <div className="pkg-meta">
                <span style={{ whiteSpace: 'nowrap' }}>{p.carrier}</span>
                <span className="mono pkg-num">{p.number}</span>
                <span className="src-tag">
                  <i className={'ph-duotone ' + (p.source === 'gmail' ? 'ph-envelope-simple' : 'ph-hand-pointing')} />
                  {p.source === 'gmail' ? 'from Gmail' : 'Added manually'}
                </span>
              </div>
              {p.isNew && (
                <div className="pkg-new">
                  <span style={{ flex: 1 }}>New from Gmail. Keep tracking?</span>
                  <button
                    className="keep"
                    onClick={(e) => {
                      e.stopPropagation();
                      onKeep(p.id);
                    }}
                  >
                    Keep
                  </button>
                  <button
                    className="dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismiss(p.id);
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {!packages.length && (
          <div className="empty">
            <p>No packages on the way. Paste a tracking number to follow one.</p>
            <button className="btn btn-secondary" onClick={onAdd}>
              Add package
            </button>
          </div>
        )}
        {delivered.length > 0 && (
          <>
            <button className="section-toggle" style={{ cursor: 'pointer' }} onClick={() => setDeliveredOpen(!deliveredOpen)}>
              <span className="label">Delivered</span>
              <span>{delivered.length}</span>
              <i className={'ph-duotone ' + (deliveredOpen ? 'ph-caret-up' : 'ph-caret-down')} style={{ fontSize: 12 }} />
              <span style={{ marginLeft: 'auto' }}>Archived after 3 days</span>
            </button>
            {deliveredOpen &&
              delivered.map((p) => (
                <div key={p.id} className="delivered-row" onClick={() => onOpen(p.id)}>
                  <span style={{ minWidth: 0 }}>{p.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{statusText(p, today)}</span>
                </div>
              ))}
          </>
        )}
      </div>
    </section>
  );
}
