import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyze, formatCost, calculateCost, getActiveSessions, buildEfficiencyInsights } from "@claude-analyzer/analyzer";
import type { AnalysisResult } from "@claude-analyzer/analyzer";

let cachedResult: AnalysisResult | null = null;

export async function getResult(forceRefresh = false): Promise<AnalysisResult> {
  if (!cachedResult || forceRefresh) {
    cachedResult = await analyze(forceRefresh);
  }
  return cachedResult;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function cutoffDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function setCachedResult(r: AnalysisResult | null): void {
  cachedResult = r;
}

export function fmtPct(n: number): string {
  return `${n.toFixed(0)}%`;
}

// ── Session-quality facet/meta files (written by Claude Code) ─────────────────

interface FacetFile {
  session_id: string;
  outcome?: string;
  claude_helpfulness?: string;
  session_type?: string;
  friction_counts?: Record<string, number>;
  friction_detail?: string;
  primary_success?: string;
  brief_summary?: string;
  user_satisfaction_counts?: Record<string, number>;
  goal_categories?: Record<string, number>;
}

interface MetaFile {
  session_id: string;
  project_path?: string;
  start_time?: string;
  duration_minutes?: number;
  uses_task_agent?: boolean;
  uses_mcp?: boolean;
  uses_web_search?: boolean;
  uses_web_fetch?: boolean;
  git_commits?: number;
  git_pushes?: number;
  files_modified?: number;
  lines_added?: number;
  lines_removed?: number;
  tool_counts?: Record<string, number>;
  tool_errors?: number;
}

function readUsageDataDir<T>(sub: string): T[] {
  const dir = join(homedir(), ".claude", "usage-data", sub);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n: string) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, n), "utf-8")) as T);
    } catch {
      /* skip malformed file */
    }
  }
  return out;
}

const ACHIEVED = new Set(["fully_achieved", "mostly_achieved"]);

function distroLines(counts: Record<string, number>, indent = "  "): string[] {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return [`${indent}(none)`];
  return entries.map(([k, v]) => {
    const label = k.replace(/_/g, " ");
    const pct = ((v / total) * 100).toFixed(0);
    const bar = "█".repeat(Math.max(1, Math.round((v / total) * 20)));
    return `${indent}${label.padEnd(28)} ${String(v).padStart(4)}  ${pct.padStart(3)}%  ${bar}`;
  });
}

export function registerTools(server: McpServer): void {
  // ── get_usage_summary ───────────────────────────────────────────────────────

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

  // ── get_project_breakdown ───────────────────────────────────────────────────

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

  // ── get_session_list ────────────────────────────────────────────────────────

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

  // ── get_session_detail ──────────────────────────────────────────────────────

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
        const topLevel = session.turns.filter((turn) => !turn.isSubagent);
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

  // ── get_spend_trend ─────────────────────────────────────────────────────────

  server.registerTool(
    "get_spend_trend",
    {
      description:
        "Analyze spend trends: daily burn rate, week-over-week comparison, and projected monthly spend. " +
        "Use this to understand if usage is growing and estimate end-of-month costs.",
      inputSchema: {
        days: z.number().optional().default(30).describe("Lookback window for the daily chart in days (default 30). Use 0 for all time."),
        project: z.string().optional().describe("Project name to filter. Omit for all projects."),
      },
    },
    async (input) => {
      const result = await getResult();
      let turns = result.allTurns;
      if (input.project) {
        turns = turns.filter((t) =>
          t.projectKey.toLowerCase().includes(input.project!.toLowerCase())
        );
      }

      if (!turns.length) {
        return { content: [{ type: "text", text: "No data found for the given filters." }] };
      }

      const dailyMap = new Map<string, number>();
      for (const t of turns) {
        const date = t.timestamp.slice(0, 10);
        dailyMap.set(date, (dailyMap.get(date) ?? 0) + t.cost.totalCost);
      }

      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const DAY = 86400000;

      const last7 = Array.from({ length: 7 }, (_, i) =>
        new Date(Date.now() - i * DAY).toISOString().slice(0, 10)
      );
      const prev7 = Array.from({ length: 7 }, (_, i) =>
        new Date(Date.now() - (i + 7) * DAY).toISOString().slice(0, 10)
      );

      const thisWeekCost = last7.reduce((s, d) => s + (dailyMap.get(d) ?? 0), 0);
      const prevWeekCost = prev7.reduce((s, d) => s + (dailyMap.get(d) ?? 0), 0);
      const avgDaily7 = thisWeekCost / 7;
      const weekDelta = prevWeekCost > 0
        ? ((thisWeekCost - prevWeekCost) / prevWeekCost) * 100
        : null;

      const monthPrefix = today.slice(0, 7);
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const dayOfMonth = now.getDate();
      const monthSoFar = [...dailyMap.entries()]
        .filter(([d]) => d.startsWith(monthPrefix))
        .reduce((s, [, c]) => s + c, 0);
      const projectedMonth = dayOfMonth > 0 ? (monthSoFar / dayOfMonth) * daysInMonth : 0;

      const peakEntry = [...dailyMap.entries()].sort((a, b) => b[1] - a[1])[0];
      const peakCost = peakEntry?.[1] ?? 1;

      const allDates = [...dailyMap.keys()].sort();
      const cutoff = input.days && input.days > 0 ? cutoffDate(input.days) : null;
      const recentDates = cutoff ? allDates.filter((d) => d >= cutoff) : allDates;
      const rows = recentDates.map((d) => {
        const cost = dailyMap.get(d)!;
        const bar = "█".repeat(Math.max(1, Math.round((cost / peakCost) * 20)));
        return `  ${d}  ${formatCost(cost).padStart(8)}  ${bar}`;
      });

      const deltaStr = weekDelta !== null
        ? `${weekDelta > 0 ? "▲" : "▼"} ${Math.abs(weekDelta).toFixed(1)}% ${weekDelta > 0 ? "more" : "less"} than prior week`
        : "n/a (no prior week data)";

      const scope = input.project ? `project: ${input.project}` : "all projects";
      const text = [
        `Spend Trend (${scope})`,
        ``,
        `── Burn Rate ─────────────────────────────────────────`,
        `7-day avg:        ${formatCost(avgDaily7)}/day`,
        `This week (7d):   ${formatCost(thisWeekCost)}`,
        `Prior week (7d):  ${formatCost(prevWeekCost)}`,
        `Trend:            ${deltaStr}`,
        ``,
        `── This Month (${monthPrefix}) ────────────────────────`,
        `Spent so far:     ${formatCost(monthSoFar)}  (${dayOfMonth} of ${daysInMonth} days elapsed)`,
        `Projected total:  ${formatCost(projectedMonth)}`,
        ``,
        peakEntry ? `── Peak Day ──────────────────────────────────────────` : "",
        peakEntry ? `${peakEntry[0]}  ${formatCost(peakEntry[1])}` : "",
        ``,
        `── Daily (last ${recentDates.length} days) ───────────────────────────`,
        ...rows,
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── get_model_breakdown ──────────────────────────────────────────────────────

  server.registerTool(
    "get_model_breakdown",
    {
      description:
        "Show cost and token share per model, plus a cost simulator showing what your usage would have cost " +
        "on a different model (default: claude-sonnet-4-6). Useful for identifying if you're over-spending on Opus.",
      inputSchema: {
        compare_to: z.string().optional().default("claude-sonnet-4-6")
          .describe("Model to simulate costs against (default: claude-sonnet-4-6)."),
        days: z.number().optional().default(0).describe("Lookback window in days (default 0 = all time)."),
      },
    },
    async (input) => {
      const result = await getResult();
      const cutoff = input.days && input.days > 0 ? cutoffDate(input.days) : null;

      let turns = result.allTurns;
      if (cutoff) turns = turns.filter((t) => t.timestamp.slice(0, 10) >= cutoff);

      if (!turns.length) {
        return { content: [{ type: "text", text: "No data found for the given filters." }] };
      }

      // Aggregate usage + cost per model from actual turns (respects cutoff)
      const byModel = new Map<string, { input: number; output: number; cacheWrite: number; cacheRead: number; actualCost: number }>();
      for (const t of turns) {
        const m = t.model === "<synthetic>" ? null : t.model;
        if (!m) continue;
        const e = byModel.get(m) ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, actualCost: 0 };
        e.input     += t.usage.input_tokens;
        e.output    += t.usage.output_tokens;
        e.cacheWrite += t.usage.cache_creation_input_tokens;
        e.cacheRead  += t.usage.cache_read_input_tokens;
        e.actualCost += t.cost.totalCost;
        byModel.set(m, e);
      }

      const totalCost = [...byModel.values()].reduce((s, e) => s + e.actualCost, 0);
      const totalTokens = [...byModel.values()].reduce((s, e) => s + e.input + e.output + e.cacheWrite + e.cacheRead, 0);

      const compareTo = input.compare_to ?? "claude-sonnet-4-6";

      // Sort by actual cost descending
      const rows = [...byModel.entries()]
        .sort((a, b) => b[1].actualCost - a[1].actualCost)
        .map(([model, e]) => {
          const tokens = e.input + e.output + e.cacheWrite + e.cacheRead;
          const costPct = totalCost > 0 ? (e.actualCost / totalCost * 100).toFixed(1) : "0.0";
          const tokenPct = totalTokens > 0 ? (tokens / totalTokens * 100).toFixed(1) : "0.0";

          const simCost = calculateCost(
            { input_tokens: e.input, output_tokens: e.output, cache_creation_input_tokens: e.cacheWrite, cache_read_input_tokens: e.cacheRead },
            compareTo
          ).totalCost;
          const savings = e.actualCost - simCost;
          const isCompareTo = model === compareTo || model.startsWith(compareTo);
          const simStr = isCompareTo ? "  (baseline)" : `  → ${formatCost(simCost)} on ${compareTo.replace("claude-", "")}  ${savings > 0.01 ? `saves ${formatCost(savings)}` : savings < -0.01 ? `costs ${formatCost(-savings)} more` : "≈ same"}`;

          return [
            `  ${model.replace("claude-", "").padEnd(32)} ${formatCost(e.actualCost).padStart(10)}  ${costPct.padStart(5)}%  ${fmtTokens(tokens).padStart(7)} tokens  ${tokenPct.padStart(5)}%`,
            `  ${"".padEnd(32)} ${simStr}`,
          ].join("\n");
        });

      const simTotal = [...byModel.entries()].reduce((s, [, e]) => {
        return s + calculateCost(
          { input_tokens: e.input, output_tokens: e.output, cache_creation_input_tokens: e.cacheWrite, cache_read_input_tokens: e.cacheRead },
          compareTo
        ).totalCost;
      }, 0);
      const totalSavings = totalCost - simTotal;

      const window = input.days && input.days > 0 ? `last ${input.days} days` : "all time";
      const text = [
        `Model Breakdown (${window})`,
        ``,
        `  ${"Model".padEnd(32)} ${"Actual Cost".padStart(10)}  Share   Tokens          Share`,
        `  ${"─".repeat(80)}`,
        rows.join("\n"),
        `  ${"─".repeat(80)}`,
        `  ${"TOTAL".padEnd(32)} ${formatCost(totalCost).padStart(10)}  100%    ${fmtTokens(totalTokens).padStart(7)} tokens  100%`,
        ``,
        `── If everything ran on ${compareTo.replace("claude-", "")} ────────────────────────────────`,
        `  Simulated total:  ${formatCost(simTotal)}`,
        totalSavings > 0.01
          ? `  Potential savings: ${formatCost(totalSavings)}  (${(totalSavings / totalCost * 100).toFixed(1)}% cheaper)`
          : totalSavings < -0.01
          ? `  Additional cost:   ${formatCost(-totalSavings)}  (${(-totalSavings / totalCost * 100).toFixed(1)}% more expensive)`
          : `  Cost is approximately the same.`,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── get_session_quality ──────────────────────────────────────────────────────

  server.registerTool(
    "get_session_quality",
    {
      description:
        "Qualitative session scoring Claude Code writes per session: success rate (goals achieved), " +
        "friction rate, outcome/helpfulness distributions, feature adoption (sub-agents/MCP/web), and " +
        "the most friction-heavy sessions with Claude's own notes on what went wrong. " +
        "Reads facet + session-meta files from ~/.claude/usage-data.",
      inputSchema: {
        days: z.number().optional().default(0).describe("Lookback window in days by session start time (default 0 = all time)."),
        project: z.string().optional().describe("Project name/path substring to filter. Omit for all projects."),
      },
    },
    async (input) => {
      const facets = readUsageDataDir<FacetFile>("facets");
      const metas = readUsageDataDir<MetaFile>("session-meta");
      if (facets.length === 0 && metas.length === 0) {
        return { content: [{ type: "text", text: "No session-quality data found in ~/.claude/usage-data/. Claude Code writes these facet files automatically over time." }] };
      }

      const metaById = new Map<string, MetaFile>();
      for (const m of metas) if (m.session_id) metaById.set(m.session_id, m);

      const cutoff = input.days && input.days > 0 ? cutoffDate(input.days) : null;
      const projQ = input.project?.toLowerCase();

      // Cost lookup from analyzer cache (best effort).
      const result = await getResult();

      const matches = (sid: string): boolean => {
        const m = metaById.get(sid);
        if (cutoff) {
          const start = m?.start_time?.slice(0, 10);
          if (!start || start < cutoff) return false;
        }
        if (projQ) {
          const rec = result.sessions.get(sid);
          const name = (rec?.projectName ?? m?.project_path ?? "").toLowerCase();
          if (!name.includes(projQ)) return false;
        }
        return true;
      };

      const scoredFacets = facets.filter((f) => f.session_id && matches(f.session_id));
      if (scoredFacets.length === 0) {
        return { content: [{ type: "text", text: "No scored sessions match the given filters." }] };
      }

      const outcomeCounts: Record<string, number> = {};
      const helpfulnessCounts: Record<string, number> = {};
      const frictionCounts: Record<string, number> = {};
      const satisfactionCounts: Record<string, number> = {};
      let frictionSessions = 0;
      let achievedCostSum = 0, achievedCount = 0, notAchievedCostSum = 0, notAchievedCount = 0;
      const frictionFeed: Array<{ name: string; outcome: string; types: string[]; detail: string }> = [];

      for (const f of scoredFacets) {
        if (f.outcome) outcomeCounts[f.outcome] = (outcomeCounts[f.outcome] ?? 0) + 1;
        if (f.claude_helpfulness) helpfulnessCounts[f.claude_helpfulness] = (helpfulnessCounts[f.claude_helpfulness] ?? 0) + 1;
        const types = Object.keys(f.friction_counts ?? {});
        for (const [k, v] of Object.entries(f.friction_counts ?? {})) frictionCounts[k] = (frictionCounts[k] ?? 0) + v;
        for (const [k, v] of Object.entries(f.user_satisfaction_counts ?? {})) satisfactionCounts[k] = (satisfactionCounts[k] ?? 0) + v;
        if (types.length > 0) frictionSessions++;

        const cost = result.sessions.get(f.session_id)?.totalCost ?? 0;
        if (f.outcome) {
          if (ACHIEVED.has(f.outcome)) { achievedCostSum += cost; achievedCount++; }
          else { notAchievedCostSum += cost; notAchievedCount++; }
        }
        if (f.friction_detail && f.friction_detail.trim()) {
          const rec = result.sessions.get(f.session_id);
          frictionFeed.push({
            name: rec?.projectName ?? (f.session_id.slice(0, 8)),
            outcome: f.outcome ?? "unknown",
            types,
            detail: f.friction_detail.trim(),
          });
        }
      }

      const scored = scoredFacets.length;
      const achievedTotal = (outcomeCounts["fully_achieved"] ?? 0) + (outcomeCounts["mostly_achieved"] ?? 0);
      const successRate = scored > 0 ? (achievedTotal / scored) * 100 : 0;
      const frictionRate = scored > 0 ? (frictionSessions / scored) * 100 : 0;

      // Feature adoption across the matching meta sessions.
      const matchingMetaIds = [...metaById.keys()].filter(matches);
      const adoptionDenom = matchingMetaIds.length;
      let taskAgent = 0, mcp = 0, webSearch = 0, webFetch = 0;
      let toolCalls = 0, toolErrors = 0;
      for (const id of matchingMetaIds) {
        const m = metaById.get(id)!;
        if (m.uses_task_agent) taskAgent++;
        if (m.uses_mcp) mcp++;
        if (m.uses_web_search) webSearch++;
        if (m.uses_web_fetch) webFetch++;
        for (const v of Object.values(m.tool_counts ?? {})) toolCalls += v;
        toolErrors += m.tool_errors ?? 0;
      }
      const toolErrorRate = toolCalls > 0 ? (toolErrors / toolCalls) * 100 : 0;
      const adopt = (c: number) => adoptionDenom > 0 ? `${c} (${fmtPct((c / adoptionDenom) * 100)})` : "n/a";

      const OUTCOME_RANK: Record<string, number> = {
        not_achieved: 0, partially_achieved: 1, unclear_from_transcript: 2, mostly_achieved: 3, fully_achieved: 4,
      };
      frictionFeed.sort((a, b) => (b.types.length - a.types.length) || ((OUTCOME_RANK[a.outcome] ?? 5) - (OUTCOME_RANK[b.outcome] ?? 5)));

      const scope = input.project ? `project: ${input.project}` : "all projects";
      const window = cutoff ? `last ${input.days}d` : "all time";
      const text = [
        `Session Quality (${scope}, ${window})`,
        ``,
        `Scored sessions:  ${scored}`,
        `Success rate:     ${fmtPct(successRate)}  (fully + mostly achieved)`,
        `Friction rate:    ${fmtPct(frictionRate)}  (${frictionSessions} of ${scored} sessions)`,
        ``,
        `── Outcomes ──────────────────────────────────────────`,
        ...distroLines(outcomeCounts),
        ``,
        `── Claude Helpfulness ────────────────────────────────`,
        ...distroLines(helpfulnessCounts),
        ``,
        `── Friction Types ────────────────────────────────────`,
        ...distroLines(frictionCounts),
        ``,
        `── User Satisfaction ─────────────────────────────────`,
        ...distroLines(satisfactionCounts),
        ``,
        `── Tool Reliability ──────────────────────────────────`,
        `  Tool calls:     ${fmtTokens(toolCalls)}`,
        `  Tool errors:    ${toolErrors}  (${fmtPct(toolErrorRate)} error rate)`,
        ``,
        `── Feature Adoption (of ${adoptionDenom} sessions) ───────────`,
        `  Sub-agents (Task)   ${adopt(taskAgent)}`,
        `  MCP tools           ${adopt(mcp)}`,
        `  Web search          ${adopt(webSearch)}`,
        `  Web fetch           ${adopt(webFetch)}`,
        ``,
        `── Cost by Outcome ───────────────────────────────────`,
        `  Achieved:      ${formatCost(achievedCount > 0 ? achievedCostSum / achievedCount : 0)} avg  (${achievedCount} sessions)`,
        `  Not achieved:  ${formatCost(notAchievedCount > 0 ? notAchievedCostSum / notAchievedCount : 0)} avg  (${notAchievedCount} sessions)`,
        ``,
        `── What Went Wrong (top ${Math.min(10, frictionFeed.length)}) ─────────────────────`,
        ...(frictionFeed.length === 0
          ? ["  (no friction notes)"]
          : frictionFeed.slice(0, 10).flatMap((fr) => [
              `  • [${fr.outcome.replace(/_/g, " ")}] ${fr.name}${fr.types.length ? ` (${fr.types.map((t) => t.replace(/_/g, " ")).join(", ")})` : ""}`,
              `    ${fr.detail}`,
            ])),
      ].join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── get_compaction_stats ─────────────────────────────────────────────────────

  server.registerTool(
    "get_compaction_stats",
    {
      description:
        "Context-compaction analysis: how often sessions hit auto-compaction, total tokens lost to " +
        "compaction, trigger breakdown, and a cost comparison of compacted vs non-compacted sessions. " +
        "Long sessions that compact tend to cost more — use this to spot them.",
      inputSchema: {
        project: z.string().optional().describe("Project name/path substring to filter. Omit for all projects."),
      },
    },
    async (input) => {
      const result = await getResult();
      const projQ = input.project?.toLowerCase();

      let totalCompactions = 0, totalSessionsWithCompaction = 0, totalSessions = 0, totalTokensLost = 0;
      const triggerCounts: Record<string, number> = {};
      let compactedCostSum = 0, compactedCount = 0, nonCompactedCostSum = 0, nonCompactedCount = 0;
      const projRows: Array<{ name: string; compactions: number; sessions: number; tokensLost: number }> = [];

      for (const project of result.projects.values()) {
        if (projQ && !project.projectName.toLowerCase().includes(projQ)) continue;
        let pCompactions = 0, pSessionsWith = 0, pTokensLost = 0;

        for (const session of project.sessions) {
          const events = session.meta.compactEvents;
          totalSessions++;
          if (events.length > 0) {
            pSessionsWith++; totalSessionsWithCompaction++;
            for (const ev of events) {
              const lost = Math.max(0, ev.preTokens - ev.postTokens);
              pTokensLost += lost; totalTokensLost += lost;
              pCompactions++; totalCompactions++;
              triggerCounts[ev.trigger] = (triggerCounts[ev.trigger] ?? 0) + 1;
            }
            compactedCostSum += session.totalCost; compactedCount++;
          } else {
            nonCompactedCostSum += session.totalCost; nonCompactedCount++;
          }
        }
        if (pCompactions > 0) projRows.push({ name: project.projectName, compactions: pCompactions, sessions: pSessionsWith, tokensLost: pTokensLost });
      }

      if (totalSessions === 0) {
        return { content: [{ type: "text", text: "No sessions match the given filters." }] };
      }

      projRows.sort((a, b) => b.compactions - a.compactions);
      const scope = input.project ? `project: ${input.project}` : "all projects";
      const text = [
        `Compaction Stats (${scope})`,
        ``,
        `Total compactions:        ${totalCompactions}`,
        `Sessions with compaction: ${totalSessionsWithCompaction} of ${totalSessions} (${fmtPct(totalSessions > 0 ? (totalSessionsWithCompaction / totalSessions) * 100 : 0)})`,
        `Total tokens lost:        ${fmtTokens(totalTokensLost)}`,
        `Avg lost per compaction:  ${fmtTokens(totalCompactions > 0 ? Math.round(totalTokensLost / totalCompactions) : 0)}`,
        ``,
        `── Triggers ──────────────────────────────────────────`,
        ...distroLines(triggerCounts),
        ``,
        `── Cost: Compacted vs Not ────────────────────────────`,
        `  Compacted:      ${formatCost(compactedCount > 0 ? compactedCostSum / compactedCount : 0)} avg  (${compactedCount} sessions)`,
        `  Not compacted:  ${formatCost(nonCompactedCount > 0 ? nonCompactedCostSum / nonCompactedCount : 0)} avg  (${nonCompactedCount} sessions)`,
        ``,
        `── Top Projects by Compactions ───────────────────────`,
        ...(projRows.length === 0 ? ["  (none)"] : projRows.slice(0, 12).map((p) =>
          `  ${p.name.padEnd(28)} ${String(p.compactions).padStart(4)} compactions  ${p.sessions} sessions  ${fmtTokens(p.tokensLost)} lost`)),
      ].join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── get_context_limit_stats ──────────────────────────────────────────────────

  server.registerTool(
    "get_context_limit_stats",
    {
      description:
        "Context-limit (window-full) analysis: how often sessions hit the context limit, how often that " +
        "co-occurs with compaction, the CLAUDE.md token cost paid every session, and the sessions that " +
        "hit the limit most. Large CLAUDE.md files shrink usable context — use this to find them.",
      inputSchema: {
        project: z.string().optional().describe("Project name/path substring to filter. Omit for all projects."),
      },
    },
    async (input) => {
      const result = await getResult();
      const projQ = input.project?.toLowerCase();

      let totalLimitHits = 0, totalSessions = 0, sessionsWithLimitHit = 0, sessionsWithBoth = 0;
      const projRows: Array<{ name: string; hits: number; sessionsWith: number; claudeMdTokens: number; mdCostPerSession: number }> = [];
      const topSessions: Array<{ title: string; name: string; hits: number; compactions: number; cost: number }> = [];

      for (const project of result.projects.values()) {
        if (projQ && !project.projectName.toLowerCase().includes(projQ)) continue;
        let pHits = 0, pSessionsWith = 0;

        for (const session of project.sessions) {
          const lhc = session.meta.limitHitCount ?? 0;
          const cc = session.meta.compactEvents.length;
          totalSessions++;
          pHits += lhc;
          if (lhc > 0) {
            pSessionsWith++; sessionsWithLimitHit++; totalLimitHits += lhc;
            if (cc > 0) sessionsWithBoth++;
            topSessions.push({
              title: session.meta.aiTitle ?? session.sessionId.slice(0, 8),
              name: project.projectName, hits: lhc, compactions: cc, cost: session.totalCost,
            });
          }
        }
        projRows.push({
          name: project.projectName, hits: pHits, sessionsWith: pSessionsWith,
          claudeMdTokens: project.claudeMd.totalEstimatedTokens,
          mdCostPerSession: project.claudeMd.totalPerSessionCostUsd,
        });
      }

      if (totalSessions === 0) {
        return { content: [{ type: "text", text: "No sessions match the given filters." }] };
      }

      projRows.sort((a, b) => b.hits - a.hits || b.claudeMdTokens - a.claudeMdTokens);
      topSessions.sort((a, b) => b.hits - a.hits || b.cost - a.cost);
      const scope = input.project ? `project: ${input.project}` : "all projects";
      const text = [
        `Context-Limit Stats (${scope})`,
        ``,
        `Total limit hits:            ${totalLimitHits}`,
        `Sessions hitting limit:      ${sessionsWithLimitHit} of ${totalSessions} (${fmtPct(totalSessions > 0 ? (sessionsWithLimitHit / totalSessions) * 100 : 0)})`,
        `  ...also compacted:         ${sessionsWithBoth}`,
        ``,
        `── Projects (by limit hits; CLAUDE.md cost is paid every session) ──`,
        ...projRows.slice(0, 12).map((p) =>
          `  ${p.name.padEnd(28)} ${String(p.hits).padStart(4)} hits  ${p.sessionsWith} sessions  CLAUDE.md ${fmtTokens(p.claudeMdTokens)} tok / ${formatCost(p.mdCostPerSession)}/session`),
        ``,
        `── Top Sessions by Limit Hits ────────────────────────`,
        ...(topSessions.length === 0 ? ["  (none)"] : topSessions.slice(0, 20).map((s) =>
          `  ${String(s.hits).padStart(3)} hits  ${s.compactions} compactions  ${formatCost(s.cost).padStart(8)}  ${s.name} — ${s.title}`)),
      ].join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── get_active_sessions ──────────────────────────────────────────────────────

  server.registerTool(
    "get_active_sessions",
    {
      description:
        "List Claude Code sessions that are currently active (a session file modified within the threshold). " +
        "Shows project, AI title, turn count, cost so far, git branch, and how long ago it was last active. " +
        "Use to see what's running right now.",
      inputSchema: {
        threshold_minutes: z.number().optional().default(10).describe("How recently a session must have been modified to count as active (default 10 minutes)."),
      },
    },
    async (input) => {
      const thresholdMs = Math.max(1, input.threshold_minutes ?? 10) * 60 * 1000;
      const sessions = await getActiveSessions(thresholdMs);
      if (sessions.length === 0) {
        return { content: [{ type: "text", text: `No active sessions in the last ${input.threshold_minutes ?? 10} minutes.` }] };
      }

      const now = Date.now();
      const fmtAgo = (ms: number): string => {
        const s = Math.floor((now - ms) / 1000);
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        return `${Math.floor(s / 3600)}h ago`;
      };

      const lines = sessions.map((s) => {
        const turns = s.turns.filter((t) => !t.isSubagent).length;
        const title = s.meta.aiTitle ?? s.sessionId.slice(0, 8);
        const branch = s.meta.gitBranch ? ` [${s.meta.gitBranch}]` : "";
        return `  ${fmtAgo(s.lastModifiedMs).padEnd(8)} ${s.projectName}${branch} — ${title}\n    ${turns} turns · ${formatCost(s.totalCost)} · ${fmtTokens(s.totals.input_tokens + s.totals.output_tokens)} tokens`;
      });

      const text = [
        `Active Sessions (last ${input.threshold_minutes ?? 10} min): ${sessions.length}`,
        ``,
        ...lines,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── refresh_cache ───────────────────────────────────────────────────────────

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

  // ── get_efficiency_insights ──────────────────────────────────────────────────

  server.registerTool(
    "get_efficiency_insights",
    {
      description:
        "Token/time efficiency insights derived from session turns: cache-miss waste (tokens lost to " +
        "prompt-cache invalidation + $ wasted, by reason), subagent cost share, model switching within " +
        "sessions, turn cadence, hour-of-day/weekday usage, ephemeral cache TTL split, hook overhead, and " +
        "queued-message count. Use to find where tokens and time leak.",
      inputSchema: {
        project: z.string().optional().describe("Project name/path substring to filter. Omit for all projects."),
        days: z.number().optional().default(0).describe("Lookback window in days (default 0 = all time)."),
      },
    },
    async (input) => {
      const result = await getResult();
      const cutoff = input.days && input.days > 0 ? cutoffDate(input.days) : null;
      const projQ = input.project?.toLowerCase();

      let turns = result.allTurns;
      if (cutoff) turns = turns.filter((t) => t.timestamp.slice(0, 10) >= cutoff);
      if (projQ) turns = turns.filter((t) => t.projectKey.toLowerCase().includes(projQ));

      const sessionIds = new Set(turns.map((t) => t.sessionId));
      const sessions = [...result.sessions.values()].filter((s) => sessionIds.has(s.sessionId));
      if (turns.length === 0) {
        return { content: [{ type: "text", text: "No data found for the given filters." }] };
      }

      const ins = buildEfficiencyInsights(turns, sessions);
      const cm = ins.cacheMiss;
      const sub = ins.subagentShare;
      const hooks = ins.hooks;

      const fmtSec = (s: number) => s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(0)}s`;

      // Hour histogram (compact 24-slot bar by turn count).
      const maxHour = Math.max(1, ...ins.byHour.map((h) => h.turns));
      const hourRows = ins.byHour
        .filter((h) => h.turns > 0)
        .map((h) => `  ${h.label}  ${String(h.turns).padStart(5)}  ${formatCost(h.cost).padStart(9)}  ${"█".repeat(Math.max(1, Math.round((h.turns / maxHour) * 20)))}`);

      const weekdayRows = ins.byWeekday
        .map((w) => `  ${w.label}  ${String(w.turns).padStart(5)} turns  ${formatCost(w.cost).padStart(9)}`);

      const scope = input.project ? `project: ${input.project}` : "all projects";
      const window = cutoff ? `last ${input.days}d` : "all time";
      const text = [
        `Efficiency Insights (${scope}, ${window})`,
        ``,
        `── Cache-Miss Waste ──────────────────────────────────`,
        `  Tokens missed:    ${fmtTokens(cm.totalMissTokens)}  (${cm.turnsAffected} turns)`,
        `  Est. $ wasted:    ${formatCost(cm.estWastedCost)}  (re-billed at cache-write vs cache-read)`,
        ...(cm.byReason.length === 0
          ? ["  (no cache-miss diagnostics recorded)"]
          : cm.byReason.map((r) => `    ${r.reason.replace(/_/g, " ").padEnd(22)} ${fmtTokens(r.tokens).padStart(8)}  ${formatCost(r.estCost)}`)),
        ``,
        `── Subagent Cost Share ───────────────────────────────`,
        `  Main thread:      ${formatCost(sub.mainCost)}  (${fmtTokens(sub.mainTokens)} tokens)`,
        `  Subagents:        ${formatCost(sub.subagentCost)}  (${fmtTokens(sub.subagentTokens)} tokens)  ${fmtPct(sub.subagentCostPct)} of spend`,
        ``,
        `── Model Switching ───────────────────────────────────`,
        `  Sessions w/ >1 model:  ${ins.modelSwitching.sessionsWithMultipleModels} of ${ins.modelSwitching.totalSessions}  (${fmtPct(ins.modelSwitching.multiModelPct)})`,
        `  Total switch events:   ${ins.modelSwitching.switchEvents}`,
        ``,
        `── Turn Cadence (gap between consecutive turns) ───────`,
        `  Median:  ${fmtSec(ins.cadence.medianGapSec)}   p90: ${fmtSec(ins.cadence.p90GapSec)}   (${ins.cadence.sampleCount} gaps, breaks >30m excluded)`,
        ``,
        `── Ephemeral Cache TTL ───────────────────────────────`,
        `  5-min bucket:  ${fmtTokens(ins.ephemeral.total5mTokens)}  (${fmtPct(ins.ephemeral.pct5m)})`,
        `  1-hour bucket: ${fmtTokens(ins.ephemeral.total1hTokens)}`,
        ``,
        `── Hook Overhead ─────────────────────────────────────`,
        `  Invocations:  ${hooks.totalInvocations}   errors: ${hooks.totalErrors} (${fmtPct(hooks.errorRate)})   total time: ${(hooks.totalDurationMs / 1000).toFixed(1)}s   avg: ${hooks.avgDurationMs.toFixed(0)}ms`,
        ``,
        `── Queued Messages (impatience) ──────────────────────`,
        `  Total queued: ${ins.queue.totalQueued}   across ${ins.queue.sessionsWithQueue} sessions`,
        ``,
        `── Usage by Weekday ──────────────────────────────────`,
        ...weekdayRows,
        ``,
        `── Usage by Hour (UTC) ───────────────────────────────`,
        ...(hourRows.length === 0 ? ["  (none)"] : hourRows),
      ].join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── get_productivity_roi ──────────────────────────────────────────────────────

  server.registerTool(
    "get_productivity_roi",
    {
      description:
        "Return-on-investment view: dollars spent per git commit, per file modified, per 100 lines " +
        "changed, lines changed per dollar, and cost per active minute — plus tool-call reliability and " +
        "which goal categories (debugging, feature design, etc.) burn the most spend. Joins facet/session-meta " +
        "files with parsed cost. Reframes spend as value delivered.",
      inputSchema: {
        project: z.string().optional().describe("Project name/path substring to filter. Omit for all projects."),
        days: z.number().optional().default(0).describe("Lookback window in days by session start time (default 0 = all time)."),
      },
    },
    async (input) => {
      const facets = readUsageDataDir<FacetFile>("facets");
      const metas = readUsageDataDir<MetaFile>("session-meta");
      if (metas.length === 0) {
        return { content: [{ type: "text", text: "No session-meta data found in ~/.claude/usage-data/. Claude Code writes these files automatically over time." }] };
      }

      const facetById = new Map<string, FacetFile>();
      for (const f of facets) if (f.session_id) facetById.set(f.session_id, f);
      const metaById = new Map<string, MetaFile>();
      for (const m of metas) if (m.session_id) metaById.set(m.session_id, m);

      const cutoff = input.days && input.days > 0 ? cutoffDate(input.days) : null;
      const projQ = input.project?.toLowerCase();
      const result = await getResult();

      const matches = (sid: string): boolean => {
        const m = metaById.get(sid);
        if (cutoff) {
          const start = m?.start_time?.slice(0, 10);
          if (!start || start < cutoff) return false;
        }
        if (projQ) {
          const rec = result.sessions.get(sid);
          const name = (rec?.projectName ?? m?.project_path ?? "").toLowerCase();
          if (!name.includes(projQ)) return false;
        }
        return true;
      };

      let cost = 0, commits = 0, pushes = 0, files = 0, linesAdded = 0, linesRemoved = 0;
      let duration = 0, sessions = 0, toolCalls = 0, toolErrors = 0;
      const goalCost: Record<string, number> = {};

      for (const id of metaById.keys()) {
        if (!matches(id)) continue;
        const m = metaById.get(id)!;
        const f = facetById.get(id);
        const c = result.sessions.get(id)?.totalCost ?? 0;
        sessions++;
        cost += c;
        commits += m.git_commits ?? 0;
        pushes += m.git_pushes ?? 0;
        files += m.files_modified ?? 0;
        linesAdded += m.lines_added ?? 0;
        linesRemoved += m.lines_removed ?? 0;
        duration += m.duration_minutes ?? 0;
        for (const v of Object.values(m.tool_counts ?? {})) toolCalls += v;
        toolErrors += m.tool_errors ?? 0;

        const goalTotal = Object.values(f?.goal_categories ?? {}).reduce((s, v) => s + v, 0);
        if (goalTotal > 0 && c > 0) {
          for (const [k, v] of Object.entries(f!.goal_categories!)) {
            goalCost[k] = (goalCost[k] ?? 0) + c * (v / goalTotal);
          }
        }
      }

      if (sessions === 0) {
        return { content: [{ type: "text", text: "No sessions match the given filters." }] };
      }

      const linesChanged = linesAdded + linesRemoved;
      const per = (denom: number) => denom > 0 ? formatCost(cost / denom) : "n/a";
      const toolErrorRate = toolCalls > 0 ? (toolErrors / toolCalls) * 100 : 0;

      const goalRows = Object.entries(goalCost)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([k, v]) => `  ${k.replace(/_/g, " ").padEnd(28)} ${formatCost(v).padStart(10)}  ${fmtPct(cost > 0 ? (v / cost) * 100 : 0)}`);

      const scope = input.project ? `project: ${input.project}` : "all projects";
      const window = cutoff ? `last ${input.days}d` : "all time";
      const text = [
        `Productivity ROI (${scope}, ${window})`,
        ``,
        `Sessions (with meta): ${sessions}`,
        `Total cost:           ${formatCost(cost)}`,
        ``,
        `── Cost per unit of work ─────────────────────────────`,
        `  Per commit:        ${per(commits)}   (${commits} commits, ${pushes} pushes)`,
        `  Per file modified: ${per(files)}   (${files} files)`,
        `  Per 100 lines:     ${linesChanged > 0 ? formatCost((cost / linesChanged) * 100) : "n/a"}   (+${fmtTokens(linesAdded)} / −${fmtTokens(linesRemoved)})`,
        `  Lines per dollar:  ${cost > 0 ? Math.round(linesChanged / cost) : "n/a"}`,
        `  Per active minute: ${per(duration)}   (${Math.round(duration)} min total)`,
        `  Per session:       ${per(sessions)}`,
        ``,
        `── Tool Reliability ──────────────────────────────────`,
        `  Tool calls: ${fmtTokens(toolCalls)}   errors: ${toolErrors}  (${fmtPct(toolErrorRate)} error rate)`,
        ``,
        `── Spend by Goal Category ────────────────────────────`,
        ...(goalRows.length === 0 ? ["  (no goal-category data)"] : goalRows),
      ].join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

}
