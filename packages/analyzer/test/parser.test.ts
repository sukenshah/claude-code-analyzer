import { test, describe, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseFile } from "../src/parser.js";
import type { ScanEntry } from "../src/types.js";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "parser-test-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

let n = 0;
async function parse(lines: unknown[]) {
  const filePath = join(dir, `f${n++}.jsonl`);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const entry: ScanEntry = { sessionId: "sess", projectKey: "proj", filePath, isSubagent: false, agentId: null };
  return parseFile(entry);
}

const usage = (o: Record<string, unknown> = {}) => ({
  input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...o,
});
const asst = (uuid: string, id: string | undefined, content: unknown[], u: unknown = usage(), extra: Record<string, unknown> = {}) => ({
  type: "assistant", uuid, parentUuid: "p-" + uuid, timestamp: `2025-01-01T00:00:0${uuid.length}.000Z`,
  message: { id, model: "claude-sonnet-5-5", usage: u, content, ...extra },
});

describe("parseFile", () => {
  test("dedups lines by message.id; last usage, first uuid/timestamp; all tool_use counted", async () => {
    const { turns, meta } = await parse([
      asst("a", "msg1", [{ type: "thinking" }], usage({ output_tokens: 5, output_tokens_details: { thinking_tokens: 3 } })),
      asst("bb", "msg1", [{ type: "tool_use", id: "t1", name: "Bash" }], usage({ output_tokens: 50, output_tokens_details: { thinking_tokens: 3 } })),
      asst("ccc", "msg1", [{ type: "tool_use", id: "t2", name: "Read" }], usage({ output_tokens: 50, output_tokens_details: { thinking_tokens: 3 } })),
      asst("dddd", "msg2", [{ type: "text", text: "hi" }]),
      asst("eeeee", undefined, [{ type: "text", text: "no id" }]),
      asst("ffffff", undefined, [{ type: "text", text: "no id 2" }]),
    ]);
    expect(turns).toHaveLength(4);
    const t = turns[0]!;
    expect(t.uuid).toBe("a");
    expect(t.parentUuid).toBe("p-a");
    expect(t.timestamp).toBe("2025-01-01T00:00:01.000Z");
    expect(t.usage.output_tokens).toBe(50);
    expect(t.thinkingTokens).toBe(3);
    expect(t.messageId).toBe("msg1");
    expect(turns[2]!.messageId).toBeNull();
    expect(meta.toolCalls).toEqual({ Bash: 1, Read: 1 });
  });

  test("reads nested cache-miss path with top-level fallback", async () => {
    const { turns } = await parse([
      asst("a", "m1", [], usage(), { diagnostics: { cache_miss_reason: { type: "tools_changed", cache_missed_input_tokens: 1234 } } }),
      asst("bb", "m2", [], usage(), { diagnostics: { cache_miss_reason: { type: "x" }, cache_missed_input_tokens: 77 } }),
    ]);
    expect(turns[0]!.cacheMissTokens).toBe(1234);
    expect(turns[0]!.cacheMissReason).toBe("tools_changed");
    expect(turns[1]!.cacheMissTokens).toBe(77);
  });

  test("detects limit hits and API errors; no synthetic turns", async () => {
    const syn = (uuid: string, text: string, extra: Record<string, unknown> = {}) => ({
      type: "assistant", uuid, timestamp: "2025-01-01T00:00:00.000Z", ...extra,
      message: { id: "s" + uuid, model: "<synthetic>", content: [{ type: "text", text }], usage: usage({ input_tokens: 0, output_tokens: 0 }) },
    });
    const { turns, meta } = await parse([
      syn("a", "You've hit your session limit - resets 5pm"),
      syn("b", "You've hit your limit"),
      syn("c", "API Error: 500", { isApiErrorMessage: true }),
      syn("d", "API Error: overloaded"),
      syn("e", "Something else"),
    ]);
    expect(turns).toHaveLength(0);
    expect(meta.limitHitCount).toBe(2);
    expect(meta.apiErrorCount).toBe(2);
  });

  test("prices with the 1h/5m cache split", async () => {
    const { turns } = await parse([
      asst("a", "m", [], usage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } })),
    ]);
    expect(turns[0]!.cost.cacheWriteCost).toBeCloseTo(4, 6); // sonnet-5-5 1h = 2x of $2
    expect(turns[0]!.ephemeral1hTokens).toBe(1_000_000);
  });

  test("counts stop hook summaries and skips Stop hook attachments", async () => {
    const { meta } = await parse([
      { type: "system", subtype: "stop_hook_summary", hookCount: 3, hookErrors: [{}], hookInfos: [{ command: "x" }] },
      { type: "attachment", attachment: { type: "hook_success", hookEvent: "Stop", durationMs: 5 } },
      { type: "attachment", attachment: { type: "hook_success", hookEvent: "PreToolUse", durationMs: 7 } },
    ]);
    expect(meta.hookInvocations).toBe(4);
    expect(meta.hookErrors).toBe(1);
    expect(meta.hookDurationMs).toBe(7);
  });

  test("maps tool errors to tool names, denials, and turn durations", async () => {
    const { meta } = await parse([
      asst("a", "m", [{ type: "tool_use", id: "t1", name: "Bash" }, { type: "tool_use", id: "t2", name: "mcp__x__y" }]),
      { type: "user", uuid: "u1", message: { content: [
        { type: "tool_result", tool_use_id: "t1", is_error: true },
        { type: "tool_result", tool_use_id: "t2", is_error: false },
        { type: "tool_result", tool_use_id: "nope", is_error: true },
      ] } },
      { type: "user", uuid: "u2", toolDenialKind: "automode-blocked", message: { content: "x" } },
      { type: "user", uuid: "u3", toolDenialKind: "automode-blocked", message: { content: [] } },
      { type: "system", subtype: "turn_duration", durationMs: 1500 },
    ]);
    expect(meta.toolErrors).toEqual({ Bash: 1, unknown: 1 });
    expect(meta.toolCalls).toEqual({ Bash: 1, mcp__x__y: 1 });
    expect(meta.mcpToolCalls).toEqual({ mcp__x__y: 1 });
    expect(meta.permissionDenials).toEqual({ "automode-blocked": 2 });
    expect(meta.turnDurationsMs).toEqual([1500]);
  });
});

const user = (extra: Record<string, unknown>, content: unknown = "hello") => ({
  type: "user", uuid: "u" + Math.random(), message: { content }, ...extra,
});
const toolResult = [{ type: "tool_result", tool_use_id: "t1", content: "ok" }];

describe("parseFile prompt attribution", () => {
  test("stamps promptId and origin; tool_result lines do not override origin; hyphens normalised", async () => {
    const { turns } = await parse([
      user({ promptId: "p1", turnOrigin: "human" }),
      asst("a", "m1", [{ type: "text", text: "x" }]),
      user({ promptId: "p1", turnOrigin: "peer" }, toolResult),
      asst("bb", "m2", [{ type: "text", text: "y" }]),
      user({ promptId: "p2", origin: { kind: "task-notification" } }),
      asst("ccc", "m3", [{ type: "text", text: "z" }]),
      user({ promptId: "p3", origin: "auto-continuation" }),
      asst("dddd", "m4", [{ type: "text", text: "w" }]),
      user({ promptId: "p4" }),
      asst("eeeee", "m5", [{ type: "text", text: "v" }]),
    ]);
    expect(turns.map((t) => t.promptId)).toEqual(["p1", "p1", "p2", "p3", "p4"]);
    expect(turns.map((t) => t.promptOrigin)).toEqual(["human", "human", "task_notification", "auto_continuation", null]);
  });

  test("turns before any user line have null promptId", async () => {
    const { turns } = await parse([asst("a", "m1", [])]);
    expect(turns[0]!.promptId).toBeNull();
    expect(turns[0]!.promptOrigin).toBeNull();
  });

  test("toolUseCount spans lines of a message group; effort is first non-empty", async () => {
    const { turns } = await parse([
      { ...asst("a", "m1", [{ type: "thinking" }]), effort: "" },
      { ...asst("bb", "m1", [{ type: "tool_use", id: "t1", name: "Bash" }]), effort: "high" },
      { ...asst("ccc", "m1", [{ type: "tool_use", id: "t2", name: "Read" }, { type: "tool_use", id: "t3", name: "Read" }]), effort: "low" },
      asst("dddd", "m2", [{ type: "text", text: "hi" }]),
    ]);
    expect(turns[0]!.toolUseCount).toBe(3);
    expect(turns[0]!.effort).toBe("high");
    expect(turns[1]!.toolUseCount).toBe(0);
    expect(turns[1]!.effort).toBeNull();
  });
});

describe("parseFile new meta", () => {
  test("permissionDecisions and bash counters", async () => {
    const { meta } = await parse([
      user({ permissionDecision: { decision: "accept", source: "config" } }, toolResult),
      user({ permissionDecision: { decision: "accept", source: "config" } }, toolResult),
      user({ permissionDecision: { decision: "reject", source: "user_reject", reasonType: "x" } }, toolResult),
      user({ toolUseResult: { stdout: "", timedOutAfterMs: 120000 } }, toolResult),
      user({ toolUseResult: { stdout: "big", persistedOutputPath: "/tmp/o" } }, toolResult),
      user({ toolUseResult: { timedOutAfterMs: 5 } }, toolResult),
      user({ toolUseResult: "string result" }, toolResult),
    ]);
    expect(meta.permissionDecisions).toEqual({ "accept/config": 2, "reject/user_reject": 1 });
    expect(meta.bashTimeouts).toBe(1);
    expect(meta.bashLargeOutputs).toBe(1);
  });

  test("queue classification", async () => {
    const q = (operation: string, extra: Record<string, unknown> = {}) => ({ type: "queue-operation", operation, ...extra });
    const { meta } = await parse([
      q("enqueue", { content: "please also do X" }),
      q("enqueue"),
      q("enqueue", { content: "  <task-notification>done" }),
      q("enqueue", { content: "<agent-message from=a>" }),
      q("remove", { reason: "absorbed_mid_turn" }),
      q("remove", { reason: "delivered_to_agent" }),
      q("dequeue"),
    ]);
    expect(meta.queuedMessages).toBe(2);
    expect(meta.queuedSystemMessages).toBe(2);
    expect(meta.queueAbsorbedMidTurn).toBe(1);
  });
});

