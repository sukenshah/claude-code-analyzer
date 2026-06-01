import { NextResponse } from "next/server";
import { buildQualityReport } from "@/lib/server/quality";

export async function GET() {
  try {
    const report = await buildQualityReport();
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
