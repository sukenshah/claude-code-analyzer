"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface GlobalStats {
  totalLimitHits: number;
  totalSessions: number;
  sessionsWithLimitHit: number;
  sessionsWithBothLimitAndCompaction: number;
}

interface ProjectRow {
  projectKey: string;
  projectName: string;
  totalSessions: number;
  limitHitCount: number;
  sessionsWithLimitHit: number;
  compactionCount: number;
  sessionsWithBothLimitAndCompaction: number;
  claudeMdTokens: number;
  claudeMdCostPerSession: number;
  totalCost: number;
}

interface SessionRow {
  sessionId: string;
  projectKey: string;
  projectName: string;
  aiTitle: string | null;
  limitHitCount: number;
  compactionCount: number;
  totalCost: number;
  firstTimestamp: string;
}

interface ContextLimitData {
  globalStats: GlobalStats;
  projectBreakdown: ProjectRow[];
  topSessions: SessionRow[];
}

function fmtCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.001) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function fmtDate(ts: string): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Diagnosis: what's most likely driving limit hits for this project
function diagnosis(row: ProjectRow): { label: string; cls: string } | null {
  if (row.limitHitCount === 0) return null;

  const hasHighClaudeMd = row.claudeMdTokens > 4000;
  const compactionRatio = row.limitHitCount > 0 ? row.compactionCount / row.limitHitCount : 0;
  const bothRatio = row.sessionsWithLimitHit > 0
    ? row.sessionsWithBothLimitAndCompaction / row.sessionsWithLimitHit
    : 0;

  if (hasHighClaudeMd && bothRatio < 0.5) {
    return { label: "Possible CLAUDE.md bloat", cls: "diag-warn" };
  }
  if (compactionRatio > 1.5 || bothRatio > 0.7) {
    return { label: "Overly long sessions", cls: "diag-info" };
  }
  if (hasHighClaudeMd) {
    return { label: "CLAUDE.md bloat + long sessions", cls: "diag-warn" };
  }
  return { label: "Long sessions", cls: "diag-info" };
}

export function ContextLimitReport() {
  const [data, setData] = useState<ContextLimitData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/context-limit")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="page-error">{error}</div>;
  if (!data) return <div className="page-loading">Loading…</div>;

  const { globalStats: g, projectBreakdown, topSessions } = data;

  const limitRate = g.totalSessions > 0
    ? ((g.sessionsWithLimitHit / g.totalSessions) * 100).toFixed(1)
    : "0.0";

  const compactionOverlapPct = g.sessionsWithLimitHit > 0
    ? ((g.sessionsWithBothLimitAndCompaction / g.sessionsWithLimitHit) * 100).toFixed(0)
    : "0";

  const projectsWithHits = projectBreakdown.filter((p) => p.limitHitCount > 0);

  return (
    <div className="page">
      <div className="page-header">
        <Link href="/" className="back-link">← Dashboard</Link>
      </div>
      <div>
        <h1>Context Limit Report</h1>
        <p className="page-subtitle">
          Tracks sessions where Claude hit the context window limit. High frequency suggests
          CLAUDE.md bloat or overly long sessions that should be broken up.
        </p>
      </div>

      {g.totalLimitHits === 0 ? (
        <div className="card compaction-empty">
          <p>No context limit events found across any session.</p>
        </div>
      ) : (
        <>
          {/* Global stat pills */}
          <div className="stat-grid">
            <div className="stat-card stat-card-limit">
              <span className="stat-value stat-value-limit">{g.totalLimitHits}</span>
              <span className="stat-label">Total limit hits</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{g.sessionsWithLimitHit}</span>
              <span className="stat-label">Sessions affected</span>
              <span className="stat-sub">{limitRate}% of {g.totalSessions} sessions</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{compactionOverlapPct}%</span>
              <span className="stat-label">Also compacted</span>
              <span className="stat-sub">{g.sessionsWithBothLimitAndCompaction} of {g.sessionsWithLimitHit} sessions</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{projectsWithHits.length}</span>
              <span className="stat-label">Projects affected</span>
            </div>
          </div>

          {/* Insight callout */}
          <div className="card">
            <h2>What causes context limit hits?</h2>
            <p className="section-desc">
              <strong>CLAUDE.md bloat</strong> — large CLAUDE.md files add thousands of tokens to every turn,
              filling the context window faster. Trim unused sections or move project docs out of CLAUDE.md.<br /><br />
              <strong>Overly long sessions</strong> — sessions that run many turns without a natural breakpoint.
              Consider splitting work across multiple sessions. Compaction helps but still loses context.<br /><br />
              <strong>Both together</strong> — the most expensive pattern. A bloated CLAUDE.md in a long session
              hits the limit faster and requires more compactions.
            </p>
          </div>

          {/* Projects table */}
          {projectsWithHits.length > 0 && (
            <section className="card">
              <h2>Projects by Limit Hits</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Limit hits</th>
                    <th>Sessions hit</th>
                    <th>Compactions</th>
                    <th>CLAUDE.md</th>
                    <th>Diagnosis</th>
                  </tr>
                </thead>
                <tbody>
                  {projectsWithHits.map((row) => {
                    const diag = diagnosis(row);
                    return (
                      <tr key={row.projectKey}>
                        <td>
                          <Link href={`/project/${encodeURIComponent(row.projectKey)}`} className="project-link">
                            {row.projectName}
                          </Link>
                        </td>
                        <td>
                          <div className="model-cost-cell">
                            <span className="stat-value-limit">{row.limitHitCount}</span>
                            <div className="model-share-bar-track">
                              <div
                                className="model-share-bar-fill"
                                style={{
                                  width: `${Math.min(100, (row.limitHitCount / (projectsWithHits[0]?.limitHitCount ?? 1)) * 100)}%`,
                                  background: "var(--red)",
                                }}
                              />
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="compact-session-fraction">
                            {row.sessionsWithLimitHit}/{row.totalSessions}
                          </span>
                        </td>
                        <td>
                          <div className="model-name-cell">
                            <span>{row.compactionCount}</span>
                            {row.sessionsWithBothLimitAndCompaction > 0 && (
                              <span className="model-token-sub">
                                {row.sessionsWithBothLimitAndCompaction} sessions had both
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          {row.claudeMdTokens > 0 ? (
                            <div className="model-name-cell">
                              <span className={row.claudeMdTokens > 4000 ? "stat-value-limit" : ""}>
                                {fmtTokens(row.claudeMdTokens)}
                              </span>
                              <span className="model-token-sub">
                                {fmtCost(row.claudeMdCostPerSession)}/session
                              </span>
                            </div>
                          ) : (
                            <span className="model-token-sub">—</span>
                          )}
                        </td>
                        <td>
                          {diag ? (
                            <span className={`diag-badge ${diag.cls}`}>{diag.label}</span>
                          ) : (
                            <span className="model-token-sub">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {/* Top sessions */}
          {topSessions.length > 0 && (
            <section className="card">
              <h2>Sessions That Hit the Limit</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Project</th>
                    <th>Limit hits</th>
                    <th>Compactions</th>
                    <th>Cost</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {topSessions.map((s) => (
                    <tr key={s.sessionId}>
                      <td>
                        <div className="model-name-cell">
                          <Link href={`/session/${encodeURIComponent(s.sessionId)}`} className="project-link">
                            {s.aiTitle ?? s.sessionId.slice(0, 8) + "…"}
                          </Link>
                        </div>
                      </td>
                      <td>
                        <Link href={`/project/${encodeURIComponent(s.projectKey)}`} className="project-link">
                          {s.projectName}
                        </Link>
                      </td>
                      <td>
                        <span className="stat-value-limit">{s.limitHitCount}</span>
                      </td>
                      <td>{s.compactionCount > 0 ? s.compactionCount : <span className="model-token-sub">—</span>}</td>
                      <td>{fmtCost(s.totalCost)}</td>
                      <td className="model-token-sub">{fmtDate(s.firstTimestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}
