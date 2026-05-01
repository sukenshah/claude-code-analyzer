"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { api, fmtCost, fmtTokens, totalTokens } from "@/lib/api";
import type { GlobalSummary, ProjectSummary } from "@/lib/types";
import { Sparkline } from "./Sparkline";
import { InfoModal } from "./InfoModal";
import { ActiveSessions } from "./ActiveSessions";
import { usePagination, Pagination } from "./Pagination";
import { PLANS, usePlan } from "@/hooks/usePlan";
import { simulateCost, COMPARE_MODELS } from "@/lib/pricing";

type ModalKey = "totalCost" | "turns" | "cacheHitRate" | "totalTokens" | null;

export function Dashboard() {
  const [summary, setSummary] = useState<GlobalSummary | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState<ModalKey>(null);
  const [autoRefresh, setAutoRefresh] = useState<0 | 120 | 300 | 600>(0);
  const [countdown, setCountdown] = useState(0);
  const [mounted, setMounted] = useState(false);
  const { page: projectsPage, setPage: setProjectsPage, paged: pagedProjects, total: projectsTotal } = usePagination(projects);
  const { plan, setPlanId } = usePlan();
  const [compareModel, setCompareModel] = useState(COMPARE_MODELS[1]!.id);

  const trendData = useMemo(() => {
    if (!summary) return null;
    const now = new Date();
    const DAY = 86400000;
    const dailyByDate = new Map(summary.dailyStats.map((d) => [d.date, d.cost]));
    const last7Cost = Array.from({ length: 7 }, (_, i) =>
      new Date(Date.now() - i * DAY).toISOString().slice(0, 10)
    ).reduce((s, d) => s + (dailyByDate.get(d) ?? 0), 0);
    const prev7Cost = Array.from({ length: 7 }, (_, i) =>
      new Date(Date.now() - (i + 7) * DAY).toISOString().slice(0, 10)
    ).reduce((s, d) => s + (dailyByDate.get(d) ?? 0), 0);
    const avgDaily7 = last7Cost / 7;
    const weekDelta = prev7Cost > 0 ? ((last7Cost - prev7Cost) / prev7Cost) * 100 : null;
    const monthPrefix = now.toISOString().slice(0, 7);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const monthSoFar = summary.dailyStats
      .filter((d) => d.date.startsWith(monthPrefix))
      .reduce((s, d) => s + d.cost, 0);
    const projectedMonth = dayOfMonth > 0 ? (monthSoFar / dayOfMonth) * daysInMonth : 0;
    return { avgDaily7, weekDelta, projectedMonth };
  }, [summary]);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    Promise.all([api.summary(), api.projects()])
      .then(([s, p]) => { setSummary(s); setProjects(p); })
      .catch((e) => setError(String(e)));
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.refresh();
      const [s, p] = await Promise.all([api.summary(), api.projects()]);
      setSummary(s);
      setProjects(p);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleRefreshRef = useRef(handleRefresh);
  handleRefreshRef.current = handleRefresh;

  useEffect(() => {
    if (autoRefresh === 0) { setCountdown(0); return; }
    setCountdown(autoRefresh);
    let remaining = autoRefresh;
    const tick = setInterval(() => {
      remaining--;
      setCountdown(remaining);
      if (remaining <= 0) {
        handleRefreshRef.current();
        remaining = autoRefresh;
        setCountdown(autoRefresh);
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [autoRefresh]);

  if (error) return <div className="error">{error}</div>;
  if (!summary) return <div className="loading">Loading...</div>;

  const last30 = summary.dailyStats.slice(-30);
  const models = Object.entries(summary.byModel).sort((a, b) => b[1].cost - a[1].cost);

  const { avgDaily7, weekDelta, projectedMonth } = trendData!;
  const cacheHitRate = totalTokens(summary.totals) > 0
    ? ((summary.totals.cache_read_input_tokens / totalTokens(summary.totals)) * 100).toFixed(1)
    : "0.0";

  const navActionsEl = mounted ? document.getElementById("nav-actions") : null;

  return (
    <div className="page">
      {navActionsEl && createPortal(
        <div className="refresh-controls">
          <select
            className="plan-select"
            value={plan.id}
            onChange={(e) => setPlanId(e.target.value as typeof plan.id)}
            aria-label="Claude plan"
          >
            {PLANS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <div className="btn-group" role="group" aria-label="Auto-refresh interval">
            {([0, 120, 300, 600] as const).map((interval) => (
              <button
                key={interval}
                className={`btn-interval ${autoRefresh === interval ? "active" : ""}`}
                onClick={() => setAutoRefresh(interval)}
              >
                {interval === 0 ? "Manual" : `${interval / 60}m`}
              </button>
            ))}
          </div>
          <button className="btn-secondary" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : countdown > 0 ? `Refresh (${countdown}s)` : "Refresh"}
          </button>
        </div>,
        navActionsEl
      )}

      <ActiveSessions />

      {plan.isSubscription && (
        <div className="plan-notice">
          <strong>{plan.label}</strong> — costs shown are API-equivalent estimates, not your actual spend.
          Token counts are accurate and reflect real usage. Your actual cost is your flat ${plan.monthlyCost}/mo subscription.
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">
            {plan.isSubscription ? "API-Equiv Cost" : "Total Cost"}
            <button className="info-btn" onClick={() => setModal("totalCost")}>?</button>
          </div>
          <div className={`stat-value ${plan.isSubscription ? "stat-value-muted" : ""}`}>
            {fmtCost(summary.totalCost)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Projects</div>
          <div className="stat-value">{summary.projectCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Sessions</div>
          <div className="stat-value">{summary.sessionCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Turns
            <button className="info-btn" onClick={() => setModal("turns")}>?</button>
          </div>
          <div className="stat-value">{summary.turnCount.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Cache Hit Rate
            <button className="info-btn" onClick={() => setModal("cacheHitRate")}>?</button>
          </div>
          <div className="stat-value">{cacheHitRate}%</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Total Tokens
            <button className="info-btn" onClick={() => setModal("totalTokens")}>?</button>
          </div>
          <div className="stat-value">{fmtTokens(totalTokens(summary.totals))}</div>
        </div>
        {summary.limitHitCount > 0 && (
          <div className="stat-card stat-card-limit">
            <div className="stat-label">Limit Reached</div>
            <div className="stat-value stat-value-limit">{summary.limitHitCount}×</div>
          </div>
        )}
      </div>

      {modal === "totalCost" && (
        <InfoModal title={plan.isSubscription ? "API-Equivalent Cost" : "Total Cost"} onClose={() => setModal(null)}>
          {plan.isSubscription ? (
            <>
              <p>You're on the <strong>{plan.label}</strong> plan. This figure is an <em>API-equivalent estimate</em> — what the same token volume would cost on pay-as-you-go API pricing.</p>
              <p>Your actual spend is your flat <strong>${plan.monthlyCost}/month</strong> subscription. Use this number to understand relative usage across projects and sessions, not as a billing figure.</p>
              <p>If this estimate consistently exceeds your subscription cost, you're getting good value from your plan. If it's far below, pay-as-you-go API might be cheaper for your usage level.</p>
            </>
          ) : (
            <>
              <p>The sum of all API charges across every project and session, calculated from token counts using Anthropic's published per-model pricing.</p>
              <p>Cost is broken down into four components:</p>
              <ul>
                <li><strong>Input tokens</strong> — tokens in your prompt sent to the model.</li>
                <li><strong>Output tokens</strong> — tokens the model generated in its reply.</li>
                <li><strong>Cache write</strong> — tokens written into the prompt cache for reuse.</li>
                <li><strong>Cache read</strong> — tokens read back from the cache (much cheaper than re-sending input).</li>
              </ul>
              <p className="modal-example">Example: a session with 50K input tokens on Sonnet 4.6 costs roughly $0.15 in input charges alone ($3 per million tokens).</p>
            </>
          )}
        </InfoModal>
      )}

      {modal === "turns" && (
        <InfoModal title="Turns" onClose={() => setModal(null)}>
          <p>A turn is one assistant response — every time Claude replied to a message, that counts as one turn.</p>
          <p>A single session typically contains many turns: one per user message plus any tool calls Claude made autonomously.</p>
          <p className="modal-example">Example: asking Claude to "write tests, run them, and fix failures" might produce 8–15 turns as it iterates.</p>
        </InfoModal>
      )}

      {modal === "cacheHitRate" && (
        <InfoModal title="Cache Hit Rate" onClose={() => setModal(null)}>
          <p>The percentage of tokens that were served from Anthropic's prompt cache instead of being re-processed as fresh input.</p>
          <p>Cache reads cost about 10× less than regular input tokens, so a high hit rate means significant savings.</p>
          <p>Calculated as: <code>cache_read_tokens ÷ total_tokens × 100</code></p>
          <p className="modal-example">Example: a rate of 60% means more than half your token volume was served from cache. On a $10 session that could save ~$4 vs. no caching.</p>
          <p>A low rate (&lt;20%) usually means short or infrequent sessions where the cache has no time to warm up.</p>
        </InfoModal>
      )}

      {modal === "totalTokens" && (
        <InfoModal title="Total Tokens" onClose={() => setModal(null)}>
          <p>The combined count of all tokens processed across every turn: input, output, cache writes, and cache reads.</p>
          <p>Token counts determine your bill — each model has a per-million-token rate for each category.</p>
          <p className="modal-example">Example: "1.2M tokens" at Sonnet 4.6 rates ($3 input / $15 output) could cost anywhere from $4 to $18 depending on the input/output split.</p>
          <p>Check the <strong>By Model</strong> table below to see how tokens break down per model.</p>
        </InfoModal>
      )}

      <div className="section-row">
        <section className="card">
          <h2>Daily Cost (last 30 days)</h2>
          <Sparkline data={last30} width={420} height={80} />
          <div className="trend-stats">
            <div className="trend-stat">
              <span className="trend-label">7-day avg</span>
              <span className={`trend-value ${plan.isSubscription ? "cost-muted" : ""}`}>
                {fmtCost(avgDaily7)}/day
              </span>
            </div>
            <div className="trend-stat">
              <span className="trend-label">vs prev week</span>
              <span className={`trend-value ${weekDelta === null ? "" : weekDelta > 5 ? "trend-up" : weekDelta < -5 ? "trend-down" : ""}`}>
                {weekDelta === null ? "—" : `${weekDelta > 0 ? "▲" : "▼"} ${Math.abs(weekDelta).toFixed(0)}%`}
              </span>
            </div>
            <div className="trend-stat">
              <span className="trend-label">month projection</span>
              <span className={`trend-value ${plan.isSubscription ? "cost-muted" : ""}`}>
                {fmtCost(projectedMonth)}
              </span>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-header-row">
            <h2>By Model</h2>
            <div className="model-compare-control">
              <span className="model-compare-label">Compare to</span>
              <select
                className="model-compare-select"
                value={compareModel}
                onChange={(e) => setCompareModel(e.target.value)}
                aria-label="Comparison model"
              >
                {COMPARE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>
          {(() => {
            const rows = models.filter(([model]) => model !== "<synthetic>");
            const simTotal = rows.reduce((s, [, stats]) => s + simulateCost(stats.usage, compareModel), 0);
            const actualTotal = rows.reduce((s, [, stats]) => s + stats.cost, 0);
            const totalDelta = simTotal - actualTotal;
            const compareLabel = COMPARE_MODELS.find((m) => m.id === compareModel)?.label ?? compareModel;
            return (
              <>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>{plan.isSubscription ? "API-Equiv Cost" : "Cost"}</th>
                      <th>vs {compareLabel}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(([model, stats]) => {
                      const costPct = summary.totalCost > 0 ? (stats.cost / summary.totalCost) * 100 : 0;
                      const sim = simulateCost(stats.usage, compareModel);
                      const delta = sim - stats.cost;
                      const isBaseline = model === compareModel || model.startsWith(compareModel);
                      return (
                        <tr key={model}>
                          <td>
                            <div className="model-name-cell">
                              <code>{model.replace("claude-", "")}</code>
                              <span className="model-token-sub">{fmtTokens(stats.usage.input_tokens + stats.usage.output_tokens)}</span>
                            </div>
                          </td>
                          <td>
                            <div className="model-cost-cell">
                              <span className={plan.isSubscription ? "cost-muted" : ""}>{fmtCost(stats.cost)}</span>
                              <div className="model-share-bar-track">
                                <div className="model-share-bar-fill" style={{ width: `${costPct}%` }} />
                              </div>
                            </div>
                          </td>
                          <td>
                            {isBaseline
                              ? <span className="model-baseline-tag">baseline</span>
                              : <span className={delta > 0.005 ? "model-delta-worse" : delta < -0.005 ? "model-delta-better" : ""}>
                                  {delta > 0 ? "+" : ""}{fmtCost(delta)}
                                </span>
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!rows.every(([m]) => m === compareModel || m.startsWith(compareModel)) && (
                  <div className="model-sim-summary">
                    <span>All on {compareLabel}:</span>
                    <span className={plan.isSubscription ? "cost-muted" : ""}><strong>{fmtCost(simTotal)}</strong></span>
                    <span className={totalDelta > 0.01 ? "model-delta-worse" : totalDelta < -0.01 ? "model-delta-better" : ""}>
                      {Math.abs(totalDelta) < 0.01 ? "≈ same" : totalDelta > 0 ? `+${fmtCost(totalDelta)}` : `${fmtCost(totalDelta)} saved`}
                    </span>
                  </div>
                )}
              </>
            );
          })()}
        </section>
      </div>

      <section className="card">
        <h2>Projects</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Sessions</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cache Read</th>
              <th>Cache Write</th>
              <th>Limit Hits</th>
              <th>{plan.isSubscription ? "API-Equiv Cost" : "Cost"}</th>
            </tr>
          </thead>
          <tbody>
            {pagedProjects.map((p) => (
              <tr key={p.projectKey}>
                <td>
                  <Link href={`/project/${encodeURIComponent(p.projectKey)}`} className="link">
                    {p.projectName}
                  </Link>
                </td>
                <td>{p.sessionCount}</td>
                <td>{fmtTokens(p.totals.input_tokens)}</td>
                <td>{fmtTokens(p.totals.output_tokens)}</td>
                <td>{fmtTokens(p.totals.cache_read_input_tokens)}</td>
                <td>{fmtTokens(p.totals.cache_creation_input_tokens)}</td>
                <td>{p.limitHitCount > 0 ? <span className="limit-hit-count">{p.limitHitCount}×</span> : "—"}</td>
                <td><strong className={plan.isSubscription ? "cost-muted" : ""}>{fmtCost(p.totalCost)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination page={projectsPage} total={projectsTotal} onChange={setProjectsPage} />
      </section>
    </div>
  );
}
