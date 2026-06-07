import { estimateCacheMissCost } from "./cost.js";
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

export interface EfficiencyInsights {
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
  };
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
  let totalQueued = 0, sessionsWithQueue = 0;
  for (const s of sessions) {
    hookInvocations += s.meta.hookInvocations ?? 0;
    hookErrors += s.meta.hookErrors ?? 0;
    hookDurationMs += s.meta.hookDurationMs ?? 0;
    const q = s.meta.queuedMessages ?? 0;
    totalQueued += q;
    if (q > 0) sessionsWithQueue++;
  }

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
    queue: { totalQueued, sessionsWithQueue },
  };
}
