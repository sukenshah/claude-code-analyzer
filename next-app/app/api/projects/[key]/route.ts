import { NextRequest, NextResponse } from "next/server";
import { ensureLoaded } from "@/lib/server/cache";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const { key } = await params;
    const result = await ensureLoaded();
    const project = result.projects.get(key);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const sessions = project.sessions.map((s) => ({
      sessionId: s.sessionId,
      projectKey: s.projectKey,
      projectName: s.projectName,
      firstTimestamp: s.firstTimestamp,
      lastTimestamp: s.lastTimestamp,
      turnCount: s.turns.length,
      totals: s.totals,
      totalCost: s.totalCost,
      hasSubagents: s.hasSubagents,
      subagentCount: s.subagentCount,
      meta: s.meta,
    }));
    return NextResponse.json({ ...project, sessions });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
