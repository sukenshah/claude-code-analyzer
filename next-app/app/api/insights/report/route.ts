import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const html = readFileSync(join(homedir(), ".claude", "usage-data", "report.html"), "utf-8");
    return new NextResponse(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
