import { useState } from 'react';
import { startOfDay } from '../../../shared/dates';
import type { Package } from '../../../shared/types';
import { trackUrl } from '../../../shared/carriers';
import { chipOf, segColor, statusText } from '../util';
import { copyText, menuProps, type MenuItem } from './ContextMenu';

export interface PackageMenuActions {
  onOpen: (id: string) => void;
  onKeep: (id: string) => void;
  onDismiss: (id: string) => void;
  onRefresh?: (id: string) => void;
  notify?: (msg: string) => void;
}

/** Right-click on a package, here and in Horizon's cards. Archive can't be undone, so it asks. */
export function packageMenu(p: Package, a: PackageMenuActions): MenuItem[] {
  return [
    { label: 'Details…', icon: 'ph-info', onSelect: () => a.onOpen(p.id) },
    { label: `Track on ${p.carrier || 'the carrier’s site'}`, icon: 'ph-arrow-square-out', href: trackUrl(p.carrier, p.number), newTab: true },
    { label: 'Copy tracking number', icon: 'ph-copy', onSelect: () => copyText(p.number, a.notify, 'Tracking number copied') },
    a.onRefresh && p.stage < 3 && { label: 'Check for updates', icon: 'ph-arrows-clockwise', onSelect: () => a.onRefresh!(p.id) },
    'sep',
    p.isNew && { label: 'Keep tracking', icon: 'ph-check', onSelect: () => a.onKeep(p.id) },
    { label: p.isNew ? 'Dismiss' : 'Archive', icon: 'ph-archive', danger: true, confirm: `${p.isNew ? 'Dismiss' : 'Archive'} “${p.label}”? It leaves the list for good.`, onSelect: () => a.onDismiss(p.id) },
  ];
}

interface Props extends PackageMenuActions {
  packages: Package[];
  now: Date;
  onAdd: () => void;
}

export function Packages({ packages, now, onAdd, ...actions }: Props) {
  const { onOpen, onKeep, onDismiss } = actions;
  const menu = (p: Package) => menuProps(() => packageMenu(p, actions), p.label);
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
      {active.length > 0 && (
        <div className="big-count" aria-hidden="true">
          <b>{active.filter((p) => p.stage === 2).length || active.length}</b>
          <span>{active.some((p) => p.stage === 2) ? 'out for delivery' : 'on the way'}{active.some((p) => p.exception) && <em>{active.filter((p) => p.exception).length} need a look</em>}</span>
        </div>
      )}
      <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {active.map((p) => {
          const chip = chipOf(p);
          return (
            <div key={p.id} className="pkg" onClick={() => onOpen(p.id)} {...menu(p)}>
              <div className="pkg-top">
                <span className="pkg-label">{p.label}</span>
                <span className={'chip ' + chip.cls}>{chip.text}</span>
              </div>
              <div className="pkg-status" style={{ color: p.exception ? 'var(--wn)' : p.stage === 2 ? 'var(--acd)' : 'var(--t2)' }}>
                {statusText(p, today)}
              </div>
              <div className="segs">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className="pkg-seg" style={{ background: segColor(p, i) }} />
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
                <div key={p.id} className="delivered-row" onClick={() => onOpen(p.id)} {...menu(p)}>
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
