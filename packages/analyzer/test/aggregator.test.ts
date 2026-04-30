import { test, describe, expect } from "vitest";
import { aggregateToSessions, aggregateToProjects, buildGlobalSummary } from "../src/aggregator.js";
import type { TurnRecord, TokenUsage, CostBreakdown, SessionMeta } from "../src/types.js";

const BASE_USAGE: TokenUsage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const BASE_COST: CostBreakdown = { inputCost: 0.0003, outputCost: 0.00075, cacheWriteCost: 0, cacheReadCost: 0, totalCost: 0.00105 };

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    uuid: "uuid-1",
    parentUuid: null,
    sessionId: "session-1",
    projectKey: "Users-test-git-project",
    timestamp: "2024-01-01T00:00:00.000Z",
    model: "claude-sonnet-4-6",
    usage: { ...BASE_USAGE },
    cost: { ...BASE_COST },
    isSubagent: false,
    agentId: null,
    sourceFile: "/fake/path.jsonl",
    ...overrides,
  };
}

function emptyMeta(): SessionMeta {
  return { aiTitle: null, entrypoint: null, gitBranch: null, permissionMode: null, version: null, mcpTools: [], compactEvents: [], limitHitCount: 0 };
}

describe("aggregateToSessions", () => {
  test("groups turns by sessionId", () => {
    const turns = [
      makeTurn({ uuid: "a", sessionId: "s1", timestamp: "2024-01-01T00:00:00.000Z" }),
      makeTurn({ uuid: "b", sessionId: "s1", timestamp: "2024-01-01T01:00:00.000Z" }),
      makeTurn({ uuid: "c", sessionId: "s2", timestamp: "2024-01-01T02:00:00.000Z" }),
    ];
    const sessions = aggregateToSessions(turns);
    expect(sessions.size).toBe(2);
    expect(sessions.get("s1")?.turns.length).toBe(2);
    expect(sessions.get("s2")?.turns.length).toBe(1);
  });

  test("sets firstTimestamp and lastTimestamp from sorted turns", () => {
    const turns = [
      makeTurn({ uuid: "a", timestamp: "2024-01-01T02:00:00.000Z" }),
      makeTurn({ uuid: "b", timestamp: "2024-01-01T00:00:00.000Z" }),
      makeTurn({ uuid: "c", timestamp: "2024-01-01T05:00:00.000Z" }),
    ];
    const session = aggregateToSessions(turns).get("session-1")!;
    expect(session.firstTimestamp).toBe("2024-01-01T00:00:00.000Z");
    expect(session.lastTimestamp).toBe("2024-01-01T05:00:00.000Z");
  });

  test("turns within session are sorted by timestamp", () => {
    const turns = [
      makeTurn({ uuid: "a", timestamp: "2024-01-01T05:00:00.000Z" }),
      makeTurn({ uuid: "b", timestamp: "2024-01-01T01:00:00.000Z" }),
    ];
    const session = aggregateToSessions(turns).get("session-1")!;
    expect(session.turns[0].uuid).toBe("b");
    expect(session.turns[1].uuid).toBe("a");
  });

  test("sums input and output tokens across all turns", () => {
    const session = aggregateToSessions([makeTurn({ uuid: "a" }), makeTurn({ uuid: "b" })]).get("session-1")!;
    expect(session.totals.input_tokens).toBe(200);
    expect(session.totals.output_tokens).toBe(100);
  });

  test("sums totalCost across all turns", () => {
    const session = aggregateToSessions([makeTurn({ uuid: "a" }), makeTurn({ uuid: "b" })]).get("session-1")!;
    expect(session.totalCost).toBeCloseTo(0.0021, 6);
  });

  test("detects subagents and counts unique agentIds", () => {
    const turns = [
      makeTurn({ uuid: "a", isSubagent: false }),
      makeTurn({ uuid: "b", isSubagent: true, agentId: "agent-1" }),
      makeTurn({ uuid: "c", isSubagent: true, agentId: "agent-1" }),
      makeTurn({ uuid: "d", isSubagent: true, agentId: "agent-2" }),
    ];
    const session = aggregateToSessions(turns).get("session-1")!;
    expect(session.hasSubagents).toBe(true);
    expect(session.subagentCount).toBe(2);
  });

  test("hasSubagents false when no subagent turns", () => {
    const session = aggregateToSessions([makeTurn({ uuid: "a" }), makeTurn({ uuid: "b" })]).get("session-1")!;
    expect(session.hasSubagents).toBe(false);
    expect(session.subagentCount).toBe(0);
  });

  test("carries projectKey from first turn", () => {
    const session = aggregateToSessions([makeTurn({ uuid: "a", projectKey: "my-proj" })]).get("session-1")!;
    expect(session.projectKey).toBe("my-proj");
  });

  test("applies meta from metaBySession map", () => {
    const meta = new Map([["session-1", { ...emptyMeta(), aiTitle: "My Session", gitBranch: "main" }]]);
    const session = aggregateToSessions([makeTurn({ uuid: "a" })], meta).get("session-1")!;
    expect(session.meta.aiTitle).toBe("My Session");
    expect(session.meta.gitBranch).toBe("main");
  });

  test("uses emptyMeta when no meta provided for session", () => {
    const session = aggregateToSessions([makeTurn({ uuid: "a" })]).get("session-1")!;
    expect(session.meta.aiTitle).toBeNull();
    expect(session.meta.mcpTools).toEqual([]);
  });

  test("empty turns returns empty map", () => {
    expect(aggregateToSessions([]).size).toBe(0);
  });

  test("handles cache token counts in totals", () => {
    const usage: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 500, cache_read_input_tokens: 200 };
    const cost: CostBreakdown = { inputCost: 0, outputCost: 0, cacheWriteCost: 0.001, cacheReadCost: 0.0001, totalCost: 0.0011 };
    const session = aggregateToSessions([makeTurn({ uuid: "a", usage, cost })]).get("session-1")!;
    expect(session.totals.cache_creation_input_tokens).toBe(500);
    expect(session.totals.cache_read_input_tokens).toBe(200);
  });
});

describe("aggregateToProjects", () => {
  test("groups sessions by projectKey", () => {
    const turns = [
      makeTurn({ uuid: "a", sessionId: "s1", projectKey: "proj-a" }),
      makeTurn({ uuid: "b", sessionId: "s2", projectKey: "proj-a" }),
      makeTurn({ uuid: "c", sessionId: "s3", projectKey: "proj-b" }),
    ];
    const projects = aggregateToProjects(aggregateToSessions(turns));
    expect(projects.size).toBe(2);
    expect(projects.get("proj-a")?.sessionCount).toBe(2);
    expect(projects.get("proj-b")?.sessionCount).toBe(1);
  });

  test("sessions sorted by lastTimestamp descending", () => {
    const turns = [
      makeTurn({ uuid: "a", sessionId: "s1", projectKey: "proj", timestamp: "2024-01-01T00:00:00.000Z" }),
      makeTurn({ uuid: "b", sessionId: "s2", projectKey: "proj", timestamp: "2024-01-03T00:00:00.000Z" }),
      makeTurn({ uuid: "c", sessionId: "s3", projectKey: "proj", timestamp: "2024-01-02T00:00:00.000Z" }),
    ];
    const project = aggregateToProjects(aggregateToSessions(turns)).get("proj")!;
    expect(project.sessions[0].sessionId).toBe("s2");
    expect(project.sessions[1].sessionId).toBe("s3");
    expect(project.sessions[2].sessionId).toBe("s1");
  });

  test("uses provided projectPaths map over derived path", () => {
    const sessions = aggregateToSessions([makeTurn({ uuid: "a", projectKey: "proj-a" })]);
    const project = aggregateToProjects(sessions, new Map([["proj-a", "/real/custom/path"]])).get("proj-a")!;
    expect(project.projectPath).toBe("/real/custom/path");
  });

  test("sums token totals across all sessions", () => {
    const turns = [
      makeTurn({ uuid: "a", sessionId: "s1", projectKey: "proj" }),
      makeTurn({ uuid: "b", sessionId: "s2", projectKey: "proj" }),
    ];
    const project = aggregateToProjects(aggregateToSessions(turns)).get("proj")!;
    expect(project.totals.input_tokens).toBe(200);
  });

  test("sums totalCost across sessions", () => {
    const turns = [
      makeTurn({ uuid: "a", sessionId: "s1", projectKey: "proj" }),
      makeTurn({ uuid: "b", sessionId: "s2", projectKey: "proj" }),
    ];
    const project = aggregateToProjects(aggregateToSessions(turns)).get("proj")!;
    expect(project.totalCost).toBeCloseTo(0.0021, 6);
  });

  test("includes claudeMd summary (empty for nonexistent path)", () => {
    const sessions = aggregateToSessions([makeTurn({ uuid: "a", projectKey: "nonexistent-proj" })]);
    const project = aggregateToProjects(sessions).get("nonexistent-proj")!;
    expect(project.claudeMd).toBeDefined();
    expect(project.claudeMd.files.length).toBe(0);
  });

  test("sums limitHitCount across sessions", () => {
    const meta = new Map([
      ["s1", { ...emptyMeta(), limitHitCount: 2 }],
      ["s2", { ...emptyMeta(), limitHitCount: 3 }],
    ]);
    const turns = [
      makeTurn({ uuid: "a", sessionId: "s1", projectKey: "proj" }),
      makeTurn({ uuid: "b", sessionId: "s2", projectKey: "proj" }),
    ];
    const project = aggregateToProjects(aggregateToSessions(turns, meta)).get("proj")!;
    expect(project.limitHitCount).toBe(5);
  });
});

describe("buildGlobalSummary", () => {
  test("counts projects and sessions correctly", () => {
    const turns = [
      makeTurn({ uuid: "a", sessionId: "s1", projectKey: "p1" }),
      makeTurn({ uuid: "b", sessionId: "s2", projectKey: "p2" }),
    ];
    const sessions = aggregateToSessions(turns);
    const summary = buildGlobalSummary(aggregateToProjects(sessions), turns);
    expect(summary.projectCount).toBe(2);
    expect(summary.sessionCount).toBe(2);
    expect(summary.turnCount).toBe(2);
  });

  test("sums total tokens and cost from all turns", () => {
    const turns = [makeTurn({ uuid: "a" }), makeTurn({ uuid: "b" })];
    const sessions = aggregateToSessions(turns);
    const summary = buildGlobalSummary(aggregateToProjects(sessions), turns);
    expect(summary.totals.input_tokens).toBe(200);
    expect(summary.totalCost).toBeCloseTo(0.0021, 6);
  });

  test("groups turns by model in byModel", () => {
    const turns = [
      makeTurn({ uuid: "a", model: "claude-sonnet-4-6" }),
      makeTurn({ uuid: "b", model: "claude-opus-4-7" }),
      makeTurn({ uuid: "c", model: "claude-sonnet-4-6" }),
    ];
    const sessions = aggregateToSessions(turns);
    const summary = buildGlobalSummary(aggregateToProjects(sessions), turns);
    expect("claude-sonnet-4-6" in summary.byModel).toBe(true);
    expect("claude-opus-4-7" in summary.byModel).toBe(true);
    expect(summary.byModel["claude-sonnet-4-6"]!.usage.input_tokens).toBe(200);
    expect(summary.byModel["claude-opus-4-7"]!.usage.input_tokens).toBe(100);
  });

  test("builds daily stats sorted by date", () => {
    const turns = [
      makeTurn({ uuid: "a", timestamp: "2024-01-03T00:00:00.000Z" }),
      makeTurn({ uuid: "b", timestamp: "2024-01-01T00:00:00.000Z" }),
      makeTurn({ uuid: "c", timestamp: "2024-01-02T00:00:00.000Z" }),
    ];
    const sessions = aggregateToSessions(turns);
    const summary = buildGlobalSummary(aggregateToProjects(sessions), turns);
    expect(summary.dailyStats.length).toBe(3);
    expect(summary.dailyStats[0].date).toBe("2024-01-01");
    expect(summary.dailyStats[1].date).toBe("2024-01-02");
    expect(summary.dailyStats[2].date).toBe("2024-01-03");
  });

  test("multiple turns same day merged into one stat", () => {
    const turns = [
      makeTurn({ uuid: "a", timestamp: "2024-01-01T08:00:00.000Z" }),
      makeTurn({ uuid: "b", timestamp: "2024-01-01T16:00:00.000Z" }),
    ];
    const sessions = aggregateToSessions(turns);
    const summary = buildGlobalSummary(aggregateToProjects(sessions), turns);
    expect(summary.dailyStats.length).toBe(1);
    expect(summary.dailyStats[0].input_tokens).toBe(200);
  });

  test("sums limitHitCount across all projects", () => {
    const meta = new Map([
      ["s1", { ...emptyMeta(), limitHitCount: 1 }],
      ["s2", { ...emptyMeta(), limitHitCount: 4 }],
    ]);
    const turns = [
      makeTurn({ uuid: "a", sessionId: "s1", projectKey: "p1" }),
      makeTurn({ uuid: "b", sessionId: "s2", projectKey: "p2" }),
    ];
    const sessions = aggregateToSessions(turns, meta);
    const summary = buildGlobalSummary(aggregateToProjects(sessions), turns);
    expect(summary.limitHitCount).toBe(5);
  });

  test("empty inputs return zero summary", () => {
    const summary = buildGlobalSummary(new Map(), []);
    expect(summary.projectCount).toBe(0);
    expect(summary.sessionCount).toBe(0);
    expect(summary.turnCount).toBe(0);
    expect(summary.totalCost).toBe(0);
    expect(summary.dailyStats.length).toBe(0);
    expect(summary.byModel).toEqual({});
  });
});
