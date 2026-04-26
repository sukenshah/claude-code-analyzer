import { NextRequest, NextResponse } from "next/server";
import { readConfig, writeConfig, resolveClaudeProjectsDir, getCandidateClaudeProjectsDirs } from "@claude-analyzer/analyzer";
import { invalidateCache } from "@/lib/server/cache";

export async function GET() {
  try {
    const config = readConfig();
    const resolvedDir = resolveClaudeProjectsDir();
    return NextResponse.json({
      claudeProjectsDir: config.claudeProjectsDir ?? null,
      resolvedDir,
      candidates: getCandidateClaudeProjectsDirs(),
      found: resolvedDir !== null,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { claudeProjectsDir } = await request.json() as { claudeProjectsDir?: string };
    const current = readConfig();
    writeConfig({ ...current, claudeProjectsDir: claudeProjectsDir || undefined });
    invalidateCache();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
