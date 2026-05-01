"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface GlobalStats {
  totalCompactions: number;
  totalSessionsWithCompaction: number;
  totalSessions: number;
  totalTokensLost: number;
  avgTokensLostPerCompaction: number;
  triggerCounts: Record<string, number>;
}

interface CostComparison {
  avgCompactedSessionCost: number;
  avgNonCompactedSessionCost: number;
  compactedSessionCount: number;
  nonCompactedSessionCount: number;
}

interface ProjectRow {
  projectName: string;
  projectKey: string;
  compactionCount: number;
  sessionsWithCompaction: number;
  totalSessions: number;
  totalTokensLost: number;
  avgTokensLostPerCompaction: number;
  avgCompactedSessionCost: number;
  avgNonCompactedSessionCost: number;
  totalCost: number;
}

interface CompactionData {
  globalStats: GlobalStats;
  costComparison: CostComparison;
  projectBreakdown: ProjectRow[];
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function fmtCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.001) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export function CompactionReport() {
  const [data, setData] = useState<CompactionData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/compaction")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="page-error">{error}</div>;
  if (!data) return <div className="page-loading">Loading…</div>;

  const { globalStats: g, costComparison: cc, projectBreakdown } = data;

  const compactionRate =
    g.totalSessions > 0 ? (g.totalSessionsWithCompaction / g.totalSessions) * 100 : 0;

  const costMultiplier =
    cc.avgNonCompactedSessionCost > 0
      ? cc.avgCompactedSessionCost / cc.avgNonCompactedSessionCost
      : null;

  const triggerEntries = Object.entries(g.triggerCounts).sort((a, b) => b[1] - a[1]);

  return (
    <div className="page">
      <div className="page-header">
        <Link href="/" className="back-link">← Dashboard</Link>
      </div>
      <div>
        <h1>Context Compaction Report</h1>
        <p className="page-subtitle">
          Context compaction fires when a session approaches the context window limit. It
          summarizes prior turns, losing tokens — but lets the session continue.
        </p>
      </div>

      {g.totalCompactions === 0 ? (
        <div className="card compaction-empty">
          <p>No compaction events found in any session. Sessions have stayed within context limits so far.</p>
        </div>
      ) : (
        <>
          {/* Global stat pills */}
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-value">{g.totalCompactions}</span>
              <span className="stat-label">Total compactions</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{fmtPct(compactionRate)}</span>
              <span className="stat-label">Sessions compacted</span>
              <span className="stat-sub">{g.totalSessionsWithCompaction} of {g.totalSessions}</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{fmtTokens(g.totalTokensLost)}</span>
              <span className="stat-label">Total tokens lost</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{fmtTokens(g.avgTokensLostPerCompaction)}</span>
              <span className="stat-label">Avg tokens lost / compact</span>
            </div>
          </div>

          {/* Cost comparison */}
          <section className="card">
            <h2>Session Cost: Compacted vs Clean</h2>
            <p className="section-desc">
              Sessions that triggered compaction tend to be longer and more expensive.
            </p>
            <div className="cost-compare-grid">
              <div className="cost-compare-block cost-compare-compacted">
                <div className="cost-compare-label">Compacted sessions</div>
                <div className="cost-compare-value">{fmtCost(cc.avgCompactedSessionCost)}</div>
                <div className="cost-compare-sub">avg cost · {cc.compactedSessionCount} sessions</div>
              </div>
              <div className="cost-compare-vs">
                {costMultiplier !== null && (
                  <span className={costMultiplier > 1.1 ? "model-delta-worse" : ""}>
                    {costMultiplier > 1.01
                      ? `${costMultiplier.toFixed(1)}× more expensive`
                      : "≈ same cost"}
                  </span>
                )}
              </div>
              <div className="cost-compare-block cost-compare-clean">
                <div className="cost-compare-label">Clean sessions</div>
                <div className="cost-compare-value">{fmtCost(cc.avgNonCompactedSessionCost)}</div>
                <div className="cost-compare-sub">avg cost · {cc.nonCompactedSessionCount} sessions</div>
              </div>
            </div>
          </section>

          {/* Trigger breakdown */}
          {triggerEntries.length > 0 && (
            <section className="card">
              <h2>Compaction Triggers</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Trigger</th>
                    <th>Count</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {triggerEntries.map(([trigger, count]) => (
                    <tr key={trigger}>
                      <td><code>{trigger}</code></td>
                      <td>{count}</td>
                      <td>
                        <div className="model-cost-cell">
                          <span>{fmtPct((count / g.totalCompactions) * 100)}</span>
                          <div className="model-share-bar-track">
                            <div
                              className="model-share-bar-fill"
                              style={{ width: `${(count / g.totalCompactions) * 100}%` }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Project breakdown */}
          <section className="card">
            <h2>Projects by Compaction Frequency</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Compactions</th>
                  <th>Sessions</th>
                  <th>Tokens lost</th>
                  <th>Cost: compacted vs clean</th>
                </tr>
              </thead>
              <tbody>
                {projectBreakdown.map((row) => {
                  const projMultiplier =
                    row.avgNonCompactedSessionCost > 0
                      ? row.avgCompactedSessionCost / row.avgNonCompactedSessionCost
                      : null;
                  return (
                    <tr key={row.projectKey}>
                      <td>
                        <div className="model-name-cell">
                          <Link href={`/project/${encodeURIComponent(row.projectKey)}`} className="project-link">
                            {row.projectName}
                          </Link>
                          <span className="model-token-sub">{row.compactionCount} compactions</span>
                        </div>
                      </td>
                      <td>
                        <div className="model-cost-cell">
                          <span>{row.compactionCount}</span>
                          <div className="model-share-bar-track">
                            <div
                              className="model-share-bar-fill"
                              style={{
                                width: `${Math.min(100, (row.compactionCount / (projectBreakdown[0]?.compactionCount ?? 1)) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="compact-session-fraction">
                          {row.sessionsWithCompaction}/{row.totalSessions}
                        </span>
                      </td>
                      <td>
                        <div className="model-name-cell">
                          <span>{fmtTokens(row.totalTokensLost)}</span>
                          <span className="model-token-sub">avg {fmtTokens(row.avgTokensLostPerCompaction)} / compact</span>
                        </div>
                      </td>
                      <td>
                        <div className="model-name-cell">
                          {row.avgCompactedSessionCost > 0 ? (
                            <>
                              <span>{fmtCost(row.avgCompactedSessionCost)}</span>
                              {row.avgNonCompactedSessionCost > 0 && projMultiplier !== null && (
                                <span className={`model-token-sub ${projMultiplier > 1.1 ? "model-delta-worse" : ""}`}>
                                  vs {fmtCost(row.avgNonCompactedSessionCost)} clean
                                  {projMultiplier > 1.01 ? ` (${projMultiplier.toFixed(1)}×)` : " (≈ same)"}
                                </span>
                              )}
                              {row.avgNonCompactedSessionCost === 0 && (
                                <span className="model-token-sub">all sessions compacted</span>
                              )}
                            </>
                          ) : (
                            <span className="model-token-sub">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
