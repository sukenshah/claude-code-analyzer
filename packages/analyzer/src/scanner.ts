import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { join, basename } from "path";
import type { ScanEntry } from "./types.js";

export { resolveClaudeProjectsDir, getCandidateClaudeProjectsDirs } from "./config.js";
import { resolveClaudeProjectsDir } from "./config.js";

function decodeProjectKey(key: string): string {
  return key.replace(/-/g, "/").replace(/^\//, "");
}

export function getProjectName(key: string): string {
  // Extract everything after the last known path segment before the project name.
  // Look for common patterns: -git-, -projects-, -workspace-, -src-
  const gitIdx = key.lastIndexOf("-git-");
  if (gitIdx !== -1) return key.slice(gitIdx + 5); // after "-git-"
  // Fallback: take last 2 hyphen-separated parts
  const parts = key.split("-").filter(Boolean);
  return parts.slice(-2).join("-") || key;
}

export function getProjectPath(key: string): string {
  return "/" + decodeProjectKey(key);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export function extractProjectPaths(entries: ScanEntry[]): Map<string, string> {
  const paths = new Map<string, string>();
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.projectKey)) continue;
    try {
      const content = readFileSync(entry.filePath, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { cwd?: string };
          if (parsed.cwd) {
            paths.set(entry.projectKey, parsed.cwd);
            seen.add(entry.projectKey);
            break;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return paths;
}

export function scanProjects(): ScanEntry[] {
  const claudeProjectsDir = resolveClaudeProjectsDir();
  if (!claudeProjectsDir || !existsSync(claudeProjectsDir)) return [];

  const entries: ScanEntry[] = [];

  const projectDirs = readdirSync(claudeProjectsDir);

  for (const projectKey of projectDirs) {
    const projectPath = join(claudeProjectsDir, projectKey);
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(projectPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const items = readdirSync(projectPath);

    for (const item of items) {
      const itemPath = join(projectPath, item);

      if (item.endsWith(".jsonl")) {
        // Top-level session file: <session-uuid>.jsonl
        const sessionId = item.replace(".jsonl", "");
        entries.push({ sessionId, projectKey, filePath: itemPath, isSubagent: false, agentId: null });
        continue;
      }

      // UUID subdirectory (subagents or new-style session dirs)
      const dirStat = (() => { try { return statSync(itemPath); } catch { return null; } })();
      if (!dirStat?.isDirectory() || !isUuid(item)) continue;

      const sessionId = item;
      const subagentsDir = join(itemPath, "subagents");

      if (existsSync(subagentsDir)) {
        const subFiles = readdirSync(subagentsDir);
        for (const subFile of subFiles) {
          if (!subFile.endsWith(".jsonl")) continue;
          const agentId = basename(subFile, ".jsonl");
          entries.push({
            sessionId,
            projectKey,
            filePath: join(subagentsDir, subFile),
            isSubagent: true,
            agentId,
          });
        }
      }

      // Also check for a session-level jsonl inside the uuid dir itself
      const sessionFile = join(itemPath, `${sessionId}.jsonl`);
      if (existsSync(sessionFile)) {
        entries.push({ sessionId, projectKey, filePath: sessionFile, isSubagent: false, agentId: null });
      }
    }
  }

  return entries;
}
