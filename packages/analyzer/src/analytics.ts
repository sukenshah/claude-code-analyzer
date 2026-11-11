import { estimateCacheMissCost, getModelPricing } from "./cost.js";
import type { TurnRecord, SessionRecord } from "./types.js";

// Inter-turn gaps longer than this are treated as session breaks (user stepped away),
// not response latency, and excluded from cadence stats.
const CADENCE_CAP_SEC = 30 * 60;

export interface CadenceStats {
  medianGapSec: number;
  p90GapSec: number;
  sampleCount: number;
}

export interface TemporalBucket {
  label: string;
  turns: number;
  cost: number;
}

export interface CacheMissReasonRow {
  reason: string;
  tokens: number;
  estCost: number;
}

export interface ToolReliabilityRow {
  tool: string;
  calls: number;
  errors: number;
  // Percentage (0-100), errors / calls.
  errorRate: number;
}

export interface PermissionDenialRow {
  kind: string;
  count: number;
}

export interface ContextBucketRow {
  label: string;
  minTokens: number;
  maxTokens: number | null;
  turns: number;
  cost: number;
  avgCostPerTurn: number;
}

export interface ContextTopSessionRow {
  sessionId: string;
  projectName: string;
  peakTokens: number;
  turns: number;
  cost: number;
}

export interface OriginRow {
  origin: string;
  prompts: number;
  turns: number;
  cost: number;
  costShare: number;
}

export interface EffortRow {
  effort: string;
  turns: number;
  cost: number;
  outputTokens: number;
  costShare: number;
}

export interface EfficiencyInsights {
  context: {
    medianTokens: number;
    p90Tokens: number;
    maxTokens: number;
    cacheReadCost: number;
    cacheReadCostShare: number;
    buckets: ContextBucketRow[];
    topSessions: ContextTopSessionRow[];
  };
  prompts: {
    count: number;
    totalCost: number;
    medianCost: number;
    p90Cost: number;
    maxCost: number;
    medianApiTurns: number;
    p90ApiTurns: number;
    medianToolCalls: number;
    p90ToolCalls: number;
    unattributedTurns: number;
    unattributedCost: number;
  };
  byOrigin: OriginRow[];
  byEffort: EffortRow[];
  permissions: { total: number; autoApproved: number; manualApproved: number; rejected: number; manualRate: number };
  bashHealth: { calls: number; timeouts: number; largeOutputs: number; timeoutRate: number };
  // Cadence: wall-clock gap between consecutive main (non-subagent) turns in a session.
  cadence: CadenceStats;
  // Temporal: how usage spreads across hour-of-day and weekday (UTC).
  byHour: TemporalBucket[];
  byWeekday: TemporalBucket[];
  // Model switching within a single session.
  modelSwitching: {
    totalSessions: number;
    sessionsWithMultipleModels: number;
    multiModelPct: number;
    switchEvents: number;
  };
  // How much spend/tokens go to subagents vs the main thread.
  subagentShare: {
    mainCost: number;
    subagentCost: number;
    subagentCostPct: number;
    mainTokens: number;
    subagentTokens: number;
  };
  // Tokens lost to prompt-cache invalidation and the estimated dollars wasted.
  cacheMiss: {
    totalMissTokens: number;
    estWastedCost: number;
    turnsAffected: number;
    byReason: CacheMissReasonRow[];
  };
  // Ephemeral cache-creation split by TTL bucket.
  ephemeral: {
    total5mTokens: number;
    total1hTokens: number;
    pct5m: number;
  };
  // Hook overhead aggregated across sessions.
  hooks: {
    totalInvocations: number;
    totalErrors: number;
    errorRate: number;
    totalDurationMs: number;
    avgDurationMs: number;
  };
  // Queued-message (impatience) signal.
  queue: {
    totalQueued: number;
    sessionsWithQueue: number;
    systemMessages: number;
    absorbedMidTurn: number;
  };
  // Wall-clock duration of turns (system/turn_duration records).
  turnDuration: { count: number; medianMs: number; p90Ms: number; totalMs: number };
  // Thinking tokens: share = thinking / output (0-1); estimatedCost at each turn's output rate.
  thinking: { thinkingTokens: number; outputTokens: number; share: number; estimatedCost: number };
  // All tools sorted by calls desc; errorRate is a percentage (0-100).
  toolReliability: ToolReliabilityRow[];
  toolErrorRate: number;
  permissionDenials: PermissionDenialRow[];
  apiErrors: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function buildEfficiencyInsights(
  turns: TurnRecord[],
  sessionsIter: Iterable<SessionRecord>,
): EfficiencyInsights {
  const sessions = [...sessionsIter];
  // ── Cadence: gap between consecutive main turns within each session ──────────
  const gaps: number[] = [];
  const bySession = new Map<string, TurnRecord[]>();
  for (const t of turns) {
    if (t.isSubagent) continue;
    const arr = bySession.get(t.sessionId) ?? [];
    arr.push(t);
    bySession.set(t.sessionId, arr);
  }
  for (const arr of bySession.values()) {
    arr.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (let i = 1; i < arr.length; i++) {
      const gap = (Date.parse(arr[i]!.timestamp) - Date.parse(arr[i - 1]!.timestamp)) / 1000;
      if (gap > 0 && gap <= CADENCE_CAP_SEC) gaps.push(gap);
    }
  }
  gaps.sort((a, b) => a - b);
  const cadence: CadenceStats = {
    medianGapSec: percentile(gaps, 50),
    p90GapSec: percentile(gaps, 90),
    sampleCount: gaps.length,
  };

  // ── Temporal: hour-of-day and weekday distributions ─────────────────────────
  const hourTurns = new Array(24).fill(0);
  const hourCost = new Array(24).fill(0);
  const wdTurns = new Array(7).fill(0);
  const wdCost = new Array(7).fill(0);
  for (const t of turns) {
    const hour = Number(t.timestamp.slice(11, 13));
    if (hour >= 0 && hour < 24) {
      hourTurns[hour]++;
      hourCost[hour] += t.cost.totalCost;
    }
    const ms = Date.parse(t.timestamp);
    if (!Number.isNaN(ms)) {
      const wd = new Date(ms).getUTCDay();
      wdTurns[wd]++;
      wdCost[wd] += t.cost.totalCost;
    }
  }
  const byHour: TemporalBucket[] = hourTurns.map((turns, h) => ({
    label: `${String(h).padStart(2, "0")}:00`,
    turns,
    cost: hourCost[h],
  }));
  const byWeekday: TemporalBucket[] = wdTurns.map((turns, d) => ({
    label: WEEKDAYS[d]!,
    turns,
    cost: wdCost[d],
  }));

  // ── Model switching + subagent share ────────────────────────────────────────
  let totalSessions = 0;
  let sessionsWithMultipleModels = 0;
  let switchEvents = 0;
  let mainCost = 0, subagentCost = 0, mainTokens = 0, subagentTokens = 0;

  const tokensOf = (t: TurnRecord) =>
    t.usage.input_tokens + t.usage.output_tokens +
    t.usage.cache_creation_input_tokens + t.usage.cache_read_input_tokens;

  for (const s of sessions) {
    totalSessions++;
    const mainTurns = s.turns.filter((t) => !t.isSubagent && t.model !== "<synthetic>");
    mainTurns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const distinct = new Set(mainTurns.map((t) => t.model));
    if (distinct.size > 1) sessionsWithMultipleModels++;
    for (let i = 1; i < mainTurns.length; i++) {
      if (mainTurns[i]!.model !== mainTurns[i - 1]!.model) switchEvents++;
    }
    for (const t of s.turns) {
      if (t.isSubagent) { subagentCost += t.cost.totalCost; subagentTokens += tokensOf(t); }
      else { mainCost += t.cost.totalCost; mainTokens += tokensOf(t); }
    }
  }

  // ── Cache-miss waste ─────────────────────────────────────────────────────────
  let totalMissTokens = 0, estWastedCost = 0, turnsAffected = 0;
  const reasonTokens = new Map<string, number>();
  const reasonCost = new Map<string, number>();
  for (const t of turns) {
    if (t.cacheMissTokens <= 0) continue;
    turnsAffected++;
    totalMissTokens += t.cacheMissTokens;
    const cost = estimateCacheMissCost(t.cacheMissTokens, t.model);
    estWastedCost += cost;
    const reason = t.cacheMissReason ?? "unknown";
    reasonTokens.set(reason, (reasonTokens.get(reason) ?? 0) + t.cacheMissTokens);
    reasonCost.set(reason, (reasonCost.get(reason) ?? 0) + cost);
  }
  const byReason: CacheMissReasonRow[] = [...reasonTokens.entries()]
    .map(([reason, tokens]) => ({ reason, tokens, estCost: reasonCost.get(reason) ?? 0 }))
    .sort((a, b) => b.tokens - a.tokens);

  // ── Ephemeral TTL split ──────────────────────────────────────────────────────
  let total5mTokens = 0, total1hTokens = 0;
  for (const t of turns) {
    total5mTokens += t.ephemeral5mTokens;
    total1hTokens += t.ephemeral1hTokens;
  }
  const ephTotal = total5mTokens + total1hTokens;

  // ── Hooks + queue (from session meta) ────────────────────────────────────────
  let hookInvocations = 0, hookErrors = 0, hookDurationMs = 0;
  let totalQueued = 0, sessionsWithQueue = 0, systemMessages = 0, absorbedMidTurn = 0;
  for (const s of sessions) {
    hookInvocations += s.meta.hookInvocations ?? 0;
    hookErrors += s.meta.hookErrors ?? 0;
    hookDurationMs += s.meta.hookDurationMs ?? 0;
    const q = s.meta.queuedMessages ?? 0;
    totalQueued += q;
    if (q > 0) sessionsWithQueue++;
    systemMessages += s.meta.queuedSystemMessages ?? 0;
    absorbedMidTurn += s.meta.queueAbsorbedMidTurn ?? 0;
  }

  // ── Turn durations, tools, denials, API errors, thinking ────────────────────
  const durations: number[] = [];
  const calls: Record<string, number> = {};
  const errs: Record<string, number> = {};
  const denials: Record<string, number> = {};
  let apiErrors = 0;
  for (const s of sessions) {
    durations.push(...(s.meta.turnDurationsMs ?? []));
    for (const [k, v] of Object.entries(s.meta.toolCalls ?? {})) calls[k] = (calls[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.meta.toolErrors ?? {})) errs[k] = (errs[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.meta.permissionDenials ?? {})) denials[k] = (denials[k] ?? 0) + v;
    apiErrors += s.meta.apiErrorCount ?? 0;
  }
  durations.sort((a, b) => a - b);
  const turnDuration = {
    count: durations.length,
    medianMs: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    totalMs: durations.reduce((a, b) => a + b, 0),
  };
  const toolNames = new Set([...Object.keys(calls), ...Object.keys(errs)]);
  const toolReliability: ToolReliabilityRow[] = [...toolNames]
    .map((tool) => {
      const c = calls[tool] ?? 0;
      const e = errs[tool] ?? 0;
      return { tool, calls: c, errors: e, errorRate: c > 0 ? (e / c) * 100 : 0 };
    })
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  const totalCalls = Object.values(calls).reduce((a, b) => a + b, 0);
  const totalErrs = Object.values(errs).reduce((a, b) => a + b, 0);
  const permissionDenials: PermissionDenialRow[] = Object.entries(denials)
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
  let thinkingTokens = 0, outputTokens = 0, thinkingCost = 0;
  for (const t of turns) {
    const th = t.thinkingTokens ?? 0;
    thinkingTokens += th;
    outputTokens += t.usage.output_tokens;
    thinkingCost += (th / 1_000_000) * getModelPricing(t.model).output;
  }

  // ── Context size ────────────────────────────────────────────────────────────
  const ctxOf = (t: TurnRecord) =>
    t.usage.input_tokens + t.usage.cache_read_input_tokens + t.usage.cache_creation_input_tokens;
  const totalCost = turns.reduce((a, t) => a + t.cost.totalCost, 0);
  const BUCKETS: Array<[string, number, number | null]> = [
    ["<50K", 0, 50_000], ["50–100K", 50_000, 100_000], ["100–200K", 100_000, 200_000],
    ["200–400K", 200_000, 400_000], ["400K+", 400_000, null],
  ];
  const buckets: ContextBucketRow[] = BUCKETS.map(([label, minTokens, maxTokens]) => ({
    label, minTokens, maxTokens, turns: 0, cost: 0, avgCostPerTurn: 0,
  }));
  const ctxSorted: number[] = [];
  let cacheReadCost = 0;
  const peakBySession = new Map<string, { peak: number; turns: number; cost: number }>();
  for (const t of turns) {
    const c = ctxOf(t);
    ctxSorted.push(c);
    cacheReadCost += t.cost.cacheReadCost;
    const b = buckets.find((x) => c >= x.minTokens && (x.maxTokens === null || c < x.maxTokens))!;
    b.turns++;
    b.cost += t.cost.totalCost;
    const e = peakBySession.get(t.sessionId) ?? { peak: 0, turns: 0, cost: 0 };
    e.peak = Math.max(e.peak, c); e.turns++; e.cost += t.cost.totalCost;
    peakBySession.set(t.sessionId, e);
  }
  for (const b of buckets) b.avgCostPerTurn = b.turns > 0 ? b.cost / b.turns : 0;
  ctxSorted.sort((a, b) => a - b);
  const nameBySession = new Map(sessions.map((s) => [s.sessionId, s.projectName]));
  const context = {
    medianTokens: percentile(ctxSorted, 50),
    p90Tokens: percentile(ctxSorted, 90),
    maxTokens: ctxSorted.length ? ctxSorted[ctxSorted.length - 1]! : 0,
    cacheReadCost,
    cacheReadCostShare: totalCost > 0 ? cacheReadCost / totalCost : 0,
    buckets,
    topSessions: [...peakBySession.entries()]
      .map(([sessionId, e]) => ({ sessionId, projectName: nameBySession.get(sessionId) ?? "", peakTokens: e.peak, turns: e.turns, cost: e.cost }))
      .sort((a, b) => b.peakTokens - a.peakTokens)
      .slice(0, 5),
  };

  // ── Prompts, origin, effort ─────────────────────────────────────────────────
  const promptAgg = new Map<string, { cost: number; turns: number; tools: number; origin: string | null }>();
  let unattributedTurns = 0, unattributedCost = 0;
  const originAgg = new Map<string, { prompts: Set<string>; turns: number; cost: number }>();
  const effortAgg = new Map<string, { turns: number; cost: number; out: number }>();
  // Subagent files share the parent's promptId, but the line carrying the origin exists only
  // in the main file. Resolve origin per (session, prompt) so subagent turns inherit it.
  const promptKey = (t: TurnRecord) => `${t.sessionId}\u0000${t.promptId}`;
  const originByPrompt = new Map<string, string>();
  for (const t of turns) {
    if (t.promptId && t.promptOrigin && !originByPrompt.has(promptKey(t))) originByPrompt.set(promptKey(t), t.promptOrigin);
  }
  for (const t of turns) {
    const origin = t.promptOrigin ?? (t.promptId ? originByPrompt.get(promptKey(t)) : undefined) ?? "unknown";
    const oa = originAgg.get(origin) ?? { prompts: new Set<string>(), turns: 0, cost: 0 };
    oa.turns++; oa.cost += t.cost.totalCost;
    originAgg.set(origin, oa);
    const effort = t.effort ?? "unknown";
    const ea = effortAgg.get(effort) ?? { turns: 0, cost: 0, out: 0 };
    ea.turns++; ea.cost += t.cost.totalCost; ea.out += t.usage.output_tokens;
    effortAgg.set(effort, ea);
    if (!t.promptId) { unattributedTurns++; unattributedCost += t.cost.totalCost; continue; }
    const key = `${t.sessionId}\u0000${t.promptId}`;
    oa.prompts.add(key);
    const pa = promptAgg.get(key) ?? { cost: 0, turns: 0, tools: 0, origin: t.promptOrigin };
    pa.cost += t.cost.totalCost; pa.turns++; pa.tools += t.toolUseCount ?? 0;
    promptAgg.set(key, pa);
  }
  const pv = [...promptAgg.values()];
  const sortedOf = (f: (p: (typeof pv)[number]) => number) => pv.map(f).sort((a, b) => a - b);
  const pc = sortedOf((p) => p.cost), pt = sortedOf((p) => p.turns), pk = sortedOf((p) => p.tools);
  const prompts = {
    count: pv.length,
    totalCost: pv.reduce((a, p) => a + p.cost, 0),
    medianCost: percentile(pc, 50), p90Cost: percentile(pc, 90), maxCost: pc.length ? pc[pc.length - 1]! : 0,
    medianApiTurns: percentile(pt, 50), p90ApiTurns: percentile(pt, 90),
    medianToolCalls: percentile(pk, 50), p90ToolCalls: percentile(pk, 90),
    unattributedTurns, unattributedCost,
  };
  const byOrigin: OriginRow[] = [...originAgg.entries()]
    .map(([origin, o]) => ({ origin, prompts: o.prompts.size, turns: o.turns, cost: o.cost, costShare: totalCost > 0 ? o.cost / totalCost : 0 }))
    .sort((a, b) => b.cost - a.cost);
  const byEffort: EffortRow[] = [...effortAgg.entries()]
    .map(([effort, e]) => ({ effort, turns: e.turns, cost: e.cost, outputTokens: e.out, costShare: totalCost > 0 ? e.cost / totalCost : 0 }))
    .sort((a, b) => b.cost - a.cost);

  // ── Permissions + bash health ───────────────────────────────────────────────
  let permTotal = 0, autoApproved = 0, manualApproved = 0, rejected = 0;
  let bashTimeouts = 0, bashLargeOutputs = 0;
  for (const s of sessions) {
    for (const [k, v] of Object.entries(s.meta.permissionDecisions ?? {})) {
      const [decision, ...rest] = k.split("/");
      const source = rest.join("/");
      permTotal += v;
      if (decision === "reject") rejected += v;
      else if (decision === "accept") { if (source === "config") autoApproved += v; else manualApproved += v; }
    }
    bashTimeouts += s.meta.bashTimeouts ?? 0;
    bashLargeOutputs += s.meta.bashLargeOutputs ?? 0;
  }
  const permissions = { total: permTotal, autoApproved, manualApproved, rejected, manualRate: permTotal > 0 ? (manualApproved / permTotal) * 100 : 0 };
  const bashCalls = calls["Bash"] ?? 0;
  const bashHealth = { calls: bashCalls, timeouts: bashTimeouts, largeOutputs: bashLargeOutputs, timeoutRate: bashCalls > 0 ? (bashTimeouts / bashCalls) * 100 : 0 };

  return {
    cadence,
    byHour,
    byWeekday,
    modelSwitching: {
      totalSessions,
      sessionsWithMultipleModels,
      multiModelPct: totalSessions > 0 ? (sessionsWithMultipleModels / totalSessions) * 100 : 0,
      switchEvents,
    },
    subagentShare: {
      mainCost,
      subagentCost,
      subagentCostPct: mainCost + subagentCost > 0 ? (subagentCost / (mainCost + subagentCost)) * 100 : 0,
      mainTokens,
      subagentTokens,
    },
    cacheMiss: { totalMissTokens, estWastedCost, turnsAffected, byReason },
    ephemeral: {
      total5mTokens,
      total1hTokens,
      pct5m: ephTotal > 0 ? (total5mTokens / ephTotal) * 100 : 0,
    },
    hooks: {
      totalInvocations: hookInvocations,
      totalErrors: hookErrors,
      errorRate: hookInvocations > 0 ? (hookErrors / hookInvocations) * 100 : 0,
      totalDurationMs: hookDurationMs,
      avgDurationMs: hookInvocations > 0 ? hookDurationMs / hookInvocations : 0,
    },
    queue: { totalQueued, sessionsWithQueue, systemMessages, absorbedMidTurn },
    context, prompts, byOrigin, byEffort, permissions, bashHealth,
    turnDuration,
    thinking: {
      thinkingTokens,
      outputTokens,
      share: outputTokens > 0 ? thinkingTokens / outputTokens : 0,
      estimatedCost: thinkingCost,
    },
    toolReliability,
    toolErrorRate: totalCalls > 0 ? (totalErrs / totalCalls) * 100 : 0,
    permissionDenials,
    apiErrors,
  };
}
