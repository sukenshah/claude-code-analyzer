import { test, describe, expect } from "vitest";
import { buildEfficiencyInsights } from "../src/analytics.js";
import { calculateCost } from "../src/cost.js";
import type { TurnRecord, SessionRecord, SessionMeta } from "../src/types.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    aiTitle: null, entrypoint: null, gitBranch: null, permissionMode: null, version: null,
    mcpTools: [], mcpToolCalls: {}, compactEvents: [], limitHitCount: 0,
    hookInvocations: 0, hookErrors: 0, hookDurationMs: 0, queuedMessages: 0,
    apiErrorCount: 0, turnDurationsMs: [], toolCalls: {}, toolErrors: {}, permissionDenials: {},
    queuedSystemMessages: 0, queueAbsorbedMidTurn: 0, permissionDecisions: {}, bashTimeouts: 0, bashLargeOutputs: 0,
    ...overrides,
  };
}

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  const usage = overrides.usage ?? { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const model = overrides.model ?? "claude-sonnet-4-6";
  return {
    uuid: "u", parentUuid: null, sessionId: "s1", projectKey: "p",
    timestamp: "2024-01-01T10:00:00.000Z", model, usage,
    cost: calculateCost(usage, model),
    isSubagent: false, agentId: null, sourceFile: "/f.jsonl",
    cacheMissTokens: 0, cacheMissReason: null, ephemeral5mTokens: 0, ephemeral1hTokens: 0,
    messageId: null, thinkingTokens: 0,
    promptId: null, promptOrigin: null, toolUseCount: 0, effort: null,
    ...overrides,
  };
}

function session(turns: TurnRecord[], m: SessionMeta = meta()): SessionRecord {
  const totalCost = turns.reduce((s, t) => s + t.cost.totalCost, 0);
  return {
    sessionId: turns[0]?.sessionId ?? "s1", projectKey: "p", projectName: "proj",
    firstTimestamp: turns[0]?.timestamp ?? "", lastTimestamp: turns[turns.length - 1]?.timestamp ?? "",
    turns, totals: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    totalCost, hasSubagents: turns.some((t) => t.isSubagent),
    subagentCount: 0, meta: m,
  };
}

describe("buildEfficiencyInsights", () => {
  test("cache-miss waste sums tokens and groups by reason", () => {
    const turns = [
      turn({ uuid: "a", cacheMissTokens: 1000, cacheMissReason: "tools_changed" }),
      turn({ uuid: "b", cacheMissTokens: 500, cacheMissReason: "tools_changed" }),
      turn({ uuid: "c", cacheMissTokens: 200, cacheMissReason: null }),
      turn({ uuid: "d" }),
    ];
    const ins = buildEfficiencyInsights(turns, [session(turns)]);
    expect(ins.cacheMiss.totalMissTokens).toBe(1700);
    expect(ins.cacheMiss.turnsAffected).toBe(3);
    expect(ins.cacheMiss.estWastedCost).toBeGreaterThan(0);
    const tc = ins.cacheMiss.byReason.find((r) => r.reason === "tools_changed");
    expect(tc?.tokens).toBe(1500);
    expect(ins.cacheMiss.byReason.find((r) => r.reason === "unknown")?.tokens).toBe(200);
  });

  test("subagent cost share splits main vs subagent", () => {
    const turns = [
      turn({ uuid: "m", isSubagent: false }),
      turn({ uuid: "s", isSubagent: true }),
    ];
    const ins = buildEfficiencyInsights(turns, [session(turns)]);
    expect(ins.subagentShare.mainCost).toBeGreaterThan(0);
    expect(ins.subagentShare.subagentCost).toBeGreaterThan(0);
    expect(ins.subagentShare.subagentCostPct).toBeCloseTo(50, 0);
  });

  test("model switching counts distinct models and switch events", () => {
    const turns = [
      turn({ uuid: "a", model: "claude-sonnet-4-6", timestamp: "2024-01-01T10:00:00.000Z" }),
      turn({ uuid: "b", model: "claude-opus-4-8", timestamp: "2024-01-01T10:01:00.000Z" }),
      turn({ uuid: "c", model: "claude-opus-4-8", timestamp: "2024-01-01T10:02:00.000Z" }),
    ];
    const ins = buildEfficiencyInsights(turns, [session(turns)]);
    expect(ins.modelSwitching.sessionsWithMultipleModels).toBe(1);
    expect(ins.modelSwitching.switchEvents).toBe(1);
  });

  test("ephemeral split and pct5m", () => {
    const turns = [
      turn({ uuid: "a", ephemeral5mTokens: 300, ephemeral1hTokens: 100 }),
    ];
    const ins = buildEfficiencyInsights(turns, [session(turns)]);
    expect(ins.ephemeral.total5mTokens).toBe(300);
    expect(ins.ephemeral.total1hTokens).toBe(100);
    expect(ins.ephemeral.pct5m).toBeCloseTo(75, 0);
  });

  test("hooks and queue aggregate from session meta", () => {
    const turns = [turn({ uuid: "a" })];
    const s = session(turns, meta({ hookInvocations: 4, hookErrors: 1, hookDurationMs: 800, queuedMessages: 2 }));
    const ins = buildEfficiencyInsights(turns, [s]);
    expect(ins.hooks.totalInvocations).toBe(4);
    expect(ins.hooks.totalErrors).toBe(1);
    expect(ins.hooks.errorRate).toBeCloseTo(25, 0);
    expect(ins.hooks.avgDurationMs).toBeCloseTo(200, 0);
    expect(ins.queue.totalQueued).toBe(2);
    expect(ins.queue.sessionsWithQueue).toBe(1);
  });

  test("cadence excludes gaps longer than 30 minutes", () => {
    const turns = [
      turn({ uuid: "a", timestamp: "2024-01-01T10:00:00.000Z" }),
      turn({ uuid: "b", timestamp: "2024-01-01T10:00:30.000Z" }), // 30s gap (kept)
      turn({ uuid: "c", timestamp: "2024-01-01T12:00:30.000Z" }), // 2h gap (excluded)
    ];
    const ins = buildEfficiencyInsights(turns, [session(turns)]);
    expect(ins.cadence.sampleCount).toBe(1);
    expect(ins.cadence.medianGapSec).toBeCloseTo(30, 0);
  });

  test("temporal buckets count turns by hour and weekday", () => {
    const turns = [
      turn({ uuid: "a", timestamp: "2024-01-01T10:00:00.000Z" }), // Mon 10:00 UTC
      turn({ uuid: "b", timestamp: "2024-01-01T10:30:00.000Z" }),
    ];
    const ins = buildEfficiencyInsights(turns, [session(turns)]);
    expect(ins.byHour[10]!.turns).toBe(2);
    expect(ins.byWeekday[1]!.turns).toBe(2); // Jan 1 2024 is a Monday
  });

  test("turn duration, tools, denials, api errors, thinking", () => {
    const turns = [
      turn({ uuid: "a", usage: { input_tokens: 0, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, thinkingTokens: 250_000 }),
    ];
    const s1 = session(turns, meta({
      turnDurationsMs: [1000, 2000, 3000, 4000], apiErrorCount: 2,
      toolCalls: { Bash: 10, Read: 5 }, toolErrors: { Bash: 2, unknown: 1 },
      permissionDenials: { "user-rejected": 1, "permission-rule": 3 },
    }));
    const ins = buildEfficiencyInsights(turns, [s1]);
    expect(ins.turnDuration).toEqual({ count: 4, medianMs: 3000, p90Ms: 4000, totalMs: 10000 });
    expect(ins.thinking.thinkingTokens).toBe(250_000);
    expect(ins.thinking.share).toBeCloseTo(0.25, 6);
    expect(ins.toolReliability[0]).toEqual({ tool: "Bash", calls: 10, errors: 2, errorRate: 20 });
    expect(ins.toolReliability.find((r) => r.tool === "unknown")).toEqual({ tool: "unknown", calls: 0, errors: 1, errorRate: 0 });
    expect(ins.toolErrorRate).toBeCloseTo(20, 6);
    expect(ins.permissionDenials).toEqual([{ kind: "permission-rule", count: 3 }, { kind: "user-rejected", count: 1 }]);
    expect(ins.apiErrors).toBe(2);
    expect(ins.thinking.estimatedCost).toBeCloseTo(3.75, 6); // sonnet-4-6 output $15/M
  });
});

describe("new efficiency sections", () => {
  const u = (input: number, cr = 0, cc = 0) => ({ input_tokens: input, output_tokens: 10, cache_creation_input_tokens: cc, cache_read_input_tokens: cr });

  test("context buckets, boundaries and top sessions", () => {
    const sizes = [49_999, 50_000, 100_000, 199_999, 200_000, 400_000];
    const turns = sizes.map((n, i) => turn({ uuid: "c" + i, usage: u(n - 2000, 1000, 1000) }));
    const ins = buildEfficiencyInsights(turns, [session(turns)]);
    expect(ins.context.buckets.map((b) => b.label)).toEqual(["<50K", "50–100K", "100–200K", "200–400K", "400K+"]);
    expect(ins.context.buckets.map((b) => b.turns)).toEqual([1, 1, 2, 1, 1]);
    expect(ins.context.buckets[4]!.maxTokens).toBeNull();
    expect(ins.context.maxTokens).toBe(400_000);
    expect(ins.context.topSessions).toHaveLength(1);
    expect(ins.context.topSessions[0]!.peakTokens).toBe(400_000);
    expect(ins.context.cacheReadCostShare).toBeGreaterThan(0);
    expect(ins.context.cacheReadCostShare).toBeLessThanOrEqual(1);
  });

  test("empty input returns all five buckets", () => {
    const ins = buildEfficiencyInsights([], []);
    expect(ins.context.buckets).toHaveLength(5);
    expect(ins.prompts.count).toBe(0);
  });

  test("prompt grouping with unattributed turns", () => {
    const turns = [
      turn({ uuid: "a", promptId: "p1", toolUseCount: 2 }),
      turn({ uuid: "b", promptId: "p1", toolUseCount: 3 }),
      turn({ uuid: "c", promptId: "p2", toolUseCount: 0, sessionId: "s2" }),
      turn({ uuid: "d", promptId: "p1", sessionId: "s2" }),
      turn({ uuid: "e", promptId: null }),
    ];
    const ins = buildEfficiencyInsights(turns, [session(turns)]);
    expect(ins.prompts.count).toBe(3);
    expect(ins.prompts.unattributedTurns).toBe(1);
    expect(ins.prompts.unattributedCost).toBeCloseTo(turns[4]!.cost.totalCost);
    expect(ins.prompts.maxCost).toBeCloseTo(turns[0]!.cost.totalCost * 2);
    expect(ins.prompts.p90ToolCalls).toBe(5);
    expect(ins.prompts.p90ApiTurns).toBe(2);
  });

  test("origin and effort shares", () => {
    const turns = [
      turn({ uuid: "a", promptId: "p1", promptOrigin: "human", effort: "high" }),
      turn({ uuid: "b", promptId: "p1", promptOrigin: "human", effort: "high" }),
      turn({ uuid: "c", promptId: "p2", promptOrigin: "human", effort: null }),
      turn({ uuid: "d", promptId: "p3", promptOrigin: null, effort: "low" }),
    ];
    const ins = buildEfficiencyInsights(turns, [session(turns)]);
    expect(ins.byOrigin[0]!.origin).toBe("human");
    expect(ins.byOrigin[0]!.prompts).toBe(2);
    expect(ins.byOrigin[0]!.turns).toBe(3);
    expect(ins.byOrigin[0]!.costShare).toBeCloseTo(0.75);
    expect(ins.byOrigin[1]!.origin).toBe("unknown");
    expect(ins.byEffort[0]).toMatchObject({ effort: "high", turns: 2, outputTokens: 100 });
    expect(ins.byEffort[0]!.costShare).toBeCloseTo(0.5);
    expect(ins.byEffort.map((e) => e.effort).sort()).toEqual(["high", "low", "unknown"]);
  });

  test("subagent turns inherit the origin of their parent prompt", () => {
    const turns = [
      // subagent turn listed first: origin must resolve regardless of order
      turn({ uuid: "s1", promptId: "p1", promptOrigin: null, isSubagent: true }),
      turn({ uuid: "m1", promptId: "p1", promptOrigin: "scheduled" }),
      turn({ uuid: "s2", promptId: "p1", promptOrigin: null, isSubagent: true }),
      turn({ uuid: "x", promptId: "p9", promptOrigin: null }),
    ];
    const ins = buildEfficiencyInsights(turns, [session(turns)]);
    expect(ins.byOrigin[0]).toMatchObject({ origin: "scheduled", prompts: 1, turns: 3 });
    expect(ins.byOrigin[1]).toMatchObject({ origin: "unknown", prompts: 1, turns: 1 });
  });

  test("permissions math, bash health, queue extras", () => {
    const m1 = meta({
      permissionDecisions: { "accept/config": 6, "accept/user_temporary": 2, "reject/user_reject": 1, "reject/config": 1 },
      toolCalls: { Bash: 20 }, bashTimeouts: 2, bashLargeOutputs: 3,
      queuedMessages: 1, queuedSystemMessages: 4, queueAbsorbedMidTurn: 2,
    });
    const m2 = meta({ permissionDecisions: { "accept/user_permanent": 0 }, queuedSystemMessages: 1 });
    const t1 = turn({ uuid: "x", sessionId: "s1" });
    const t2 = turn({ uuid: "y", sessionId: "s2" });
    const ins = buildEfficiencyInsights([t1, t2], [session([t1], m1), session([t2], m2)]);
    expect(ins.permissions).toMatchObject({ total: 10, autoApproved: 6, manualApproved: 2, rejected: 2 });
    expect(ins.permissions.manualRate).toBeCloseTo(20);
    expect(ins.bashHealth).toMatchObject({ calls: 20, timeouts: 2, largeOutputs: 3 });
    expect(ins.bashHealth.timeoutRate).toBeCloseTo(10);
    expect(ins.queue).toMatchObject({ totalQueued: 1, sessionsWithQueue: 1, systemMessages: 5, absorbedMidTurn: 2 });
  });
});

