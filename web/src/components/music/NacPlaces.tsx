import { useId, useState, type FormEvent } from 'react';
import { ampm, fmtClock, NAC_MAX_PLACES, NAC_NAME_MAX, NAC_SHORT_MAX } from '../../../../shared/nac';
import type { NacLookup, NacStatus } from '../../../../shared/types';
import { api } from '../../api';

const PORTAL = 'https://eservices.nac.gov.sg/Busking';
type Names = { name: string; short: string };

/**
 * Music › Busking slots › Locations: the places it checks, in order. Add one from its link on
 * the NAC portal (the server reads its page once to check it's real), rename, reorder or remove.
 * Changes show straight away; a new location's slots come with the next check.
 */
export function NacPlaces({ s, codes, now, onSaved, onClose }: { s: NacStatus; codes: Record<string, string>; now: Date; onSaved: (s: NacStatus) => void; onClose: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Names>({ name: '', short: '' });
  const [link, setLink] = useState('');
  const [found, setFound] = useState<NacLookup | null>(null);
  const [names, setNames] = useState<Names>({ name: '', short: '' });
  const [busy, setBusy] = useState<'save' | 'lookup' | 'add' | null>(null);
  const [error, setError] = useState('');
  const uid = useId();
  const places = s.watching;
  // A reading cached before there was a most.
  const most = s.max_places ?? NAC_MAX_PLACES;
  const full = places.length >= most;
  const next = s.next_check ? fmtClock(s.next_check, now) : '';

  const run = <T,>(kind: 'save' | 'lookup' | 'add', p: Promise<T>, then: (v: T) => void) => {
    setBusy(kind);
    setError('');
    p.then(then)
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(null));
  };
  const save = (list: typeof places, then: () => void = () => {}) =>
    run('save', api.nacEditPlaces(list.map(({ key, name, short }) => ({ key, name, short }))), (r) => {
      onSaved(r);
      then();
    });

  const move = (i: number, by: number) => {
    const list = [...places];
    const [p] = list.splice(i, 1);
    list.splice(i + by, 0, p);
    save(list);
  };
  const remove = (key: string) => {
    const p = places.find((x) => x.key === key)!;
    if (!confirm(`Stop checking ${p.name}?\n\nIts slots leave the calendar now. To check it again, add it from its NAC link.`)) return;
    save(
      places.filter((x) => x.key !== key),
      () => editing === key && setEditing(null),
    );
  };
  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim()) return setError('Give it a name.');
    // A blank short name is what its placeholder shows: the name, cut to fit.
    const short = draft.short.trim() || draft.name.trim().slice(0, NAC_SHORT_MAX);
    save(
      places.map((p) => (p.key === editing ? { ...p, name: draft.name, short } : p)),
      () => setEditing(null),
    );
  };
  const lookup = (e: FormEvent) => {
    e.preventDefault();
    if (!link.trim()) return;
    run('lookup', api.nacLookup(link), (r) => {
      setFound(r);
      setNames({ name: r.name, short: r.short });
    });
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!found) return;
    if (!names.name.trim()) return setError('Give it a name.');
    run('add', api.nacAddPlace({ id: found.id, name: names.name, short: names.short }), (r) => {
      onSaved(r);
      setFound(null);
      setLink('');
    });
  };
  const cancelAdd = () => {
    setFound(null);
    setError('');
  };

  return (
    <section className="nac-places" aria-label="Locations" onKeyDown={(e) => e.key === 'Escape' && !editing && !found && (e.stopPropagation(), onClose())}>
      <div className="nac-places-head">
        <h3 className="nac-places-title">Locations</h3>
        <span className="meta">
          {places.length} of {most}. Each one adds a request to every check.
        </span>
        <button type="button" className="btn btn-secondary btn-small" onClick={onClose}>
          Done
        </button>
      </div>

      {places.length ? (
        <ol className="nac-place-list">
          {places.map((p, i) =>
            editing === p.key ? (
              <li key={p.key} className="nac-place editing">
                <form className="nac-place-form" onSubmit={rename} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setEditing(null))}>
                  <label className="field">
                    Name
                    <input className="input sm" value={draft.name} maxLength={NAC_NAME_MAX} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
                  </label>
                  <label className="field">
                    Short name, for the calendar and tight rows
                    <input className="input sm" value={draft.short} maxLength={NAC_SHORT_MAX} onChange={(e) => setDraft({ ...draft, short: e.target.value })} placeholder={draft.name.slice(0, NAC_SHORT_MAX)} />
                  </label>
                  <span className="nac-place-btns">
                    <button className="btn btn-primary btn-small" disabled={busy === 'save'}>
                      {busy === 'save' && <i className="ph-duotone ph-circle-notch spin" aria-hidden="true" />}
                      Save
                    </button>
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </span>
                </form>
              </li>
            ) : (
              <li key={p.key} className="nac-place">
                <b className="nac-code" aria-hidden="true">
                  {codes[p.key]}
                </b>
                <span className="nac-place-names">
                  <span className="nac-place-name">{p.name}</span>
                  <span className="meta">
                    {p.short !== p.name && <>{p.short} · </>}
                    {p.nac || 'NAC location'}
                    {!s.locations.some((l) => l.key === p.key) && <> · {next ? `checked from ${next}` : 'not checked yet'}</>}
                  </span>
                </span>
                <span className="nac-place-acts">
                  <a className="icon-btn" href={p.url} target="_blank" rel="noopener noreferrer" title={`${p.name} on the NAC portal`} aria-label={`${p.name} on the NAC portal`}>
                    <i className="ph-duotone ph-arrow-square-out" />
                  </a>
                  <button type="button" className="icon-btn" title="Move up" aria-label={`Move ${p.name} up`} disabled={i === 0 || !!busy} onClick={() => move(i, -1)}>
                    <i className="ph-duotone ph-arrow-up" />
                  </button>
                  <button type="button" className="icon-btn" title="Move down" aria-label={`Move ${p.name} down`} disabled={i === places.length - 1 || !!busy} onClick={() => move(i, 1)}>
                    <i className="ph-duotone ph-arrow-down" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Rename"
                    aria-label={`Rename ${p.name}`}
                    disabled={!!busy}
                    onClick={() => {
                      setDraft({ name: p.name, short: p.short });
                      setEditing(p.key);
                      setError('');
                    }}
                  >
                    <i className="ph-duotone ph-pencil-simple" />
                  </button>
                  <button type="button" className="icon-btn" title="Remove" aria-label={`Remove ${p.name}`} disabled={!!busy} onClick={() => remove(p.key)}>
                    <i className="ph-duotone ph-trash" />
                  </button>
                </span>
              </li>
            ),
          )}
        </ol>
      ) : (
        <p className="meta nac-places-none">No locations on the list, so nothing is checked. Add one below.</p>
      )}

      {full ? (
        <p className="meta">That’s {most}, the most it checks. Remove one to add another.</p>
      ) : found ? (
        <form className="nac-found" onSubmit={add} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), cancelAdd())}>
          <p className="nac-found-what">
            <i className="ph-duotone ph-map-pin" aria-hidden="true" />
            <span>
              <b>{found.nac}</b>
              <span className="meta">
                {' '}
                · open {ampm(found.open)} – {ampm(found.close)}
              </span>
            </span>
          </p>
          {found.watched ? (
            <p className="meta">That’s on the list already, as {found.watched}.</p>
          ) : (
            <div className="nac-place-form">
              <label className="field">
                Name
                <input className="input sm" value={names.name} maxLength={NAC_NAME_MAX} onChange={(e) => setNames({ ...names, name: e.target.value })} autoFocus />
              </label>
              <label className="field">
                Short name, for the calendar and tight rows
                <input className="input sm" value={names.short} maxLength={NAC_SHORT_MAX} onChange={(e) => setNames({ ...names, short: e.target.value })} placeholder={names.name.slice(0, NAC_SHORT_MAX)} />
              </label>
            </div>
          )}
          <span className="nac-place-btns">
            {!found.watched && (
              <button className="btn btn-primary btn-small" disabled={busy === 'add'}>
                {busy === 'add' && <i className="ph-duotone ph-circle-notch spin" aria-hidden="true" />}
                Add
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-small" onClick={cancelAdd}>
              {found.watched ? 'OK' : 'Cancel'}
            </button>
            {!found.watched && <span className="meta">Its slots come with the next check{next ? `, at ${next}` : ''}.</span>}
          </span>
        </form>
      ) : (
        <form className="field nac-add" onSubmit={lookup}>
          {/* Not a <label> round it all, so the input's name isn't "…here Look up". */}
          <span id={`${uid}-add`}>
            Add a location: open it on the{' '}
            <a className="btn-link" href={PORTAL} target="_blank" rel="noopener noreferrer">
              NAC portal
            </a>{' '}
            and paste its address here
          </span>
          <span className="nac-add-row">
            <input
              aria-labelledby={`${uid}-add`}
              className="input sm"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://eservices.nac.gov.sg/Busking/locations/…/events"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn btn-secondary btn-small" disabled={!link.trim() || busy === 'lookup'}>
              <i className={'ph-duotone ' + (busy === 'lookup' ? 'ph-circle-notch spin' : 'ph-magnifying-glass')} aria-hidden="true" />
              Look up
            </button>
          </span>
        </form>
      )}
      {error && (
        <p className="nac-places-error" role="alert">
          <i className="ph-duotone ph-warning" aria-hidden="true" /> {error}
        </p>
      )}
    </section>
  );
}
