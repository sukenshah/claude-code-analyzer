import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Breadcrumb } from "@/components/Breadcrumb";
import { InsightsClient } from "@/components/InsightsClient";

export default function InsightsPage() {
  const exists = existsSync(join(homedir(), ".claude", "usage-data", "report.html"));
  return (
    <div className="page">
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <Breadcrumb crumbs={[{ label: "Dashboard", href: "/" }, { label: "Insights" }]} />
        <InsightsClient reportExists={exists} />
      </div>
    </div>
  );
}
