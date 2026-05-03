export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheWriteCost: number;
  cacheReadCost: number;
  totalCost: number;
}

export interface TurnRecord {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  projectKey: string;
  timestamp: string;
  model: string;
  usage: TokenUsage;
  cost: CostBreakdown;
  isSubagent: boolean;
  agentId: string | null;
}

export interface SessionMeta {
  aiTitle: string | null;
  entrypoint: string | null;
  gitBranch: string | null;
  permissionMode: string | null;
  version: string | null;
  mcpTools: string[];
  mcpToolCalls: Record<string, number>;
  compactEvents: CompactEvent[];
  limitHitCount: number;
}

export interface CompactEvent {
  timestamp: string;
  trigger: string;
  preTokens: number;
  postTokens: number;
  durationMs: number;
}

export interface SessionSummary {
  sessionId: string;
  projectKey: string;
  projectName: string;
  firstTimestamp: string;
  lastTimestamp: string;
  turnCount: number;
  totals: TokenUsage;
  totalCost: number;
  hasSubagents: boolean;
  subagentCount: number;
  meta: SessionMeta;
}

export interface SessionDetail extends Omit<SessionSummary, "turnCount"> {
  turns: TurnRecord[];
}

export interface ClaudeMdFile {
  filePath: string;
  relativePath: string;
  sizeBytes: number;
  estimatedTokens: number;
  perSessionCostUsd: number;
}

export interface ClaudeMdSummary {
  files: ClaudeMdFile[];
  totalEstimatedTokens: number;
  totalPerSessionCostUsd: number;
}

export interface MemoryTopicFile {
  fileName: string;
  sizeBytes: number;
}

export interface ProjectMemory {
  exists: boolean;
  mainContentHtml: string | null;
  mainContentIsEmpty: boolean;
  topicFiles: MemoryTopicFile[];
}

export interface ProjectSummary {
  projectKey: string;
  projectName: string;
  projectPath: string;
  sessionCount: number;
  totals: TokenUsage;
  totalCost: number;
  limitHitCount: number;
}

export interface ProjectDetail extends ProjectSummary {
  sessions: SessionSummary[];
  claudeMd: ClaudeMdSummary;
}

export interface ToolUse {
  name: string;
  title?: string;
}

export interface RawMessage {
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

export interface AppConfig {
  claudeProjectsDir: string | null;
  resolvedDir: string | null;
  candidates: string[];
  found: boolean;
}

export interface ActiveSession {
  sessionId: string;
  projectKey: string;
  projectName: string;
  aiTitle: string | null;
  turnCount: number;
  totalCost: number;
  totals: TokenUsage;
  lastTimestamp: string;
  lastModifiedMs: number;
  secondsAgo: number;
  gitBranch: string | null;
  entrypoint: string | null;
}

export interface DailyStats {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost: number;
}

export interface GlobalSummary {
  projectCount: number;
  sessionCount: number;
  turnCount: number;
  totals: TokenUsage;
  totalCost: number;
  byModel: Record<string, { usage: TokenUsage; cost: number }>;
  dailyStats: DailyStats[];
  limitHitCount: number;
}
