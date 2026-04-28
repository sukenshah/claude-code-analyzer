import { statSync } from "fs";
import { scanProjects, extractProjectPaths } from "./scanner.js";
import { parseFile } from "./parser.js";
import { aggregateToSessions, aggregateToProjects, buildGlobalSummary } from "./aggregator.js";
import { isFileCached, saveTurns, loadCachedTurns, loadCachedMeta } from "./cache.js";
import type { TurnRecord, SessionRecord, ProjectRecord, GlobalSummary, SessionMeta } from "./types.js";

export type { TurnRecord, SessionRecord, ProjectRecord, GlobalSummary };
export type { TokenUsage, CostBreakdown, DailyStats, ScanEntry, ClaudeMdFile, ClaudeMdSummary, SessionMeta, CompactEvent } from "./types.js";
export { calculateCost, sumUsage, sumCost, formatCost } from "./cost.js";
export { getProjectName, getProjectPath, scanProjects, extractProjectPaths, resolveClaudeProjectsDir, getCandidateClaudeProjectsDirs } from "./scanner.js";
export { readConfig, writeConfig } from "./config.js";
export type { AnalyzerConfig } from "./config.js";

export type ActiveSessionRecord = SessionRecord & { lastModifiedMs: number };

function dedupTurnsByUuid(turns: TurnRecord[]): TurnRecord[] {
  const seen = new Map<string, TurnRecord>();
  for (const turn of turns) {
    if (!seen.has(turn.uuid)) seen.set(turn.uuid, turn);
  }
  return [...seen.values()];
}

export async function getActiveSessions(thresholdMs = 10 * 60 * 1000): Promise<ActiveSessionRecord[]> {
  const now = Date.now();
  const entries = scanProjects();

  // Collect mtime for every file
  const fileMtimes = new Map<string, number>();
  for (const e of entries) {
    try { fileMtimes.set(e.filePath, statSync(e.filePath).mtimeMs); } catch { /* skip */ }
  }

  // Sessions that have at least one recently-modified file
  const activeSessionIds = new Set<string>();
  for (const e of entries) {
    if (now - (fileMtimes.get(e.filePath) ?? 0) <= thresholdMs) activeSessionIds.add(e.sessionId);
  }
  if (activeSessionIds.size === 0) return [];

  // Parse all files for active sessions; re-parse recently-changed ones
  const sessionEntries = entries.filter(e => activeSessionIds.has(e.sessionId));
  const allTurns: TurnRecord[] = [];
  const metaBySession = new Map<string, SessionMeta>();

  for (const entry of sessionEntries) {
    const isRecent = now - (fileMtimes.get(entry.filePath) ?? 0) <= thresholdMs;
    let turns: TurnRecord[];
    let meta: SessionMeta;

    if (!isRecent && isFileCached(entry.filePath)) {
      turns = loadCachedTurns(entry.filePath);
      meta = loadCachedMeta(entry.filePath);
    } else {
      const parsed = await parseFile(entry);
      turns = parsed.turns;
      meta = parsed.meta;
      saveTurns(entry.filePath, entry.sessionId, entry.projectKey, entry.isSubagent, entry.agentId, turns, meta);
    }

    allTurns.push(...turns);
    const existing = metaBySession.get(entry.sessionId);
    metaBySession.set(entry.sessionId, existing
      ? {
          aiTitle: existing.aiTitle ?? meta.aiTitle,
          entrypoint: existing.entrypoint ?? meta.entrypoint,
          gitBranch: existing.gitBranch ?? meta.gitBranch,
          permissionMode: existing.permissionMode ?? meta.permissionMode,
          version: existing.version ?? meta.version,
          mcpTools: [...new Set([...existing.mcpTools, ...meta.mcpTools])],
          compactEvents: [...existing.compactEvents, ...meta.compactEvents]
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
          limitHitCount: (existing.limitHitCount ?? 0) + (meta.limitHitCount ?? 0),
        }
      : meta
    );
  }

  const sessions = aggregateToSessions(dedupTurnsByUuid(allTurns), metaBySession);

  // Max mtime per session
  const sessionMtimes = new Map<string, number>();
  for (const e of sessionEntries) {
    const mtime = fileMtimes.get(e.filePath) ?? 0;
    if (mtime > (sessionMtimes.get(e.sessionId) ?? 0)) sessionMtimes.set(e.sessionId, mtime);
  }

  return [...sessions.values()]
    .map(s => ({ ...s, lastModifiedMs: sessionMtimes.get(s.sessionId) ?? 0 }))
    .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
}

export interface AnalysisResult {
  projects: Map<string, ProjectRecord>;
  sessions: Map<string, SessionRecord>;
  allTurns: TurnRecord[];
  summary: GlobalSummary;
  newFilesScanned: number;
}

export async function analyze(forceRefresh = false): Promise<AnalysisResult> {
  const entries = scanProjects();
  const allTurns: TurnRecord[] = [];
  const metaBySession = new Map<string, SessionMeta>();
  let newFilesScanned = 0;

  for (const entry of entries) {
    let turns: TurnRecord[];
    let meta: SessionMeta;
    if (!forceRefresh && isFileCached(entry.filePath)) {
      turns = loadCachedTurns(entry.filePath);
      meta = loadCachedMeta(entry.filePath);
    } else {
      const parsed = await parseFile(entry);
      turns = parsed.turns;
      meta = parsed.meta;
      saveTurns(entry.filePath, entry.sessionId, entry.projectKey, entry.isSubagent, entry.agentId, turns, meta);
      newFilesScanned++;
    }
    allTurns.push(...turns);

    // Merge metadata across files belonging to the same session (main + subagents)
    const existing = metaBySession.get(entry.sessionId);
    metaBySession.set(entry.sessionId, existing
      ? { ...existing,
          aiTitle: existing.aiTitle ?? meta.aiTitle,
          entrypoint: existing.entrypoint ?? meta.entrypoint,
          gitBranch: existing.gitBranch ?? meta.gitBranch,
          permissionMode: existing.permissionMode ?? meta.permissionMode,
          version: existing.version ?? meta.version,
          mcpTools: [...new Set([...existing.mcpTools, ...meta.mcpTools])],
          compactEvents: [...existing.compactEvents, ...meta.compactEvents]
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
          limitHitCount: (existing.limitHitCount ?? 0) + (meta.limitHitCount ?? 0),
        }
      : meta
    );
  }

  const projectPaths = extractProjectPaths(entries);
  const dedupedTurns = dedupTurnsByUuid(allTurns);
  const sessions = aggregateToSessions(dedupedTurns, metaBySession);
  const projects = aggregateToProjects(sessions, projectPaths);
  const summary = buildGlobalSummary(projects, dedupedTurns);

  return { projects, sessions, allTurns: dedupedTurns, summary, newFilesScanned };
}
