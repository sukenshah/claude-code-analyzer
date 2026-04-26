import { useState, useRef } from "react";
import type { DailyStats } from "../types.js";

interface Props {
  data: DailyStats[];
  width?: number;
  height?: number;
}

const PAD_LEFT = 8;
const PAD_RIGHT = 8;

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export function Sparkline({ data, width = 300, height = 60 }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (data.length < 2) return null;

  const maxCost = Math.max(...data.map((d) => d.cost));
  if (maxCost === 0) return null;

  const plotW = width - PAD_LEFT - PAD_RIGHT;

  const coords = data.map((d, i) => ({
    x: PAD_LEFT + (i / (data.length - 1)) * plotW,
    y: height - (d.cost / maxCost) * (height - 8) - 4,
  }));

  const polyline = coords.map((p) => `${p.x},${p.y}`).join(" ");
  const areaPoints = `${PAD_LEFT},${height} ${polyline} ${PAD_LEFT + plotW},${height}`;

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let closest = 0;
    let minDist = Infinity;
    coords.forEach((p, i) => {
      const d = Math.abs(p.x - mx);
      if (d < minDist) { minDist = d; closest = i; }
    });
    setHovered(closest);
  }

  const tip = hovered !== null ? data[hovered] : null;
  const tipCoord = hovered !== null ? coords[hovered] : null;

  // Clamp tooltip left edge so it stays within chart width
  const TIP_W = 160;
  const tipLeft = tipCoord
    ? Math.min(Math.max(tipCoord.x - TIP_W / 2, 0), width - TIP_W)
    : 0;

  return (
    <div style={{ position: "relative", width }}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        className="sparkline"
        style={{ cursor: "crosshair", display: "block" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHovered(null)}
      >
        <defs>
          <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4f8ef7" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#4f8ef7" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        <polygon points={areaPoints} fill="url(#sparkGrad)" />
        <polyline points={polyline} fill="none" stroke="#4f8ef7" strokeWidth="1.5" />

        {tipCoord && (
          <>
            <line
              x1={tipCoord.x} y1={0}
              x2={tipCoord.x} y2={height}
              stroke="#4f8ef7" strokeWidth="1" strokeDasharray="3 3" opacity="0.5"
            />
            <circle cx={tipCoord.x} cy={tipCoord.y} r="4" fill="#4f8ef7" />
          </>
        )}
      </svg>

      {/* Tooltip rendered below the chart — never overlaps it */}
      <div className="sparkline-dates">
        {tip ? (
          <div className="spark-tooltip">
            <div className="spark-tooltip-header">
              <span className="spark-tooltip-date">{tip.date}</span>
              <span className="spark-tooltip-cost">${tip.cost.toFixed(4)}</span>
            </div>
            <div className="spark-tooltip-tokens">
              <span style={{ color: "#4f8ef7" }}>In {fmtK(tip.input_tokens)}</span>
              <span style={{ color: "#4ecb71" }}>Out {fmtK(tip.output_tokens)}</span>
              <span style={{ color: "#a78bfa" }}>↩ {fmtK(tip.cache_read_input_tokens)}</span>
              <span style={{ color: "#fb923c" }}>↪ {fmtK(tip.cache_creation_input_tokens)}</span>
            </div>
          </div>
        ) : (
          <>
            <span>{data[0]?.date}</span>
            <span>{data[data.length - 1]?.date}</span>
          </>
        )}
      </div>
    </div>
  );
}
