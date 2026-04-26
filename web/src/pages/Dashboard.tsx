import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { api, fmtCost, fmtTokens, totalTokens } from "../api.js";
import type { GlobalSummary, ProjectSummary } from "../types.js";
import { Sparkline } from "../components/Sparkline.js";
import { InfoModal } from "../components/InfoModal.js";
import { ActiveSessions } from "../components/ActiveSessions.js";
import { usePagination, Pagination } from "../components/Pagination.js";
import { PLANS, usePlan } from "../hooks/usePlan.js";
type ModalKey = "totalCost" | "turns" | "cacheHitRate" | "totalTokens" | null;

export function Dashboard() {
  const [summary, setSummary] = useState<GlobalSummary | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState<ModalKey>(null);
  const [autoRefresh, setAutoRefresh] = useState<0 | 120 | 300 | 600>(0);
  const [countdown, setCountdown] = useState(0);
  const { page: projectsPage, setPage: setProjectsPage, paged: pagedProjects, total: projectsTotal } = usePagination(projects);
  const { plan, setPlanId } = usePlan();

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
  const cacheHitRate = totalTokens(summary.totals) > 0
    ? ((summary.totals.cache_read_input_tokens / totalTokens(summary.totals)) * 100).toFixed(1)
    : "0.0";

  return (
    <div className="page">
      {createPortal(
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
        document.getElementById("nav-actions")!
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
        </section>

        <section className="card">
          <h2>By Model</h2>
          <table className="table">
            <thead>
              <tr><th>Model</th><th>Tokens</th><th>{plan.isSubscription ? "API-Equiv Cost" : "Cost"}</th></tr>
            </thead>
            <tbody>
              {models.map(([model, stats]) => (
                <tr key={model}>
                  <td><code>{model.replace("claude-", "")}</code></td>
                  <td>{fmtTokens(stats.usage.input_tokens + stats.usage.output_tokens)}</td>
                  <td className={plan.isSubscription ? "cost-muted" : ""}>{fmtCost(stats.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
                  <Link to={`/project/${encodeURIComponent(p.projectKey)}`} className="link">
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
