import { test, describe, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanClaudeMd } from "../src/claude-md.js";

const CHARS_PER_TOKEN = 3.5;
const INPUT_RATE_PER_M = 3.0;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "analyzer-claudemd-"));
}

describe("scanClaudeMd", () => {
  test("returns empty summary for nonexistent path", () => {
    const result = scanClaudeMd("/nonexistent/path/that/does/not/exist/ever");
    expect(result.files.length).toBe(0);
    expect(result.totalEstimatedTokens).toBe(0);
    expect(result.totalPerSessionCostUsd).toBe(0);
  });

  test("finds CLAUDE.md in root directory", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "CLAUDE.md"), "# Test\nSome content here.\n");

    const result = scanClaudeMd(dir);
    expect(result.files.length).toBe(1);
    expect(result.files[0].relativePath).toBe("CLAUDE.md");
  });

  test("finds CLAUDE.md in subdirectory", () => {
    const dir = tempDir();
    const sub = join(dir, "packages", "core");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "CLAUDE.md"), "# Sub package docs.");

    const result = scanClaudeMd(dir);
    expect(result.files.length).toBe(1);
    expect(result.files[0].relativePath).toMatch(/packages/);
  });

  test("finds CLAUDE.md in both root and subdirectory", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "CLAUDE.md"), "Root");
    const sub = join(dir, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "CLAUDE.md"), "Sub");

    expect(scanClaudeMd(dir).files.length).toBe(2);
  });

  test("skips node_modules directory", () => {
    const dir = tempDir();
    const nm = join(dir, "node_modules", "some-pkg");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "CLAUDE.md"), "Should be ignored");

    expect(scanClaudeMd(dir).files.length).toBe(0);
  });

  test("skips .git directory", () => {
    const dir = tempDir();
    const git = join(dir, ".git");
    mkdirSync(git);
    writeFileSync(join(git, "CLAUDE.md"), "Should be ignored");

    expect(scanClaudeMd(dir).files.length).toBe(0);
  });

  test("skips dist directory", () => {
    const dir = tempDir();
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "CLAUDE.md"), "Should be ignored");

    expect(scanClaudeMd(dir).files.length).toBe(0);
  });

  test("skips .next directory", () => {
    const dir = tempDir();
    const next = join(dir, ".next");
    mkdirSync(next);
    writeFileSync(join(next, "CLAUDE.md"), "Should be ignored");

    expect(scanClaudeMd(dir).files.length).toBe(0);
  });

  test("calculates estimatedTokens from char count (chars / 3.5)", () => {
    const dir = tempDir();
    const content = "a".repeat(350);
    writeFileSync(join(dir, "CLAUDE.md"), content);

    const result = scanClaudeMd(dir);
    expect(result.files[0].estimatedTokens).toBe(Math.round(350 / CHARS_PER_TOKEN));
    expect(result.totalEstimatedTokens).toBe(Math.round(350 / CHARS_PER_TOKEN));
  });

  test("calculates perSessionCostUsd from token estimate", () => {
    const dir = tempDir();
    const content = "a".repeat(350);
    writeFileSync(join(dir, "CLAUDE.md"), content);
    const expectedTokens = Math.round(350 / CHARS_PER_TOKEN);
    const expectedCost = (expectedTokens * INPUT_RATE_PER_M) / 1_000_000;

    const result = scanClaudeMd(dir);
    expect(result.files[0].perSessionCostUsd).toBeCloseTo(expectedCost, 7);
  });

  test("sums tokens and cost across multiple files", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "CLAUDE.md"), "a".repeat(700));
    const sub = join(dir, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "CLAUDE.md"), "b".repeat(350));

    const expectedTokens = Math.round(700 / CHARS_PER_TOKEN) + Math.round(350 / CHARS_PER_TOKEN);
    expect(scanClaudeMd(dir).totalEstimatedTokens).toBe(expectedTokens);
  });

  test("sizeBytes reflects UTF-8 byte length", () => {
    const dir = tempDir();
    const content = "hello world";
    writeFileSync(join(dir, "CLAUDE.md"), content);

    expect(scanClaudeMd(dir).files[0].sizeBytes).toBe(Buffer.byteLength(content, "utf8"));
  });

  test("relativePath is CLAUDE.md for root file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "CLAUDE.md"), "content");

    expect(scanClaudeMd(dir).files[0].relativePath).toBe("CLAUDE.md");
  });

  test("relativePath uses OS separator for nested file", () => {
    const dir = tempDir();
    const sub = join(dir, "mypackage");
    mkdirSync(sub);
    writeFileSync(join(sub, "CLAUDE.md"), "content");

    expect(scanClaudeMd(dir).files[0].relativePath).toContain("mypackage");
  });

  test("depth limit: does not recurse beyond 4 levels", () => {
    const dir = tempDir();
    const deep = join(dir, "a", "b", "c", "d", "e");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "CLAUDE.md"), "too deep");

    expect(scanClaudeMd(dir).files.length).toBe(0);
  });

  test("depth limit: finds file at exactly 4 levels deep", () => {
    const dir = tempDir();
    const level4 = join(dir, "a", "b", "c", "d");
    mkdirSync(level4, { recursive: true });
    writeFileSync(join(level4, "CLAUDE.md"), "just within limit");

    expect(scanClaudeMd(dir).files.length).toBe(1);
  });

  test("empty directory returns empty summary", () => {
    const dir = tempDir();
    const result = scanClaudeMd(dir);
    expect(result.files.length).toBe(0);
    expect(result.totalEstimatedTokens).toBe(0);
    expect(result.totalPerSessionCostUsd).toBe(0);
  });
});
