import type { CostBreakdown, TokenUsage } from "./types.js";

// NOTE: this module must import types only (no fs / sqlite) so it can be bundled client-side
// via the "@claude-analyzer/analyzer/cost" subpath export.

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface CacheSplit {
  ephemeral5m: number;
  ephemeral1h: number;
}

// [input, output, cacheRead] in USD per million tokens.
const RATES: Record<string, [number, number, number]> = {
  "claude-fable-5-2": [8, 40, 0.2],
  "claude-mythos-5-2": [8, 40, 0.2],
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-mythos-5-1": [10, 50, 0.25],
  "claude-fable-5": [10, 50, 1],
  "claude-mythos-5": [10, 50, 1],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-opus-4-8": [5, 25, 0.5],
  "claude-opus-4-7": [5, 25, 0.5],
  "claude-opus-4-6": [5, 25, 0.5],
  "claude-opus-4-5": [5, 25, 0.5],
  "claude-opus-4-1": [15, 75, 1.5],
  "claude-opus-4-0": [15, 75, 1.5],
  "claude-opus-4-2025": [15, 75, 1.5],
  "claude-3-opus": [15, 75, 1.5],
  "claude-sonnet-5-5": [2, 10, 0.1],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-sonnet-4-6": [3, 15, 0.3],
  "claude-sonnet-4-5": [3, 15, 0.3],
  "claude-sonnet-4-0": [3, 15, 0.3],
  "claude-sonnet-4-2025": [3, 15, 0.3],
  "claude-3-7-sonnet": [3, 15, 0.3],
  "claude-3-5-sonnet": [3, 15, 0.3],
  "claude-3-sonnet": [3, 15, 0.3],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "claude-haiku-4-5": [1, 5, 0.1],
  "claude-3-5-haiku": [0.8, 4, 0.08],
  "claude-3-haiku": [0.25, 1.25, 0.03],
};

const FAMILY_FALLBACK: Array<[string, string]> = [
  ["fable", "claude-fable-5-2"],
  ["mythos", "claude-fable-5-2"],
  ["opus", "claude-opus-5-5"],
  ["sonnet", "claude-sonnet-5-5"],
  ["haiku", "claude-haiku-5-5"],
];
const DEFAULT_KEY = "claude-sonnet-5-5";

// Claude Haiku 5.5 charges 5x when a single request's prompt exceeds this many tokens.
const HAIKU_55_LONG_PROMPT_THRESHOLD = 100_000;
const HAIKU_55_LONG_PROMPT_MULTIPLIER = 5;

const SORTED_KEYS = Object.keys(RATES).sort((a, b) => b.length - a.length);

function resolveKey(model: string): { key: string; known: boolean } {
  if (RATES[model]) return { key: model, known: true };
  for (const key of SORTED_KEYS) {
    if (model.startsWith(key)) return { key, known: true };
  }
  for (const [kw, key] of FAMILY_FALLBACK) {
    if (model.includes(kw)) return { key, known: false };
  }
  return { key: DEFAULT_KEY, known: false };
}

function toPricing(key: string, multiplier = 1): ModelPricing {
  const [input, output, cacheRead] = RATES[key]!;
  return {
    input: input * multiplier,
    output: output * multiplier,
    cacheWrite5m: input * 1.25 * multiplier,
    cacheWrite1h: input * 2 * multiplier,
    cacheRead: cacheRead * multiplier,
  };
}

const ZERO_PRICING: ModelPricing = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

/** True only for exact or prefix hits in the pricing table (not family fallbacks). */
export function isKnownModel(model: string): boolean {
  return resolveKey(model).known;
}

/** Base-tier pricing for a model (USD per million tokens). `<synthetic>` is zero. */
export function getModelPricing(model: string): ModelPricing {
  if (model === "<synthetic>") return ZERO_PRICING;
  return toPricing(resolveKey(model).key);
}

function pricingForRequest(usage: TokenUsage, model: string): ModelPricing {
  if (model === "<synthetic>") return ZERO_PRICING;
  const { key } = resolveKey(model);
  if (key === "claude-haiku-5-5") {
    const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    if (prompt > HAIKU_55_LONG_PROMPT_THRESHOLD) return toPricing(key, HAIKU_55_LONG_PROMPT_MULTIPLIER);
  }
  return toPricing(key);
}

export function calculateCost(usage: TokenUsage, model: string, cacheSplit?: CacheSplit): CostBreakdown {
  const p = pricingForRequest(usage, model);
  const M = 1_000_000;
  const inputCost = (usage.input_tokens / M) * p.input;
  const outputCost = (usage.output_tokens / M) * p.output;
  let cacheWriteCost: number;
  if (cacheSplit) {
    const h1 = cacheSplit.ephemeral1h;
    const covered = cacheSplit.ephemeral5m + h1;
    const m5 = cacheSplit.ephemeral5m + Math.max(0, usage.cache_creation_input_tokens - covered);
    cacheWriteCost = (m5 / M) * p.cacheWrite5m + (h1 / M) * p.cacheWrite1h;
  } else {
    cacheWriteCost = (usage.cache_creation_input_tokens / M) * p.cacheWrite5m;
  }
  const cacheReadCost = (usage.cache_read_input_tokens / M) * p.cacheRead;
  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
  };
}

/** Total USD for a usage priced on a given model (5m cache-write rate). */
export function simulateCost(usage: TokenUsage, model: string): number {
  return calculateCost(usage, model).totalCost;
}

// Estimate the dollars wasted by a cache miss: tokens that should have been billed at the
// cheap cache-read rate were instead re-billed at the cache-write (creation) rate.
export function estimateCacheMissCost(missTokens: number, model: string): number {
  if (missTokens <= 0) return 0;
  const p = getModelPricing(model);
  return (missTokens / 1_000_000) * (p.cacheWrite5m - p.cacheRead);
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
