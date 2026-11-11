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
  queue: { totalQueued: number; sessionsWithQueue: number; systemMessages?: number; absorbedMidTurn?: number };
  context?: {
    medianTokens: number;
    p90Tokens: number;
    maxTokens: number;
    cacheReadCost: number;
    cacheReadCostShare: number;
    buckets: Array<{ label: string; minTokens: number; maxTokens: number | null; turns: number; cost: number; avgCostPerTurn: number }>;
    topSessions: Array<{ sessionId: string; projectName: string; peakTokens: number; turns: number; cost: number }>;
  };
  prompts?: {
    count: number;
    totalCost: number;
    medianCost: number;
    p90Cost: number;
    maxCost: number;
    medianApiTurns: number;
    p90ApiTurns: number;
    medianToolCalls: number;
    p90ToolCalls: number;
    unattributedTurns: number;
    unattributedCost: number;
  };
  byOrigin?: Array<{ origin: string; prompts: number; turns: number; cost: number; costShare: number }>;
  byEffort?: Array<{ effort: string; turns: number; cost: number; outputTokens: number; costShare: number }>;
  permissions?: { total: number; autoApproved: number; manualApproved: number; rejected: number; manualRate: number };
  bashHealth?: { calls: number; timeouts: number; largeOutputs: number; timeoutRate: number };
  turnDuration?: { count: number; medianMs: number; p90Ms: number; totalMs: number };
  thinking?: { thinkingTokens: number; outputTokens: number; share: number; estimatedCost: number };
  toolReliability?: Array<{ tool: string; calls: number; errors: number; errorRate: number }>;
  toolErrorRate?: number;
  permissionDenials?: Array<{ kind: string; count: number }>;
  apiErrors?: number;
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

function fmtMs(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const ORIGIN_LABELS: Record<string, string> = {
  human: "Typed by you",
  peer: "Agent / other session message",
  task_notification: "Background task notification",
  scheduled: "Scheduled task",
  auto_continuation: "Auto-continuation",
  coordinator: "Coordinator",
  unknown: "Unknown",
};

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
          <span className="stat-label">Queued while Claude was busy</span>
          <span className="stat-sub">
            typed by you · {data.queue.sessionsWithQueue} sessions
            {data.queue.systemMessages != null ? ` · ${data.queue.systemMessages} system` : ""}
            {data.queue.absorbedMidTurn != null ? ` · ${data.queue.absorbedMidTurn} absorbed mid-turn` : ""}
          </span>
        </div>
      </div>

      {/* Context size */}
      {data.context && data.context.buckets?.some((b) => b.turns > 0) && (
        <section className="card">
          <h2>Context Size</h2>
          <p className="section-desc">
            Cost per turn grows with context size; /clear or /compact when a session moves into the expensive buckets.
          </p>
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-value">{fmtTokens(data.context.medianTokens ?? 0)}</span>
              <span className="stat-label">Median context</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{fmtTokens(data.context.p90Tokens ?? 0)}</span>
              <span className="stat-label">p90 context</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{fmtTokens(data.context.maxTokens ?? 0)}</span>
              <span className="stat-label">Max context</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{fmtCost(data.context.cacheReadCost ?? 0)}</span>
              <span className="stat-label">Cache-read cost</span>
              <span className="stat-sub">{fmtPct((data.context.cacheReadCostShare ?? 0) * 100)} of total spend</span>
            </div>
          </div>
          <table className="table">
            <thead>
              <tr><th>Context size</th><th>Turns</th><th>Cost</th><th>Avg $ per turn</th></tr>
            </thead>
            <tbody>
              {data.context.buckets.filter((b) => b.turns > 0).map((b) => {
                const maxAvg = Math.max(0, ...data.context!.buckets.map((x) => x.avgCostPerTurn ?? 0));
                return (
                  <tr key={b.label}>
                    <td>{b.label}</td>
                    <td>{b.turns}</td>
                    <td>{fmtCost(b.cost)}</td>
                    <td>
                      <div className="model-cost-cell">
                        <span>{fmtCost(b.avgCostPerTurn ?? 0)}</span>
                        <div className="model-share-bar-track">
                          <div className="model-share-bar-fill" style={{ width: `${maxAvg > 0 ? ((b.avgCostPerTurn ?? 0) / maxAvg) * 100 : 0}%` }} />
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(data.context.topSessions?.length ?? 0) > 0 && (
            <>
              <h3>Top sessions by peak context</h3>
              <table className="table">
                <thead>
                  <tr><th>Session</th><th>Project</th><th>Peak context</th><th>Turns</th><th>Cost</th></tr>
                </thead>
                <tbody>
                  {data.context.topSessions.map((s) => (
                    <tr key={s.sessionId}>
                      <td>
                        <Link href={`/session/${encodeURIComponent(s.sessionId)}`} className="project-link">
                          {s.sessionId.slice(0, 8)}
                        </Link>
                      </td>
                      <td>{s.projectName}</td>
                      <td>{fmtTokens(s.peakTokens)}</td>
                      <td>{s.turns}</td>
                      <td>{fmtCost(s.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {/* Cost per prompt */}
      {data.prompts && data.prompts.count > 0 && (
        <section className="card">
          <h2>Cost per Prompt</h2>
          <table className="table">
            <thead>
              <tr><th>Metric</th><th>Median</th><th>p90</th><th>Max</th></tr>
            </thead>
            <tbody>
              <tr><td>Cost</td><td>{fmtCost(data.prompts.medianCost)}</td><td>{fmtCost(data.prompts.p90Cost)}</td><td>{fmtCost(data.prompts.maxCost)}</td></tr>
              <tr><td>API turns</td><td>{data.prompts.medianApiTurns}</td><td>{data.prompts.p90ApiTurns}</td><td>—</td></tr>
              <tr><td>Tool calls</td><td>{data.prompts.medianToolCalls}</td><td>{data.prompts.p90ToolCalls}</td><td>—</td></tr>
            </tbody>
          </table>
          <p className="method-note">{data.prompts.count} prompts · {fmtCost(data.prompts.totalCost)} total</p>
        </section>
      )}

      {/* Spend by origin */}
      {(data.byOrigin?.length ?? 0) > 0 && (
        <section className="card">
          <h2>Spend by Origin</h2>
          <table className="table">
            <thead>
              <tr><th>Origin</th><th>Prompts</th><th>Turns</th><th>Cost</th><th>Share</th></tr>
            </thead>
            <tbody>
              {(data.byOrigin ?? []).map((o) => (
                <tr key={o.origin}>
                  <td>{ORIGIN_LABELS[o.origin] ?? prettify(o.origin)}</td>
                  <td>{o.prompts}</td>
                  <td>{o.turns}</td>
                  <td>{fmtCost(o.cost)}</td>
                  <td>{fmtPct((o.costShare ?? 0) * 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Spend by effort */}
      {(data.byEffort?.length ?? 0) > 0 && (
        <section className="card">
          <h2>Spend by Effort</h2>
          <table className="table">
            <thead>
              <tr><th>Effort</th><th>Turns</th><th>Output tokens</th><th>Cost</th><th>Share</th></tr>
            </thead>
            <tbody>
              {(data.byEffort ?? []).map((e) => (
                <tr key={e.effort}>
                  <td>{prettify(e.effort)}</td>
                  <td>{e.turns}</td>
                  <td>{fmtTokens(e.outputTokens)}</td>
                  <td>{fmtCost(e.cost)}</td>
                  <td>{fmtPct((e.costShare ?? 0) * 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

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

      {/* Turn duration */}
      {(data.turnDuration?.count ?? 0) > 0 && data.turnDuration && (
        <section className="card">
          <h2>Turn Duration</h2>
          <p className="section-desc">Wall-clock time Claude spent working on each turn.</p>
          <table className="table">
            <tbody>
              <tr><td>Turns measured</td><td>{data.turnDuration.count}</td></tr>
              <tr><td>Median</td><td>{fmtMs(data.turnDuration.medianMs)}</td></tr>
              <tr><td>p90</td><td>{fmtMs(data.turnDuration.p90Ms)}</td></tr>
              <tr><td>Total agent working time</td><td>{fmtMs(data.turnDuration.totalMs)}</td></tr>
            </tbody>
          </table>
        </section>
      )}

      {/* Thinking */}
      {(data.thinking?.thinkingTokens ?? 0) > 0 && data.thinking && (
        <section className="card">
          <h2>Thinking</h2>
          <p className="section-desc">Extended-thinking tokens are billed as output tokens.</p>
          <table className="table">
            <tbody>
              <tr><td>Thinking tokens</td><td>{fmtTokens(data.thinking.thinkingTokens)}</td></tr>
              <tr><td>Share of output tokens</td><td>{(data.thinking.share * 100).toFixed(1)}%</td></tr>
              <tr><td>Estimated cost</td><td>{fmtCost(data.thinking.estimatedCost)}</td></tr>
            </tbody>
          </table>
        </section>
      )}

      {/* Tool reliability */}
      {(data.toolReliability?.length ?? 0) > 0 && (
        <section className="card">
          <h2>Tool Reliability</h2>
          <p className="section-desc">
            Overall tool error rate: {(data.toolErrorRate ?? 0).toFixed(1)}%. Top 10 tools by call count.
          </p>
          <table className="table">
            <thead>
              <tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Error rate</th></tr>
            </thead>
            <tbody>
              {[...(data.toolReliability ?? [])].sort((a, b) => b.calls - a.calls).slice(0, 10).map((t) => (
                <tr key={t.tool}>
                  <td>{t.tool}</td>
                  <td>{t.calls}</td>
                  <td>{t.errors}</td>
                  <td>{t.errorRate.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Permission denials + API errors */}
      {((data.permissionDenials?.length ?? 0) > 0 || (data.apiErrors ?? 0) > 0) && (
        <section className="card">
          <h2>Permission Denials &amp; API Errors</h2>
          <table className="table">
            <tbody>
              {(data.permissionDenials ?? []).map((d) => (
                <tr key={d.kind}><td>Denied: {prettify(d.kind)}</td><td>{d.count}</td></tr>
              ))}
              <tr><td>API errors</td><td>{data.apiErrors ?? 0}</td></tr>
            </tbody>
          </table>
        </section>
      )}

      {/* Permission decisions + Bash health */}
      {((data.permissions?.total ?? 0) > 0 || (data.bashHealth?.calls ?? 0) > 0) && (
        <section className="card">
          <h2>Permissions &amp; Bash Health</h2>
          <table className="table">
            <tbody>
              {data.permissions && data.permissions.total > 0 && (
                <>
                  <tr><td>Permission decisions</td><td>{data.permissions.total}</td></tr>
                  <tr><td>Auto-approved</td><td>{data.permissions.autoApproved}</td></tr>
                  <tr><td>Manually approved</td><td>{data.permissions.manualApproved} ({(data.permissions.manualRate ?? 0).toFixed(1)}%)</td></tr>
                  <tr><td>Rejected</td><td>{data.permissions.rejected}</td></tr>
                </>
              )}
              {data.bashHealth && data.bashHealth.calls > 0 && (
                <>
                  <tr><td>Bash calls</td><td>{data.bashHealth.calls}</td></tr>
                  <tr><td>Bash timeouts</td><td>{data.bashHealth.timeouts} ({(data.bashHealth.timeoutRate ?? 0).toFixed(1)}%)</td></tr>
                  <tr><td>Outputs too large to keep inline</td><td>{data.bashHealth.largeOutputs}</td></tr>
                </>
              )}
            </tbody>
          </table>
        </section>
      )}

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
