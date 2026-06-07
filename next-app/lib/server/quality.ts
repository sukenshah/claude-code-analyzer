import { readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { ensureLoaded } from "./cache";

// ── Raw shapes written by Claude Code into ~/.claude/usage-data ──────────────

interface FacetFile {
  session_id: string;
  underlying_goal?: string;
  goal_categories?: Record<string, number>;
  outcome?: string;
  user_satisfaction_counts?: Record<string, number>;
  claude_helpfulness?: string;
  session_type?: string;
  friction_counts?: Record<string, number>;
  friction_detail?: string;
  primary_success?: string;
  brief_summary?: string;
}

interface MetaFile {
  session_id: string;
  project_path?: string;
  start_time?: string;
  duration_minutes?: number;
  user_message_count?: number;
  assistant_message_count?: number;
  tool_counts?: Record<string, number>;
  languages?: Record<string, number>;
  git_commits?: number;
  git_pushes?: number;
  files_modified?: number;
  lines_added?: number;
  lines_removed?: number;
  tool_errors?: number;
  user_interruptions?: number;
  first_prompt?: string;
  uses_task_agent?: boolean;
  uses_mcp?: boolean;
  uses_web_search?: boolean;
  uses_web_fetch?: boolean;
}

// ── Public response shapes ───────────────────────────────────────────────────

export interface QualitySessionRow {
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

export interface FeatureAdoptionRow {
  name: string;
  count: number;
  pct: number;
}

export interface FrictionFeedRow {
  sessionId: string;
  projectName: string;
  outcome: string | null;
  frictionTypes: string[];
  detail: string;
}

export interface QualityProjectRow {
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

export interface RoiStats {
  totalCost: number;
  costPerCommit: number;
  costPerFileModified: number;
  costPer100Lines: number;
  linesPerDollar: number;
  costPerMinute: number;
  costPerSession: number;
}

export interface ToolReliability {
  totalToolCalls: number;
  totalToolErrors: number;
  errorRatePct: number;
}

export interface QualityReport {
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
  roi: RoiStats;
  toolReliability: ToolReliability;
  costByGoalCategory: Array<{ name: string; cost: number }>;
  costByLanguage: Array<{ name: string; cost: number }>;
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
  recentSessions: QualitySessionRow[];
  projectBreakdown: QualityProjectRow[];
}

// Outcomes that count as a "success" for rate calculations.
const ACHIEVED = new Set(["fully_achieved", "mostly_achieved"]);

function usageDataDir(): string {
  return join(homedir(), ".claude", "usage-data");
}

function readJsonDir<T>(sub: string): T[] {
  const dir = join(usageDataDir(), sub);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
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

function bump(map: Record<string, number>, key: string | undefined | null, by = 1): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + by;
}

function sumInto(map: Record<string, number>, src: Record<string, number> | undefined): void {
  if (!src) return;
  for (const [k, v] of Object.entries(src)) map[k] = (map[k] ?? 0) + v;
}

function topN(map: Record<string, number>, n: number): Array<{ name: string; count: number }> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

export async function buildQualityReport(): Promise<QualityReport> {
  const facets = readJsonDir<FacetFile>("facets");
  const metas = readJsonDir<MetaFile>("session-meta");

  const empty: QualityReport = {
    hasData: false,
    global: {
      scoredSessions: 0, metaSessions: 0, successRate: 0, frictionRate: 0,
      avgDurationMinutes: 0, totalDurationMinutes: 0, totalCommits: 0, totalPushes: 0,
      totalLinesAdded: 0, totalLinesRemoved: 0, totalFilesModified: 0,
      totalInterruptions: 0, totalToolErrors: 0,
    },
    roi: { totalCost: 0, costPerCommit: 0, costPerFileModified: 0, costPer100Lines: 0, linesPerDollar: 0, costPerMinute: 0, costPerSession: 0 },
    toolReliability: { totalToolCalls: 0, totalToolErrors: 0, errorRatePct: 0 },
    costByGoalCategory: [], costByLanguage: [],
    outcomeCounts: {}, helpfulnessCounts: {}, sessionTypeCounts: {},
    primarySuccessCounts: {}, satisfactionCounts: {}, frictionCounts: {},
    topGoalCategories: [], topTools: [], languageMix: [],
    costByOutcome: { achievedAvgCost: 0, notAchievedAvgCost: 0, achievedCount: 0, notAchievedCount: 0 },
    featureAdoption: [], frictionFeed: [],
    recentSessions: [], projectBreakdown: [],
  };
  if (facets.length === 0 && metas.length === 0) return empty;

  const facetById = new Map<string, FacetFile>();
  for (const f of facets) if (f.session_id) facetById.set(f.session_id, f);
  const metaById = new Map<string, MetaFile>();
  for (const m of metas) if (m.session_id) metaById.set(m.session_id, m);

  // Cost + project name lookup from the analyzer cache (best effort).
  const costById = new Map<string, { cost: number; projectName: string; projectKey: string }>();
  try {
    const analysis = await ensureLoaded();
    for (const s of analysis.sessions.values()) {
      costById.set(s.sessionId, {
        cost: s.totalCost,
        projectName: s.projectName,
        projectKey: s.projectKey,
      });
    }
  } catch {
    /* analyzer cache unavailable — render without cost */
  }

  // Distribution accumulators.
  const outcomeCounts: Record<string, number> = {};
  const helpfulnessCounts: Record<string, number> = {};
  const sessionTypeCounts: Record<string, number> = {};
  const primarySuccessCounts: Record<string, number> = {};
  const satisfactionCounts: Record<string, number> = {};
  const frictionCounts: Record<string, number> = {};
  const goalCategories: Record<string, number> = {};
  const toolCounts: Record<string, number> = {};
  const languages: Record<string, number> = {};
  // Cost attributed to goal categories / languages, split proportionally per session.
  const goalCost: Record<string, number> = {};
  const languageCost: Record<string, number> = {};

  for (const f of facets) {
    bump(outcomeCounts, f.outcome);
    bump(helpfulnessCounts, f.claude_helpfulness);
    bump(sessionTypeCounts, f.session_type);
    bump(primarySuccessCounts, f.primary_success);
    sumInto(satisfactionCounts, f.user_satisfaction_counts);
    sumInto(frictionCounts, f.friction_counts);
    sumInto(goalCategories, f.goal_categories);
  }

  // Per-session aggregation over the union of meta + facet session ids.
  const allIds = new Set<string>([...metaById.keys(), ...facetById.keys()]);

  let totalDuration = 0, totalCommits = 0, totalPushes = 0;
  let totalLinesAdded = 0, totalLinesRemoved = 0, totalFilesModified = 0;
  let totalInterruptions = 0, totalToolErrors = 0;
  let totalToolCalls = 0;
  let totalCostJoined = 0;
  let frictionSessions = 0;
  let achievedCostSum = 0, achievedCount = 0;
  let notAchievedCostSum = 0, notAchievedCount = 0;
  // Feature adoption: count of sessions (with meta) using each capability.
  let usesTaskAgent = 0, usesMcp = 0, usesWebSearch = 0, usesWebFetch = 0;

  const rows: QualitySessionRow[] = [];
  const frictionFeed: FrictionFeedRow[] = [];
  // Per-project accumulation.
  const projAcc = new Map<string, {
    projectName: string; projectKey: string | null;
    sessions: number; scored: number; achieved: number;
    commits: number; linesAdded: number; durationSum: number; cost: number;
  }>();

  for (const id of allIds) {
    const m = metaById.get(id);
    const f = facetById.get(id);
    const joined = costById.get(id);

    sumInto(toolCounts, m?.tool_counts);
    sumInto(languages, m?.languages);

    const sessionCost = joined?.cost ?? 0;
    totalCostJoined += sessionCost;
    for (const v of Object.values(m?.tool_counts ?? {})) totalToolCalls += v;

    // Split this session's cost across its goal categories / languages, weighted by count.
    const goalTotal = Object.values(f?.goal_categories ?? {}).reduce((s, v) => s + v, 0);
    if (goalTotal > 0 && sessionCost > 0) {
      for (const [k, v] of Object.entries(f!.goal_categories!)) {
        goalCost[k] = (goalCost[k] ?? 0) + sessionCost * (v / goalTotal);
      }
    }
    const langTotal = Object.values(m?.languages ?? {}).reduce((s, v) => s + v, 0);
    if (langTotal > 0 && sessionCost > 0) {
      for (const [k, v] of Object.entries(m!.languages!)) {
        languageCost[k] = (languageCost[k] ?? 0) + sessionCost * (v / langTotal);
      }
    }

    if (m) {
      if (m.uses_task_agent) usesTaskAgent++;
      if (m.uses_mcp) usesMcp++;
      if (m.uses_web_search) usesWebSearch++;
      if (m.uses_web_fetch) usesWebFetch++;
    }

    const duration = m?.duration_minutes ?? 0;
    const commits = m?.git_commits ?? 0;
    const linesAdded = m?.lines_added ?? 0;
    totalDuration += duration;
    totalCommits += commits;
    totalPushes += m?.git_pushes ?? 0;
    totalLinesAdded += linesAdded;
    totalLinesRemoved += m?.lines_removed ?? 0;
    totalFilesModified += m?.files_modified ?? 0;
    totalInterruptions += m?.user_interruptions ?? 0;
    totalToolErrors += m?.tool_errors ?? 0;

    const friction = Object.keys(f?.friction_counts ?? {});
    if (friction.length > 0) frictionSessions++;

    if (f?.outcome) {
      const isAchieved = ACHIEVED.has(f.outcome);
      const cost = joined?.cost ?? 0;
      if (isAchieved) { achievedCostSum += cost; achievedCount++; }
      else { notAchievedCostSum += cost; notAchievedCount++; }
    }

    const projectName =
      joined?.projectName ?? (m?.project_path ? basename(m.project_path) : "Unknown");
    const projectKey = joined?.projectKey ?? null;

    rows.push({
      sessionId: id,
      projectName,
      projectKey,
      title: f?.brief_summary || m?.first_prompt || "(untitled session)",
      startTime: m?.start_time ?? null,
      durationMinutes: duration,
      outcome: f?.outcome ?? null,
      helpfulness: f?.claude_helpfulness ?? null,
      sessionType: f?.session_type ?? null,
      gitCommits: commits,
      gitPushes: m?.git_pushes ?? 0,
      linesAdded,
      linesRemoved: m?.lines_removed ?? 0,
      toolErrors: m?.tool_errors ?? 0,
      interruptions: m?.user_interruptions ?? 0,
      friction,
      cost: joined?.cost ?? null,
    });

    if (f?.friction_detail && f.friction_detail.trim().length > 0) {
      frictionFeed.push({
        sessionId: id,
        projectName,
        outcome: f.outcome ?? null,
        frictionTypes: friction,
        detail: f.friction_detail.trim(),
      });
    }

    const pKey = projectKey ?? projectName;
    const acc = projAcc.get(pKey) ?? {
      projectName, projectKey, sessions: 0, scored: 0, achieved: 0,
      commits: 0, linesAdded: 0, durationSum: 0, cost: 0,
    };
    acc.sessions++;
    acc.commits += commits;
    acc.linesAdded += linesAdded;
    acc.durationSum += duration;
    acc.cost += joined?.cost ?? 0;
    if (f?.outcome) { acc.scored++; if (ACHIEVED.has(f.outcome)) acc.achieved++; }
    projAcc.set(pKey, acc);
  }

  const scoredSessions = facetById.size;
  const achievedTotal = (outcomeCounts["fully_achieved"] ?? 0) + (outcomeCounts["mostly_achieved"] ?? 0);

  rows.sort((a, b) => (b.startTime ?? "").localeCompare(a.startTime ?? ""));

  // Feature adoption — share of sessions that used each capability.
  const adoptionDenom = metaById.size;
  const featureAdoption: FeatureAdoptionRow[] = adoptionDenom === 0 ? [] : [
    { name: "Sub-agents (Task)", count: usesTaskAgent },
    { name: "MCP tools", count: usesMcp },
    { name: "Web search", count: usesWebSearch },
    { name: "Web fetch", count: usesWebFetch },
  ].map((r) => ({ ...r, pct: (r.count / adoptionDenom) * 100 }));

  // Friction feed — most friction-heavy sessions first, then non-achieved outcomes.
  const OUTCOME_RANK: Record<string, number> = {
    not_achieved: 0, partially_achieved: 1, unclear_from_transcript: 2,
    mostly_achieved: 3, fully_achieved: 4,
  };
  frictionFeed.sort((a, b) => {
    const byCount = b.frictionTypes.length - a.frictionTypes.length;
    if (byCount !== 0) return byCount;
    return (OUTCOME_RANK[a.outcome ?? ""] ?? 5) - (OUTCOME_RANK[b.outcome ?? ""] ?? 5);
  });

  const projectBreakdown: QualityProjectRow[] = [...projAcc.values()]
    .map((a) => ({
      projectName: a.projectName,
      projectKey: a.projectKey,
      sessions: a.sessions,
      scoredSessions: a.scored,
      achievedRate: a.scored > 0 ? (a.achieved / a.scored) * 100 : 0,
      gitCommits: a.commits,
      linesAdded: a.linesAdded,
      avgDurationMinutes: a.sessions > 0 ? a.durationSum / a.sessions : 0,
      totalCost: a.cost,
    }))
    .sort((a, b) => b.totalCost - a.totalCost || b.sessions - a.sessions);

  const totalLinesChanged = totalLinesAdded + totalLinesRemoved;
  const roi: RoiStats = {
    totalCost: totalCostJoined,
    costPerCommit: totalCommits > 0 ? totalCostJoined / totalCommits : 0,
    costPerFileModified: totalFilesModified > 0 ? totalCostJoined / totalFilesModified : 0,
    costPer100Lines: totalLinesChanged > 0 ? (totalCostJoined / totalLinesChanged) * 100 : 0,
    linesPerDollar: totalCostJoined > 0 ? totalLinesChanged / totalCostJoined : 0,
    costPerMinute: totalDuration > 0 ? totalCostJoined / totalDuration : 0,
    costPerSession: allIds.size > 0 ? totalCostJoined / allIds.size : 0,
  };
  const toolReliability: ToolReliability = {
    totalToolCalls,
    totalToolErrors,
    errorRatePct: totalToolCalls > 0 ? (totalToolErrors / totalToolCalls) * 100 : 0,
  };
  const costByGoalCategory = Object.entries(goalCost)
    .map(([name, cost]) => ({ name, cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 12);
  const costByLanguage = Object.entries(languageCost)
    .map(([name, cost]) => ({ name, cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10);

  return {
    hasData: true,
    global: {
      scoredSessions,
      metaSessions: metaById.size,
      successRate: scoredSessions > 0 ? (achievedTotal / scoredSessions) * 100 : 0,
      frictionRate: scoredSessions > 0 ? (frictionSessions / scoredSessions) * 100 : 0,
      avgDurationMinutes: allIds.size > 0 ? totalDuration / allIds.size : 0,
      totalDurationMinutes: totalDuration,
      totalCommits, totalPushes, totalLinesAdded, totalLinesRemoved,
      totalFilesModified, totalInterruptions, totalToolErrors,
    },
    roi,
    toolReliability,
    costByGoalCategory,
    costByLanguage,
    outcomeCounts, helpfulnessCounts, sessionTypeCounts,
    primarySuccessCounts, satisfactionCounts, frictionCounts,
    topGoalCategories: topN(goalCategories, 12),
    topTools: topN(toolCounts, 12),
    languageMix: topN(languages, 10),
    costByOutcome: {
      achievedAvgCost: achievedCount > 0 ? achievedCostSum / achievedCount : 0,
      notAchievedAvgCost: notAchievedCount > 0 ? notAchievedCostSum / notAchievedCount : 0,
      achievedCount,
      notAchievedCount,
    },
    featureAdoption,
    frictionFeed: frictionFeed.slice(0, 20),
    recentSessions: rows.slice(0, 30),
    projectBreakdown,
  };
}
