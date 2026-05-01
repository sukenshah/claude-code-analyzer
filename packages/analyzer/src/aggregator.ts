import { sumUsage, sumCost } from "./cost.js";
import { getProjectName, getProjectPath } from "./scanner.js";
import { scanClaudeMd } from "./claude-md.js";
import { emptyMeta } from "./parser.js";
import type { TurnRecord, SessionRecord, ProjectRecord, GlobalSummary, DailyStats, SessionMeta } from "./types.js";

export function mergeToolCallCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

export function mergeMeta(a: SessionMeta, b: SessionMeta): SessionMeta {
  return {
    aiTitle: a.aiTitle ?? b.aiTitle,
    entrypoint: a.entrypoint ?? b.entrypoint,
    gitBranch: a.gitBranch ?? b.gitBranch,
    permissionMode: a.permissionMode ?? b.permissionMode,
    version: a.version ?? b.version,
    mcpTools: [...new Set([...a.mcpTools, ...b.mcpTools])],
    mcpToolCalls: mergeToolCallCounts(a.mcpToolCalls ?? {}, b.mcpToolCalls ?? {}),
    compactEvents: [...a.compactEvents, ...b.compactEvents]
      .sort((x, y) => x.timestamp.localeCompare(y.timestamp)),
    limitHitCount: (a.limitHitCount ?? 0) + (b.limitHitCount ?? 0),
  };
}

export function aggregateToSessions(turns: TurnRecord[], metaBySession?: Map<string, SessionMeta>): Map<string, SessionRecord> {
  const bySession = new Map<string, TurnRecord[]>();

  for (const turn of turns) {
    const existing = bySession.get(turn.sessionId) ?? [];
    existing.push(turn);
    bySession.set(turn.sessionId, existing);
  }

  const sessions = new Map<string, SessionRecord>();

  for (const [sessionId, sessionTurns] of bySession) {
    const sorted = [...sessionTurns].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const subagents = sorted.filter((t) => t.isSubagent);
    const allTurns = sorted;

    const projectKey = sorted[0]?.projectKey ?? "";
    const totals = sumUsage(allTurns.map((t) => t.usage));
    const totalCost = sumCost(allTurns.map((t) => t.cost));
    const subagentIds = new Set(subagents.map((t) => t.agentId).filter(Boolean));

    sessions.set(sessionId, {
      sessionId,
      projectKey,
      projectName: getProjectName(projectKey),
      firstTimestamp: sorted[0]?.timestamp ?? "",
      lastTimestamp: sorted[sorted.length - 1]?.timestamp ?? "",
      turns: allTurns,
      totals,
      totalCost,
      hasSubagents: subagents.length > 0,
      subagentCount: subagentIds.size,
      meta: metaBySession?.get(sessionId) ?? emptyMeta(),
    });
  }

  return sessions;
}

export function aggregateToProjects(sessions: Map<string, SessionRecord>, projectPaths?: Map<string, string>): Map<string, ProjectRecord> {
  const byProject = new Map<string, SessionRecord[]>();

  for (const session of sessions.values()) {
    const existing = byProject.get(session.projectKey) ?? [];
    existing.push(session);
    byProject.set(session.projectKey, existing);
  }

  const projects = new Map<string, ProjectRecord>();

  for (const [projectKey, projectSessions] of byProject) {
    const sorted = [...projectSessions].sort((a, b) =>
      b.lastTimestamp.localeCompare(a.lastTimestamp)
    );
    const totals = sumUsage(sorted.map((s) => s.totals));
    const totalCost = sorted.reduce((acc, s) => acc + s.totalCost, 0);
    const projectPath = projectPaths?.get(projectKey) ?? getProjectPath(projectKey);

    projects.set(projectKey, {
      projectKey,
      projectName: getProjectName(projectKey),
      projectPath,
      sessionCount: sorted.length,
      sessions: sorted,
      totals,
      totalCost,
      claudeMd: scanClaudeMd(projectPath),
      limitHitCount: sorted.reduce((acc, s) => acc + (s.meta.limitHitCount ?? 0), 0),
    });
  }

  return projects;
}

export function buildGlobalSummary(
  projects: Map<string, ProjectRecord>,
  allTurns: TurnRecord[]
): GlobalSummary {
  const totals = sumUsage(allTurns.map((t) => t.usage));
  let totalCost = 0;
  for (const p of projects.values()) totalCost += p.totalCost;

  const byModel: Record<string, { usage: typeof totals; cost: number }> = {};
  for (const turn of allTurns) {
    if (!byModel[turn.model]) {
      byModel[turn.model] = { usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cost: 0 };
    }
    const entry = byModel[turn.model]!;
    entry.usage.input_tokens += turn.usage.input_tokens;
    entry.usage.output_tokens += turn.usage.output_tokens;
    entry.usage.cache_creation_input_tokens += turn.usage.cache_creation_input_tokens;
    entry.usage.cache_read_input_tokens += turn.usage.cache_read_input_tokens;
    entry.cost += turn.cost.totalCost;
  }

  // Daily stats
  const dailyMap = new Map<string, DailyStats>();
  for (const turn of allTurns) {
    const date = turn.timestamp.slice(0, 10);
    if (!dailyMap.has(date)) {
      dailyMap.set(date, { date, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost: 0 });
    }
    const day = dailyMap.get(date)!;
    day.input_tokens += turn.usage.input_tokens;
    day.output_tokens += turn.usage.output_tokens;
    day.cache_creation_input_tokens += turn.usage.cache_creation_input_tokens;
    day.cache_read_input_tokens += turn.usage.cache_read_input_tokens;
    day.cost += turn.cost.totalCost;
  }

  const dailyStats = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  let sessionCount = 0;
  for (const p of projects.values()) sessionCount += p.sessionCount;

  let limitHitCount = 0;
  for (const p of projects.values()) limitHitCount += p.limitHitCount;

  return {
    projectCount: projects.size,
    sessionCount,
    turnCount: allTurns.length,
    totals,
    totalCost,
    byModel,
    dailyStats,
    limitHitCount,
  };
}
