"use client";

import { useRouter } from "next/navigation";

export function InsightsClient({ reportExists }: { reportExists: boolean }) {
  const router = useRouter();

  if (!reportExists) {
    return (
      <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
        <p style={{ color: "var(--text2)", marginBottom: 16 }}>
          No insights report found. Run <code>/insights</code> in any Claude Code session to generate one.
        </p>
        <button className="btn-secondary" onClick={() => router.refresh()}>
          Check again
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button className="btn-secondary" onClick={() => router.refresh()}>
          Refresh
        </button>
      </div>
      <iframe
        src="/api/insights/report"
        style={{
          width: "100%",
          height: "85vh",
          border: "none",
          borderRadius: "var(--radius)",
        }}
        title="Claude Code Insights"
      />
    </div>
  );
}
