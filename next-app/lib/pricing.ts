interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8":              { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-opus-4-7":              { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-opus-4-5":              { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-sonnet-4-6":            { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  "claude-sonnet-4-5":            { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  "claude-haiku-4-5":             { input: 0.80, output: 4,    cacheWrite: 1,     cacheRead: 0.08 },
  "claude-haiku-4-5-20251001":    { input: 0.80, output: 4,    cacheWrite: 1,     cacheRead: 0.08 },
  "claude-3-5-sonnet-20241022":   { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  "claude-3-5-sonnet-20240620":   { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  "claude-3-5-haiku-20241022":    { input: 0.80, output: 4,    cacheWrite: 1,     cacheRead: 0.08 },
  "claude-3-opus-20240229":       { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-3-sonnet-20240229":     { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  "claude-3-haiku-20240307":      { input: 0.25, output: 1.25, cacheWrite: 0.30,  cacheRead: 0.03 },
};

function getPricing(model: string): ModelPricing {
  if (PRICING[model]) return PRICING[model]!;
  for (const [key, p] of Object.entries(PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) return p;
  }
  if (model.includes("haiku")) {
    if (/claude-3-haiku/.test(model)) return PRICING["claude-3-haiku-20240307"]!;
    return PRICING["claude-haiku-4-5"]!;
  }
  if (model.includes("opus")) return PRICING["claude-opus-4-8"]!;
  return PRICING["claude-sonnet-4-6"]!;
}

export interface TokenUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function simulateCost(usage: TokenUsageLike, model: string): number {
  const p = getPricing(model);
  const M = 1_000_000;
  return (
    (usage.input_tokens / M) * p.input +
    (usage.output_tokens / M) * p.output +
    (usage.cache_creation_input_tokens / M) * p.cacheWrite +
    (usage.cache_read_input_tokens / M) * p.cacheRead
  );
}

export interface CompareOption {
  id: string;
  label: string;
}

export const COMPARE_MODELS: CompareOption[] = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-sonnet-4-6",         label: "Sonnet 4.6" },
  { id: "claude-opus-4-7",           label: "Opus 4.7" },
  { id: "claude-opus-4-8",           label: "Opus 4.8" },
];
