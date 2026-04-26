import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, fmtCost, fmtTokens } from "../api.js";
import type { SessionDetail, RawMessage, TurnRecord, ToolUse } from "../types.js";
import { TokenBar } from "../components/TokenBar.js";
import { Breadcrumb } from "../components/Breadcrumb.js";
import { usePagination, Pagination } from "../components/Pagination.js";

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSubagents, setShowSubagents] = useState(false);
  const [messages, setMessages] = useState<RawMessage[] | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [msgFilter, setMsgFilter] = useState<"all" | "user" | "assistant" | "system" | "summary" | "output">("all");
  const [msgSearch, setMsgSearch] = useState("");

  useEffect(() => {
    if (!id) return;
    api.session(id)
      .then(setSession)
      .catch((e) => setError(String(e)));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    setMessagesLoading(true);
    api.sessionMessages(id)
      .then(setMessages)
      .catch(() => setMessages([]))
      .finally(() => setMessagesLoading(false));
  }, [id]);

  // Hoisted before early returns so hooks are called unconditionally
  const topLevelTurns = session ? session.turns.filter((t) => !t.isSubagent) : [];
  const filteredMessages = (messages ?? []).filter((m) => {
    const typeMatch = msgFilter === "all" || (msgFilter === "output" ? m.type === "tool_output" : m.type === msgFilter);
    if (!typeMatch) return false;
    if (!msgSearch) return true;
    const q = msgSearch.toLowerCase();
    return [m.text, m.command, m.hookResult, m.systemCaveat, m.toolName]
      .some((v) => v?.toLowerCase().includes(q));
  });
  const { page: msgPage, setPage: setMsgPage, paged: pagedMessages, total: msgTotal } = usePagination(filteredMessages);

  if (error) return <div className="error">{error}</div>;
  if (!session) return <div className="loading">Loading...</div>;

  const subagentTurns = session.turns.filter((t) => t.isSubagent);
  const subagentIds = [...new Set(subagentTurns.map((t) => t.agentId).filter(Boolean))] as string[];

  const totalCostBreakdown = {
    inputCost: session.turns.reduce((s, t) => s + t.cost.inputCost, 0),
    outputCost: session.turns.reduce((s, t) => s + t.cost.outputCost, 0),
    cacheWriteCost: session.turns.reduce((s, t) => s + t.cost.cacheWriteCost, 0),
    cacheReadCost: session.turns.reduce((s, t) => s + t.cost.cacheReadCost, 0),
  };

  // Build UUID → TurnRecord map for inline cost display
  const turnByUuid = new Map(topLevelTurns.map((t) => [t.uuid, t]));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <Breadcrumb crumbs={[
            { label: "Dashboard", href: "/" },
            { label: session.projectName, href: `/project/${encodeURIComponent(session.projectKey)}` },
            { label: session.meta.aiTitle ?? session.sessionId.slice(0, 8) + "…" },
          ]} />
          <h1>{session.meta.aiTitle ?? "Session"}</h1>
          <code className="path">{session.sessionId}</code>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Project</div>
          <div className="stat-value small">
            <Link to={`/project/${encodeURIComponent(session.projectKey)}`} className="link">
              {session.projectName}
            </Link>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Date</div>
          <div className="stat-value small">{session.lastTimestamp.slice(0, 16).replace("T", " ")}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Turns</div>
          <div className="stat-value">{topLevelTurns.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Subagents</div>
          <div className="stat-value">{subagentIds.length || "—"}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Cost</div>
          <div className="stat-value">{fmtCost(session.totalCost)}</div>
        </div>
        {session.meta.limitHitCount > 0 && (
          <div className="stat-card stat-card-limit">
            <div className="stat-label">Limit Reached</div>
            <div className="stat-value stat-value-limit">{session.meta.limitHitCount}×</div>
          </div>
        )}
      </div>

      <section className="card">
        <h2>Token Breakdown</h2>
        <TokenBar usage={session.totals} costs={totalCostBreakdown} />
      </section>

      <section className="card">
        <h2>Session Info</h2>
        <div className="meta-grid">
          {session.meta.entrypoint && (
            <div className="meta-row">
              <span className="meta-label">Client</span>
              <span className="meta-value">{session.meta.entrypoint}</span>
            </div>
          )}
          {session.meta.gitBranch && (
            <div className="meta-row">
              <span className="meta-label">Git branch</span>
              <span className="meta-value mono">{session.meta.gitBranch}</span>
            </div>
          )}
          {session.meta.permissionMode && (
            <div className="meta-row">
              <span className="meta-label">Permission mode</span>
              <span className="meta-value">{session.meta.permissionMode}</span>
            </div>
          )}
          {session.meta.version && (
            <div className="meta-row">
              <span className="meta-label">Claude Code version</span>
              <span className="meta-value mono">{session.meta.version}</span>
            </div>
          )}
          {session.meta.mcpTools.length > 0 && (
            <div className="meta-row meta-row-wrap">
              <span className="meta-label">MCP tools</span>
              <div className="meta-tags">
                {session.meta.mcpTools.map((t) => (
                  <span key={t} className="badge">{t.replace("mcp__", "")}</span>
                ))}
              </div>
            </div>
          )}
          {session.meta.compactEvents.length > 0 && (
            <div className="meta-row meta-row-wrap">
              <span className="meta-label">Context compactions</span>
              <div className="compact-events">
                {session.meta.compactEvents.map((ev, i) => (
                  <div key={i} className="compact-event">
                    <span className="meta-value mono">{ev.timestamp.slice(11, 19)}</span>
                    <span className="compact-detail">{ev.trigger} · {(ev.preTokens / 1000).toFixed(1)}K → {(ev.postTokens / 1000).toFixed(1)}K tokens · {(ev.durationMs / 1000).toFixed(1)}s</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            Timeline
            {msgSearch && <span className="search-count"> ({msgTotal} of {(messages ?? []).length})</span>}
          </h2>
          <div className="sort-buttons">
            Filter:
            {(["all", "user", "assistant", "output", "system", "summary"] as const).map((f) => (
              <button key={f} className={`btn-sort ${msgFilter === f ? "active" : ""}`} onClick={() => { setMsgFilter(f); setMsgPage(1); }}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>
            ))}
          </div>
        </div>
        <input
          className="search-input"
          type="search"
          placeholder="Search timeline…"
          value={msgSearch}
          onChange={(e) => { setMsgSearch(e.target.value); setMsgPage(1); }}
        />
        {messagesLoading
          ? <div className="loading" style={{ padding: "20px 0" }}>Loading…</div>
          : <>
              <MessageList messages={pagedMessages} turnByUuid={turnByUuid} />
              <Pagination page={msgPage} total={msgTotal} onChange={setMsgPage} />
            </>
        }
      </section>

      {subagentIds.length > 0 && (
        <section className="card">
          <div className="section-header">
            <h2>Subagents ({subagentIds.length})</h2>
            <button className="btn-secondary" onClick={() => setShowSubagents(!showSubagents)}>
              {showSubagents ? "Hide" : "Show"} turns
            </button>
          </div>
          {subagentIds.map((agentId) => (
            <SubagentSection
              key={agentId}
              agentId={agentId}
              turns={subagentTurns.filter((t) => t.agentId === agentId)}
              showTurns={showSubagents}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function SubagentSection({ agentId, turns, showTurns }: { agentId: string; turns: TurnRecord[]; showTurns: boolean }) {
  const agentCost = turns.reduce((s, t) => s + t.cost.totalCost, 0);
  const agentTokens = turns.reduce((s, t) => ({
    input_tokens: s.input_tokens + t.usage.input_tokens,
    output_tokens: s.output_tokens + t.usage.output_tokens,
    cache_creation_input_tokens: s.cache_creation_input_tokens + t.usage.cache_creation_input_tokens,
    cache_read_input_tokens: s.cache_read_input_tokens + t.usage.cache_read_input_tokens,
  }), { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

  const { page, setPage, paged, total } = usePagination(turns);

  return (
    <div className="subagent-section">
      <div className="subagent-header">
        <code>{agentId}</code>
        <span>{turns.length} turns · {fmtCost(agentCost)}</span>
      </div>
      <TokenBar usage={agentTokens} height={16} />
      {showTurns && (
        <>
          <table className="table table-sm" style={{ marginTop: 10 }}>
            <thead>
              <tr><th>#</th><th>Time</th><th>Model</th><th>In</th><th>Out</th><th>Cost</th></tr>
            </thead>
            <tbody>
              {paged.map((t, i) => (
                <tr key={t.uuid}>
                  <td>{(page - 1) * 10 + i + 1}</td>
                  <td>{t.timestamp.slice(11, 19)}</td>
                  <td><code>{t.model.replace("claude-", "")}</code></td>
                  <td>{fmtTokens(t.usage.input_tokens)}</td>
                  <td>{fmtTokens(t.usage.output_tokens)}</td>
                  <td>{fmtCost(t.cost.totalCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} total={total} onChange={setPage} />
        </>
      )}
    </div>
  );
}

const TRUNCATE_AT = 500;

function MessageList({ messages, turnByUuid }: { messages: RawMessage[]; turnByUuid: Map<string, TurnRecord> }) {
  if (messages.length === 0) return <p style={{ color: "var(--text2)", fontSize: 13 }}>No messages found.</p>;
  return (
    <div className="msg-list">
      {messages.map((m) => {
        const turn = m.type === "tool_output"
          ? turnByUuid.get(m.parentAssistantUuid ?? "")
          : turnByUuid.get(m.uuid);
        return <MessageRow key={m.uuid} message={m} turn={turn} />;
      })}
    </div>
  );
}

function TruncatedPre({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = !expanded && text.length > TRUNCATE_AT;
  return (
    <>
      <pre className={className}>{truncated ? text.slice(0, TRUNCATE_AT) + "…" : text}</pre>
      {truncated && <button className="msg-expand" onClick={() => setExpanded(true)}>show more</button>}
    </>
  );
}

function fmtK(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function ToolOutputRow({ message: m, turn }: { message: RawMessage; turn?: TurnRecord }) {
  const [expanded, setExpanded] = useState(false);
  const text = m.text ?? "";

  return (
    <div className="msg-row msg-row-tool-output">
      <div className="msg-role">
        output
        <div className="msg-time">{m.timestamp.slice(11, 19)}</div>
      </div>
      <div className="msg-body">
        <div className="msg-tool-output-header">
          <code className="msg-tool-output-name">{m.toolName ?? "tool"}</code>
          <button className="msg-expand" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "collapse" : "expand"}
          </button>
        </div>
        <pre className={`msg-text msg-tool-output-pre ${expanded ? "msg-tool-output-expanded" : "msg-tool-output-collapsed"}`}>
          {text}
        </pre>
        {turn && (
          <div className="msg-turn-chip">
            <span className="msg-turn-model">{turn.model.replace("claude-", "")}</span>
            <span className="msg-turn-stat">↓ {fmtK(turn.usage.input_tokens)}</span>
            <span className="msg-turn-stat">↑ {fmtK(turn.usage.output_tokens)}</span>
            {turn.usage.cache_read_input_tokens > 0 && (
              <span className="msg-turn-stat msg-turn-cache">⚡ {fmtK(turn.usage.cache_read_input_tokens)} cached</span>
            )}
            <span className="msg-turn-cost">{fmtCost(turn.cost.totalCost)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageRow({ message: m, turn }: { message: RawMessage; turn?: TurnRecord }) {
  if (m.type === "system") {
    if (m.subtype === "compact") {
      const meta = m.compactMeta;
      const isAuto = meta?.trigger === "auto";
      return (
        <div className={`msg-divider msg-divider-compact ${isAuto ? "msg-divider-compact-auto" : ""}`}>
          <span className="msg-divider-icon">{isAuto ? "⚡" : "📦"}</span>
          <span>
            {isAuto ? "Context limit reached" : "Context compacted"}
            {meta && (
              <span className="msg-divider-detail">
                {" "}— {fmtK(meta.preTokens)} → {fmtK(meta.postTokens)} tokens
              </span>
            )}
          </span>
          <span className="msg-divider-time">{m.timestamp.slice(11, 19)}</span>
        </div>
      );
    }
    if (m.subtype === "api_error") {
      const err = m.apiError;
      const label = err?.status === 429 ? "Rate limit hit"
        : err?.status === 529 ? "API overloaded"
        : err?.code === "ECONNRESET" ? "Connection reset"
        : "API error";
      const retryInfo = err?.retryAttempt != null
        ? ` (retry ${err.retryAttempt}/${err.maxRetries ?? "?"})`
        : "";
      return (
        <div className="msg-divider msg-divider-api-error">
          <span className="msg-divider-icon">⚠</span>
          <span>{label}{retryInfo}</span>
          <span className="msg-divider-time">{m.timestamp.slice(11, 19)}</span>
        </div>
      );
    }
    return (
      <div className="msg-divider">
        <span>{m.text}</span>
        <span className="msg-divider-time">{m.timestamp.slice(11, 19)}</span>
      </div>
    );
  }

  if (m.subtype === "limit_reached") {
    return (
      <div className="msg-limit-reached">
        <span className="msg-limit-icon">🚫</span>
        <div className="msg-limit-body">
          <span className="msg-limit-title">Usage limit reached</span>
          {m.text && <span className="msg-limit-detail">{m.text}</span>}
        </div>
        <span className="msg-divider-time">{m.timestamp.slice(11, 19)}</span>
      </div>
    );
  }

  if (m.type === "tool_output") {
    return <ToolOutputRow message={m} turn={turn} />;
  }

  const hasStructured = m.command || m.hookResult || m.systemCaveat;

  return (
    <div className={`msg-row msg-row-${m.type}`}>
      <div className="msg-role">
        {m.type === "summary" ? "summary" : m.type}
        <div className="msg-time">{m.timestamp.slice(11, 19)}</div>
      </div>
      <div className="msg-body">
        {m.text && <TruncatedPre text={m.text} className="msg-text" />}
        {hasStructured && (
          <div className="msg-structured">
            {m.command && (
              <div className="msg-field">
                <span className="msg-field-label">command</span>
                <TruncatedPre text={m.command} className="msg-field-pre" />
              </div>
            )}
            {m.hookResult && (
              <div className="msg-field">
                <span className="msg-field-label">hook_result</span>
                <TruncatedPre text={m.hookResult} className="msg-field-pre" />
              </div>
            )}
            {m.systemCaveat && (
              <div className="msg-field msg-field-caveat">
                <span className="msg-field-label">system_caveat</span>
                <TruncatedPre text={m.systemCaveat} className="msg-field-pre" />
              </div>
            )}
          </div>
        )}
        {m.toolUses.length > 0 && (
          <div className="msg-tools">
            {m.toolUses.map((tool: ToolUse, i) => (
              <>
                <span key={i} className="badge msg-tool-badge">
                  <span className="msg-tool-name">{tool.name}</span>
                </span>
                {tool.title && <span className="msg-text">{tool.title}</span>}
              </>
            ))}
          </div>
        )}
        {m.type === "assistant" && turn && (
          <div className="msg-turn-chip">
            <span className="msg-turn-model">{turn.model.replace("claude-", "")}</span>
            <span className="msg-turn-stat">↓ {fmtK(turn.usage.input_tokens)}</span>
            <span className="msg-turn-stat">↑ {fmtK(turn.usage.output_tokens)}</span>
            {turn.usage.cache_read_input_tokens > 0 && (
              <span className="msg-turn-stat msg-turn-cache">⚡ {fmtK(turn.usage.cache_read_input_tokens)} cached</span>
            )}
            <span className="msg-turn-cost">{fmtCost(turn.cost.totalCost)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
