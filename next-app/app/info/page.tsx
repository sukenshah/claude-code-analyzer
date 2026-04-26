import { readFileSync } from "fs";
import { join } from "path";
import { marked } from "marked";
import { Breadcrumb } from "@/components/Breadcrumb";

export default function InfoPage() {
  let html = "";
  try {
    const readmeRaw = readFileSync(join(process.cwd(), "..", "README.md"), "utf-8");
    html = marked(readmeRaw) as string;
  } catch {
    html = "<p>README not found.</p>";
  }

  return (
    <div className="page">
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <Breadcrumb crumbs={[{ label: "Dashboard", href: "/" }, { label: "Info" }]} />
        <div className="card info-page-body" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
