import { useMemo, useRef, useState } from 'react';
import { localGet, localSet } from '../api';
import { MC_ALL_COMMANDS } from '../mcAllCommands';
import { MC_COMMANDS, MC_GROUPS, fillFor, filterCommands, parsePins, togglePin } from '../mcCommands';

type Tab = 'short' | 'all';

interface RowProps {
  usage: string;
  note?: string;
  disabled: boolean;
  onFill: (usage: string) => void;
  /** Without it the row has no pin button. */
  pinned?: boolean;
  onPin?: () => void;
}

function Row({ usage, note, disabled, onFill, pinned, onPin }: RowProps) {
  return (
    <div className="mc-sheet-item">
      <button className="mc-sheet-row" disabled={disabled} onClick={() => onFill(usage)} title={`Put "${fillFor(usage).trim()}" in the command box`}>
        <span className="mono mc-sheet-cmd">{usage}</span>
        {note && <span className="meta">{note}</span>}
      </button>
      {onPin && (
        <button
          className={'icon-btn mc-pin' + (pinned ? ' on' : '')}
          aria-pressed={pinned}
          aria-label={`${pinned ? 'Take' : 'Add'} ${fillFor(usage).trim()} ${pinned ? 'off' : 'to'} the short list`}
          title={pinned ? 'On the short list. Click to remove' : 'Add to the short list'}
          onClick={onPin}
        >
          <i className="ph-duotone ph-push-pin" />
        </button>
      )}
    </div>
  );
}

/** The console's command cheatsheet: a short list you can add to, and every command the server has. */
export function McCommandSheet({ canType, onFill }: { canType: boolean; onFill: (usage: string) => void }) {
  const [tab, setTab] = useState<Tab>(() => (localGet('mcSheetTab') === 'all' ? 'all' : 'short'));
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [pins, setPins] = useState(() => parsePins(localGet('mcPins'), MC_ALL_COMMANDS));
  const search = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);

  const pick = (t: Tab) => {
    setTab(t);
    localSet('mcSheetTab', t);
    if (t === 'all') window.setTimeout(() => search.current?.focus(), 0);
  };
  const pin = (usage: string) => {
    const next = togglePin(pins, usage);
    setPins(next);
    localSet('mcPins', JSON.stringify(next));
  };

  const pinned = useMemo(() => pins.flatMap((u) => MC_ALL_COMMANDS.find((c) => c.usage === u) ?? []), [pins]);
  const shown = useMemo(() => filterCommands(MC_ALL_COMMANDS, query, group), [query, group]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of filterCommands(MC_ALL_COMMANDS, query, null)) m.set(c.group, (m.get(c.group) ?? 0) + 1);
    return m;
  }, [query]);
  const matching = [...counts.values()].reduce((a, b) => a + b, 0);

  /** Arrow keys walk the rows; up from the first goes back to the search box. */
  const walk = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(body.current?.querySelectorAll<HTMLButtonElement>('.mc-sheet-row:not(:disabled)') ?? [])];
    const at = rows.indexOf(e.target as HTMLButtonElement);
    if (e.target === search.current) {
      if (e.key === 'ArrowDown' && rows.length) (e.preventDefault(), rows[0].focus());
    } else if (at >= 0) {
      e.preventDefault();
      if (e.key === 'ArrowUp' && at === 0) search.current?.focus();
      else rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
    }
  };

  return (
    <div id="mc-sheet" className={'mc-sheet' + (tab === 'all' ? ' all' : '')} role="region" aria-label="Command cheatsheet" onKeyDown={walk}>
      <div className="mc-sheet-bar">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'short'} className={'tab' + (tab === 'short' ? ' active' : '')} onClick={() => pick('short')}>
            Short list
          </button>
          <button role="tab" aria-selected={tab === 'all'} className={'tab' + (tab === 'all' ? ' active' : '')} onClick={() => pick('all')}>
            All commands · {MC_ALL_COMMANDS.length}
          </button>
        </div>
        {tab === 'all' && (
          <input
            ref={search}
            className="input sm mc-sheet-search"
            type="search"
            value={query}
            placeholder="Find a command, or a mod’s"
            aria-label="Find a command"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), setQuery(''))}
          />
        )}
      </div>
      {tab === 'all' && (
        <div className="mc-sheet-groups" role="group" aria-label="Show only">
          <button className={'chip mc-chip ' + (group === null ? 'chip-accent' : 'chip-neutral')} aria-pressed={group === null} onClick={() => setGroup(null)}>
            All · {matching}
          </button>
          {MC_GROUPS.map((g) => (
            <button key={g} className={'chip mc-chip ' + (group === g ? 'chip-accent' : 'chip-neutral')} aria-pressed={group === g} onClick={() => setGroup(group === g ? null : g)}>
              {g} · {counts.get(g) ?? 0}
            </button>
          ))}
        </div>
      )}
      <p className="meta mc-sheet-hint">
        {!canType
          ? 'Commands can only be sent while the server is running in tmux or screen. You can still look around and pin.'
          : tab === 'all'
            ? group === 'Mods'
              ? 'These come from All the Mods 10. A vanilla server doesn’t have them. Click one to put it in the box, then fill in the <parts>.'
              : 'Click a command to put it in the box. Fill in the <parts>, then Send. Pin the ones you use to keep them on the short list.'
            : 'Click a command to put it in the box. Fill in the <parts>, then Send.'}
      </p>
      <div className="mc-sheet-scroll" ref={body}>
        {tab === 'short' ? (
          <>
            <div className="mc-sheet-group">
              <span className="drawer-label">Yours</span>
              {pinned.length ? (
                pinned.map((c) => <Row key={c.usage} usage={c.usage} note={c.desc ?? c.mod} disabled={!canType} onFill={onFill} pinned onPin={() => pin(c.usage)} />)
              ) : (
                <span className="meta mc-sheet-empty">
                  Nothing yet. Open <button className="mc-link" onClick={() => pick('all')}>All commands</button> and pin the ones you want here.
                </span>
              )}
            </div>
            {MC_COMMANDS.map((g) => (
              <div key={g.title} className="mc-sheet-group">
                <span className="drawer-label">{g.title}</span>
                {g.commands.map((c) => (
                  <Row key={c.usage} usage={c.usage} note={c.desc} disabled={!canType} onFill={onFill} />
                ))}
              </div>
            ))}
          </>
        ) : !shown.length ? (
          <span className="meta mc-sheet-empty">Nothing matches “{query}”{group ? ` in ${group}` : ''}.</span>
        ) : (
          MC_GROUPS.map((g) => {
            const rows = shown.filter((c) => c.group === g);
            return (
              rows.length > 0 && (
                <div key={g} className="mc-sheet-group">
                  <span className="drawer-label mc-sheet-label">
                    {g} · {rows.length}
                  </span>
                  {rows.map((c) => (
                    <Row
                      key={c.usage}
                      usage={c.usage}
                      note={[c.desc ?? c.mod, c.also?.length ? `also /${c.also.join(', /')}` : ''].filter(Boolean).join(' · ')}
                      disabled={!canType}
                      onFill={onFill}
                      pinned={pins.includes(c.usage)}
                      onPin={() => pin(c.usage)}
                    />
                  ))}
                </div>
              )
            );
          })
        )}
      </div>
    </div>
  );
}
