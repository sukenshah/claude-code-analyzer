import express from "express";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { analyze, getActiveSessions, readConfig, writeConfig, resolveClaudeProjectsDir, getCandidateClaudeProjectsDirs } from "@claude-analyzer/analyzer";
import type { AnalysisResult } from "@claude-analyzer/analyzer";

// ── Message extraction ────────────────────────────────────────────────────────

interface ToolUse {
  name: string;
  title?: string;
}

interface MessageRecord {
  uuid: string;
  type: "user" | "assistant" | "system" | "summary" | "tool_output";
  subtype?: "compact" | "api_error" | "limit_reached";
  timestamp: string;
  text: string | null;
  toolUses: ToolUse[];
  model?: string;
  command?: string;
  hookResult?: string;
  systemCaveat?: string;
  compactMeta?: { trigger: string; preTokens: number; postTokens: number };
  apiError?: { code?: string; status?: number; retryAttempt?: number; maxRetries?: number };
  toolName?: string;
  parentAssistantUuid?: string;
}

function extractText(content: unknown): string | null {
  if (!content) return null;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts = (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!);
  return parts.length > 0 ? parts.join("\n").trim() || null : null;
}

function toolTitle(name: string, input: Record<string, unknown>): string | undefined {
  if (input.description && typeof input.description === "string") return input.description;
  if (input.file_path && typeof input.file_path === "string") return input.file_path as string;
  if (input.query && typeof input.query === "string") return input.query as string;
  if (input.url && typeof input.url === "string") return input.url as string;
  if (input.prompt && typeof input.prompt === "string") return (input.prompt as string).slice(0, 80);
  if (name === "TodoWrite") return "update tasks";
  return undefined;
}

function extractTag(text: string, tag: string): string | undefined {
  // Use word boundary after tag name to avoid matching <command-name> when looking for <command>
  const m = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].trim() || undefined : undefined;
}

function innerText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n")
    .trim();
}

function extractToolUses(content: unknown): ToolUse[] {
  if (!content || !Array.isArray(content)) return [];
  return (content as Array<{ type: string; name?: string; input?: Record<string, unknown> }>)
    .filter((b) => b.type === "tool_use" && b.name)
    .map((b) => ({ name: b.name!, title: toolTitle(b.name!, b.input ?? {}) }));
}

async function extractMessages(filePath: string): Promise<MessageRecord[]> {
  const messages: MessageRecord[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  // Track the last assistant UUID and its tool_use_id → tool_name mapping so
  // tool_result blocks can reference the turn that generated them.
  let lastAssistantUuid: string | null = null;
  const lastToolUseIdToName = new Map<string, string>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    const type = parsed.type as string | undefined;
    if (!type) continue;
    const msg = parsed.message as Record<string, unknown> | undefined;

    if (type === "user") {
      const rawContent = msg?.content;
      const uuid = (parsed.uuid as string) ?? String(messages.length);
      const timestamp = (parsed.timestamp as string) ?? "";

      // String content: slash commands, caveats, summaries, plain text
      if (typeof rawContent === "string") {
        const text = rawContent.trim();
        if (!text) continue;
        const isSummary = text.startsWith("This session is being continued from a previous conversation");
        const isCommand = text.startsWith("<command-name>") || text.startsWith("<command-message>");
        const isCaveat = text.startsWith("<local-command-caveat>");
        messages.push({
          uuid,
          type: isSummary ? "summary" : "user",
          timestamp,
          text: isCommand || isCaveat ? null : text,
          toolUses: [],
          command: isCommand ? (extractTag(text, "command-message") ?? extractTag(text, "command-name")) : undefined,
          hookResult: extractTag(text, "hook_result"),
          systemCaveat: extractTag(text, "system_caveat") ?? (isCaveat ? text.replace(/<\/?local-command-caveat[^>]*>/g, "").trim() : undefined),
        });

      // Array content: text blocks and/or tool_result blocks
      } else if (Array.isArray(rawContent)) {
        // Plain text blocks (regular user messages)
        const plainText = extractText(rawContent);
        if (plainText) {
          const isSummary = plainText.startsWith("This session is being continued from a previous conversation");
          messages.push({
            uuid,
            type: isSummary ? "summary" : "user",
            timestamp,
            text: plainText,
            toolUses: [],
            hookResult: extractTag(plainText, "hook_result"),
            systemCaveat: extractTag(plainText, "system_caveat"),
          });
        }

        // Tool result blocks
        for (const block of rawContent as Array<Record<string, unknown>>) {
          if (block.type !== "tool_result") continue;
          const rawText = innerText(block.content);
          const toolUseId = block.tool_use_id as string | undefined;
          const hookResult = rawText ? extractTag(rawText, "hook_result") : undefined;
          const systemCaveat = rawText ? extractTag(rawText, "system_caveat") : undefined;

          if (hookResult || systemCaveat) {
            // Surface hook/caveat metadata as a user-type message
            messages.push({
              uuid: toolUseId ?? uuid,
              type: "user",
              timestamp,
              text: null,
              toolUses: [],
              hookResult,
              systemCaveat,
            });
          } else if (rawText?.trim()) {
            messages.push({
              uuid: toolUseId ?? uuid,
              type: "tool_output",
              timestamp,
              text: rawText.trim(),
              toolUses: [],
              toolName: toolUseId ? lastToolUseIdToName.get(toolUseId) : undefined,
              parentAssistantUuid: lastAssistantUuid ?? undefined,
            });
          }
        }
      }
    } else if (type === "assistant") {
      const text = extractText(msg?.content);
      const toolUses = extractToolUses(msg?.content);
      if (!text && toolUses.length === 0) continue;
      const isLimitHit = msg?.model === "<synthetic>" && typeof text === "string" && text.startsWith("You've hit your limit");
      const assistantUuid = (parsed.uuid as string) ?? String(messages.length);

      // Track for subsequent tool_result association
      lastAssistantUuid = assistantUuid;
      lastToolUseIdToName.clear();
      for (const block of (msg?.content as Array<Record<string, unknown>>) ?? []) {
        if (block.type === "tool_use" && block.id && block.name) {
          lastToolUseIdToName.set(block.id as string, block.name as string);
        }
      }

      messages.push({
        uuid: assistantUuid,
        type: "assistant",
        subtype: isLimitHit ? "limit_reached" : undefined,
        timestamp: (parsed.timestamp as string) ?? "",
        text,
        toolUses,
        model: msg?.model as string | undefined,
      });
    } else if (type === "system" && parsed.subtype === "compact_boundary") {
      const meta = parsed.compactMetadata as Record<string, unknown> | undefined;
      messages.push({
        uuid: (parsed.uuid as string) ?? String(messages.length),
        type: "system",
        subtype: "compact",
        timestamp: (parsed.timestamp as string) ?? "",
        text: (parsed.content as string) ?? "Conversation compacted",
        toolUses: [],
        compactMeta: meta ? {
          trigger: (meta.trigger as string) ?? "auto",
          preTokens: (meta.preTokens as number) ?? 0,
          postTokens: (meta.postTokens as number) ?? 0,
        } : undefined,
      });
    } else if (type === "system" && parsed.subtype === "api_error") {
      const cause = parsed.cause as Record<string, unknown> | undefined;
      const err = parsed.error as Record<string, unknown> | undefined;
      messages.push({
        uuid: (parsed.uuid as string) ?? String(messages.length),
        type: "system",
        subtype: "api_error",
        timestamp: (parsed.timestamp as string) ?? "",
        text: null,
        toolUses: [],
        apiError: {
          code: (cause?.code as string) ?? (err?.code as string) ?? undefined,
          status: (cause?.status as number) ?? (err?.status as number) ?? undefined,
          retryAttempt: parsed.retryAttempt as number | undefined,
          maxRetries: parsed.maxRetries as number | undefined,
        },
      });
    }
  }

  return messages;
}

const app = express();
const PORT = 3001;

app.use(express.json());

// In-memory cache of the analysis result
let cachedResult: AnalysisResult | null = null;
let loading = false;

async function ensureLoaded(force = false): Promise<AnalysisResult> {
  if (cachedResult && !force) return cachedResult;
  if (loading) {
    // Wait for existing load to finish
    while (loading) await new Promise((r) => setTimeout(r, 50));
    return cachedResult!;
  }
  loading = true;
  try {
    cachedResult = await analyze(force);
  } finally {
    loading = false;
  }
  return cachedResult!;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/api/summary", async (_req, res) => {
  try {
    const result = await ensureLoaded();
    res.json(result.summary);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/projects", async (_req, res) => {
  try {
    const result = await ensureLoaded();
    const projects = [...result.projects.values()].map((p) => ({
      projectKey: p.projectKey,
      projectName: p.projectName,
      projectPath: p.projectPath,
      sessionCount: p.sessionCount,
      totals: p.totals,
      totalCost: p.totalCost,
      limitHitCount: p.limitHitCount,
    }));
    projects.sort((a, b) => b.totalCost - a.totalCost);
    res.json(projects);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/projects/:key", async (req, res) => {
  try {
    const result = await ensureLoaded();
    const project = result.projects.get(req.params.key);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const sessions = project.sessions.map((s) => ({
      sessionId: s.sessionId,
      projectKey: s.projectKey,
      projectName: s.projectName,
      firstTimestamp: s.firstTimestamp,
      lastTimestamp: s.lastTimestamp,
      turnCount: s.turns.length,
      totals: s.totals,
      totalCost: s.totalCost,
      hasSubagents: s.hasSubagents,
      subagentCount: s.subagentCount,
      meta: s.meta,
    }));
    res.json({ ...project, sessions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/sessions/:id", async (req, res) => {
  try {
    const result = await ensureLoaded();
    const session = result.sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/active-sessions", async (_req, res) => {
  try {
    const now = Date.now();
    const sessions = await getActiveSessions();
    res.json(sessions.map((s) => ({
      sessionId: s.sessionId,
      projectKey: s.projectKey,
      projectName: s.projectName,
      aiTitle: s.meta.aiTitle,
      turnCount: s.turns.filter((t) => !t.isSubagent).length,
      totalCost: s.totalCost,
      totals: s.totals,
      lastTimestamp: s.lastTimestamp,
      lastModifiedMs: s.lastModifiedMs,
      secondsAgo: Math.floor((now - s.lastModifiedMs) / 1000),
      gitBranch: s.meta.gitBranch,
      entrypoint: s.meta.entrypoint,
    })));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/sessions/:id/messages", async (req, res) => {
  try {
    const result = await ensureLoaded();
    const session = result.sessions.get(req.params.id);
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    const mainTurn = session.turns.find((t) => !t.isSubagent);
    if (!mainTurn) { res.json([]); return; }
    const messages = await extractMessages(mainTurn.sourceFile);
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/refresh", async (_req, res) => {
  try {
    cachedResult = null;
    const result = await ensureLoaded(true);
    res.json({
      newFilesScanned: result.newFilesScanned,
      projectCount: result.summary.projectCount,
      sessionCount: result.summary.sessionCount,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Config ────────────────────────────────────────────────────────────────────

app.get("/api/config", (_req, res) => {
  try {
    const config = readConfig();
    const resolvedDir = resolveClaudeProjectsDir();
    res.json({
      claudeProjectsDir: config.claudeProjectsDir ?? null,
      resolvedDir,
      candidates: getCandidateClaudeProjectsDirs(),
      found: resolvedDir !== null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/config", async (req, res) => {
  try {
    const { claudeProjectsDir } = req.body as { claudeProjectsDir?: string };
    const current = readConfig();
    writeConfig({ ...current, claudeProjectsDir: claudeProjectsDir || undefined });
    // Invalidate the in-memory cache so the next load uses the new dir
    cachedResult = null;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Usage Analyzer API running at http://localhost:${PORT}`);
  console.log(`Loading JSONL files...`);
  ensureLoaded().then((r) => {
    console.log(`Ready: ${r.summary.projectCount} projects, ${r.summary.sessionCount} sessions, ${r.summary.turnCount} turns`);
  });
});
