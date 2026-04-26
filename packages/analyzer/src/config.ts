import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";

const CONFIG_DIR = join(homedir(), ".claude-analyzer");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface AnalyzerConfig {
  claudeProjectsDir?: string;
}

export function readConfig(): AnalyzerConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as AnalyzerConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: AnalyzerConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

export function getCandidateClaudeProjectsDirs(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  if (platform() === "win32") {
    // Windows: Claude Code stores data under %APPDATA%\Claude
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    if (appData) candidates.push(join(appData, "Claude", "projects"));
    if (localAppData) candidates.push(join(localAppData, "Claude", "projects"));
  }

  // macOS, Linux, and Windows fallback: ~/.claude/projects
  candidates.push(join(home, ".claude", "projects"));

  return candidates;
}

export function resolveClaudeProjectsDir(): string | null {
  // 1. Environment variable override (useful for CI or non-standard installs)
  const envDir = process.env.CLAUDE_DATA_DIR;
  if (envDir) return envDir;

  // 2. User-saved config
  const config = readConfig();
  if (config.claudeProjectsDir) return config.claudeProjectsDir;

  // 3. Platform-aware auto-detection: return first candidate that exists
  for (const candidate of getCandidateClaudeProjectsDirs()) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}
