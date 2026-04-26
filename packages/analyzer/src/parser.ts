import { createReadStream } from "fs";
import { createInterface } from "readline";
import { calculateCost } from "./cost.js";
import type { TurnRecord, ScanEntry, SessionMeta, CompactEvent } from "./types.js";

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
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
  attachment?: { type?: string; addedNames?: string[] };
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number; durationMs?: number };
  message?: { model?: string; usage?: RawUsage; content?: Array<{ type?: string; text?: string }> };
}

export function emptyMeta(): SessionMeta {
  return { aiTitle: null, entrypoint: null, gitBranch: null, permissionMode: null, version: null, mcpTools: [], compactEvents: [], limitHitCount: 0 };
}

export async function parseFile(entry: ScanEntry): Promise<{ turns: TurnRecord[]; meta: SessionMeta }> {
  const turns: TurnRecord[] = [];
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

    turns.push({
      uuid: parsed.uuid ?? `${entry.sessionId}-${turns.length}`,
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
    });
  }

  meta.mcpTools = [...mcpToolSet];
  return { turns, meta };
}
