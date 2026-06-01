import type { CostBreakdown, TokenUsage } from "./types.js";

interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Claude 4.x
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-haiku-4-5":  { input: 0.80, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-opus-4-8":   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-opus-4-7":   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-opus-4-5":   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  // Claude 3.5
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-3-5-sonnet-20240620": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-3-5-haiku-20241022":  { input: 0.80, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  // Claude 3 — significantly different pricing; haiku especially must not fall through to 4.5 rates
  "claude-3-opus-20240229":  { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-3-sonnet-20240229": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-3-haiku-20240307":  { input: 0.25, output: 1.25, cacheWrite: 0.30, cacheRead: 0.03 },
};

const DEFAULT_PRICING = PRICING["claude-sonnet-4-6"];

function getPricing(model: string): ModelPricing {
  if (PRICING[model]) return PRICING[model];
  // Fuzzy match: find by prefix
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) return pricing;
  }
  // Claude 3 Haiku has much lower pricing than later haiku models — must not conflate
  if (model.includes("haiku")) {
    if (/claude-3-haiku/.test(model)) return PRICING["claude-3-haiku-20240307"]!;
    return PRICING["claude-haiku-4-5"]!;
  }
  if (model.includes("opus")) return PRICING["claude-opus-4-8"]!;
  return DEFAULT_PRICING;
}

export function calculateCost(usage: TokenUsage, model: string): CostBreakdown {
  const p = getPricing(model);
  const M = 1_000_000;
  const inputCost = (usage.input_tokens / M) * p.input;
  const outputCost = (usage.output_tokens / M) * p.output;
  const cacheWriteCost = (usage.cache_creation_input_tokens / M) * p.cacheWrite;
  const cacheReadCost = (usage.cache_read_input_tokens / M) * p.cacheRead;
  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
  };
}

export function sumUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (acc, u) => ({
      input_tokens: acc.input_tokens + u.input_tokens,
      output_tokens: acc.output_tokens + u.output_tokens,
      cache_creation_input_tokens: acc.cache_creation_input_tokens + u.cache_creation_input_tokens,
      cache_read_input_tokens: acc.cache_read_input_tokens + u.cache_read_input_tokens,
    }),
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  );
}

export function sumCost(costs: CostBreakdown[]): number {
  return costs.reduce((acc, c) => acc + c.totalCost, 0);
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `${(usd * 100).toFixed(3)}¢`;
  return `$${usd.toFixed(4)}`;
}
