import { NextRequest, NextResponse } from "next/server";
import { ensureLoaded } from "@/lib/server/cache";
import { extractMessages } from "@/lib/server/messages";

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
    const mainTurn = session.turns.find((t) => !t.isSubagent);
    if (!mainTurn) {
      return NextResponse.json([]);
    }
    const messages = await extractMessages(mainTurn.sourceFile);
    return NextResponse.json(messages);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
