import { useRef, useState } from 'react';
import { CARRIERS, detectCarrier, trackUrl } from '../../../shared/carriers';
import { startOfDay } from '../../../shared/dates';
import { DEFAULT_ENGINES } from '../../../shared/defaults';
import type { AccentKey, AppState, Backup, BookmarkGroup, GoogleSource, Note, Package, Photo, Prefs, SearchEngine, ThemeMode } from '../../../shared/types';
import { PhotoSettings } from './Photos';
import { STEP_LABELS, ago, chipOf, fmtStamp, hm, segColor, statusText } from '../util';

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title}>
        <div className="drawer-head">
          <h2 className="drawer-title">{title}</h2>
          <button className="icon-btn md" title="Close" onClick={onClose}>
            <i className="ph-duotone ph-x" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

// ---------- package detail ----------

export function PackageDrawer({ pkg, now, onRename, onArchive }: {
  pkg: Package;
  now: Date;
  onRename: (label: string) => void;
  onArchive: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [label, setLabel] = useState(pkg.label);
  const chip = chipOf(pkg);
  const today = startOfDay(now);

  const copy = () => {
    navigator.clipboard?.writeText(pkg.number).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const dotFor = (i: number) => (i === 0 ? (pkg.exception ? 'var(--wn)' : pkg.stage === 2 ? 'var(--ac)' : 'var(--t2)') : 'var(--ln)');

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
        <label className="field">
          Label
          <input
            className="input"
            style={{ fontSize: 15, fontWeight: 500 }}
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              onRename(e.target.value);
            }}
          />
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--t2)', flexWrap: 'wrap' }}>
          <span>{pkg.carrier}</span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--t3)' }}>
            {pkg.number}
          </span>
          <button className="btn-link" style={{ textDecoration: 'none', color: 'var(--t3)', display: 'grid', placeItems: 'center' }} title="Copy tracking number" onClick={copy}>
            <i className={'ph-duotone ' + (copied ? 'ph-check' : 'ph-copy')} />
          </button>
          <span className={'chip ' + chip.cls} style={{ marginLeft: 'auto' }}>
            {chip.text}
          </span>
        </div>
        <div className="steps">
          {STEP_LABELS.map((l, i) => (
            <div key={l} className="step">
              <span style={{ height: 3, borderRadius: 2, background: segColor(pkg, i) }} />
              <span
                style={{
                  color: i === pkg.stage ? (pkg.exception ? 'var(--wn)' : 'var(--tx)') : i < pkg.stage ? 'var(--t2)' : 'var(--t3)',
                  fontWeight: i === pkg.stage ? 600 : 400,
                }}
              >
                {pkg.exception && i === pkg.stage ? 'Failed attempt' : l}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="drawer-label" style={{ paddingBottom: 10 }}>
          Tracking history
        </div>
        {pkg.timeline.length ? (
          pkg.timeline.map((t, i, a) => (
            <div key={i} className="timeline-item">
              <div className="timeline-rail">
                <span className="timeline-dot" style={{ background: dotFor(i) }} />
                <span className="timeline-line" style={{ background: i < a.length - 1 ? 'var(--ln)' : 'transparent' }} />
              </div>
              <div style={{ paddingBottom: 15 }}>
                <div style={{ fontSize: 14, lineHeight: '20px', color: i === 0 ? 'var(--tx)' : 'var(--t2)', fontWeight: i === 0 ? 500 : 400 }}>{t.event}</div>
                <div className="tnum" style={{ fontSize: 12, color: 'var(--t3)' }}>
                  {fmtStamp(new Date(t.at))}
                  {t.location ? ` · ${t.location}` : ''}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div style={{ fontSize: 13, color: 'var(--t3)' }}>{statusText(pkg, today)}</div>
        )}
        {pkg.lastChecked && (
          <div style={{ fontSize: 12, color: 'var(--t3)', paddingTop: 5 }}>Checked {ago(pkg.lastChecked, now)}</div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <a className="btn btn-primary" href={trackUrl(pkg.carrier, pkg.number)} target="_blank" rel="noopener">
          Track on {pkg.carrier}
          <i className="ph-duotone ph-arrow-up-right" />
        </a>
        <button className="btn btn-secondary" style={{ color: 'var(--t2)', fontWeight: 400 }} onClick={onArchive}>
          <i className="ph-duotone ph-archive" />
          Archive
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>{pkg.source === 'gmail' ? 'Detected from Gmail' : 'Added manually'}</span>
      </div>
    </>
  );
}

// ---------- add package ----------

export function AddPackageDrawer({ onSubmit, onCancel }: {
  onSubmit: (number: string, label: string, carrier: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [num, setNum] = useState('');
  const [label, setLabel] = useState('');
  const [carrier, setCarrier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const det = detectCarrier(num);
  const final = carrier || det;
  const ready = !!num.trim() && !!final && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(num.trim(), label.trim(), final);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const onKey = (e: React.KeyboardEvent) => e.key === 'Enter' && submit();

  const line = !num.trim()
    ? 'Carrier is detected from the number format.'
    : carrier
      ? `Using ${carrier} (manual override).`
      : det
        ? `Looks like a ${det} number.`
        : 'Couldn’t recognise this format. Pick a carrier.';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
      <label className="field">
        Tracking number
        <input className="input mono" style={{ fontSize: 13 }} value={num} autoFocus placeholder="Paste a tracking number" onChange={(e) => setNum(e.target.value)} onKeyDown={onKey} />
      </label>
      <label className="field">
        Label (optional)
        <input className="input" value={label} placeholder="e.g. New keyboard" onChange={(e) => setLabel(e.target.value)} onKeyDown={onKey} />
      </label>
      <label className="field">
        Carrier
        <select className="input" style={{ padding: '0 8px' }} value={carrier} onChange={(e) => setCarrier(e.target.value)}>
          <option value="">{det ? `Auto-detected: ${det}` : 'Auto-detect'}</option>
          {CARRIERS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <div style={{ fontSize: 12, color: num.trim() && !final ? 'var(--wn)' : 'var(--t3)' }}>{line}</div>
      {error && <div style={{ fontSize: 12, color: 'var(--wn)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!ready} onClick={submit}>
          {busy ? 'Tracking…' : 'Track package'}
        </button>
      </div>
    </div>
  );
}

// ---------- settings ----------

const ACCENTS: { key: AccentKey; name: string; light: string; dark: string }[] = [
  { key: 'sage', name: 'Sage', light: '#5a7a5c', dark: '#9cb99a' },
  { key: 'slate', name: 'Slate blue', light: '#4e6a8d', dark: '#a0b5d2' },
  { key: 'terracotta', name: 'Terracotta', light: '#ad603f', dark: '#dd9b7b' },
];

export function SettingsDrawer({ data, now, dark, onPrefs, onConnect, onDisconnect, onImport, onAddPhotos, onRemovePhoto, onPhotoFocus }: {
  data: AppState;
  now: Date;
  dark: boolean;
  onPrefs: (p: Prefs) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onImport: (bookmarks: BookmarkGroup[] | undefined, notes: Note[] | undefined) => void;
  onAddPhotos: (files: File[]) => Promise<string>;
  onRemovePhoto: (id: string) => void;
  onPhotoFocus: (id: string, focus: Photo['focus']) => void;
}) {
  const [importMsg, setImportMsg] = useState('Exports bookmarks and all notepads in one file.');
  const fileRef = useRef<HTMLInputElement>(null);
  const p = data.prefs;
  const g = data.google;
  const [name, setName] = useState(p.name);
  const [tab, setTab] = useState<SettingsTab>('general');

  const sourceRows: { key: GoogleSource; name: string; icon: string }[] = [
    { key: 'calendar', name: 'Google Calendar', icon: 'ph-calendar-blank' },
    { key: 'tasks', name: 'Google Tasks', icon: 'ph-check-square' },
    { key: 'gmail', name: 'Gmail (package detection)', icon: 'ph-envelope-simple' },
  ];

  const exportJson = () => {
    const backup: Backup = { version: 1, exported: new Date().toISOString(), bookmarks: data.bookmarks, notes: data.notes };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'launchpad-backup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const importJson = async (f: File) => {
    try {
      const d = JSON.parse(await f.text()) as Partial<Backup>;
      const okB = Array.isArray(d.bookmarks) && d.bookmarks.every((x) => x && typeof x.name === 'string' && Array.isArray(x.items));
      const okN = Array.isArray(d.notes) && d.notes.length > 0 && d.notes.every((x) => x && typeof x.text === 'string');
      if (!okB && !okN) throw new Error();
      onImport(okB ? d.bookmarks : undefined, okN ? d.notes : undefined);
      setImportMsg(`Imported ${[okB && `${d.bookmarks!.length} groups`, okN && `${d.notes!.length} notepads`].filter(Boolean).join(', ')}.`);
    } catch {
      setImportMsg('That file isn’t a Launchpad backup.');
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const syncLine = (key: GoogleSource) => {
    if (!p.sources[key]) return { text: 'Off', warn: false };
    const s = data.sync[key];
    const verb = key === 'gmail' ? 'Last checked' : 'Last synced';
    if (s.lastError) return { text: `Failing · last synced ${s.lastSuccess ? hm(new Date(s.lastSuccess)) : 'never'}`, warn: true, title: s.lastError };
    return { text: s.lastSuccess ? `${verb} ${hm(new Date(s.lastSuccess))}` : 'Waiting for first sync', warn: false };
  };

  return (
    <>
      <div className="tabs settings-tabs" role="tablist">
        {SETTINGS_TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={'tab' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
            {t.name}
          </button>
        ))}
      </div>
      {tab === 'panels' && <PanelSettings prefs={p} onPrefs={onPrefs} photoCount={data.photos.length} />}
      {tab === 'search' && <SearchSettings prefs={p} onPrefs={onPrefs} />}
      {tab === 'trackers' && <TrackerSettings prefs={p} onPrefs={onPrefs} />}
      {tab === 'photos' && <PhotoSettings photos={data.photos} onAdd={onAddPhotos} onRemove={onRemovePhoto} onFocus={onPhotoFocus} />}
      {tab === 'general' && (
      <>
      <div className="drawer-section">
        <div className="drawer-label">Google account</div>
        {g.connected ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--act)', color: 'var(--acd)', display: 'grid', placeItems: 'center', fontWeight: 600 }}>
                {(g.name || g.email || '?')[0].toUpperCase()}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{g.name || 'Google account'}</span>
                <span style={{ fontSize: 12, color: 'var(--t3)' }}>{g.email}</span>
              </div>
              <button className="btn-link" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t2)' }} onClick={onDisconnect}>
                Disconnect
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {sourceRows.map((r) => {
                const on = p.sources[r.key];
                const l = syncLine(r.key);
                return (
                  <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
                    <i className={'ph-duotone ' + r.icon} style={{ fontSize: 17, color: 'var(--t2)' }} />
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 14 }}>{r.name}</span>
                      <span style={{ fontSize: 12, color: l.warn ? 'var(--wn)' : 'var(--t3)' }} title={'title' in l ? l.title || '' : ''}>
                        {l.text}
                      </span>
                    </div>
                    <button
                      role="switch"
                      aria-checked={on}
                      aria-label={r.name}
                      className={'switch' + (on ? ' on' : '')}
                      onClick={() => onPrefs({ ...p, sources: { ...p.sources, [r.key]: !on } })}
                    >
                      <span />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : g.configured ? (
          <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={onConnect}>
            <i className="ph-duotone ph-google-logo" />
            Connect Google
          </button>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--t2)' }}>
            Google isn’t set up on the server yet. Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code> (see docs/setup.md), then restart.
          </p>
        )}
      </div>

      {g.connected && data.calendars.length > 0 && (
        <div className="drawer-section">
          <div className="drawer-label">Calendars to show</div>
          {data.calendars.map((c) => {
            const on = !p.hiddenCalendars.includes(c.id);
            return (
              <button
                key={c.id}
                onClick={() => onPrefs({ ...p, hiddenCalendars: on ? [...p.hiddenCalendars, c.id] : p.hiddenCalendars.filter((x) => x !== c.id) })}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0', border: 'none', background: 'none', color: 'var(--tx)', cursor: 'pointer', textAlign: 'left' }}
              >
                <span
                  style={{ width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${c.color}`, background: on ? c.color : 'transparent', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11 }}
                >
                  {on && <i className="ph-duotone ph-check" />}
                </span>
                <span style={{ fontSize: 14 }}>{c.name}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="drawer-section">
        <div className="drawer-label">Greeting name</div>
        <input className="input sm" style={{ maxWidth: 240 }} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== p.name && onPrefs({ ...p, name: name.trim() })} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      </div>

      <div className="drawer-section">
        <div className="drawer-label">Theme</div>
        <div className="segmented">
          {(['system', 'light', 'dark'] as ThemeMode[]).map((t) => (
            <button key={t} className={p.theme === t ? 'on' : ''} onClick={() => onPrefs({ ...p, theme: t })}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="drawer-section">
        <div className="drawer-label">Accent</div>
        <div style={{ display: 'flex', gap: 15, flexWrap: 'wrap' }}>
          {ACCENTS.map((a) => (
            <button
              key={a.key}
              onClick={() => onPrefs({ ...p, accent: a.key })}
              style={{ display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'none', padding: 0, fontSize: 13, color: p.accent === a.key ? 'var(--tx)' : 'var(--t2)', cursor: 'pointer' }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  background: dark ? a.dark : a.light,
                  boxShadow: p.accent === a.key ? '0 0 0 2px var(--rz), 0 0 0 3.5px var(--tx)' : 'none',
                }}
              />
              {a.name}
            </button>
          ))}
        </div>
      </div>

      <div className="drawer-section">
        <div className="drawer-label">Weather</div>
        <select
          className="input sm"
          style={{ maxWidth: 240 }}
          aria-label="Weather area"
          value={p.weatherArea}
          onChange={(e) => onPrefs({ ...p, weatherArea: e.target.value })}
        >
          <option value="">Off</option>
          {[...new Set([...data.weather.areas, p.weatherArea].filter(Boolean))].sort().map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <div style={{ fontSize: 12, color: 'var(--t3)' }}>2-hour forecast and nearest temperature from the Meteorological Service Singapore, beside the clock.</div>
      </div>

      <div className="drawer-section">
        <div className="drawer-label">Package tracking</div>
        <div style={{ fontSize: 13, color: 'var(--t2)' }}>
          {data.tracking.allCarriers
            ? 'Live status for SingPost, plus other carriers through 17TRACK.'
            : 'Live status for SingPost. Add a 17TRACK API key on the server to track other carriers too.'}
          {data.sync.carriers.lastSuccess && <span style={{ color: 'var(--t3)' }}> Updated {ago(data.sync.carriers.lastSuccess, now)}.</span>}
        </div>
      </div>

      <div className="drawer-section">
        <div className="drawer-label">Bookmarks and notes</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" style={{ padding: '7px 12px', gap: 5, fontWeight: 400 }} onClick={exportJson}>
            <i className="ph-duotone ph-download-simple" />
            Export JSON
          </button>
          <label className="btn btn-secondary" style={{ padding: '7px 12px', gap: 5, fontWeight: 400 }}>
            <i className="ph-duotone ph-upload-simple" />
            Import JSON
            <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
          </label>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)' }}>{importMsg}</div>
      </div>
      </>
      )}
    </>
  );
}

type SettingsTab = 'general' | 'panels' | 'search' | 'trackers' | 'photos';
const SETTINGS_TABS: { key: SettingsTab; name: string }[] = [
  { key: 'general', name: 'General' },
  { key: 'panels', name: 'Panels' },
  { key: 'search', name: 'Search' },
  { key: 'trackers', name: 'Trackers' },
  { key: 'photos', name: 'Photos' },
];

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={'switch' + (on ? ' on' : '')} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

export const PANEL_ROWS: { section: string; hint?: string; rows: { key: string; name: string; meta?: string }[] }[] = [
  {
    section: 'Home panels',
    rows: [
      { key: 'panel:today', name: 'Today' },
      { key: 'panel:tasks', name: 'Tasks' },
      { key: 'panel:notes', name: 'Notes' },
      { key: 'panel:packages', name: 'Packages' },
      { key: 'panel:photos', name: 'Photos' },
      { key: 'panel:bookmarks', name: 'Bookmarks' },
    ],
  },
  {
    section: 'Top bar',
    rows: [
      { key: 'top:weather', name: 'Weather', meta: 'Beside the clock; pick the area in General' },
      { key: 'top:air', name: 'Air quality, UV and rain', meta: 'The PSI chip and the extras in the weather details' },
      { key: 'top:cig', name: 'Cigarette button', meta: 'Today’s count; C logs one from anywhere' },
      { key: 'top:countdown', name: 'Nearest countdown', meta: 'In the line under the greeting' },
    ],
  },
  {
    section: 'Views',
    hint: 'In the rail on the left',
    rows: [
      { key: 'view:news', name: 'News' },
      { key: 'view:you', name: 'You', meta: 'Countdowns, cigarettes, mood' },
      { key: 'view:server', name: 'Server', meta: 'Health, internet speed, services' },
    ],
  },
];

function PanelSettings({ prefs, onPrefs, photoCount }: { prefs: Prefs; onPrefs: (p: Prefs) => void; photoCount: number }) {
  const set = (key: string, on: boolean) => onPrefs({ ...prefs, hidden: on ? prefs.hidden.filter((h) => h !== key) : [...prefs.hidden, key] });
  return (
    <>
      {PANEL_ROWS.map((s) => (
        <div key={s.section} className="drawer-section" style={{ gap: 0 }}>
          <div className="split" style={{ paddingBottom: 6 }}>
            <span className="drawer-label">{s.section}</span>
            {s.hint && <span className="meta">{s.hint}</span>}
          </div>
          {s.rows.map((r) => {
            const on = !prefs.hidden.includes(r.key);
            const meta = r.key === 'panel:photos' ? (photoCount ? `${photoCount} photo${photoCount > 1 ? 's' : ''}` : 'Add photos in the Photos tab') : r.meta;
            return (
              <div key={r.key} className="setting-row">
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', opacity: on ? 1 : 0.55 }}>
                  <span style={{ fontSize: 14 }}>{r.name}</span>
                  {meta && <span className="meta">{meta}</span>}
                </span>
                <Switch on={on} label={`Show ${r.name}`} onChange={(v) => set(r.key, v)} />
              </div>
            );
          })}
        </div>
      ))}
      <div className="meta">Hidden views stay reachable from ⌘K and with G then a letter.</div>
    </>
  );
}

function SearchSettings({ prefs, onPrefs }: { prefs: Prefs; onPrefs: (p: Prefs) => void }) {
  const [list, setList] = useState<SearchEngine[]>(prefs.searchEngines);
  const [msg, setMsg] = useState('');
  const save = (next: SearchEngine[]) => {
    setList(next);
    const clean = next.filter((e) => e.prefix.trim() && /^https?:\/\//i.test(e.url.trim()));
    const prefixes = clean.map((e) => e.prefix.trim().toLowerCase());
    if (new Set(prefixes).size !== prefixes.length) return setMsg('Each prefix can only be used once.');
    setMsg(clean.length < next.length ? 'Rows without a prefix or an http(s) address aren’t saved.' : '');
    onPrefs({ ...prefs, searchEngines: clean });
  };
  const edit = (i: number, patch: Partial<SearchEngine>) => setList(list.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <>
      <div className="drawer-section">
        <div className="drawer-label">Search engines</div>
        <div className="meta">
          Type a prefix and a space in the search box or ⌘K, like “yt lofi”. Plain searches use the first engine. Put <span className="mono">%s</span> where the search
          words go.
        </div>
        <div className="engines">
          {list.map((e, i) => (
            <div key={i} className="engine-row">
              <input className="input sm mono" aria-label="Prefix" value={e.prefix} onChange={(ev) => edit(i, { prefix: ev.target.value })} onBlur={() => save(list)} style={{ width: 56 }} />
              <input className="input sm" aria-label="Name" value={e.name} onChange={(ev) => edit(i, { name: ev.target.value })} onBlur={() => save(list)} style={{ width: 110 }} />
              <input className="input sm" aria-label="Address" value={e.url} onChange={(ev) => edit(i, { url: ev.target.value })} onBlur={() => save(list)} style={{ flex: 1, minWidth: 0 }} />
              <button className="icon-btn" title={i ? 'Make default' : 'Default'} disabled={!i} onClick={() => save([e, ...list.filter((_, j) => j !== i)])}>
                <i className={'ph-duotone ' + (i ? 'ph-arrow-up' : 'ph-star')} />
              </button>
              <button className="icon-btn" title="Remove" disabled={list.length <= 1} onClick={() => save(list.filter((_, j) => j !== i))}>
                <i className="ph-duotone ph-trash" />
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-small" disabled={list.length >= 12} onClick={() => setList([...list, { prefix: '', name: '', url: 'https://' }])}>
            <i className="ph-duotone ph-plus" />
            Add engine
          </button>
          <button className="btn btn-ghost btn-small" onClick={() => save(DEFAULT_ENGINES)}>
            Reset to defaults
          </button>
        </div>
        {msg && <div className="meta" style={{ color: 'var(--wn)' }}>{msg}</div>}
      </div>
    </>
  );
}

function NumberField({ label, value, min, max, suffix, onSave }: { label: string; value: number; min: number; max: number; suffix?: string; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value || ''));
  const commit = () => {
    const n = Math.min(max, Math.max(min, Math.round(Number(v) || 0)));
    setV(n ? String(n) : '');
    if (n !== value) onSave(n);
  };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t2)' }}>
      <input
        className="input sm tnum"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        aria-label={label}
        placeholder="None"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        style={{ width: 96 }}
      />
      {suffix}
    </label>
  );
}

function TrackerSettings({ prefs, onPrefs }: { prefs: Prefs; onPrefs: (p: Prefs) => void }) {
  return (
    <>
      <div className="drawer-section">
        <div className="drawer-label">Cigarettes</div>
        <NumberField label="Daily limit" value={prefs.cigaretteLimit} min={0} max={99} suffix="a day at most" onSave={(n) => onPrefs({ ...prefs, cigaretteLimit: n })} />
        <div className="meta">Drawn as a line on the chart in You. Leave it empty for no limit.</div>
      </div>
      <div className="drawer-section">
        <div className="drawer-label">Internet speed test</div>
        <div className="segmented">
          {[0, 1, 3, 6, 12, 24].map((h) => (
            <button key={h} className={prefs.speedTestHours === h ? 'on' : ''} onClick={() => onPrefs({ ...prefs, speedTestHours: h })}>
              {h ? `${h} h` : 'Off'}
            </button>
          ))}
        </div>
        <div className="meta">How often the server tests its connection, against Cloudflare. Each test moves about 130 MB.</div>
        <NumberField label="Plan speed" value={prefs.speedPlanMbps} min={0} max={100000} suffix="Mbps plan, shown as a line on the chart" onSave={(n) => onPrefs({ ...prefs, speedPlanMbps: n })} />
      </div>
    </>
  );
}
