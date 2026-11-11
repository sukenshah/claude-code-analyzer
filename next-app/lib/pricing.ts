import { simulateCost as coreSimulateCost } from "@claude-analyzer/analyzer/cost";

export interface TokenUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function simulateCost(usage: TokenUsageLike, model: string): number {
  return coreSimulateCost(usage as Parameters<typeof coreSimulateCost>[0], model);
}

export interface CompareOption {
  id: string;
  label: string;
}

export const COMPARE_MODELS: CompareOption[] = [
  { id: "claude-haiku-5-5",  label: "Haiku 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-opus-5-5",   label: "Opus 5.5" },
  { id: "claude-fable-5-2",  label: "Fable 5.2" },
];
