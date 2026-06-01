import { test, describe, expect } from "vitest";
import { calculateCost, sumUsage, sumCost, formatCost } from "../src/cost.js";
import type { TokenUsage } from "../src/types.js";

const zero: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const oneMillion: TokenUsage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

describe("calculateCost", () => {
  test("sonnet-4-6 input + output costs", () => {
    const cost = calculateCost(oneMillion, "claude-sonnet-4-6");
    expect(cost.inputCost).toBe(3);
    expect(cost.outputCost).toBe(15);
    expect(cost.cacheWriteCost).toBe(0);
    expect(cost.cacheReadCost).toBe(0);
    expect(cost.totalCost).toBe(18);
  });

  test("cache write and read costs", () => {
    const usage: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
    const cost = calculateCost(usage, "claude-sonnet-4-6");
    expect(cost.cacheWriteCost).toBe(3.75);
    expect(cost.cacheReadCost).toBe(0.30);
    expect(cost.totalCost).toBeCloseTo(4.05, 4);
  });

  test("all-zero usage = zero cost", () => {
    const cost = calculateCost(zero, "claude-opus-4-7");
    expect(cost.totalCost).toBe(0);
  });

  test("haiku-4-5 uses correct lower pricing", () => {
    const usage: TokenUsage = { ...zero, input_tokens: 1_000_000 };
    const cost = calculateCost(usage, "claude-haiku-4-5");
    expect(cost.inputCost).toBe(0.80);
  });

  test("claude-3-haiku pricing lower than haiku-4-5", () => {
    const usage: TokenUsage = { ...zero, input_tokens: 1_000_000 };
    const v3 = calculateCost(usage, "claude-3-haiku-20240307");
    const v45 = calculateCost(usage, "claude-haiku-4-5");
    expect(v3.inputCost).toBeLessThan(v45.inputCost);
    expect(v3.inputCost).toBe(0.25);
  });

  test("opus-4-7 pricing", () => {
    const usage: TokenUsage = { ...zero, input_tokens: 1_000_000 };
    const cost = calculateCost(usage, "claude-opus-4-7");
    expect(cost.inputCost).toBe(15);
  });

  test("opus-4-8 pricing", () => {
    const usage: TokenUsage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
    const cost = calculateCost(usage, "claude-opus-4-8");
    expect(cost.inputCost).toBe(15);
    expect(cost.outputCost).toBe(75);
    expect(cost.cacheWriteCost).toBe(18.75);
    expect(cost.cacheReadCost).toBe(1.50);
  });

  test("unknown model falls back to sonnet-4-6 default", () => {
    const usage: TokenUsage = { ...zero, input_tokens: 1_000_000 };
    const unknown = calculateCost(usage, "totally-unknown-model-xyz");
    const known = calculateCost(usage, "claude-sonnet-4-6");
    expect(unknown.inputCost).toBe(known.inputCost);
  });

  test("fuzzy prefix match on haiku variant", () => {
    const usage: TokenUsage = { ...zero, input_tokens: 1_000_000 };
    const cost = calculateCost(usage, "claude-haiku-future-model");
    expect(cost.inputCost).toBe(0.80);
  });

  test("fuzzy prefix match on opus variant", () => {
    const usage: TokenUsage = { ...zero, input_tokens: 1_000_000 };
    const cost = calculateCost(usage, "claude-opus-future-model");
    expect(cost.inputCost).toBe(15);
  });

  test("totalCost equals sum of all components", () => {
    const usage: TokenUsage = { input_tokens: 500_000, output_tokens: 200_000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 50_000 };
    const cost = calculateCost(usage, "claude-sonnet-4-6");
    const expected = cost.inputCost + cost.outputCost + cost.cacheWriteCost + cost.cacheReadCost;
    expect(cost.totalCost).toBeCloseTo(expected, 6);
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
