import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { marked } from "marked";
import { Breadcrumb } from "@/components/Breadcrumb";

export default async function PlanDetailPage({ params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  // Strip path traversal characters — allow only alphanumeric, dot, dash, underscore
  const safe = decodeURIComponent(filename).replace(/[^a-zA-Z0-9._-]/g, "");
  const title = safe.replace(/\.md$/, "");
  let html = "";
  try {
    const raw = readFileSync(join(homedir(), ".claude", "plans", safe), "utf-8");
    html = marked(raw) as string;
  } catch {
    html = "<p>Plan not found.</p>";
  }

  return (
    <div className="page">
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <Breadcrumb
          crumbs={[
            { label: "Dashboard", href: "/" },
            { label: "Plans", href: "/plans" },
            { label: title },
          ]}
        />
        <div className="card info-page-body" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
