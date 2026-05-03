import { NextRequest, NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { marked } from "marked";
import { resolveClaudeProjectsDir } from "@claude-analyzer/analyzer";
import type { ProjectMemory } from "@/lib/types";

const EMPTY: ProjectMemory = { exists: false, mainContentHtml: null, mainContentIsEmpty: false, topicFiles: [] };

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const { key } = await params;
    const projectsDir = resolveClaudeProjectsDir();
    if (!projectsDir) return NextResponse.json(EMPTY);

    const memoryDir = join(projectsDir, key, "memory");
    if (!existsSync(memoryDir)) return NextResponse.json(EMPTY);

    const mainPath = join(memoryDir, "MEMORY.md");
    let mainContentHtml: string | null = null;
    let mainContentIsEmpty = false;
    if (existsSync(mainPath)) {
      try {
        const raw = readFileSync(mainPath, "utf-8");
        if (raw.trim().length === 0) {
          mainContentIsEmpty = true;
        } else {
          mainContentHtml = marked(raw) as string;
        }
      } catch { /* unreadable */ }
    }

    const topicFiles: Array<{ fileName: string; sizeBytes: number }> = [];
    try {
      for (const entry of readdirSync(memoryDir)) {
        if (!entry.endsWith(".md") || entry === "MEMORY.md") continue;
        try {
          topicFiles.push({ fileName: entry, sizeBytes: statSync(join(memoryDir, entry)).size });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    topicFiles.sort((a, b) => a.fileName.localeCompare(b.fileName));

    return NextResponse.json({ exists: true, mainContentHtml, mainContentIsEmpty, topicFiles } satisfies ProjectMemory);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
