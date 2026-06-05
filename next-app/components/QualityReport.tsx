"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { InfoModal } from "./InfoModal";

type ModalKey = "successRate" | "friction" | "interruptions" | null;

interface SessionRow {
  sessionId: string;
  projectName: string;
  projectKey: string | null;
  title: string;
  startTime: string | null;
  durationMinutes: number;
  outcome: string | null;
  helpfulness: string | null;
  sessionType: string | null;
  gitCommits: number;
  gitPushes: number;
  linesAdded: number;
  linesRemoved: number;
  toolErrors: number;
  interruptions: number;
  friction: string[];
  cost: number | null;
}

interface ProjectRow {
  projectName: string;
  projectKey: string | null;
  sessions: number;
  scoredSessions: number;
  achievedRate: number;
  gitCommits: number;
  linesAdded: number;
  avgDurationMinutes: number;
  totalCost: number;
}

interface FeatureAdoptionRow {
  name: string;
  count: number;
  pct: number;
}

interface FrictionFeedRow {
  sessionId: string;
  projectName: string;
  outcome: string | null;
  frictionTypes: string[];
  detail: string;
}

interface QualityData {
  hasData: boolean;
  global: {
    scoredSessions: number;
    metaSessions: number;
    successRate: number;
    frictionRate: number;
    avgDurationMinutes: number;
    totalDurationMinutes: number;
    totalCommits: number;
    totalPushes: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
    totalFilesModified: number;
    totalInterruptions: number;
    totalToolErrors: number;
  };
  outcomeCounts: Record<string, number>;
  helpfulnessCounts: Record<string, number>;
  sessionTypeCounts: Record<string, number>;
  primarySuccessCounts: Record<string, number>;
  satisfactionCounts: Record<string, number>;
  frictionCounts: Record<string, number>;
  topGoalCategories: Array<{ name: string; count: number }>;
  topTools: Array<{ name: string; count: number }>;
  languageMix: Array<{ name: string; count: number }>;
  costByOutcome: {
    achievedAvgCost: number;
    notAchievedAvgCost: number;
    achievedCount: number;
    notAchievedCount: number;
  };
  featureAdoption: FeatureAdoptionRow[];
  frictionFeed: FrictionFeedRow[];
  recentSessions: SessionRow[];
  projectBreakdown: ProjectRow[];
}

function prettify(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtCost(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.005) return `$${n.toFixed(2)}`;
  return `<$0.01`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(0)}%`;
}

function fmtDuration(min: number): string {
  if (min >= 60) return `${(min / 60).toFixed(1)}h`;
  return `${Math.round(min)}m`;
}

function fmtNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const OUTCOME_CLASS: Record<string, string> = {
  fully_achieved: "q-pos",
  mostly_achieved: "q-pos",
  partially_achieved: "q-warn",
  unclear_from_transcript: "q-muted",
  not_achieved: "q-neg",
};

function Distribution({
  title,
  counts,
  positive,
}: {
  title: string;
  counts: Record<string, number>;
  positive?: Set<string>;
}) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return null;
  return (
    <section className="card">
      <h2>{title}</h2>
      <table className="table">
        <tbody>
          {entries.map(([key, count]) => (
            <tr key={key}>
              <td style={{ width: "40%" }}>
                <span className={positive?.has(key) ? "q-pos" : undefined}>{prettify(key)}</span>
              </td>
              <td>
                <div className="model-cost-cell">
                  <span>
                    {count} · {fmtPct((count / total) * 100)}
                  </span>
                  <div className="model-share-bar-track">
                    <div
                      className="model-share-bar-fill"
                      style={{ width: `${(count / total) * 100}%` }}
                    />
                  </div>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CollapsibleCard({
  title,
  children,
  defaultOpen = false,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="card">
      <div className="collapsible-header" onClick={() => setOpen((o) => !o)}>
        <h2>{title}</h2>
        <span className="collapse-chevron">{open ? "−" : "+"}</span>
      </div>
      {open && <div className="collapsible-body">{children}</div>}
    </section>
  );
}

export function QualityReport() {
  const [data, setData] = useState<QualityData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKey>(null);

  useEffect(() => {
    fetch("/api/quality")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="page-error">{error}</div>;
  if (!data) return <div className="page-loading">Loading…</div>;

  const g = data.global;

  return (
    <div className="page">
      <div className="page-header">
        <Link href="/" className="back-link">← Dashboard</Link>
      </div>
      <div>
        <h1>Session Quality</h1>
        <p className="page-subtitle">
          Qualitative scoring Claude Code writes per session (outcome, helpfulness, friction) joined
          with activity metrics (duration, commits, lines changed) and cost.
        </p>
      </div>

      {!data.hasData ? (
        <div className="card">
          <p>
            No session-quality data found in <code>~/.claude/usage-data/</code>. Claude Code writes
            these facet files automatically over time.
          </p>
        </div>
      ) : (
        <>
          {/* Headline pills */}
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-value">{fmtPct(g.successRate)}</span>
              <span className="stat-label">
                Success rate
                <button className="info-btn" onClick={() => setModal("successRate")}>?</button>
              </span>
              <span className="stat-sub">fully + mostly achieved · {g.scoredSessions} scored</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{fmtPct(g.frictionRate)}</span>
              <span className="stat-label stat-label-wrap">
                Sessions with friction
                <button className="info-btn" onClick={() => setModal("friction")}>?</button>
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{fmtDuration(g.avgDurationMinutes)}</span>
              <span className="stat-label">Avg session length</span>
              <span className="stat-sub">{fmtDuration(g.totalDurationMinutes)} total</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{g.totalCommits}</span>
              <span className="stat-label">Git commits</span>
              <span className="stat-sub">{g.totalPushes} pushes</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">+{fmtNum(g.totalLinesAdded)}</span>
              <span className="stat-label">Lines added</span>
              <span className="stat-sub">−{fmtNum(g.totalLinesRemoved)} removed · {g.totalFilesModified} files</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{g.totalInterruptions}</span>
              <span className="stat-label stat-label-wrap">
                User interruptions
                <button className="info-btn" onClick={() => setModal("interruptions")}>?</button>
              </span>
              <span className="stat-sub">{g.totalToolErrors} tool errors</span>
            </div>
          </div>

          {/* How metrics are calculated */}
          <CollapsibleCard title="How these metrics are calculated">
            <p className="section-desc">
              These numbers are not heuristics computed from logs. After each session, Claude Code reads
              the full transcript and writes a <strong>facet file</strong> to{" "}
              <code>~/.claude/usage-data/facets/</code> grading the session, plus a{" "}
              <strong>metadata file</strong> to <code>~/.claude/usage-data/session-meta/</code> with raw
              activity counts. This page joins the two. So the qualitative scores reflect Claude&apos;s own
              judgement of the conversation, while the activity figures are mechanical counts.
            </p>

            <h3 className="method-h">Success rate</h3>
            <p className="method-p">
              Claude grades every scored session&apos;s <code>outcome</code> as one of:{" "}
              <span className="q-pos">fully achieved</span>, <span className="q-pos">mostly achieved</span>,{" "}
              <span className="q-warn">partially achieved</span>,{" "}
              <span className="q-muted">unclear from transcript</span>, or{" "}
              <span className="q-neg">not achieved</span>. Success rate counts the top two buckets:
            </p>
            <pre className="method-formula">successRate = (fully_achieved + mostly_achieved) / scoredSessions × 100</pre>
            <p className="method-p">
              The denominator is only sessions that actually received a facet score
              ({g.scoredSessions} here), <em>not</em> every session — a session with no transcript to
              judge is excluded rather than counted as a failure. The full split is in the{" "}
              <em>Outcomes</em> breakdown below.
            </p>

            <h3 className="method-h">Sessions with friction</h3>
            <p className="method-p">
              While scoring, Claude flags <strong>friction events</strong> — moments where the work
              didn&apos;t go smoothly — into a <code>friction_counts</code> map keyed by type (e.g.{" "}
              wrong approach, user rejected an action, buggy code, misunderstood request, session
              interruption). A session counts toward this metric if it has <em>any</em> friction event,
              regardless of how many:
            </p>
            <pre className="method-formula">frictionRate = sessionsWithAnyFriction / scoredSessions × 100</pre>
            <p className="method-p">
              High friction isn&apos;t inherently bad — iterative course-correction is normal work. The
              actual notes Claude wrote per session are in <em>What Went Wrong</em>, and the type split is
              in <em>Friction Types</em>.
            </p>

            <h3 className="method-h">Activity metrics (mechanical)</h3>
            <p className="method-p">
              Avg session length, git commits/pushes, lines added/removed, files modified, user
              interruptions, and tool errors are <strong>summed directly from session metadata</strong> —
              no judgement involved. Interruptions count Esc presses; tool errors count failed tool calls
              (e.g. a non-zero Bash exit or an edit that didn&apos;t apply). Feature adoption counts how
              many sessions used sub-agents, MCP tools, web search, or web fetch.
            </p>

            <h3 className="method-h">Cost by outcome</h3>
            <p className="method-p">
              Per-session cost comes from the analyzer cache (parsed token usage × model pricing), joined
              to the facet outcome. We then average cost separately for achieved vs not-achieved sessions —
              a rough read on whether spend is buying results.
            </p>

            <p className="method-note">
              Because grading is Claude&apos;s own assessment of a conversation, treat these as a
              directional signal, not an exact measurement. Scores can vary with how a session was
              summarized.
            </p>
          </CollapsibleCard>

          {/* Feature adoption */}
          {data.featureAdoption.length > 0 && (
            <section className="card">
              <h2>Feature Adoption</h2>
              <p className="section-desc">
                Share of sessions (of {g.metaSessions} with activity metadata) that used each Claude Code
                capability — how much of the toolset your workflow actually reaches for.
              </p>
              <table className="table">
                <tbody>
                  {data.featureAdoption.map((feat) => (
                    <tr key={feat.name}>
                      <td style={{ width: "40%" }}>{feat.name}</td>
                      <td>
                        <div className="model-cost-cell">
                          <span>
                            {feat.count} · {fmtPct(feat.pct)}
                          </span>
                          <div className="model-share-bar-track">
                            <div className="model-share-bar-fill" style={{ width: `${feat.pct}%` }} />
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Cost by outcome */}
          {(data.costByOutcome.achievedCount > 0 || data.costByOutcome.notAchievedCount > 0) && (
            <section className="card">
              <h2>Cost by Outcome</h2>
              <p className="section-desc">
                Average session cost for goals that were achieved vs not — is spend buying results?
              </p>
              <div className="cost-compare-grid">
                <div className="cost-compare-block cost-compare-clean">
                  <div className="cost-compare-label">Achieved</div>
                  <div className="cost-compare-value">{fmtCost(data.costByOutcome.achievedAvgCost)}</div>
                  <div className="cost-compare-sub">avg · {data.costByOutcome.achievedCount} sessions</div>
                </div>
                <div className="cost-compare-vs"><span>vs</span></div>
                <div className="cost-compare-block cost-compare-compacted">
                  <div className="cost-compare-label">Not achieved</div>
                  <div className="cost-compare-value">{fmtCost(data.costByOutcome.notAchievedAvgCost)}</div>
                  <div className="cost-compare-sub">avg · {data.costByOutcome.notAchievedCount} sessions</div>
                </div>
              </div>
            </section>
          )}

          {/* Distributions */}
          <Distribution
            title="Outcomes"
            counts={data.outcomeCounts}
            positive={new Set(["fully_achieved", "mostly_achieved"])}
          />
          <Distribution
            title="Claude Helpfulness"
            counts={data.helpfulnessCounts}
            positive={new Set(["very_helpful", "moderately_helpful"])}
          />
          <Distribution title="Session Type" counts={data.sessionTypeCounts} />
          <Distribution title="Primary Success Mode" counts={data.primarySuccessCounts} />
          <Distribution title="Friction Types" counts={data.frictionCounts} />

          {/* Friction detail feed */}
          {data.frictionFeed.length > 0 && (
            <section className="card">
              <h2>What Went Wrong</h2>
              <p className="section-desc">
                Claude&apos;s own notes on where each session hit friction — the &quot;why&quot; behind the
                counts above. Most friction-heavy sessions first.
              </p>
              <ul className="friction-feed">
                {data.frictionFeed.map((fr) => (
                  <li key={fr.sessionId} className="friction-feed-item">
                    <div className="friction-feed-head">
                      <Link href={`/session/${fr.sessionId}`} className="project-link">
                        {fr.projectName}
                      </Link>
                      {fr.outcome && (
                        <span className={OUTCOME_CLASS[fr.outcome]}>{prettify(fr.outcome)}</span>
                      )}
                      {fr.frictionTypes.map((t) => (
                        <span key={t} className="friction-tag">{prettify(t)}</span>
                      ))}
                    </div>
                    <p className="friction-feed-detail">{fr.detail}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Goal categories */}
          {data.topGoalCategories.length > 0 && (
            <section className="card">
              <h2>Top Goal Categories</h2>
              <table className="table">
                <tbody>
                  {data.topGoalCategories.map((g0) => {
                    const max = data.topGoalCategories[0]?.count ?? 1;
                    return (
                      <tr key={g0.name}>
                        <td style={{ width: "40%" }}>{prettify(g0.name)}</td>
                        <td>
                          <div className="model-cost-cell">
                            <span>{g0.count}</span>
                            <div className="model-share-bar-track">
                              <div className="model-share-bar-fill" style={{ width: `${(g0.count / max) * 100}%` }} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {/* Tools + languages side by side */}
          <div className="quality-two-col">
            {data.topTools.length > 0 && (
              <section className="card">
                <h2>Most-Used Tools</h2>
                <table className="table">
                  <tbody>
                    {data.topTools.map((t) => {
                      const max = data.topTools[0]?.count ?? 1;
                      return (
                        <tr key={t.name}>
                          <td style={{ width: "45%" }}><code>{t.name}</code></td>
                          <td>
                            <div className="model-cost-cell">
                              <span>{fmtNum(t.count)}</span>
                              <div className="model-share-bar-track">
                                <div className="model-share-bar-fill" style={{ width: `${(t.count / max) * 100}%` }} />
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            )}
            {data.languageMix.length > 0 && (
              <section className="card">
                <h2>Language Mix</h2>
                <table className="table">
                  <tbody>
                    {data.languageMix.map((l) => {
                      const max = data.languageMix[0]?.count ?? 1;
                      return (
                        <tr key={l.name}>
                          <td style={{ width: "45%" }}>{l.name}</td>
                          <td>
                            <div className="model-cost-cell">
                              <span>{l.count}</span>
                              <div className="model-share-bar-track">
                                <div className="model-share-bar-fill" style={{ width: `${(l.count / max) * 100}%` }} />
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            )}
          </div>

          {/* Project breakdown */}
          {data.projectBreakdown.length > 0 && (
            <section className="card">
              <h2>Projects by Quality</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Success</th>
                    <th>Sessions</th>
                    <th>Commits</th>
                    <th>Lines +</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projectBreakdown.map((p) => (
                    <tr key={p.projectKey ?? p.projectName}>
                      <td>
                        {p.projectKey ? (
                          <Link href={`/project/${encodeURIComponent(p.projectKey)}`} className="project-link">
                            {p.projectName}
                          </Link>
                        ) : (
                          p.projectName
                        )}
                      </td>
                      <td>{p.scoredSessions > 0 ? fmtPct(p.achievedRate) : "—"}</td>
                      <td>{p.sessions}</td>
                      <td>{p.gitCommits}</td>
                      <td>+{fmtNum(p.linesAdded)}</td>
                      <td>{fmtCost(p.totalCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Recent sessions */}
          {data.recentSessions.length > 0 && (
            <section className="card">
              <h2>Recent Scored Sessions</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Outcome</th>
                    <th>Length</th>
                    <th>Commits</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentSessions.map((s) => (
                    <tr key={s.sessionId}>
                      <td>
                        <div className="model-name-cell">
                          <Link href={`/session/${s.sessionId}`} className="project-link">
                            {s.title.length > 80 ? `${s.title.slice(0, 80)}…` : s.title}
                          </Link>
                          <span className="model-token-sub">
                            {s.projectName}
                            {s.friction.length > 0 && ` · friction: ${s.friction.map(prettify).join(", ")}`}
                          </span>
                        </div>
                      </td>
                      <td>
                        {s.outcome ? (
                          <span className={OUTCOME_CLASS[s.outcome]}>{prettify(s.outcome)}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{fmtDuration(s.durationMinutes)}</td>
                      <td>{s.gitCommits}</td>
                      <td>{fmtCost(s.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {modal === "successRate" && (
        <InfoModal title="Success Rate" onClose={() => setModal(null)}>
          <p>
            Share of <em>scored</em> sessions where Claude rated the outcome as
            <strong> fully achieved</strong> or <strong>mostly achieved</strong>.
          </p>
          <p>
            After a session, Claude Code writes a facet file to <code>~/.claude/usage-data/facets/</code>
            grading the outcome as one of: fully achieved, mostly achieved, partially achieved,
            not achieved, or unclear. This metric counts the top two buckets.
          </p>
          <p className="modal-example">
            Denominator is sessions that actually have a facet score ({data.global.scoredSessions} here),
            not every session. See the Outcomes breakdown below for the full distribution.
          </p>
        </InfoModal>
      )}

      {modal === "friction" && (
        <InfoModal title="Sessions with Friction" onClose={() => setModal(null)}>
          <p>
            Share of scored sessions where Claude flagged at least one <strong>friction event</strong> —
            a moment where the work didn't go smoothly.
          </p>
          <p>
            Friction types include: wrong approach, user rejected an action, buggy code, misunderstood
            request, and session interruption. A single session can have several; this metric counts a
            session once if it has any.
          </p>
          <p className="modal-example">
            High friction isn't necessarily bad — iterative refinement and course-corrections are normal.
            The Friction Types breakdown below shows which kinds are most common.
          </p>
        </InfoModal>
      )}

      {modal === "interruptions" && (
        <InfoModal title="User Interruptions" onClose={() => setModal(null)}>
          <p>
            Total number of times you pressed Esc (or otherwise stopped Claude) mid-response across all
            sessions — summed from each session's metadata.
          </p>
          <p>
            Interruptions usually mean Claude was heading the wrong way and you redirected it, so this is
            a rough signal of how often output needed steering.
          </p>
          <p className="modal-example">
            The sub-figure (tool errors) counts failed tool calls — e.g. a Bash command that exited
            non-zero or an edit that didn't apply.
          </p>
        </InfoModal>
      )}
    </div>
  );
}
