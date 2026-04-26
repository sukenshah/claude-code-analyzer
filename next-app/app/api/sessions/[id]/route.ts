import { NextRequest, NextResponse } from "next/server";
import { ensureLoaded } from "@/lib/server/cache";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = await ensureLoaded();
    const session = result.sessions.get(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json(session);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
