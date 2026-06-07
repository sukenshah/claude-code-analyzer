import { test, describe, expect } from "vitest";
import { buildEfficiencyInsights } from "../src/analytics.js";
import { calculateCost } from "../src/cost.js";
import type { TurnRecord, SessionRecord, SessionMeta } from "../src/types.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    aiTitle: null, entrypoint: null, gitBranch: null, permissionMode: null, version: null,
    mcpTools: [], mcpToolCalls: {}, compactEvents: [], limitHitCount: 0,
    hookInvocations: 0, hookErrors: 0, hookDurationMs: 0, queuedMessages: 0,
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
});
