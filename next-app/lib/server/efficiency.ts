import { buildEfficiencyInsights } from "@claude-analyzer/analyzer";
import type { EfficiencyInsights } from "@claude-analyzer/analyzer";
import { ensureLoaded } from "./cache";

export async function buildEfficiencyReport(): Promise<EfficiencyInsights> {
  const analysis = await ensureLoaded();
  return buildEfficiencyInsights(analysis.allTurns, analysis.sessions.values());
}
