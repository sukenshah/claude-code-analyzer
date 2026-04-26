import { analyze } from "@claude-analyzer/analyzer";
import type { AnalysisResult } from "@claude-analyzer/analyzer";

let cachedResult: AnalysisResult | null = null;
let loading = false;

export async function ensureLoaded(force = false): Promise<AnalysisResult> {
  if (cachedResult && !force) return cachedResult;
  if (loading) {
    while (loading) await new Promise((r) => setTimeout(r, 50));
    return cachedResult!;
  }
  loading = true;
  try {
    cachedResult = await analyze(force);
  } finally {
    loading = false;
  }
  return cachedResult!;
}

export function invalidateCache() {
  cachedResult = null;
}
