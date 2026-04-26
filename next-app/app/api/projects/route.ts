import { NextResponse } from "next/server";
import { ensureLoaded } from "@/lib/server/cache";

export async function GET() {
  try {
    const result = await ensureLoaded();
    const projects = [...result.projects.values()].map((p) => ({
      projectKey: p.projectKey,
      projectName: p.projectName,
      projectPath: p.projectPath,
      sessionCount: p.sessionCount,
      totals: p.totals,
      totalCost: p.totalCost,
      limitHitCount: p.limitHitCount,
    }));
    projects.sort((a, b) => b.totalCost - a.totalCost);
    return NextResponse.json(projects);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
