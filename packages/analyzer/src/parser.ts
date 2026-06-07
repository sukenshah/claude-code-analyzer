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
}

interface RawDiagnostics {
  cache_miss_reason?: { type?: string };
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
  attachment?: {
    type?: string;
    addedNames?: string[];
    exitCode?: number;
    durationMs?: number;
  };
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number; durationMs?: number };
  message?: {
    model?: string;
    usage?: RawUsage;
    content?: Array<{ type?: string; text?: string; name?: string }>;
    diagnostics?: RawDiagnostics;
  };
}

export function emptyMeta(): SessionMeta {
  return {
    aiTitle: null, entrypoint: null, gitBranch: null, permissionMode: null, version: null,
    mcpTools: [], mcpToolCalls: {}, compactEvents: [], limitHitCount: 0,
    hookInvocations: 0, hookErrors: 0, hookDurationMs: 0, queuedMessages: 0,
  };
}

// Attachment types Claude Code emits for hook lifecycle events.
const HOOK_ATTACHMENT_TYPES = new Set(["hook_success", "hook_non_blocking_error", "async_hook_response"]);

export async function parseFile(entry: ScanEntry): Promise<{ turns: TurnRecord[]; meta: SessionMeta }> {
  const turns: TurnRecord[] = [];
  const seenUuids = new Set<string>();
  const meta = emptyMeta();
  const mcpToolSet = new Set<string>();

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
    if (parsed.type === "attachment" && parsed.attachment && HOOK_ATTACHMENT_TYPES.has(parsed.attachment.type ?? "")) {
      meta.hookInvocations++;
      meta.hookDurationMs += parsed.attachment.durationMs ?? 0;
      if (parsed.attachment.type === "hook_non_blocking_error" || (parsed.attachment.exitCode ?? 0) !== 0) {
        meta.hookErrors++;
      }
    }

    // Queue operations — user enqueued a message while Claude was working.
    if (parsed.type === "queue-operation" && parsed.operation === "enqueue") {
      meta.queuedMessages++;
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

    // Count MCP tool calls from assistant tool_use blocks
    if (parsed.type === "assistant") {
      for (const block of parsed.message?.content ?? []) {
        if (block.type === "tool_use" && block.name?.startsWith("mcp__")) {
          meta.mcpToolCalls[block.name] = (meta.mcpToolCalls[block.name] ?? 0) + 1;
        }
      }
    }

    // Detect synthetic "You've hit your limit" messages
    if (parsed.type === "assistant" && parsed.message?.model === "<synthetic>") {
      const blocks = parsed.message.content ?? [];
      for (const block of blocks) {
        if (block.type === "text" && block.text?.startsWith("You've hit your limit")) {
          meta.limitHitCount++;
          break;
        }
      }
    }

    // Turn records (assistant lines only)
    if (parsed.type !== "assistant") continue;
    const usage = parsed.message?.usage;
    if (!usage) continue;

    const model = parsed.message?.model ?? "claude-sonnet-4-6";
    const tokenUsage = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    };

    const diag = parsed.message?.diagnostics;
    const cacheMissTokens = diag?.cache_missed_input_tokens ?? 0;
    const cacheMissReason = diag?.cache_miss_reason?.type ?? null;
    const ephemeral5mTokens = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const ephemeral1hTokens = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;

    // Synthetic fallback includes agentId to prevent cross-file UUID collisions when the
    // UUID field is absent: main file and subagent files share the same sessionId but
    // each resets turns.length to 0, so without the agentId they'd generate identical keys.
    const uuid = parsed.uuid ?? `${entry.sessionId}-${entry.agentId ?? "main"}-${turns.length}`;
    if (seenUuids.has(uuid)) continue;
    seenUuids.add(uuid);

    turns.push({
      uuid,
      parentUuid: parsed.parentUuid ?? null,
      sessionId: parsed.sessionId ?? entry.sessionId,
      projectKey: entry.projectKey,
      timestamp: parsed.timestamp ?? new Date().toISOString(),
      model,
      usage: tokenUsage,
      cost: calculateCost(tokenUsage, model),
      isSubagent: entry.isSubagent,
      agentId: entry.agentId,
      sourceFile: entry.filePath,
      cacheMissTokens,
      cacheMissReason,
      ephemeral5mTokens,
      ephemeral1hTokens,
    });
  }

  meta.mcpTools = [...mcpToolSet];
  return { turns, meta };
}
