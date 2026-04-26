import { NextResponse } from "next/server";
import { getActiveSessions } from "@claude-analyzer/analyzer";

export async function GET() {
  try {
    const now = Date.now();
    const sessions = await getActiveSessions();
    return NextResponse.json(sessions.map((s) => ({
      sessionId: s.sessionId,
      projectKey: s.projectKey,
      projectName: s.projectName,
      aiTitle: s.meta.aiTitle,
      turnCount: s.turns.filter((t) => !t.isSubagent).length,
      totalCost: s.totalCost,
      totals: s.totals,
      lastTimestamp: s.lastTimestamp,
      lastModifiedMs: s.lastModifiedMs,
      secondsAgo: Math.floor((now - s.lastModifiedMs) / 1000),
      gitBranch: s.meta.gitBranch,
      entrypoint: s.meta.entrypoint,
    })));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
