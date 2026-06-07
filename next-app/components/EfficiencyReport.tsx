"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface TemporalBucket {
  label: string;
  turns: number;
  cost: number;
}

interface EfficiencyData {
  cadence: { medianGapSec: number; p90GapSec: number; sampleCount: number };
  byHour: TemporalBucket[];
  byWeekday: TemporalBucket[];
  modelSwitching: {
    totalSessions: number;
    sessionsWithMultipleModels: number;
    multiModelPct: number;
    switchEvents: number;
  };
  subagentShare: {
    mainCost: number;
    subagentCost: number;
    subagentCostPct: number;
    mainTokens: number;
    subagentTokens: number;
  };
  cacheMiss: {
    totalMissTokens: number;
    estWastedCost: number;
    turnsAffected: number;
    byReason: Array<{ reason: string; tokens: number; estCost: number }>;
  };
  ephemeral: { total5mTokens: number; total1hTokens: number; pct5m: number };
  hooks: {
    totalInvocations: number;
    totalErrors: number;
    errorRate: number;
    totalDurationMs: number;
    avgDurationMs: number;
  };
  queue: { totalQueued: number; sessionsWithQueue: number };
}

function prettify(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function fmtCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.005) return `$${n.toFixed(2)}`;
  if (n > 0) return `<$0.01`;
  return "$0.00";
}
function fmtPct(n: number): string {
  return `${n.toFixed(0)}%`;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function fmtSec(s: number): string {
  if (s >= 60) return `${(s / 60).toFixed(1)}m`;
  return `${s.toFixed(0)}s`;
}

function BarTable({
  rows,
  max,
  label,
  value,
}: {
  rows: Array<{ key: string; label: React.ReactNode; n: number }>;
  max: number;
  label?: string;
  value: (n: number) => string;
}) {
  return (
    <table className="table">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td style={{ width: "40%" }}>{r.label}</td>
            <td>
              <div className="model-cost-cell">
                <span>{value(r.n)}</span>
                <div className="model-share-bar-track">
                  <div className="model-share-bar-fill" style={{ width: `${max > 0 ? (r.n / max) * 100 : 0}%` }} />
                </div>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EfficiencyReport() {
  const [data, setData] = useState<EfficiencyData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/efficiency")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="page-error">{error}</div>;
  if (!data) return <div className="page-loading">Loading…</div>;

  const cm = data.cacheMiss;
  const sub = data.subagentShare;
  const maxHour = Math.max(1, ...data.byHour.map((h) => h.turns));
  const maxWd = Math.max(1, ...data.byWeekday.map((w) => w.turns));

  return (
    <div className="page">
      <div className="page-header">
        <Link href="/" className="back-link">← Dashboard</Link>
      </div>
      <div>
        <h1>Efficiency Insights</h1>
        <p className="page-subtitle">
          Where tokens and time leak — derived from parsed session turns: cache-miss waste, subagent
          cost share, model switching, turn cadence, temporal usage, hook overhead, and queued messages.
        </p>
      </div>

      {/* Headline pills */}
      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-value">{fmtCost(cm.estWastedCost)}</span>
          <span className="stat-label">Cache-miss waste</span>
          <span className="stat-sub">{fmtTokens(cm.totalMissTokens)} tokens · {cm.turnsAffected} turns</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{fmtPct(sub.subagentCostPct)}</span>
          <span className="stat-label">Subagent spend share</span>
          <span className="stat-sub">{fmtCost(sub.subagentCost)} of {fmtCost(sub.mainCost + sub.subagentCost)}</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{fmtPct(data.modelSwitching.multiModelPct)}</span>
          <span className="stat-label">Multi-model sessions</span>
          <span className="stat-sub">{data.modelSwitching.switchEvents} switch events</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{fmtSec(data.cadence.medianGapSec)}</span>
          <span className="stat-label">Median turn gap</span>
          <span className="stat-sub">p90 {fmtSec(data.cadence.p90GapSec)} · {data.cadence.sampleCount} gaps</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{data.hooks.totalInvocations}</span>
          <span className="stat-label">Hook invocations</span>
          <span className="stat-sub">{data.hooks.totalErrors} errors · {(data.hooks.totalDurationMs / 1000).toFixed(1)}s total</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{data.queue.totalQueued}</span>
          <span className="stat-label">Queued messages</span>
          <span className="stat-sub">across {data.queue.sessionsWithQueue} sessions</span>
        </div>
      </div>

      {/* Cache-miss waste */}
      <section className="card">
        <h2>Cache-Miss Waste</h2>
        <p className="section-desc">
          Tokens that should have hit the prompt cache but didn&apos;t — re-billed at the cache-write rate
          instead of the cheap cache-read rate. The estimated waste is the rate delta on those tokens,
          grouped by the reason the cache was invalidated.
        </p>
        {cm.byReason.length === 0 ? (
          <p className="method-note">No cache-miss diagnostics recorded in these sessions.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Reason</th><th>Tokens</th><th>Est. wasted</th></tr>
            </thead>
            <tbody>
              {cm.byReason.map((r) => (
                <tr key={r.reason}>
                  <td>{prettify(r.reason)}</td>
                  <td>{fmtTokens(r.tokens)}</td>
                  <td>{fmtCost(r.estCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Subagent vs main */}
      <section className="card">
        <h2>Subagent vs Main-Thread Cost</h2>
        <p className="section-desc">How much of your spend goes to spawned sub-agents vs the main conversation.</p>
        <div className="cost-compare-grid">
          <div className="cost-compare-block cost-compare-clean">
            <div className="cost-compare-label">Main thread</div>
            <div className="cost-compare-value">{fmtCost(sub.mainCost)}</div>
            <div className="cost-compare-sub">{fmtTokens(sub.mainTokens)} tokens</div>
          </div>
          <div className="cost-compare-vs"><span>vs</span></div>
          <div className="cost-compare-block cost-compare-compacted">
            <div className="cost-compare-label">Subagents</div>
            <div className="cost-compare-value">{fmtCost(sub.subagentCost)}</div>
            <div className="cost-compare-sub">{fmtTokens(sub.subagentTokens)} tokens · {fmtPct(sub.subagentCostPct)}</div>
          </div>
        </div>
      </section>

      {/* Ephemeral TTL */}
      {(data.ephemeral.total5mTokens > 0 || data.ephemeral.total1hTokens > 0) && (
        <section className="card">
          <h2>Ephemeral Cache TTL Split</h2>
          <p className="section-desc">
            Cache-creation tokens by time-to-live bucket. A heavier 1-hour share means longer-lived cache
            entries (cheaper for long sessions); a heavier 5-minute share churns more.
          </p>
          <BarTable
            max={Math.max(data.ephemeral.total5mTokens, data.ephemeral.total1hTokens)}
            value={fmtTokens}
            rows={[
              { key: "5m", label: `5-minute (${fmtPct(data.ephemeral.pct5m)})`, n: data.ephemeral.total5mTokens },
              { key: "1h", label: "1-hour", n: data.ephemeral.total1hTokens },
            ]}
          />
        </section>
      )}

      {/* Two-col: weekday + hour */}
      <div className="quality-two-col">
        <section className="card">
          <h2>Usage by Weekday</h2>
          <BarTable
            max={maxWd}
            value={(n) => `${n} turns`}
            rows={data.byWeekday.map((w) => ({ key: w.label, label: w.label, n: w.turns }))}
          />
        </section>
        <section className="card">
          <h2>Usage by Hour (UTC)</h2>
          <BarTable
            max={maxHour}
            value={(n) => `${n}`}
            rows={data.byHour.filter((h) => h.turns > 0).map((h) => ({ key: h.label, label: h.label, n: h.turns }))}
          />
        </section>
      </div>

      {/* Hooks */}
      {data.hooks.totalInvocations > 0 && (
        <section className="card">
          <h2>Hook Overhead</h2>
          <p className="section-desc">
            Lifecycle hooks fire on session/tool events. They add wall-clock time and can fail — this is the
            total cost of that automation.
          </p>
          <table className="table">
            <tbody>
              <tr><td>Invocations</td><td>{data.hooks.totalInvocations}</td></tr>
              <tr><td>Errors</td><td>{data.hooks.totalErrors} ({fmtPct(data.hooks.errorRate)})</td></tr>
              <tr><td>Total time added</td><td>{(data.hooks.totalDurationMs / 1000).toFixed(1)}s</td></tr>
              <tr><td>Avg per invocation</td><td>{data.hooks.avgDurationMs.toFixed(0)}ms</td></tr>
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
