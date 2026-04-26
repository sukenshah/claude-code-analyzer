import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyze, formatCost } from "@claude-analyzer/analyzer";
import type { AnalysisResult } from "@claude-analyzer/analyzer";

// Cache analysis result for the lifetime of the MCP process
let cachedResult: AnalysisResult | null = null;

async function getResult(forceRefresh = false): Promise<AnalysisResult> {
  if (!cachedResult || forceRefresh) {
    cachedResult = await analyze(forceRefresh);
  }
  return cachedResult;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function cutoffDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "usage-analyzer",
  version: "1.0.0",
});

// ── get_usage_summary ─────────────────────────────────────────────────────────

server.registerTool(
  "get_usage_summary",
  {
    description:
      "Get total token usage and cost breakdown for all Claude Code sessions. " +
      "Optionally filter to a specific project or time window.",
    inputSchema: {
      project: z.string().optional().describe("Project name to filter (e.g. 'maths-guru'). Omit for all projects."),
      days: z.number().optional().default(30).describe("Lookback window in days (default 30). Use 0 for all time."),
    },
  },
  async (input) => {
    const result = await getResult();
    const cutoff = input.days && input.days > 0 ? cutoffDate(input.days) : null;

    let turns = result.allTurns;
    if (cutoff) turns = turns.filter((t) => t.timestamp.slice(0, 10) >= cutoff);
    if (input.project) {
      turns = turns.filter((t) =>
        t.projectKey.toLowerCase().includes(input.project!.toLowerCase())
      );
    }

    if (!turns.length) {
      return { content: [{ type: "text", text: "No data found for the given filters." }] };
    }

    let inputT = 0, outputT = 0, cacheWrite = 0, cacheRead = 0, cost = 0;
    const sessions = new Set<string>();
    for (const t of turns) {
      inputT += t.usage.input_tokens;
      outputT += t.usage.output_tokens;
      cacheWrite += t.usage.cache_creation_input_tokens;
      cacheRead += t.usage.cache_read_input_tokens;
      cost += t.cost.totalCost;
      sessions.add(t.sessionId);
    }

    const totalTokens = inputT + outputT + cacheWrite + cacheRead;
    const cacheHitRate = totalTokens > 0 ? ((cacheRead / totalTokens) * 100).toFixed(1) : "0.0";
    const scope = input.project ? `project: ${input.project}` : "all projects";
    const window = input.days && input.days > 0 ? `last ${input.days} days` : "all time";

    const text = [
      `Usage Summary (${scope}, ${window})`,
      ``,
      `Sessions:         ${sessions.size}`,
      `Turns (prompts):  ${turns.length}`,
      ``,
      `Tokens:`,
      `  Input:          ${fmtTokens(inputT)}`,
      `  Output:         ${fmtTokens(outputT)}`,
      `  Cache write:    ${fmtTokens(cacheWrite)}`,
      `  Cache read:     ${fmtTokens(cacheRead)}  (${cacheHitRate}% of total)`,
      ``,
      `Estimated cost:   ${formatCost(cost)}`,
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── get_project_breakdown ─────────────────────────────────────────────────────

server.registerTool(
  "get_project_breakdown",
  {
    description: "List all Claude Code projects ranked by cost, token usage, or session count.",
    inputSchema: {
      sort_by: z.enum(["cost", "tokens", "sessions"]).optional().default("cost"),
      limit: z.number().optional().default(10),
    },
  },
  async (input) => {
    const result = await getResult();
    const projects = [...result.projects.values()];

    projects.sort((a, b) => {
      if (input.sort_by === "sessions") return b.sessionCount - a.sessionCount;
      if (input.sort_by === "tokens") {
        const at = a.totals.input_tokens + a.totals.output_tokens;
        const bt = b.totals.input_tokens + b.totals.output_tokens;
        return bt - at;
      }
      return b.totalCost - a.totalCost;
    });

    const top = projects.slice(0, input.limit ?? 10);
    const rows = top.flatMap((p, i) => {
      const t = p.totals;
      const tokens = fmtTokens(t.input_tokens + t.output_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens);
      const main = `${String(i + 1).padStart(2)}. ${p.projectName.padEnd(30)} ${p.sessionCount.toString().padStart(4)} sessions  ${tokens.padStart(8)} tokens  ${formatCost(p.totalCost)}`;
      const md = p.claudeMd;
      if (md.files.length === 0) return [main];
      const mdLine = `    ${"".padEnd(30)} CLAUDE.md: ${fmtTokens(md.totalEstimatedTokens)} tokens/session  ${formatCost(md.totalPerSessionCostUsd)}/session  (~${formatCost(md.totalPerSessionCostUsd * p.sessionCount)} cumulative)`;
      return [main, mdLine];
    });

    const text = [
      `Project Breakdown (sorted by ${input.sort_by ?? "cost"}, top ${top.length})`,
      ``,
      `    ${"Project".padEnd(30)} Sessions   Tokens       Cost`,
      `    ${"─".repeat(65)}`,
      ...rows,
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── get_session_list ──────────────────────────────────────────────────────────

server.registerTool(
  "get_session_list",
  {
    description: "List sessions for a project with per-session cost and token counts.",
    inputSchema: {
      project: z.string().describe("Project name (e.g. 'maths-guru')"),
      sort_by: z.enum(["cost", "tokens", "date"]).optional().default("date"),
      limit: z.number().optional().default(20),
    },
  },
  async (input) => {
    const result = await getResult();
    const project = [...result.projects.values()].find((p) =>
      p.projectKey.toLowerCase().includes(input.project.toLowerCase()) ||
      p.projectName.toLowerCase().includes(input.project.toLowerCase())
    );

    if (!project) {
      const names = [...result.projects.values()].map((p) => p.projectName).join(", ");
      return { content: [{ type: "text", text: `Project '${input.project}' not found. Available: ${names}` }] };
    }

    let sessions = [...project.sessions];
    if (input.sort_by === "cost") sessions.sort((a, b) => b.totalCost - a.totalCost);
    else if (input.sort_by === "tokens") {
      sessions.sort((a, b) => {
        const at = a.totals.input_tokens + a.totals.output_tokens;
        const bt = b.totals.input_tokens + b.totals.output_tokens;
        return bt - at;
      });
    } else {
      sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
    }

    const top = sessions.slice(0, input.limit ?? 20);
    const rows = top.map((s) => {
      const date = s.lastTimestamp.slice(0, 16).replace("T", " ");
      const t = s.totals;
      const tokens = fmtTokens(t.input_tokens + t.output_tokens);
      const sub = s.hasSubagents ? ` [+${s.subagentCount} subagents]` : "";
      return `${s.sessionId.slice(0, 8)}  ${date}  ${s.turns.length.toString().padStart(3)} turns  ${tokens.padStart(7)} tokens  ${formatCost(s.totalCost)}${sub}`;
    });

    const text = [
      `Sessions for ${project.projectName} (${sessions.length} total, showing ${top.length})`,
      ``,
      `SessionID  Date              Turns  Tokens    Cost`,
      `${"─".repeat(65)}`,
      ...rows,
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── get_session_detail ────────────────────────────────────────────────────────

server.registerTool(
  "get_session_detail",
  {
    description: "Get full detail for a session including token breakdown and optional per-turn stats.",
    inputSchema: {
      session_id: z.string().describe("Session UUID (or first 8 chars)"),
      include_turns: z.boolean().optional().default(false).describe("Include per-turn token breakdown (can be verbose)"),
    },
  },
  async (input) => {
    const result = await getResult();
    const session = [...result.sessions.values()].find((s) =>
      s.sessionId === input.session_id || s.sessionId.startsWith(input.session_id)
    );

    if (!session) {
      return { content: [{ type: "text", text: `Session '${input.session_id}' not found.` }], isError: true };
    }

    const t = session.totals;
    const totalTokens = t.input_tokens + t.output_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
    const cacheHitRate = totalTokens > 0 ? ((t.cache_read_input_tokens / totalTokens) * 100).toFixed(1) : "0.0";

    const lines = [
      `Session: ${session.sessionId}`,
      `Project: ${session.projectName}`,
      `Date:    ${session.firstTimestamp.slice(0, 16).replace("T", " ")} → ${session.lastTimestamp.slice(0, 16).replace("T", " ")} UTC`,
      `Turns:   ${session.turns.length}${session.hasSubagents ? ` (includes ${session.subagentCount} subagent(s))` : ""}`,
      ``,
      `Token Breakdown:`,
      `  Input:       ${fmtTokens(t.input_tokens)}`,
      `  Output:      ${fmtTokens(t.output_tokens)}`,
      `  Cache write: ${fmtTokens(t.cache_creation_input_tokens)}`,
      `  Cache read:  ${fmtTokens(t.cache_read_input_tokens)}  (${cacheHitRate}% cache hit rate)`,
      ``,
      `Estimated Cost: ${formatCost(session.totalCost)}`,
    ];

    if (input.include_turns) {
      lines.push(``, `Per-Turn Breakdown:`);
      lines.push(`${"Turn".padEnd(4)}  ${"Time".padEnd(16)}  ${"Model".padEnd(20)}  In       Out      Cost`);
      lines.push("─".repeat(80));
      const topLevel = session.turns.filter((t) => !t.isSubagent);
      topLevel.forEach((turn, i) => {
        const time = turn.timestamp.slice(11, 16);
        const model = turn.model.replace("claude-", "").slice(0, 18);
        lines.push(
          `${String(i + 1).padStart(4)}  ${time.padEnd(16)}  ${model.padEnd(20)}  ${fmtTokens(turn.usage.input_tokens).padStart(7)}  ${fmtTokens(turn.usage.output_tokens).padStart(7)}  ${formatCost(turn.cost.totalCost)}`
        );
      });
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── get_cost_forecast ─────────────────────────────────────────────────────────

server.registerTool(
  "get_cost_forecast",
  {
    description: "Forecast monthly cost based on recent usage patterns.",
    inputSchema: {
      project: z.string().optional().describe("Filter to a specific project. Omit for all."),
      days: z.number().optional().default(7).describe("Historical window for forecast base (default 7 days)"),
    },
  },
  async (input) => {
    const result = await getResult();
    const cutoff = cutoffDate(input.days ?? 7);

    let turns = result.allTurns.filter((t) => t.timestamp.slice(0, 10) >= cutoff);
    if (input.project) {
      turns = turns.filter((t) => t.projectKey.toLowerCase().includes(input.project!.toLowerCase()));
    }

    const dailyCosts: Record<string, number> = {};
    for (const turn of turns) {
      const date = turn.timestamp.slice(0, 10);
      dailyCosts[date] = (dailyCosts[date] ?? 0) + turn.cost.totalCost;
    }

    const days = Object.keys(dailyCosts);
    if (!days.length) {
      return { content: [{ type: "text", text: "No recent activity to forecast from." }] };
    }

    const totalCost = Object.values(dailyCosts).reduce((a, b) => a + b, 0);
    const avgDailyCost = totalCost / (input.days ?? 7);
    const projectedMonthly = avgDailyCost * 30;
    const projectedWeekly = avgDailyCost * 7;

    const scope = input.project ? `project: ${input.project}` : "all projects";
    const text = [
      `Cost Forecast (${scope}, based on last ${input.days ?? 7} days)`,
      ``,
      `Active days in window: ${days.length}`,
      `Total in window:       ${formatCost(totalCost)}`,
      `Avg daily cost:        ${formatCost(avgDailyCost)}`,
      ``,
      `Projected weekly:      ${formatCost(projectedWeekly)}`,
      `Projected monthly:     ${formatCost(projectedMonthly)}`,
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── refresh_cache ─────────────────────────────────────────────────────────────

server.registerTool(
  "refresh_cache",
  {
    description: "Re-scan all Claude Code JSONL files and rebuild the analysis cache. Use after new sessions to see updated stats.",
    inputSchema: {},
  },
  async () => {
    cachedResult = null;
    const result = await analyze(true);
    cachedResult = result;
    return {
      content: [{
        type: "text",
        text: `Cache refreshed. Scanned ${result.newFilesScanned} files. Found ${result.summary.sessionCount} sessions across ${result.summary.projectCount} projects.`,
      }],
    };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
