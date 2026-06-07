import { test, describe, beforeEach, expect } from "vitest";
import { fmtTokens, cutoffDate, setCachedResult, registerTools } from "../src/tools.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AnalysisResult,
  TurnRecord,
  SessionRecord,
  ProjectRecord,
  TokenUsage,
  CostBreakdown,
  SessionMeta,
  ClaudeMdSummary,
  GlobalSummary,
} from "@claude-analyzer/analyzer";

// ─── Mock MCP server ─────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

class MockServer {
  private handlers = new Map<string, ToolHandler>();

  registerTool(name: string, _opts: unknown, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  async call(name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
    const h = this.handlers.get(name);
    if (!h) throw new Error(`Tool not registered: ${name}`);
    return h(input);
  }

  async text(name: string, input: Record<string, unknown> = {}): Promise<string> {
    return (await this.call(name, input)).content[0].text;
  }

  registered(): string[] {
    return [...this.handlers.keys()];
  }
}

// ─── Fixture factories ────────────────────────────────────────────────────────

const BASE_USAGE: TokenUsage = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 200,
};
const BASE_COST: CostBreakdown = {
  inputCost: 0.003,
  outputCost: 0.0075,
  cacheWriteCost: 0,
  cacheReadCost: 0.00006,
  totalCost: 0.01056,
};
const EMPTY_META: SessionMeta = {
  aiTitle: null,
  entrypoint: null,
  gitBranch: null,
  permissionMode: null,
  version: null,
  mcpTools: [],
  compactEvents: [],
  limitHitCount: 0,
};
const EMPTY_CLAUDE_MD: ClaudeMdSummary = {
  files: [],
  totalEstimatedTokens: 0,
  totalPerSessionCostUsd: 0,
};

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    uuid: "turn-uuid-1",
    parentUuid: null,
    sessionId: "session-aabbccdd-1234-5678-abcd-000000000001",
    projectKey: "Users-test-git-myproject",
    timestamp: "2024-06-15T10:00:00.000Z",
    model: "claude-sonnet-4-6",
    usage: { ...BASE_USAGE },
    cost: { ...BASE_COST },
    isSubagent: false,
    agentId: null,
    sourceFile: "/fake/path.jsonl",
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "session-aabbccdd-1234-5678-abcd-000000000001",
    projectKey: "Users-test-git-myproject",
    projectName: "myproject",
    firstTimestamp: "2024-06-15T10:00:00.000Z",
    lastTimestamp: "2024-06-15T11:00:00.000Z",
    turns: [makeTurn()],
    totals: { ...BASE_USAGE },
    totalCost: BASE_COST.totalCost,
    hasSubagents: false,
    subagentCount: 0,
    meta: { ...EMPTY_META },
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  const session = makeSession();
  return {
    projectKey: "Users-test-git-myproject",
    projectName: "myproject",
    projectPath: "/Users/test/git/myproject",
    sessionCount: 1,
    sessions: [session],
    totals: { ...BASE_USAGE },
    totalCost: BASE_COST.totalCost,
    claudeMd: { ...EMPTY_CLAUDE_MD },
    limitHitCount: 0,
    ...overrides,
  };
}

function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const project = makeProject();
  const session = project.sessions[0];
  const turns = session.turns;

  return {
    projects: new Map([[project.projectKey, project]]),
    sessions: new Map([[session.sessionId, session]]),
    allTurns: turns,
    summary: {
      projectCount: 1,
      sessionCount: 1,
      turnCount: turns.length,
      totals: { ...BASE_USAGE },
      totalCost: BASE_COST.totalCost,
      byModel: {},
      dailyStats: [],
      limitHitCount: 0,
    } satisfies GlobalSummary,
    newFilesScanned: 0,
    ...overrides,
  };
}

// ─── fmtTokens ────────────────────────────────────────────────────────────────

describe("fmtTokens", () => {
  test("zero", () => expect(fmtTokens(0)).toBe("0"));
  test("under 1K", () => expect(fmtTokens(999)).toBe("999"));
  test("exactly 1K", () => expect(fmtTokens(1000)).toBe("1.0K"));
  test("1.5K", () => expect(fmtTokens(1500)).toBe("1.5K"));
  test("999.9K", () => expect(fmtTokens(999_900)).toBe("999.9K"));
  test("exactly 1M", () => expect(fmtTokens(1_000_000)).toBe("1.00M"));
  test("1.23M", () => expect(fmtTokens(1_234_567)).toBe("1.23M"));
  test("10M", () => expect(fmtTokens(10_000_000)).toBe("10.00M"));
});

// ─── cutoffDate ──────────────────────────────────────────────────────────────

describe("cutoffDate", () => {
  test("returns YYYY-MM-DD format", () => {
    expect(cutoffDate(7)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("7-day cutoff is in the past", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(cutoffDate(7) < today).toBe(true);
  });

  test("0-day cutoff equals today", () => {
    expect(cutoffDate(0)).toBe(new Date().toISOString().slice(0, 10));
  });

  test("30-day cutoff is earlier than 7-day cutoff", () => {
    expect(cutoffDate(30) < cutoffDate(7)).toBe(true);
  });
});

// ─── Tool registration ────────────────────────────────────────────────────────

describe("registerTools", () => {
  test("registers exactly 13 tools", () => {
    const server = new MockServer();
    registerTools(server as unknown as McpServer);
    expect(server.registered().length).toBe(13);
  });

  test("registers expected tool names, no forecast tool", () => {
    const server = new MockServer();
    registerTools(server as unknown as McpServer);
    const names = server.registered();
    expect(names).toContain("get_usage_summary");
    expect(names).toContain("get_project_breakdown");
    expect(names).toContain("get_session_list");
    expect(names).toContain("get_session_detail");
    expect(names).toContain("get_spend_trend");
    expect(names).toContain("get_model_breakdown");
    expect(names).toContain("get_session_quality");
    expect(names).toContain("get_compaction_stats");
    expect(names).toContain("get_context_limit_stats");
    expect(names).toContain("get_active_sessions");
    expect(names).toContain("get_efficiency_insights");
    expect(names).toContain("get_productivity_roi");
    expect(names).toContain("refresh_cache");
    expect(names).not.toContain("get_cost_forecast");
  });
});

// ─── get_usage_summary ────────────────────────────────────────────────────────

describe("get_usage_summary", () => {
  let server: MockServer;

  beforeEach(() => {
    server = new MockServer();
    registerTools(server as unknown as McpServer);
    setCachedResult(makeResult());
  });

  test("shows session and turn counts", async () => {
    const text = await server.text("get_usage_summary", { days: 0 });
    expect(text).toMatch(/Sessions:\s+1/);
    expect(text).toMatch(/Turns.*:\s+1/);
  });

  test("shows estimated cost", async () => {
    expect(await server.text("get_usage_summary", { days: 0 })).toMatch(/Estimated cost/);
  });

  test("shows all token categories", async () => {
    const text = await server.text("get_usage_summary", { days: 0 });
    expect(text).toMatch(/Input:/);
    expect(text).toMatch(/Output:/);
    expect(text).toMatch(/Cache write:/);
    expect(text).toMatch(/Cache read:/);
  });

  test("days=0 includes all turns regardless of age", async () => {
    const result = makeResult();
    result.allTurns.push(makeTurn({ uuid: "old", timestamp: "2020-01-01T00:00:00.000Z" }));
    setCachedResult(result);

    expect(await server.text("get_usage_summary", { days: 0 })).toMatch(/Turns.*:\s+2/);
  });

  test("project filter narrows to matching turns", async () => {
    const result = makeResult();
    result.allTurns.push(makeTurn({ uuid: "other", projectKey: "Users-work-git-otherproject", sessionId: "session-other" }));
    setCachedResult(result);

    expect(await server.text("get_usage_summary", { days: 0, project: "myproject" })).toMatch(/Turns.*:\s+1/);
  });

  test("no-match filter returns no-data message", async () => {
    expect(await server.text("get_usage_summary", { days: 0, project: "nonexistent-xyz" })).toMatch(/No data found/);
  });

  test("scope label shows project name when filtered", async () => {
    expect(await server.text("get_usage_summary", { days: 0, project: "myproject" })).toMatch(/project: myproject/);
  });

  test("scope label shows all projects when unfiltered", async () => {
    expect(await server.text("get_usage_summary", { days: 0 })).toMatch(/all projects/);
  });
});

// ─── get_project_breakdown ───────────────────────────────────────────────────

describe("get_project_breakdown", () => {
  let server: MockServer;

  beforeEach(() => {
    server = new MockServer();
    registerTools(server as unknown as McpServer);

    const proj1 = makeProject({ projectKey: "proj-a", projectName: "alpha", totalCost: 5.0, sessions: [], sessionCount: 3 });
    const proj2 = makeProject({ projectKey: "proj-b", projectName: "beta", totalCost: 2.0, sessions: [], sessionCount: 10 });

    setCachedResult(makeResult({
      projects: new Map([["proj-a", proj1], ["proj-b", proj2]]),
      allTurns: [],
    }));
  });

  test("lists both projects", async () => {
    const text = await server.text("get_project_breakdown", { sort_by: "cost", limit: 10 });
    expect(text).toMatch(/alpha/);
    expect(text).toMatch(/beta/);
  });

  test("sort by cost: higher cost first", async () => {
    const text = await server.text("get_project_breakdown", { sort_by: "cost", limit: 10 });
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("beta"));
  });

  test("sort by sessions: more sessions first", async () => {
    const text = await server.text("get_project_breakdown", { sort_by: "sessions", limit: 10 });
    expect(text.indexOf("beta")).toBeLessThan(text.indexOf("alpha"));
  });

  test("limit restricts output", async () => {
    const text = await server.text("get_project_breakdown", { sort_by: "cost", limit: 1 });
    expect(text).toMatch(/top 1/);
    expect(text).not.toContain("beta");
  });

  test("header shows sort_by field", async () => {
    expect(await server.text("get_project_breakdown", { sort_by: "tokens", limit: 10 })).toMatch(/sorted by tokens/);
  });

  test("CLAUDE.md line shown when files present", async () => {
    const proj = makeProject({
      projectKey: "proj-c",
      projectName: "gamma",
      claudeMd: {
        files: [{ filePath: "/p/CLAUDE.md", relativePath: "CLAUDE.md", sizeBytes: 100, estimatedTokens: 200, perSessionCostUsd: 0.0006 }],
        totalEstimatedTokens: 200,
        totalPerSessionCostUsd: 0.0006,
      },
    });
    setCachedResult(makeResult({ projects: new Map([["proj-c", proj]]), allTurns: [] }));

    expect(await server.text("get_project_breakdown", { sort_by: "cost", limit: 10 })).toMatch(/CLAUDE\.md/);
  });
});

// ─── get_session_list ────────────────────────────────────────────────────────

describe("get_session_list", () => {
  let server: MockServer;

  beforeEach(() => {
    server = new MockServer();
    registerTools(server as unknown as McpServer);

    const s1 = makeSession({ sessionId: "aaaa0001-1234-5678-abcd-000000000001", lastTimestamp: "2024-06-15T11:00:00.000Z", totalCost: 0.05 });
    const s2 = makeSession({
      sessionId: "bbbb0002-1234-5678-abcd-000000000002",
      lastTimestamp: "2024-06-10T08:00:00.000Z",
      totalCost: 0.20,
      turns: [makeTurn({ uuid: "t2", sessionId: "bbbb0002-1234-5678-abcd-000000000002" })],
    });
    const project = makeProject({ sessions: [s1, s2], sessionCount: 2 });
    setCachedResult(makeResult({ projects: new Map([[project.projectKey, project]]) }));
  });

  test("project not found returns error message with available list", async () => {
    const text = await server.text("get_session_list", { project: "definitely-not-a-project", sort_by: "date", limit: 20 });
    expect(text).toMatch(/not found/);
    expect(text).toMatch(/Available/);
  });

  test("found project shows both sessions", async () => {
    const text = await server.text("get_session_list", { project: "myproject", sort_by: "date", limit: 20 });
    expect(text).toMatch(/Sessions for myproject/);
    expect(text).toContain("aaaa0001");
    expect(text).toContain("bbbb0002");
  });

  test("sort by date: newer session first", async () => {
    const text = await server.text("get_session_list", { project: "myproject", sort_by: "date", limit: 20 });
    expect(text.indexOf("aaaa0001")).toBeLessThan(text.indexOf("bbbb0002"));
  });

  test("sort by cost: higher cost first", async () => {
    const text = await server.text("get_session_list", { project: "myproject", sort_by: "cost", limit: 20 });
    expect(text.indexOf("bbbb0002")).toBeLessThan(text.indexOf("aaaa0001"));
  });

  test("limit cuts session list", async () => {
    expect(await server.text("get_session_list", { project: "myproject", sort_by: "date", limit: 1 })).toMatch(/showing 1/);
  });

  test("partial project name matches case-insensitively", async () => {
    expect(await server.text("get_session_list", { project: "MYPROJ", sort_by: "date", limit: 20 })).toMatch(/Sessions for myproject/);
  });

  test("subagent indicator shown when present", async () => {
    const sWithSub = makeSession({ sessionId: "cccc0003-0000-0000-0000-000000000003", hasSubagents: true, subagentCount: 2 });
    const project = makeProject({ sessions: [sWithSub], sessionCount: 1 });
    setCachedResult(makeResult({ projects: new Map([[project.projectKey, project]]) }));

    expect(await server.text("get_session_list", { project: "myproject", sort_by: "date", limit: 20 })).toMatch(/subagent/);
  });
});

// ─── get_session_detail ──────────────────────────────────────────────────────

describe("get_session_detail", () => {
  let server: MockServer;
  const sessionId = "session-aabbccdd-1234-5678-abcd-000000000001";

  beforeEach(() => {
    server = new MockServer();
    registerTools(server as unknown as McpServer);
    setCachedResult(makeResult());
  });

  test("session not found returns isError=true", async () => {
    const result = await server.call("get_session_detail", { session_id: "nonexistent-id", include_turns: false });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });

  test("full session ID match returns detail", async () => {
    const text = await server.text("get_session_detail", { session_id: sessionId, include_turns: false });
    expect(text).toMatch(/Session:/);
    expect(text).toContain(sessionId);
  });

  test("prefix (first 8 chars) match works", async () => {
    const text = await server.text("get_session_detail", { session_id: sessionId.slice(0, 8), include_turns: false });
    expect(text).toContain(sessionId);
  });

  test("shows project name", async () => {
    expect(await server.text("get_session_detail", { session_id: sessionId, include_turns: false })).toMatch(/Project: myproject/);
  });

  test("shows all token breakdown fields", async () => {
    const text = await server.text("get_session_detail", { session_id: sessionId, include_turns: false });
    expect(text).toMatch(/Token Breakdown/);
    expect(text).toMatch(/Input:/);
    expect(text).toMatch(/Output:/);
    expect(text).toMatch(/Cache write:/);
    expect(text).toMatch(/Cache read:/);
  });

  test("shows estimated cost", async () => {
    expect(await server.text("get_session_detail", { session_id: sessionId, include_turns: false })).toMatch(/Estimated Cost/);
  });

  test("include_turns=false: no per-turn table", async () => {
    expect(await server.text("get_session_detail", { session_id: sessionId, include_turns: false })).not.toContain("Per-Turn Breakdown");
  });

  test("include_turns=true: per-turn table present", async () => {
    const text = await server.text("get_session_detail", { session_id: sessionId, include_turns: true });
    expect(text).toMatch(/Per-Turn Breakdown/);
    expect(text).toMatch(/Turn.*Time.*Model/);
  });

  test("shows subagent count when present", async () => {
    const session = makeSession({
      sessionId,
      hasSubagents: true,
      subagentCount: 3,
      turns: [makeTurn({ uuid: "t1", isSubagent: false }), makeTurn({ uuid: "t2", isSubagent: true, agentId: "agent-1" })],
    });
    setCachedResult(makeResult({ sessions: new Map([[sessionId, session]]) }));

    expect(await server.text("get_session_detail", { session_id: sessionId, include_turns: false })).toMatch(/3 subagent/);
  });

  test("shows cache hit rate", async () => {
    expect(await server.text("get_session_detail", { session_id: sessionId, include_turns: false })).toMatch(/cache hit rate/);
  });
});
