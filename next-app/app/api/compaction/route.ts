import { NextResponse } from "next/server";
import { ensureLoaded } from "@/lib/server/cache";

export async function GET() {
  try {
    const result = await ensureLoaded();

    let totalCompactions = 0;
    let totalSessionsWithCompaction = 0;
    let totalSessions = 0;
    let totalTokensLost = 0;
    const triggerCounts: Record<string, number> = {};

    let compactedSessionCostSum = 0;
    let nonCompactedSessionCostSum = 0;
    let compactedSessionCount = 0;
    let nonCompactedSessionCount = 0;

    const projectBreakdown: Array<{
      projectName: string;
      projectKey: string;
      compactionCount: number;
      sessionsWithCompaction: number;
      totalSessions: number;
      totalTokensLost: number;
      avgTokensLostPerCompaction: number;
      avgCompactedSessionCost: number;
      avgNonCompactedSessionCost: number;
      totalCost: number;
    }> = [];

    for (const project of result.projects.values()) {
      let projCompactionCount = 0;
      let projSessionsWithCompaction = 0;
      let projTokensLost = 0;
      let projCompactedCostSum = 0;
      let projNonCompactedCostSum = 0;
      let projCompactedCount = 0;
      let projNonCompactedCount = 0;

      for (const session of project.sessions) {
        const events = session.meta.compactEvents;
        const hasCompaction = events.length > 0;

        if (hasCompaction) {
          projSessionsWithCompaction++;
          totalSessionsWithCompaction++;
          for (const ev of events) {
            const lost = Math.max(0, ev.preTokens - ev.postTokens);
            projTokensLost += lost;
            totalTokensLost += lost;
            projCompactionCount++;
            totalCompactions++;
            triggerCounts[ev.trigger] = (triggerCounts[ev.trigger] ?? 0) + 1;
          }
          projCompactedCostSum += session.totalCost;
          projCompactedCount++;
          compactedSessionCostSum += session.totalCost;
          compactedSessionCount++;
        } else {
          projNonCompactedCostSum += session.totalCost;
          projNonCompactedCount++;
          nonCompactedSessionCostSum += session.totalCost;
          nonCompactedSessionCount++;
        }
      }

      totalSessions += project.sessions.length;

      if (projCompactionCount > 0) {
        projectBreakdown.push({
          projectName: project.projectName,
          projectKey: project.projectKey,
          compactionCount: projCompactionCount,
          sessionsWithCompaction: projSessionsWithCompaction,
          totalSessions: project.sessions.length,
          totalTokensLost: projTokensLost,
          avgTokensLostPerCompaction:
            projCompactionCount > 0 ? Math.round(projTokensLost / projCompactionCount) : 0,
          avgCompactedSessionCost:
            projCompactedCount > 0 ? projCompactedCostSum / projCompactedCount : 0,
          avgNonCompactedSessionCost:
            projNonCompactedCount > 0 ? projNonCompactedCostSum / projNonCompactedCount : 0,
          totalCost: project.totalCost,
        });
      }
    }

    projectBreakdown.sort((a, b) => b.compactionCount - a.compactionCount);

    return NextResponse.json({
      globalStats: {
        totalCompactions,
        totalSessionsWithCompaction,
        totalSessions,
        totalTokensLost,
        avgTokensLostPerCompaction:
          totalCompactions > 0 ? Math.round(totalTokensLost / totalCompactions) : 0,
        triggerCounts,
      },
      costComparison: {
        avgCompactedSessionCost:
          compactedSessionCount > 0 ? compactedSessionCostSum / compactedSessionCount : 0,
        avgNonCompactedSessionCost:
          nonCompactedSessionCount > 0 ? nonCompactedSessionCostSum / nonCompactedSessionCount : 0,
        compactedSessionCount,
        nonCompactedSessionCount,
      },
      projectBreakdown,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
