import { createReadStream } from "fs";
import { createInterface } from "readline";
import { calculateCost } from "./cost.js";
import type { TurnRecord, ScanEntry, SessionMeta, CompactEvent } from "./types.js";

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  output_tokens_details?: { thinking_tokens?: number };
}

interface RawDiagnostics {
  cache_miss_reason?: { type?: string; cache_missed_input_tokens?: number };
  cache_missed_input_tokens?: number;
}

interface RawLine {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  aiTitle?: string;
  entrypoint?: string;
  gitBranch?: string;
  permissionMode?: string;
  version?: string;
  operation?: string;
  durationMs?: number;
  hookCount?: number;
  hookErrors?: unknown[];
  isApiErrorMessage?: boolean;
  toolDenialKind?: unknown;
  promptId?: string;
  turnOrigin?: unknown;
  origin?: unknown;
  effort?: unknown;
  content?: string;
  reason?: string;
  permissionDecision?: { decision?: string; source?: string; reasonType?: string };
  toolUseResult?: unknown;
  attachment?: {
    type?: string;
    hookEvent?: string;
    addedNames?: string[];
    exitCode?: number;
    durationMs?: number;
  };
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number; durationMs?: number };
  message?: {
    id?: string;
    model?: string;
    usage?: RawUsage;
    content?: string | Array<{ type?: string; text?: string; name?: string; id?: string; tool_use_id?: string; is_error?: boolean }>;
    diagnostics?: RawDiagnostics;
  };
}

export function emptyMeta(): SessionMeta {
  return {
    aiTitle: null, entrypoint: null, gitBranch: null, permissionMode: null, version: null,
    mcpTools: [], mcpToolCalls: {}, compactEvents: [], limitHitCount: 0,
    hookInvocations: 0, hookErrors: 0, hookDurationMs: 0, queuedMessages: 0,
    queuedSystemMessages: 0, queueAbsorbedMidTurn: 0, permissionDecisions: {}, bashTimeouts: 0, bashLargeOutputs: 0,
    apiErrorCount: 0, turnDurationsMs: [], toolCalls: {}, toolErrors: {}, permissionDenials: {},
  };
}

function effortOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Attachment types Claude Code emits for hook lifecycle events.
function normaliseOrigin(v: unknown): string | null {
  const raw = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" ? (v as { kind: string }).kind : null;
  return raw ? raw.trim().replace(/-/g, "_") || null : null;
}

const HOOK_ATTACHMENT_TYPES = new Set(["hook_success", "hook_non_blocking_error", "async_hook_response"]);

export async function parseFile(entry: ScanEntry): Promise<{ turns: TurnRecord[]; meta: SessionMeta }> {
  const turns: TurnRecord[] = [];
  const seenUuids = new Set<string>();
  // One API response spans several JSONL lines sharing message.id; keep one turn per id.
  const turnByMessageId = new Map<string, TurnRecord>();
  const toolNameById = new Map<string, string>();
  const meta = emptyMeta();
  const mcpToolSet = new Set<string>();
  let lastPromptId: string | null = null;
  const originByPrompt = new Map<string, string>();
  const toolUseByMsg = new Map<string, number>();

  const rl = createInterface({
    input: createReadStream(entry.filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: RawLine;
    try {
      parsed = JSON.parse(line) as RawLine;
    } catch {
      continue;
    }

    // Session-level metadata
    if (parsed.type === "ai-title" && parsed.aiTitle && !meta.aiTitle) {
      meta.aiTitle = parsed.aiTitle;
    }
    if (parsed.entrypoint && !meta.entrypoint) {
      meta.entrypoint = parsed.entrypoint;
    }
    if (parsed.gitBranch && !meta.gitBranch) {
      meta.gitBranch = parsed.gitBranch;
    }
    if (parsed.permissionMode && !meta.permissionMode) {
      meta.permissionMode = parsed.permissionMode;
    }
    if (parsed.version && !meta.version) {
      meta.version = parsed.version;
    }
    if (parsed.type === "attachment" && parsed.attachment?.type === "deferred_tools_delta") {
      for (const tool of parsed.attachment.addedNames ?? []) {
        if (tool.startsWith("mcp__")) mcpToolSet.add(tool);
      }
    }

    // Hook telemetry — count invocations, failures, and total wall-clock added.
    if (parsed.type === "attachment" && parsed.attachment && HOOK_ATTACHMENT_TYPES.has(parsed.attachment.type ?? "") && parsed.attachment.hookEvent !== "Stop") {
      meta.hookInvocations++;
      meta.hookDurationMs += parsed.attachment.durationMs ?? 0;
      if (parsed.attachment.type === "hook_non_blocking_error" || (parsed.attachment.exitCode ?? 0) !== 0) {
        meta.hookErrors++;
      }
    }

    // Queue operations — user enqueued a message while Claude was working.
    if (parsed.type === "queue-operation") {
      if (parsed.operation === "enqueue") {
        const c = typeof parsed.content === "string" ? parsed.content.trim() : "";
        if (c.startsWith("<task-notification") || c.startsWith("<agent-message")) meta.queuedSystemMessages++;
        else meta.queuedMessages++;
      } else if (parsed.operation === "remove" && parsed.reason === "absorbed_mid_turn") {
        meta.queueAbsorbedMidTurn++;
      }
    }
    if (parsed.type === "system" && parsed.subtype === "compact_boundary" && parsed.compactMetadata) {
      const ev: CompactEvent = {
        timestamp: parsed.timestamp ?? "",
        trigger: parsed.compactMetadata.trigger ?? "auto",
        preTokens: parsed.compactMetadata.preTokens ?? 0,
        postTokens: parsed.compactMetadata.postTokens ?? 0,
        durationMs: parsed.compactMetadata.durationMs ?? 0,
      };
      meta.compactEvents.push(ev);
    }

    // Stop-hook summaries (counted here; Stop hook attachments are skipped above).
    if (parsed.type === "system" && parsed.subtype === "stop_hook_summary") {
      meta.hookInvocations += parsed.hookCount ?? 0;
      meta.hookErrors += Array.isArray(parsed.hookErrors) ? parsed.hookErrors.length : 0;
    }
    if (parsed.type === "system" && parsed.subtype === "turn_duration" && typeof parsed.durationMs === "number") {
      meta.turnDurationsMs.push(parsed.durationMs);
    }

    // User lines: tool errors and permission denials
    if (parsed.type === "user") {
      if (typeof parsed.toolDenialKind === "string") {
        meta.permissionDenials[parsed.toolDenialKind] = (meta.permissionDenials[parsed.toolDenialKind] ?? 0) + 1;
      }
      const content = parsed.message?.content;
      const isToolResult = Array.isArray(content) && content.some((b) => b.type === "tool_result");
      if (typeof parsed.promptId === "string" && parsed.promptId) {
        lastPromptId = parsed.promptId;
        if (!isToolResult && !originByPrompt.has(parsed.promptId)) {
          const o = normaliseOrigin(parsed.turnOrigin) ?? normaliseOrigin(parsed.origin);
          if (o) originByPrompt.set(parsed.promptId, o);
        }
      }
      const pd = parsed.permissionDecision;
      if (pd && typeof pd === "object" && pd.decision) {
        const key = `${pd.decision}/${pd.source ?? "unknown"}`;
        meta.permissionDecisions[key] = (meta.permissionDecisions[key] ?? 0) + 1;
      }
      const tur = parsed.toolUseResult;
      if (tur && typeof tur === "object" && "stdout" in tur) {
        const r = tur as { timedOutAfterMs?: unknown; persistedOutputPath?: unknown };
        if (r.timedOutAfterMs) meta.bashTimeouts++;
        if (r.persistedOutputPath) meta.bashLargeOutputs++;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.is_error === true) {
            const name = (block.tool_use_id && toolNameById.get(block.tool_use_id)) || "unknown";
            meta.toolErrors[name] = (meta.toolErrors[name] ?? 0) + 1;
          }
        }
      }
      continue;
    }

    if (parsed.type !== "assistant") continue;
    const blocks = Array.isArray(parsed.message?.content) ? parsed.message!.content as Array<{ type?: string; text?: string; name?: string; id?: string }> : [];

    const lineToolUses = blocks.filter((b) => b.type === "tool_use").length;
    const lineMsgId = parsed.message?.id;
    if (lineMsgId && lineToolUses > 0) toolUseByMsg.set(lineMsgId, (toolUseByMsg.get(lineMsgId) ?? 0) + lineToolUses);

    // Tool calls: every line carries a different content block, so inspect all lines.
    for (const block of blocks) {
      if (block.type !== "tool_use" || !block.name) continue;
      meta.toolCalls[block.name] = (meta.toolCalls[block.name] ?? 0) + 1;
      if (block.id) toolNameById.set(block.id, block.name);
      if (block.name.startsWith("mcp__")) {
        meta.mcpToolCalls[block.name] = (meta.mcpToolCalls[block.name] ?? 0) + 1;
      }
    }

    const model = parsed.message?.model ?? "claude-sonnet-5-5";

    // Client-generated notices: limit hits and API errors. Never emit turns for synthetic messages.
    const firstText = blocks.find((b) => b.type === "text")?.text ?? "";
    const isLimitHit = /^You've hit your .*limit/i.test(firstText) || firstText.startsWith("You've hit your limit");
    if (model === "<synthetic>" || parsed.isApiErrorMessage === true || firstText.startsWith("API Error")) {
      if (isLimitHit) meta.limitHitCount++;
      else if (parsed.isApiErrorMessage === true || firstText.startsWith("API Error")) meta.apiErrorCount++;
    }
    if (model === "<synthetic>") continue;

    const usage = parsed.message?.usage;
    if (!usage) continue;

    const tokenUsage = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    };

    const diag = parsed.message?.diagnostics;
    const cacheMissTokens =
      diag?.cache_miss_reason?.cache_missed_input_tokens ?? diag?.cache_missed_input_tokens ?? 0;
    const cacheMissReason = diag?.cache_miss_reason?.type ?? null;
    const ephemeral5mTokens = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const ephemeral1hTokens = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cost = calculateCost(tokenUsage, model, { ephemeral5m: ephemeral5mTokens, ephemeral1h: ephemeral1hTokens });
    const thinkingTokens = usage.output_tokens_details?.thinking_tokens ?? 0;
    const messageId = parsed.message?.id ?? null;

    // Later line of an already-seen response: refresh usage from the last line, keep first-line identity.
    const prior = messageId ? turnByMessageId.get(messageId) : undefined;
    if (prior) {
      prior.model = model;
      prior.usage = tokenUsage;
      prior.cost = cost;
      prior.cacheMissTokens = cacheMissTokens;
      prior.cacheMissReason = cacheMissReason;
      prior.ephemeral5mTokens = ephemeral5mTokens;
      prior.ephemeral1hTokens = ephemeral1hTokens;
      prior.thinkingTokens = thinkingTokens;
      if (!prior.effort) prior.effort = effortOf(parsed.effort);
      continue;
    }

    // Synthetic fallback includes agentId to prevent cross-file UUID collisions when the
    // UUID field is absent: main file and subagent files share the same sessionId but
    // each resets turns.length to 0, so without the agentId they'd generate identical keys.
    const uuid = parsed.uuid ?? `${entry.sessionId}-${entry.agentId ?? "main"}-${turns.length}`;
    if (seenUuids.has(uuid)) continue;
    seenUuids.add(uuid);

    const turn: TurnRecord = {
      uuid,
      parentUuid: parsed.parentUuid ?? null,
      sessionId: parsed.sessionId ?? entry.sessionId,
      projectKey: entry.projectKey,
      timestamp: parsed.timestamp ?? new Date().toISOString(),
      model,
      usage: tokenUsage,
      cost,
      isSubagent: entry.isSubagent,
      agentId: entry.agentId,
      sourceFile: entry.filePath,
      cacheMissTokens,
      cacheMissReason,
      ephemeral5mTokens,
      ephemeral1hTokens,
      messageId,
      thinkingTokens,
      promptId: lastPromptId,
      promptOrigin: lastPromptId ? originByPrompt.get(lastPromptId) ?? null : null,
      toolUseCount: messageId ? 0 : lineToolUses,
      effort: effortOf(parsed.effort),
    };
    turns.push(turn);
    if (messageId) turnByMessageId.set(messageId, turn);
  }

  for (const t of turns) if (t.messageId) t.toolUseCount = toolUseByMsg.get(t.messageId) ?? 0;
  meta.mcpTools = [...mcpToolSet];
  return { turns, meta };
}
