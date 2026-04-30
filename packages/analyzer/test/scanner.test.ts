import { test, describe, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getProjectName, getProjectPath, extractProjectPaths } from "../src/scanner.js";
import type { ScanEntry } from "../src/types.js";

describe("getProjectName", () => {
  test("extracts segment after -git-", () => {
    expect(getProjectName("Users-john-git-my-project")).toBe("my-project");
  });

  test("extracts multi-part name after -git-", () => {
    expect(getProjectName("Users-john-git-claude-code-analyzer")).toBe("claude-code-analyzer");
  });

  test("falls back to last 2 hyphen parts when no -git-", () => {
    expect(getProjectName("Users-john-projects-my-app")).toBe("my-app");
  });

  test("falls back gracefully for very short key", () => {
    expect(getProjectName("abc").length).toBeGreaterThan(0);
  });

  test("handles key with single segment", () => {
    const result = getProjectName("project");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("-git- takes priority over last-2-parts fallback", () => {
    expect(getProjectName("a-b-git-foo-bar")).toBe("foo-bar");
  });
});

describe("getProjectPath", () => {
  test("converts all hyphens to path separators", () => {
    // decodeProjectKey replaces ALL hyphens with slashes — lossy encoding by design
    expect(getProjectPath("Users-john-git-myproject")).toBe("/Users/john/git/myproject");
  });

  test("always starts with a slash", () => {
    expect(getProjectPath("any-key")).toMatch(/^\//);
  });

  test("strips leading slash from decoded key (no double slash)", () => {
    expect(getProjectPath("Users-test")).not.toMatch(/^\/\//);
  });

  test("single segment key", () => {
    expect(getProjectPath("home")).toBe("/home");
  });
});

describe("extractProjectPaths", () => {
  test("extracts cwd from first line of JSONL file", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyzer-scanner-"));
    const filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, JSON.stringify({ type: "summary", cwd: "/my/project/path" }) + "\n");

    const entries: ScanEntry[] = [{ sessionId: "s1", projectKey: "my-project", filePath, isSubagent: false, agentId: null }];
    expect(extractProjectPaths(entries).get("my-project")).toBe("/my/project/path");
  });

  test("skips lines without cwd, finds cwd on later line", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyzer-scanner-"));
    const filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, [
      JSON.stringify({ type: "other", data: 123 }),
      JSON.stringify({ type: "summary", cwd: "/real/path" }),
    ].join("\n"));

    const entries: ScanEntry[] = [{ sessionId: "s1", projectKey: "proj", filePath, isSubagent: false, agentId: null }];
    expect(extractProjectPaths(entries).get("proj")).toBe("/real/path");
  });

  test("no cwd anywhere returns empty map", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyzer-scanner-"));
    const filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, JSON.stringify({ type: "other", data: 123 }) + "\n");

    const entries: ScanEntry[] = [{ sessionId: "s1", projectKey: "proj", filePath, isSubagent: false, agentId: null }];
    expect(extractProjectPaths(entries).has("proj")).toBe(false);
  });

  test("nonexistent file is skipped gracefully", () => {
    const entries: ScanEntry[] = [{ sessionId: "s1", projectKey: "proj", filePath: "/nonexistent/path/file.jsonl", isSubagent: false, agentId: null }];
    expect(extractProjectPaths(entries).size).toBe(0);
  });

  test("deduplicates: only uses first file for same projectKey", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyzer-scanner-"));
    const f1 = join(dir, "s1.jsonl");
    const f2 = join(dir, "s2.jsonl");
    writeFileSync(f1, JSON.stringify({ cwd: "/first/path" }) + "\n");
    writeFileSync(f2, JSON.stringify({ cwd: "/second/path" }) + "\n");

    const entries: ScanEntry[] = [
      { sessionId: "s1", projectKey: "proj", filePath: f1, isSubagent: false, agentId: null },
      { sessionId: "s2", projectKey: "proj", filePath: f2, isSubagent: false, agentId: null },
    ];
    expect(extractProjectPaths(entries).get("proj")).toBe("/first/path");
  });

  test("different projectKeys get independent paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyzer-scanner-"));
    const f1 = join(dir, "s1.jsonl");
    const f2 = join(dir, "s2.jsonl");
    writeFileSync(f1, JSON.stringify({ cwd: "/path/a" }) + "\n");
    writeFileSync(f2, JSON.stringify({ cwd: "/path/b" }) + "\n");

    const entries: ScanEntry[] = [
      { sessionId: "s1", projectKey: "proj-a", filePath: f1, isSubagent: false, agentId: null },
      { sessionId: "s2", projectKey: "proj-b", filePath: f2, isSubagent: false, agentId: null },
    ];
    const paths = extractProjectPaths(entries);
    expect(paths.get("proj-a")).toBe("/path/a");
    expect(paths.get("proj-b")).toBe("/path/b");
  });

  test("empty entries returns empty map", () => {
    expect(extractProjectPaths([]).size).toBe(0);
  });

  test("handles invalid JSON lines without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyzer-scanner-"));
    const filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, "not-json\n{bad json\n" + JSON.stringify({ cwd: "/valid/path" }) + "\n");

    const entries: ScanEntry[] = [{ sessionId: "s1", projectKey: "proj", filePath, isSubagent: false, agentId: null }];
    expect(extractProjectPaths(entries).get("proj")).toBe("/valid/path");
  });
});
