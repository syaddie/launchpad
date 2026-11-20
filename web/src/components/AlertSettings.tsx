import { useEffect, useState } from 'react';
import { DEFAULT_PREFS } from '../../../shared/defaults';
import type { AlertKind, AlertRecord, AlertsInfo, Prefs } from '../../../shared/types';
import { api } from '../api';
import { ago } from '../util';

/** The switches shown. */
const KINDS: { key: AlertKind; name: string; meta: string }[] = [
  { key: 'health', name: 'Health warnings', meta: 'The database, daily copies, Drive and syncs, as on the Server view' },
  { key: 'containers', name: 'Containers', meta: 'One that stops, turns unhealthy or keeps restarting' },
  { key: 'disks', name: 'Disks', meta: 'The disk Launchpad’s data is on 90% full, or SMART saying a disk is failing' },
  { key: 'minecraft', name: 'Minecraft', meta: 'A saved server that crashes, and when Launchpad gives up restarting one' },
  { key: 'busking', name: 'Busking slots', meta: 'A slot you’re watching in Music that frees up; tap it to open the location on the NAC portal' },
];

const ICONS: Record<AlertRecord['type'], string> = { problem: 'ph-warning', fixed: 'ph-check-circle', paused: 'ph-bell-slash', event: 'ph-siren', test: 'ph-bell-ringing' };
const TYPES: Record<AlertRecord['type'], string> = { problem: 'Problem', fixed: 'Fixed', paused: 'Paused', event: 'Alert', test: 'Test' };

/** A topic nobody would guess: "launchpad-" and 20 random letters and digits. */
function randomTopic(): string {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `https://ntfy.sh/launchpad-${[...bytes].map((b) => abc[b % abc.length]).join('')}`;
}

/** The topic's name and, when it isn't ntfy.sh, its server, for subscribing in the app. */
function topicParts(url: string): { topic: string; server: string | null } | null {
  try {
    const u = new URL(url);
    const topic = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const base = u.origin + u.pathname.slice(0, u.pathname.lastIndexOf('/'));
    return topic ? { topic, server: u.host === 'ntfy.sh' ? null : base } : null;
  } catch {
    return null;
  }
}

/** Settings › Alerts: where phone alerts go (an ntfy topic) and which kinds are on. */
export function AlertSettings({ prefs, onPrefs, now }: { prefs: Prefs; onPrefs: (p: Prefs) => void; now: Date }) {
  const [info, setInfo] = useState<AlertsInfo | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('');
  const [msg, setMsg] = useState<{ text: string; warn: boolean } | null>(null);
  const [loadError, setLoadError] = useState('');
  const on = { ...DEFAULT_PREFS.alerts, ...prefs.alerts };

  const load = () =>
    api
      .alerts()
      .then((i) => {
        setInfo(i);
        setLoadError('');
        return i;
      })
      .catch((e) => {
        setLoadError(`Couldn’t load the alert settings: ${(e as Error).message}`);
        return null;
      });

  useEffect(() => {
    load().then((i) => i && setUrl(i.topicUrl));
    // What was sent lately, kept up to date while this is open.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const save = async (next: string) => {
    if (!info || next.trim() === info.topicUrl) return;
    setBusy('save');
    setMsg(null);
    try {
      const i = await api.setAlertTopic(next.trim());
      setInfo(i);
      setUrl(i.topicUrl);
      // Turned off: the status line below says so.
      setMsg(i.topicUrl ? { text: 'Saved. Send a test to check it reaches your phone.', warn: false } : null);
    } catch (e) {
      setMsg({ text: (e as Error).message, warn: true });
    } finally {
      setBusy('');
    }
  };

  const suggest = () => {
    if (info?.topicUrl && !confirm('Swap the topic for a new one? Your phone needs to subscribe to the new one, and stops hearing alerts on the old one.')) return;
    const t = randomTopic();
    setUrl(t);
    save(t);
  };

  const test = async () => {
    setBusy('test');
    setMsg(null);
    try {
      setInfo(await api.testAlert());
      setMsg({ text: 'Sent. It should be on your phone in a few seconds.', warn: false });
    } catch (e) {
      setMsg({ text: `Couldn’t send it: ${(e as Error).message}`, warn: true });
      load();
    } finally {
      setBusy('');
    }
  };

  const saved = info?.topicUrl ?? '';
  const parts = saved ? topicParts(saved) : null;
  const dirty = !!info && url.trim() !== saved;
  const last = info?.recent[0];
  const status = !info
    ? null
    : !saved
      ? { text: 'Off until there’s a topic.', warn: false }
      : info.lastError
        ? { text: `Couldn’t send the last one, ${ago(info.lastError.at, now)}: ${info.lastError.message}`, warn: true }
        : last
          ? { text: `Last sent ${ago(last.at, now)}.`, warn: false }
          : { text: 'Nothing sent yet.', warn: false };

  return (
    <>
      <div className="drawer-section">
        <div className="drawer-label">Phone alerts</div>
        <div className="meta">
          Get a push on your phone when something on the server breaks, and another when it’s fixed. It goes through ntfy: install the ntfy app, subscribe to a topic, and put
          the topic’s address here. ntfy.sh is free, or use an ntfy server of your own.
        </div>
        <input
          className="input sm mono"
          aria-label="Topic address"
          placeholder="https://ntfy.sh/your-topic"
          value={url}
          disabled={!info}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => save(url)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-secondary" style={{ padding: '7px 12px', gap: 5, fontWeight: 400 }} disabled={!info || !!busy} onClick={suggest}>
            <i className="ph-duotone ph-shuffle" />
            Suggest a topic
          </button>
          <button className="btn btn-secondary" style={{ padding: '7px 12px', gap: 5, fontWeight: 400 }} disabled={!saved || dirty || !!busy} onClick={test} title={dirty ? 'Save the address first' : undefined}>
            <i className="ph-duotone ph-paper-plane-tilt" />
            {busy === 'test' ? 'Sending…' : 'Send test'}
          </button>
          {busy === 'save' && <span className="meta">Saving…</span>}
        </div>
        {msg && <div className="meta" style={msg.warn ? { color: 'var(--wn)' } : undefined}>{msg.text}</div>}
        {loadError && <div className="meta" style={{ color: 'var(--wn)' }}>{loadError}</div>}
        {parts && (
          <div className="meta">
            In the ntfy app, tap + and subscribe to <b className="mono" style={{ fontWeight: 500, color: 'var(--t2)', overflowWrap: 'anywhere' }}>{parts.topic}</b>
            {parts.server ? <>, with “Use another server” set to <span className="mono" style={{ overflowWrap: 'anywhere' }}>{parts.server}</span></> : null}.{' '}
            <a href={saved} target="_blank" rel="noreferrer">
              Open it in ntfy
            </a>
          </div>
        )}
        <div className="meta">Anyone who knows the topic can read your alerts, so keep it hard to guess. It stays out of backup files and Drive copies.</div>
        {/* A failure just above already says why. */}
        {status && !(status.warn && msg?.warn) && <div style={{ fontSize: 12, color: status.warn ? 'var(--wn)' : 'var(--t2)' }}>{status.text}</div>}
      </div>

      <div className="drawer-section" style={{ gap: 0 }}>
        <div className="split" style={{ paddingBottom: 6 }}>
          <span className="drawer-label">What to alert on</span>
        </div>
        {KINDS.map((k) => (
          <div key={k.key} className="setting-row">
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', opacity: on[k.key] ? 1 : 0.55 }}>
              <span style={{ fontSize: 14 }}>{k.name}</span>
              <span className="meta">{k.meta}</span>
            </span>
            <button role="switch" aria-checked={on[k.key]} aria-label={k.name} className={'switch' + (on[k.key] ? ' on' : '')} onClick={() => onPrefs({ ...prefs, alerts: { ...on, [k.key]: !on[k.key] } })}>
              <span />
            </button>
          </div>
        ))}
        <div className="meta" style={{ paddingTop: 8 }}>
          One alert when a problem starts and one when it clears, once it’s shown up on two checks a minute apart. Something that keeps coming and going is paused after four
          alerts in six hours, and there are never more than 15 in an hour.
        </div>
      </div>

      {!!info?.open.length && (
        <div className="drawer-section">
          <div className="drawer-label">Going on now</div>
          <div className="snap-list">
            {info.open.map((o) => (
              <div key={o.at + o.title} className="snap-row">
                <i className="ph-duotone ph-warning" style={{ fontSize: 16, color: 'var(--wn)' }} />
                <div className="snap-when">
                  <span style={{ overflowWrap: 'anywhere' }}>{o.title}</span>
                  <span className="snap-meta">Since {ago(o.at, now)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!!info?.recent.length && (
        <div className="drawer-section">
          <div className="drawer-label">Sent lately</div>
          <div className="snap-list">
            {info.recent.map((r, i) => (
              <div key={r.at + i} className="snap-row">
                <i className={'ph-duotone ' + ICONS[r.type]} style={{ fontSize: 16, color: r.type === 'problem' || r.type === 'event' ? 'var(--wn)' : 'var(--t2)' }} />
                <div className="snap-when">
                  <span style={{ overflowWrap: 'anywhere' }}>{r.title}</span>
                  <span className="snap-meta">
                    {TYPES[r.type]} · {ago(r.at, now)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
