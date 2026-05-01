import { NextResponse } from "next/server";
import { ensureLoaded } from "@/lib/server/cache";

interface SessionRow {
  sessionId: string;
  projectKey: string;
  projectName: string;
  aiTitle: string | null;
  limitHitCount: number;
  compactionCount: number;
  totalCost: number;
  firstTimestamp: string;
}

interface ProjectRow {
  projectKey: string;
  projectName: string;
  totalSessions: number;
  limitHitCount: number;
  sessionsWithLimitHit: number;
  compactionCount: number;
  sessionsWithBothLimitAndCompaction: number;
  claudeMdTokens: number;
  claudeMdCostPerSession: number;
  totalCost: number;
}

export async function GET() {
  try {
    const result = await ensureLoaded();

    let totalLimitHits = 0;
    let totalSessions = 0;
    let sessionsWithLimitHit = 0;
    let sessionsWithBothLimitAndCompaction = 0;

    const projectBreakdown: ProjectRow[] = [];
    const topSessions: SessionRow[] = [];

    for (const project of result.projects.values()) {
      let projLimitHitCount = 0;
      let projSessionsWithLimitHit = 0;
      let projCompactionCount = 0;
      let projSessionsWithBothLimitAndCompaction = 0;

      for (const session of project.sessions) {
        const lhc = session.meta.limitHitCount ?? 0;
        const cc = session.meta.compactEvents.length;

        projLimitHitCount += lhc;
        projCompactionCount += cc;

        if (lhc > 0) {
          projSessionsWithLimitHit++;
          sessionsWithLimitHit++;
          totalLimitHits += lhc;

          if (cc > 0) {
            projSessionsWithBothLimitAndCompaction++;
            sessionsWithBothLimitAndCompaction++;
          }

          topSessions.push({
            sessionId: session.sessionId,
            projectKey: session.projectKey,
            projectName: session.projectName,
            aiTitle: session.meta.aiTitle,
            limitHitCount: lhc,
            compactionCount: cc,
            totalCost: session.totalCost,
            firstTimestamp: session.firstTimestamp,
          });
        }
      }

      totalSessions += project.sessions.length;

      projectBreakdown.push({
        projectKey: project.projectKey,
        projectName: project.projectName,
        totalSessions: project.sessions.length,
        limitHitCount: projLimitHitCount,
        sessionsWithLimitHit: projSessionsWithLimitHit,
        compactionCount: projCompactionCount,
        sessionsWithBothLimitAndCompaction: projSessionsWithBothLimitAndCompaction,
        claudeMdTokens: project.claudeMd.totalEstimatedTokens,
        claudeMdCostPerSession: project.claudeMd.totalPerSessionCostUsd,
        totalCost: project.totalCost,
      });
    }

    // Sort: projects with limit hits first, then by limitHitCount desc
    projectBreakdown.sort((a, b) => b.limitHitCount - a.limitHitCount);

    // Top 20 sessions by limitHitCount desc
    topSessions.sort((a, b) => b.limitHitCount - a.limitHitCount || b.totalCost - a.totalCost);
    const topSessionsSliced = topSessions.slice(0, 20);

    return NextResponse.json({
      globalStats: {
        totalLimitHits,
        totalSessions,
        sessionsWithLimitHit,
        sessionsWithBothLimitAndCompaction,
      },
      projectBreakdown,
      topSessions: topSessionsSliced,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
