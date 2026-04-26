import type { TokenUsage } from "../types.js";
import { fmtTokens, fmtCost } from "../api.js";

interface Props {
  usage: TokenUsage;
  costs?: { inputCost: number; outputCost: number; cacheWriteCost: number; cacheReadCost: number };
  height?: number;
}

const SEGMENTS = [
  { key: "input_tokens" as const,                label: "Input",        color: "#4f8ef7" },
  { key: "output_tokens" as const,               label: "Output",       color: "#4ecb71" },
  { key: "cache_read_input_tokens" as const,     label: "Cache Read",   color: "#a78bfa" },
  { key: "cache_creation_input_tokens" as const, label: "Cache Write",  color: "#fb923c" },
];

export function TokenBar({ usage, costs, height = 24 }: Props) {
  const total = SEGMENTS.reduce((sum, s) => sum + usage[s.key], 0);
  if (total === 0) return <div className="token-bar-empty">No tokens</div>;

  return (
    <div className="token-bar-container">
      <div className="token-bar" style={{ height }}>
        {SEGMENTS.map((seg) => {
          const val = usage[seg.key];
          const pct = (val / total) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={seg.key}
              className="token-bar-segment"
              style={{ width: `${pct}%`, background: seg.color }}
              title={`${seg.label}: ${fmtTokens(val)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <div className="token-bar-legend">
        {SEGMENTS.map((seg) => {
          const val = usage[seg.key];
          if (!val) return null;
          const costVal = costs
            ? seg.key === "input_tokens" ? costs.inputCost
            : seg.key === "output_tokens" ? costs.outputCost
            : seg.key === "cache_creation_input_tokens" ? costs.cacheWriteCost
            : costs.cacheReadCost
            : null;
          return (
            <span key={seg.key} className="legend-item">
              <span className="legend-dot" style={{ background: seg.color }} />
              {seg.label}: {fmtTokens(val)}
              {costVal != null && <span className="legend-cost"> ({fmtCost(costVal)})</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
