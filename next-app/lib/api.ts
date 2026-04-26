import type { GlobalSummary, ProjectSummary, ProjectDetail, SessionDetail, ActiveSession, RawMessage, AppConfig } from "./types";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  summary: () => get<GlobalSummary>("/api/summary"),
  projects: () => get<ProjectSummary[]>("/api/projects"),
  project: (key: string) => get<ProjectDetail>(`/api/projects/${encodeURIComponent(key)}`),
  session: (id: string) => get<SessionDetail>(`/api/sessions/${id}`),
  sessionMessages: (id: string) => get<RawMessage[]>(`/api/sessions/${id}/messages`),
  refresh: () => fetch("/api/refresh", { method: "POST" }).then((r) => r.json()),
  activeSessions: () => get<ActiveSession[]>("/api/active-sessions"),
  config: () => get<AppConfig>("/api/config"),
  saveConfig: (claudeProjectsDir: string) =>
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claudeProjectsDir }),
    }).then((r) => r.json() as Promise<{ ok: boolean }>),
};

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtCost(usd: number): string {
  if (usd < 0.005) return `<$0.01`;
  return `$${usd.toFixed(2)}`;
}

export function totalTokens(usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }): number {
  return usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
}
