import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyze, formatCost, calculateCost } from "@claude-analyzer/analyzer";
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

}
