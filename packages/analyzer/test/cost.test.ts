import { test, describe, expect } from "vitest";
import { calculateCost, sumUsage, sumCost, formatCost, getModelPricing, isKnownModel, simulateCost, estimateCacheMissCost } from "../src/cost.js";
import type { TokenUsage } from "../src/types.js";

const zero: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const oneMillion: TokenUsage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

describe("calculateCost", () => {
  test("sonnet-4-6 input + output costs", () => {
    const cost = calculateCost(oneMillion, "claude-sonnet-4-6");
    expect(cost.inputCost).toBe(3);
    expect(cost.outputCost).toBe(15);
    expect(cost.totalCost).toBe(18);
  });

  test("cache write (5m) and read costs", () => {
    const usage: TokenUsage = { ...zero, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
    const cost = calculateCost(usage, "claude-sonnet-4-6");
    expect(cost.cacheWriteCost).toBe(3.75);
    expect(cost.cacheReadCost).toBe(0.30);
  });

  test("1h vs 5m cache split, uncovered tokens priced at 5m", () => {
    const usage: TokenUsage = { ...zero, cache_creation_input_tokens: 3_000_000 };
    const c = calculateCost(usage, "claude-sonnet-4-6", { ephemeral5m: 1_000_000, ephemeral1h: 1_000_000 });
    // 1M@3.75 + 1M@6 + 1M uncovered@3.75
    expect(c.cacheWriteCost).toBeCloseTo(13.5, 6);
    const all5m = calculateCost(usage, "claude-sonnet-4-6");
    expect(all5m.cacheWriteCost).toBeCloseTo(11.25, 6);
  });

  test("all-zero usage = zero cost", () => {
    expect(calculateCost(zero, "claude-opus-4-7").totalCost).toBe(0);
  });

  test("opus 4.x vs 4.1 vs 5 vs 5.5 (longest prefix)", () => {
    const u: TokenUsage = { ...zero, input_tokens: 1_000_000 };
    expect(calculateCost(u, "claude-opus-4-8").inputCost).toBe(5);
    expect(calculateCost(u, "claude-opus-4-1-20250805").inputCost).toBe(15);
    expect(calculateCost(u, "claude-opus-4-20250514").inputCost).toBe(15);
    expect(calculateCost(u, "claude-opus-5").inputCost).toBe(5);
    expect(calculateCost(u, "claude-opus-5-5").inputCost).toBe(4);
    expect(getModelPricing("claude-opus-5-5").cacheRead).toBe(0.2);
    expect(getModelPricing("claude-opus-5").cacheRead).toBe(0.5);
  });

  test("dated ids resolve by prefix", () => {
    expect(getModelPricing("claude-haiku-4-5-20251001")).toMatchObject({ input: 1, output: 5, cacheRead: 0.1 });
    expect(getModelPricing("claude-3-haiku-20240307").input).toBe(0.25);
    expect(getModelPricing("claude-3-5-haiku-20241022").input).toBe(0.8);
  });

  test("fable/mythos tiers", () => {
    expect(getModelPricing("claude-fable-5")).toMatchObject({ input: 10, output: 50, cacheRead: 1 });
    expect(getModelPricing("claude-fable-5-1").cacheRead).toBe(0.25);
    expect(getModelPricing("claude-mythos-5-2")).toMatchObject({ input: 8, output: 40, cacheRead: 0.2 });
  });

  test("getModelPricing exposes derived write rates", () => {
    const p = getModelPricing("claude-sonnet-4-6");
    expect(p.cacheWrite5m).toBe(3.75);
    expect(p.cacheWrite1h).toBe(6);
  });

  test("unknown model falls back by family, else sonnet-5-5", () => {
    expect(getModelPricing("claude-opus-future").input).toBe(4);
    expect(getModelPricing("claude-haiku-future").input).toBe(0.1);
    expect(getModelPricing("claude-sonnet-future").input).toBe(2);
    expect(getModelPricing("claude-fable-9").input).toBe(8);
    expect(getModelPricing("totally-unknown-model-xyz")).toEqual(getModelPricing("claude-sonnet-5-5"));
  });

  test("isKnownModel only for exact/prefix hits", () => {
    expect(isKnownModel("claude-sonnet-4-6")).toBe(true);
    expect(isKnownModel("claude-haiku-4-5-20251001")).toBe(true);
    expect(isKnownModel("claude-opus-future")).toBe(false);
    expect(isKnownModel("gpt-5")).toBe(false);
  });

  test("synthetic costs zero", () => {
    const c = calculateCost({ ...zero, input_tokens: 1_000_000 }, "<synthetic>");
    expect(c.totalCost).toBe(0);
  });

  test("haiku-5-5 base tier matches Claude Code accounting", () => {
    // Many small requests (each < 100K prompt).
    let total = 0;
    for (let i = 0; i < 4; i++) {
      total += calculateCost({ ...zero, input_tokens: 80191.25, output_tokens: 25359 / 4 }, "claude-haiku-5-5").totalCost;
    }
    expect(total).toBeCloseTo(0.044756, 4);
  });

  test("haiku-5-5 long-prompt tier is 5x per request", () => {
    const small = calculateCost({ ...zero, input_tokens: 100_000, output_tokens: 1000 }, "claude-haiku-5-5");
    const big = calculateCost({ ...zero, input_tokens: 100_001, output_tokens: 1000 }, "claude-haiku-5-5");
    expect(big.outputCost).toBeCloseTo(small.outputCost * 5, 10);
    expect(big.inputCost).toBeCloseTo(0.5 * 100_001 / 1e6, 10);
    const cached = calculateCost({ ...zero, cache_read_input_tokens: 200_000 }, "claude-haiku-5-5");
    expect(cached.cacheReadCost).toBeCloseTo(0.05 * 0.2, 10);
  });

  test("sonnet-5-5 matches Claude Code accounting", () => {
    const usage: TokenUsage = { input_tokens: 916, output_tokens: 321441, cache_read_input_tokens: 34585193, cache_creation_input_tokens: 1418819 };
    const c = calculateCost(usage, "claude-sonnet-5-5", { ephemeral5m: 1418819, ephemeral1h: 0 });
    expect(c.totalCost).toBeCloseTo(10.2218088, 4);
  });

  test("simulateCost prices usage on another model", () => {
    expect(simulateCost(oneMillion, "claude-sonnet-4-6")).toBe(18);
  });

  test("estimateCacheMissCost uses write-minus-read delta", () => {
    expect(estimateCacheMissCost(1_000_000, "claude-sonnet-4-6")).toBeCloseTo(3.45, 6);
    expect(estimateCacheMissCost(0, "claude-sonnet-4-6")).toBe(0);
  });
});

describe("sumUsage", () => {
  test("sums two usages", () => {
    const a: TokenUsage = { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 10 };
    const b: TokenUsage = { input_tokens: 300, output_tokens: 400, cache_creation_input_tokens: 20, cache_read_input_tokens: 5 };
    const result = sumUsage([a, b]);
    expect(result.input_tokens).toBe(400);
    expect(result.output_tokens).toBe(600);
    expect(result.cache_creation_input_tokens).toBe(70);
    expect(result.cache_read_input_tokens).toBe(15);
  });

  test("empty array returns zeros", () => {
    const result = sumUsage([]);
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.cache_creation_input_tokens).toBe(0);
    expect(result.cache_read_input_tokens).toBe(0);
  });

  test("single usage returned as-is", () => {
    const u: TokenUsage = { input_tokens: 7, output_tokens: 8, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 };
    expect(sumUsage([u])).toEqual(u);
  });

  test("sums three usages", () => {
    const items = [
      { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { input_tokens: 20, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { input_tokens: 30, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ];
    expect(sumUsage(items).input_tokens).toBe(60);
  });
});

describe("sumCost", () => {
  test("sums totalCost fields", () => {
    const costs = [
      { inputCost: 1, outputCost: 2, cacheWriteCost: 0.5, cacheReadCost: 0.1, totalCost: 3.6 },
      { inputCost: 0.5, outputCost: 1, cacheWriteCost: 0.2, cacheReadCost: 0.05, totalCost: 1.75 },
    ];
    expect(sumCost(costs)).toBeCloseTo(5.35, 4);
  });

  test("empty array returns 0", () => {
    expect(sumCost([])).toBe(0);
  });

  test("single cost entry", () => {
    expect(sumCost([{ inputCost: 1, outputCost: 2, cacheWriteCost: 0, cacheReadCost: 0, totalCost: 5 }])).toBe(5);
  });
});

describe("formatCost", () => {
  test("formats dollars for values >= $0.01", () => {
    expect(formatCost(1.2345)).toBe("$1.2345");
  });

  test("formats exactly $0.01 as dollars", () => {
    expect(formatCost(0.01)).toMatch(/^\$/);
  });

  test("formats values < $0.01 as cents", () => {
    const result = formatCost(0.001);
    expect(result).toMatch(/¢$/);
    expect(result.startsWith("$")).toBe(false);
  });

  test("formats zero as cents", () => {
    expect(formatCost(0)).toMatch(/¢$/);
  });

  test("cent value has 3 decimal places", () => {
    expect(formatCost(0.005)).toMatch(/\d+\.\d{3}¢/);
  });

  test("dollar value has 4 decimal places", () => {
    expect(formatCost(0.5)).toMatch(/\$\d+\.\d{4}/);
  });
});
