import { NextResponse } from "next/server";
import { ensureLoaded, invalidateCache } from "@/lib/server/cache";

export async function POST() {
  try {
    invalidateCache();
    const result = await ensureLoaded(true);
    return NextResponse.json({
      newFilesScanned: result.newFilesScanned,
      projectCount: result.summary.projectCount,
      sessionCount: result.summary.sessionCount,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
