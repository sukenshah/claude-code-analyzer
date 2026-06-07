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
  sourceFile: string;
  // Cache-invalidation diagnostics (from message.diagnostics): tokens that missed
  // the prompt cache and the reason the cache was busted (e.g. "tools_changed").
  cacheMissTokens: number;
  cacheMissReason: string | null;
  // Ephemeral cache-creation split by TTL bucket (from usage.cache_creation).
  ephemeral5mTokens: number;
  ephemeral1hTokens: number;
}

export interface SessionRecord {
  sessionId: string;
  projectKey: string;
  projectName: string;
  firstTimestamp: string;
  lastTimestamp: string;
  turns: TurnRecord[];
  totals: TokenUsage;
  totalCost: number;
  hasSubagents: boolean;
  subagentCount: number;
  meta: SessionMeta;
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

export interface ProjectRecord {
  projectKey: string;
  projectName: string;
  projectPath: string;
  sessionCount: number;
  sessions: SessionRecord[];
  totals: TokenUsage;
  totalCost: number;
  claudeMd: ClaudeMdSummary;
  limitHitCount: number;
}

export interface CompactEvent {
  timestamp: string;
  trigger: string;
  preTokens: number;
  postTokens: number;
  durationMs: number;
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
  // Hook telemetry from attachment records (hook_success / hook_non_blocking_error /
  // async_hook_response): how many hooks fired, how many failed, total wall-clock added.
  hookInvocations: number;
  hookErrors: number;
  hookDurationMs: number;
  // Count of queue-operation (enqueue) records — user queued messages while Claude was busy.
  queuedMessages: number;
}

export interface ScanEntry {
  sessionId: string;
  projectKey: string;
  filePath: string;
  isSubagent: boolean;
  agentId: string | null;
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
