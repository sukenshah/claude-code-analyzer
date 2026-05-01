"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api, fmtCost, fmtTokens } from "@/lib/api";
import type { ProjectDetail, ClaudeMdFile, SessionSummary } from "@/lib/types";
import { TokenBar } from "./TokenBar";
import { Breadcrumb } from "./Breadcrumb";
import { usePagination, Pagination } from "./Pagination";

export function ProjectPage() {
  const params = useParams<{ key: string }>();
  const key = params?.key;
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<"date" | "cost" | "tokens">("date");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!key) return;
    api.project(decodeURIComponent(key))
      .then(setProject)
      .catch((e) => setError(String(e)));
  }, [key]);

  const sessions = project
    ? [...project.sessions]
        .filter((s) => {
          if (!search) return true;
          const q = search.toLowerCase();
          return (s.meta.aiTitle ?? s.sessionId).toLowerCase().includes(q);
        })
        .sort((a, b) => {
          if (sort === "cost") return b.totalCost - a.totalCost;
          if (sort === "tokens") return (b.totals.input_tokens + b.totals.output_tokens) - (a.totals.input_tokens + a.totals.output_tokens);
          return b.lastTimestamp.localeCompare(a.lastTimestamp);
        })
    : [];

  const { page: sessionsPage, setPage: setSessionsPage, paged: pagedSessions, total: sessionsTotal } = usePagination(sessions);

  if (error) return <div className="error">{error}</div>;
  if (!project) return <div className="loading">Loading...</div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <Breadcrumb crumbs={[
            { label: "Dashboard", href: "/" },
            { label: project.projectName },
          ]} />
          <h1>{project.projectName}</h1>
          <code className="path">{project.projectPath}</code>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Total Cost</div>
          <div className="stat-value">{fmtCost(project.totalCost)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Sessions</div>
          <div className="stat-value">{project.sessionCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Input Tokens</div>
          <div className="stat-value">{fmtTokens(project.totals.input_tokens)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Output Tokens</div>
          <div className="stat-value">{fmtTokens(project.totals.output_tokens)}</div>
        </div>
        {project.limitHitCount > 0 && (
          <div className="stat-card stat-card-limit">
            <div className="stat-label">Limit Reached</div>
            <div className="stat-value stat-value-limit">{project.limitHitCount}×</div>
          </div>
        )}
      </div>

      <section className="card">
        <h2>Token Breakdown</h2>
        <TokenBar usage={project.totals} />
      </section>

      {project.claudeMd.files.length > 0 && (
        <section className="card">
          <h2>CLAUDE.md Context Overhead</h2>
          <p className="claude-md-note">
            Each session loads these files into the system prompt. Estimated tokens and per-session cost use the Sonnet 4.6 input rate ($3/M tokens).
          </p>
          <table className="table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Est. Tokens</th>
                <th>Cost / Session</th>
              </tr>
            </thead>
            <tbody>
              {project.claudeMd.files.map((f: ClaudeMdFile) => (
                <tr key={f.filePath}>
                  <td><code>{f.relativePath}</code></td>
                  <td>{(f.sizeBytes / 1024).toFixed(1)} KB</td>
                  <td>{fmtTokens(f.estimatedTokens)}</td>
                  <td>{fmtCost(f.perSessionCostUsd)}</td>
                </tr>
              ))}
            </tbody>
            {project.claudeMd.files.length > 1 && (
              <tfoot>
                <tr>
                  <td colSpan={2} style={{ color: "var(--text2)", fontSize: 12 }}>Total</td>
                  <td><strong>{fmtTokens(project.claudeMd.totalEstimatedTokens)}</strong></td>
                  <td><strong>{fmtCost(project.claudeMd.totalPerSessionCostUsd)}</strong></td>
                </tr>
              </tfoot>
            )}
          </table>
          <p className="claude-md-note" style={{ marginTop: 10 }}>
            Across {project.sessionCount} sessions: ~{fmtCost(project.claudeMd.totalPerSessionCostUsd * project.sessionCount)} cumulative context overhead
            ({((project.claudeMd.totalPerSessionCostUsd * project.sessionCount / (project.totalCost || 1)) * 100).toFixed(1)}% of total project cost)
          </p>
        </section>
      )}

      <McpToolSection sessions={project.sessions} />

      <section className="card">
        <div className="section-header">
          <h2>
            Sessions
            {search
              ? ` (${sessionsTotal} of ${project.sessionCount})`
              : ` (${project.sessionCount})`}
          </h2>
          <div className="sort-buttons">
            Sort:
            {(["date", "cost", "tokens"] as const).map((s) => (
              <button key={s} className={`btn-sort ${sort === s ? "active" : ""}`} onClick={() => setSort(s)}>{s.charAt(0).toUpperCase() + s.slice(1)}</button>
            ))}
          </div>
        </div>
        <input
          className="search-input"
          type="search"
          placeholder="Search sessions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <table className="table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Date</th>
              <th>Turns</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cache Read</th>
              <th>Subagents</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {pagedSessions.map((s) => (
              <tr key={s.sessionId}>
                <td>
                  <Link href={`/session/${s.sessionId}`} className="link">
                    {s.meta.aiTitle ?? s.sessionId.slice(0, 8) + "…"}
                  </Link>
                  <div className="session-badges">
                    {s.meta.entrypoint && <span className="badge">{s.meta.entrypoint.replace("claude-", "")}</span>}
                    {s.meta.gitBranch && s.meta.gitBranch !== "HEAD" && <span className="badge badge-branch">⎇ {s.meta.gitBranch}</span>}
                    {s.meta.compactEvents.length > 0 && <span className="badge badge-compact">{s.meta.compactEvents.length} compact</span>}
                    {s.meta.limitHitCount > 0 && <span className="badge badge-limit">{s.meta.limitHitCount}× limit</span>}
                  </div>
                </td>
                <td>{s.lastTimestamp.slice(0, 16).replace("T", " ")}</td>
                <td>{s.turnCount}</td>
                <td>{fmtTokens(s.totals.input_tokens)}</td>
                <td>{fmtTokens(s.totals.output_tokens)}</td>
                <td>{fmtTokens(s.totals.cache_read_input_tokens)}</td>
                <td>{s.hasSubagents ? `${s.subagentCount}` : "—"}</td>
                <td><strong>{fmtCost(s.totalCost)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination page={sessionsPage} total={sessionsTotal} onChange={setSessionsPage} />
      </section>
    </div>
  );
}

function McpToolSection({ sessions }: { sessions: SessionSummary[] }) {
  const totals: Record<string, number> = {};
  for (const s of sessions) {
    for (const [tool, count] of Object.entries(s.meta.mcpToolCalls ?? {})) {
      totals[tool] = (totals[tool] ?? 0) + count;
    }
  }

  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return null;

  const maxCount = rows[0]?.[1] ?? 1;

  return (
    <section className="card">
      <h2>MCP Tool Usage</h2>
      <p className="section-desc">
        Tool call frequency across all sessions. High-frequency external MCP calls add latency and may carry API costs from the MCP server provider.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Server</th>
            <th>Calls</th>
            <th>Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([tool, count]) => {
            const server = tool.match(/^mcp__([^_]+)__/)?.[1] ?? "";
            const name = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
            return (
              <tr key={tool}>
                <td><code>{name}</code></td>
                <td><span className="badge">{server}</span></td>
                <td>{count}</td>
                <td>
                  <div className="model-cost-cell">
                    <span>{((count / maxCount) * 100).toFixed(0)}%</span>
                    <div className="model-share-bar-track">
                      <div
                        className="model-share-bar-fill"
                        style={{ width: `${(count / maxCount) * 100}%` }}
                      />
                    </div>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
