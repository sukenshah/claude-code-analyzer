import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative } from "path";
import type { ClaudeMdFile, ClaudeMdSummary } from "./types.js";

// Sonnet 4.6 input token rate — used as baseline for per-session cost estimate
const INPUT_RATE_PER_M = 3.0;
const CHARS_PER_TOKEN = 3.5;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "__pycache__", ".venv", "venv"]);

function findClaudeMdFiles(dir: string, root: string, depth = 0): string[] {
  if (depth > 4) return [];
  let results: string[] = [];

  let items: string[];
  try { items = readdirSync(dir); } catch { return []; }

  for (const item of items) {
    if (item === "CLAUDE.md") {
      results.push(join(dir, item));
      continue;
    }
    if (SKIP_DIRS.has(item)) continue;
    const full = join(dir, item);
    try {
      if (statSync(full).isDirectory()) {
        results = results.concat(findClaudeMdFiles(full, root, depth + 1));
      }
    } catch { /* skip */ }
  }

  return results;
}

export function scanClaudeMd(projectPath: string): ClaudeMdSummary {
  if (!existsSync(projectPath)) {
    return { files: [], totalEstimatedTokens: 0, totalPerSessionCostUsd: 0 };
  }

  const paths = findClaudeMdFiles(projectPath, projectPath);
  const files: ClaudeMdFile[] = [];

  for (const filePath of paths) {
    let content: string;
    try { content = readFileSync(filePath, "utf8"); } catch { continue; }

    const sizeBytes = Buffer.byteLength(content, "utf8");
    const estimatedTokens = Math.round(content.length / CHARS_PER_TOKEN);
    const perSessionCostUsd = (estimatedTokens * INPUT_RATE_PER_M) / 1_000_000;

    files.push({
      filePath,
      relativePath: relative(projectPath, filePath) || "CLAUDE.md",
      sizeBytes,
      estimatedTokens,
      perSessionCostUsd,
    });
  }

  const totalEstimatedTokens = files.reduce((s, f) => s + f.estimatedTokens, 0);
  const totalPerSessionCostUsd = files.reduce((s, f) => s + f.perSessionCostUsd, 0);

  return { files, totalEstimatedTokens, totalPerSessionCostUsd };
}
