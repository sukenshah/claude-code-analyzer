"use client";

import { useState, useRef, useEffect } from "react";
import { PLANS, Plan, PlanId } from "@/hooks/usePlan";

interface Props {
  plan: Plan;
  onPlanChange: (id: PlanId) => void;
  autoRefresh: 0 | 120 | 300 | 600;
  onAutoRefreshChange: (v: 0 | 120 | 300 | 600) => void;
  onRefresh: () => void;
  refreshing: boolean;
  countdown: number;
}

function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

export function NavRefreshPopover({ plan, onPlanChange, autoRefresh, onAutoRefreshChange, onRefresh, refreshing, countdown }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn-theme"
        onClick={() => setOpen((v) => !v)}
        aria-label="Refresh settings"
        title="Refresh settings"
      >
        <RefreshIcon />
      </button>
      {open && (
        <div className="refresh-popover">
          <select
            className="plan-select"
            value={plan.id}
            onChange={(e) => onPlanChange(e.target.value as PlanId)}
            aria-label="Claude plan"
          >
            {PLANS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <div className="btn-group" role="group" aria-label="Auto-refresh interval">
            {([0, 120, 300, 600] as const).map((interval) => (
              <button
                key={interval}
                className={`btn-interval ${autoRefresh === interval ? "active" : ""}`}
                onClick={() => onAutoRefreshChange(interval)}
              >
                {interval === 0 ? "Manual" : `${interval / 60}m`}
              </button>
            ))}
          </div>
          <button className="btn-secondary" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : countdown > 0 ? `Refresh (${countdown}s)` : "Refresh"}
          </button>
        </div>
      )}
    </div>
  );
}
