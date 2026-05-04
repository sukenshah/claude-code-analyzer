import { readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import Link from "next/link";
import { Breadcrumb } from "@/components/Breadcrumb";

export default function PlansPage() {
  const plansDir = join(homedir(), ".claude", "plans");
  let plans: { name: string; size: number; mtime: Date }[] = [];
  try {
    plans = readdirSync(plansDir)
      .filter((f) => f.endsWith(".md"))
      .map((name) => {
        const stat = statSync(join(plansDir, name));
        return { name, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  } catch { /* dir missing or unreadable */ }

  return (
    <div className="page">
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <Breadcrumb crumbs={[{ label: "Dashboard", href: "/" }, { label: "Plans" }]} />
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Modified</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.name}>
                  <td>
                    <Link href={`/plans/${encodeURIComponent(p.name)}`} className="link">
                      {p.name.replace(/\.md$/, "")}
                    </Link>
                  </td>
                  <td>{p.mtime.toLocaleDateString()}</td>
                  <td>{(p.size / 1024).toFixed(1)} KB</td>
                </tr>
              ))}
              {plans.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ textAlign: "center", color: "var(--text-muted)" }}>
                    No plans found in ~/.claude/plans/
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
