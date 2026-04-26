import { NextResponse } from "next/server";
import { ensureLoaded } from "@/lib/server/cache";

export async function GET() {
  try {
    const result = await ensureLoaded();
    return NextResponse.json(result.summary);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
