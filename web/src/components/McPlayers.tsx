import { useCallback, useEffect, useRef, useState } from 'react';
import type { McPlayer, McPlayerAction, McPlayers, McStatus } from '../../../shared/types';
import { api } from '../api';

const EVERY = 15_000;
const NAME = /^[.*]?[A-Za-z0-9_]{1,16}$/;

/** A player's face, from a public skin service, by id when it's known and by name otherwise. */
export const headUrl = (p: { name: string; uuid: string | null }) => `https://mc-heads.net/avatar/${encodeURIComponent(p.uuid ? p.uuid.replace(/-/g, '') : p.name)}/32`;

function Head({ p }: { p: { name: string; uuid: string | null } }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="mc-head mc-head-none" aria-hidden>
        {p.name.replace(/^[.*]/, '').slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return <img className="mc-head" src={headUrl(p)} alt="" width={28} height={28} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

/** The Minecraft console's Players: who's on, with kick, op, whitelist and teleport, and the whitelist itself. */
export function McPlayersView({ s, onNote }: { s: McStatus; onNote: (text: string, failed: boolean) => void }) {
  const [data, setData] = useState<McPlayers | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tpFor, setTpFor] = useState<string | null>(null);
  const [tpWho, setTpWho] = useState('');
  const [add, setAdd] = useState('');
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const load = useCallback(
    (fresh = false) => {
      setLoading(true);
      api
        .mcPlayers(s.id, fresh)
        .then((d) => {
          if (!alive.current) return;
          setData(d);
          setError('');
        })
        .catch((e: Error) => alive.current && setError(e.message))
        .finally(() => alive.current && setLoading(false));
    },
    [s.id],
  );

  useEffect(() => {
    load(true);
    const iv = window.setInterval(() => document.visibilityState === 'visible' && load(), EVERY);
    return () => clearInterval(iv);
  }, [load, s.running]);

  const canType = s.running && s.attached;
  const act = (action: McPlayerAction, name: string, done: string, to?: string) => {
    setBusy(`${action}:${name}`);
    api
      .mcPlayerAction(s.id, action, name, to)
      .then(() => {
        onNote(done, false);
        setTpFor(null);
        // ops.json and whitelist.json change a moment after the command.
        window.setTimeout(() => alive.current && load(true), 1200);
      })
      .catch((e: Error) => onNote(e.message, true))
      .finally(() => alive.current && setBusy(null));
  };

  const kick = (p: McPlayer) => {
    if (!window.confirm(`Kick ${p.name} from ${s.name}? They can join again straight away.`)) return;
    act('kick', p.name, `Kicked ${p.name}.`);
  };

  const addToList = () => {
    const name = add.trim();
    if (!NAME.test(name)) return onNote('A player’s name is 1–16 letters, numbers and underscores.', true);
    act('whitelist-add', name, `Added ${name} to the whitelist.`);
    setAdd('');
  };

  const players = data?.players ?? [];
  const head = !data
    ? ''
    : !data.running
      ? `${s.name} is stopped, so no one’s online.`
      : data.online === null
        ? 'Couldn’t count the players.'
        : `${data.online} of ${data.max ?? '?'} online${data.version ? ` · ${data.version}` : ''}`;

  return (
    <div className="mc-view" aria-label="Players">
      <div className="mc-view-head">
        <span className="meta">{head}</span>
        <button className="icon-btn" title="Look again" aria-label="Look for players again" disabled={loading} onClick={() => load(true)}>
          <i className={'ph-duotone ' + (loading ? 'ph-circle-notch spin' : 'ph-arrow-clockwise')} />
        </button>
      </div>
      {error && <div className="status-line" style={{ margin: 0 }}>{error}</div>}
      {!data && !error && <p className="meta">Looking for players…</p>}
      {data?.note && <p className="meta mc-note">{data.note}</p>}
      {data?.running && !s.attached && <p className="meta mc-note">{s.name} isn’t running in tmux or screen, so the buttons can’t type into its console.</p>}
      {data?.running && !players.length && data.online === 0 && <p className="meta">No one’s online.</p>}
      {players.length > 0 && (
        <ul className="mc-players" aria-label="Online">
          {players.map((p) => {
            const others = players.filter((o) => o.name !== p.name);
            const is = (a: McPlayerAction) => busy === `${a}:${p.name}`;
            return (
              <li key={p.name} className="mc-player">
                <div className="mc-player-who">
                  <Head p={p} />
                  <span className="mc-player-name">{p.name}</span>
                  {p.op && <span className="chip chip-accent">Op</span>}
                  {data?.whitelistOn && p.whitelisted && <span className="chip chip-neutral">Whitelisted</span>}
                </div>
                <div className="mc-player-tools">
                  <button className="btn btn-secondary btn-small" disabled={!canType || !others.length || !!busy} aria-expanded={tpFor === p.name} title={others.length ? `Bring someone to ${p.name}` : 'No one else is online to teleport'} onClick={() => (setTpFor(tpFor === p.name ? null : p.name), setTpWho(others[0]?.name ?? ''))}>
                    <i className="ph-duotone ph-arrow-bend-down-right" />
                    Teleport here
                  </button>
                  <button className="btn btn-secondary btn-small" disabled={!canType || !!busy} onClick={() => act(p.op ? 'deop' : 'op', p.name, p.op ? `${p.name} is no longer an operator.` : `${p.name} is an operator now.`)}>
                    <i className={'ph-duotone ' + (is('op') || is('deop') ? 'ph-circle-notch spin' : p.op ? 'ph-shield-slash' : 'ph-shield-check')} />
                    {p.op ? 'De-op' : 'Op'}
                  </button>
                  <button
                    className="btn btn-secondary btn-small"
                    disabled={!canType || !!busy}
                    onClick={() => act(p.whitelisted ? 'whitelist-remove' : 'whitelist-add', p.name, p.whitelisted ? `Took ${p.name} off the whitelist.` : `Added ${p.name} to the whitelist.`)}
                  >
                    <i className={'ph-duotone ' + (p.whitelisted ? 'ph-user-minus' : 'ph-user-plus')} />
                    {p.whitelisted ? 'Unwhitelist' : 'Whitelist'}
                  </button>
                  <button className="btn btn-secondary btn-small" disabled={!canType || !!busy} onClick={() => kick(p)}>
                    <i className={'ph-duotone ' + (is('kick') ? 'ph-circle-notch spin' : 'ph-sign-out')} />
                    Kick
                  </button>
                </div>
                {tpFor === p.name && others.length > 0 && (
                  <form
                    className="mc-tp"
                    onSubmit={(e) => {
                      e.preventDefault();
                      act('tp', p.name, `Teleported ${tpWho} to ${p.name}.`, tpWho);
                    }}
                  >
                    <span className="meta">Bring</span>
                    <select className="input sm" value={tpWho} onChange={(e) => setTpWho(e.target.value)} aria-label={`Who to teleport to ${p.name}`}>
                      {others.map((o) => (
                        <option key={o.name} value={o.name}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                    <span className="meta">to {p.name}</span>
                    <button className="btn btn-primary btn-small" disabled={!tpWho || !!busy}>
                      Teleport
                    </button>
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => setTpFor(null)}>
                      Cancel
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {data && (
        <section className="mc-section" aria-label="Whitelist">
          <div className="mc-view-head">
            <span className="drawer-label">Whitelist · {data.whitelist.length}</span>
            <span className={'chip ' + (data.whitelistOn ? 'chip-accent' : 'chip-muted')} title="white-list in server.properties">
              {data.whitelistOn ? 'On' : 'Off'}
            </span>
          </div>
          {!data.whitelistOn && <p className="meta mc-note">The whitelist is off, so anyone can join. Turn it on with the command whitelist on.</p>}
          {!data.whitelist.length ? (
            <p className="meta">No one is on the whitelist.</p>
          ) : (
            <ul className="mc-wl">
              {data.whitelist.map((p) => (
                <li key={p.name} className="mc-wl-row">
                  <Head p={p} />
                  <span className="mc-player-name">{p.name}</span>
                  <button className="icon-btn" disabled={!canType || !!busy} title={canType ? `Take ${p.name} off the whitelist` : 'Start the server to change the whitelist'} aria-label={`Take ${p.name} off the whitelist`} onClick={() => act('whitelist-remove', p.name, `Took ${p.name} off the whitelist.`)}>
                    <i className={'ph-duotone ' + (busy === `whitelist-remove:${p.name}` ? 'ph-circle-notch spin' : 'ph-x')} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mc-wl-add"
            onSubmit={(e) => {
              e.preventDefault();
              addToList();
            }}
          >
            <input className="input sm mono" value={add} maxLength={17} onChange={(e) => setAdd(e.target.value)} placeholder={canType ? 'A player’s name' : 'Start the server to change the whitelist'} disabled={!canType} aria-label="Add a player to the whitelist" autoComplete="off" spellCheck={false} />
            <button className="btn btn-secondary btn-small" disabled={!canType || !add.trim() || !!busy}>
              <i className="ph-duotone ph-user-plus" />
              Add
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
