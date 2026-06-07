import { NextResponse } from "next/server";
import { buildEfficiencyReport } from "@/lib/server/efficiency";

export async function GET() {
  try {
    const report = await buildEfficiencyReport();
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
