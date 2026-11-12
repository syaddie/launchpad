import { useEffect, useState } from 'react';
import { fmtTokens, fmtUsd, type UsageReport } from '../../../shared/claudeUsage';
import { monthName } from '../../../shared/money';
import { parseYmd } from '../../../shared/dates';
import type { AppState } from '../../../shared/types';
import { api } from '../api';
import { fmtDay, niceMax } from '../util';

/**
 * Server › Claude usage: what each feature's Claude calls used this month and last month,
 * the cost estimated from list prices, and the last 30 days day by day. Reloads whenever
 * the page hears that this month's spend changed.
 */
export function ClaudeUsagePanel({ data, onOpenSettings }: { data: AppState; onOpenSettings: () => void }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [which, setWhich] = useState<0 | 1>(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    api
      .claudeUsage()
      .then((r) => {
        setReport(r);
        setError('');
      })
      .catch((e) => setError(e.message));
  }, [data.claudeSpend, data.prefs.claudeBudget]);

  const head = (
    <div className="panel-head" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <h2 className="panel-title">Claude usage</h2>
      {report && (
        <div className="tabs">
          {report.months.map((m, i) => (
            <button key={m.key} className={'tab' + (i === which ? ' active' : '')} aria-pressed={i === which} onClick={() => setWhich(i as 0 | 1)}>
              {i === 0 ? 'This month' : monthName(m.key)}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (!report) {
    return (
      <section className="panel srv-panel cu" aria-label="Claude usage">
        {head}
        <div className="empty">
          <p>{error ? `Couldn’t load the usage: ${error}` : 'Adding up Claude’s usage…'}</p>
        </div>
      </section>
    );
  }

  const [now, last] = report.months;
  const month = report.months[which];
  const budget = report.budget;
  const over = budget > 0 && now.total.cost > budget;
  const top = niceMax(Math.max(...report.days.map((d) => d.cost)));
  const shown = hover === null ? null : report.days[hover];
  const nothing = !report.days.some((d) => d.calls) && !now.total.calls && !last.total.calls;

  return (
    <section className="panel srv-panel cu" aria-label="Claude usage">
      {head}
      <div className="speed-stats">
        <div className="speed-stat">
          <span className="meta">This month</span>
          <span className="serif tnum">{fmtUsd(now.total.cost)}</span>
        </div>
        <div className="speed-stat">
          <span className="meta">{monthName(last.key)}</span>
          <span className="serif tnum">{fmtUsd(last.total.cost)}</span>
        </div>
        <div className="speed-stat">
          <span className="meta">Calls this month</span>
          <span className="serif tnum">{now.total.calls}</span>
        </div>
        <span className="meta" style={{ marginLeft: 'auto', alignSelf: 'flex-end' }}>
          {budget > 0 ? `Budget ${fmtUsd(budget)} a month` : (
            <button className="btn-link" style={{ color: 'var(--t3)' }} onClick={onOpenSettings}>Set a monthly budget</button>
          )}
        </span>
      </div>
      {over && (
        <div className="status-line" style={{ margin: 0 }}>
          <i className="ph-duotone ph-warning" aria-hidden="true" />
          Over budget: {fmtUsd(now.total.cost)} so far this month, against {fmtUsd(budget)}.
        </div>
      )}
      {!report.enabled && <div className="meta">No Anthropic API key on the server, so nothing new is being used.</div>}

      {nothing ? (
        <div className="empty">
          <p>No Claude calls yet. Each summary, note, briefing and ⌘K question is counted here once it runs.</p>
        </div>
      ) : (
        <>
          <div className="cu-chart">
            <div className="cu-readout meta tnum">
              {shown ? `${fmtDay(parseYmd(shown.date))} · ${fmtUsd(shown.cost)} · ${shown.calls} call${shown.calls === 1 ? '' : 's'}` : `Last 30 days · up to ${fmtUsd(top)} a day`}
            </div>
            <div className="cu-bars" role="img" aria-label={`Estimated cost a day, last 30 days, oldest first: ${report.days.map((d) => fmtUsd(d.cost)).join(', ')}`} onMouseLeave={() => setHover(null)}>
              {report.days.map((d, i) => (
                <span key={d.date} className={'cu-col' + (i === hover ? ' on' : '')} onMouseEnter={() => setHover(i)}>
                  <span className="cu-bar" style={{ height: `${(d.cost / top) * 100}%` }} />
                </span>
              ))}
            </div>
            <div className="axis tnum">
              <span>{fmtDay(parseYmd(report.days[0].date))}</span>
              <span>Today</span>
            </div>
          </div>

          {month.features.length ? (
            <table className="sheet cu-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th className="r">Calls</th>
                  <th className="r">In</th>
                  <th className="r">Out</th>
                  <th className="r" title="Read from and written to the prompt cache">Cache</th>
                  <th className="r">Cost</th>
                </tr>
              </thead>
              <tbody>
                {month.features.map((f) => (
                  <tr key={f.feature} title={f.models.join(', ')}>
                    <td className="cu-name">{f.name}</td>
                    <td className="r tnum">{f.calls}</td>
                    <td className="r tnum">{fmtTokens(f.input)}</td>
                    <td className="r tnum">{fmtTokens(f.output)}</td>
                    <td className="r tnum">{fmtTokens(f.cacheRead + f.cacheWrite)}</td>
                    <td className="r tnum">{fmtUsd(f.cost)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <td className="r tnum">{month.total.calls}</td>
                  <td className="r tnum">{fmtTokens(month.total.input)}</td>
                  <td className="r tnum">{fmtTokens(month.total.output)}</td>
                  <td className="r tnum">{fmtTokens(month.total.cacheRead + month.total.cacheWrite)}</td>
                  <td className="r tnum">{fmtUsd(month.total.cost)}</td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <div className="meta">Nothing in {which === 0 ? 'this month' : monthName(month.key)} yet.</div>
          )}
        </>
      )}
      <span className="meta">
        Estimated from Anthropic’s list prices; your bill at platform.claude.com is the real figure.
        {report.unpriced.length > 0 && ` No price on file for ${report.unpriced.join(', ')}, so those count as $0.`}
      </span>
    </section>
  );
}
