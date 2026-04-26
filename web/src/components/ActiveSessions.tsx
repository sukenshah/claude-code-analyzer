import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtCost, fmtTokens } from "../api.js";
import type { ActiveSession } from "../types.js";

function timeAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function ActiveSessions() {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const data = await api.activeSessions();
        if (mounted) setSessions(data);
      } catch { /* ignore polling errors */ }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  if (sessions.length === 0) return null;

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <h2>Live Sessions</h2>
      <div className="active-sessions">
        {sessions.map((s) => {
          const isHot = s.secondsAgo < 120;
          return (
            <div key={s.sessionId} className="active-session-row">
              <span className={`live-dot ${isHot ? "live-dot-hot" : "live-dot-warm"}`} />
              <div className="active-session-main">
                <Link to={`/session/${s.sessionId}`} className="link active-session-title">
                  {s.aiTitle ?? s.sessionId.slice(0, 12) + "…"}
                </Link>
                <div className="active-session-meta">
                  <Link to={`/project/${encodeURIComponent(s.projectKey)}`} className="link">
                    {s.projectName}
                  </Link>
                  {s.gitBranch && s.gitBranch !== "HEAD" && (
                    <span className="badge badge-branch">⎇ {s.gitBranch}</span>
                  )}
                  {s.entrypoint && (
                    <span className="badge">{s.entrypoint.replace("claude-", "")}</span>
                  )}
                </div>
              </div>
              <div className="active-session-stats">
                <span className="active-stat">{s.turnCount} turns</span>
                <span className="active-stat">{fmtTokens(s.totals.input_tokens + s.totals.output_tokens)} tokens</span>
                <span className="active-stat-cost">{fmtCost(s.totalCost)}</span>
                <span className="active-time">{timeAgo(s.secondsAgo)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
