"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AppConfig } from "@/lib/types";

export function ConfigBanner({ onConfigured }: { onConfigured: () => void }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [inputPath, setInputPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.config().then((c) => {
      setConfig(c);
      if (c.claudeProjectsDir) setInputPath(c.claudeProjectsDir);
    }).catch(() => { /* server not yet ready */ });
  }, []);

  if (!config || config.found) return null;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const path = inputPath.trim();
    if (!path) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveConfig(path);
      const updated = await api.config();
      setConfig(updated);
      if (updated.found) onConfigured();
      else setError("Directory saved but no Claude Code session files found there. Check the path and try again.");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  const platformHint = config.candidates.length > 0
    ? `Common locations: ${config.candidates.join(", ")}`
    : null;

  return (
    <div className="config-banner">
      <div className="config-banner-inner">
        <div className="config-banner-icon">⚠</div>
        <div className="config-banner-body">
          <p className="config-banner-title">Claude Code session data not found</p>
          <p className="config-banner-desc">
            No session files were detected in the default location(s). Enter the path to your{" "}
            <code>.claude/projects</code> directory, or set the{" "}
            <code>CLAUDE_DATA_DIR</code> environment variable before starting the server.
          </p>
          {platformHint && <p className="config-banner-hint">{platformHint}</p>}
          <form className="config-banner-form" onSubmit={handleSave}>
            <input
              className="config-banner-input"
              type="text"
              value={inputPath}
              onChange={(e) => setInputPath(e.target.value)}
              placeholder="/path/to/.claude/projects"
              spellCheck={false}
            />
            <button className="btn-primary" type="submit" disabled={saving || !inputPath.trim()}>
              {saving ? "Saving…" : "Save"}
            </button>
          </form>
          {error && <p className="config-banner-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
