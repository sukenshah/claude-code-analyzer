#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/packages/mcp/dist/http.js"
PORT="${MCP_HTTP_PORT:-3456}"
WITH_DASHBOARD=false
[[ "${1:-}" == "--with-dashboard" ]] && WITH_DASHBOARD=true

# ── Prerequisites ─────────────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "Error: Node.js not found. Install from https://nodejs.org" >&2
  exit 1
fi

# ── Build if stale or missing ─────────────────────────────────────────────────

needs_build() {
  [[ ! -f "$DIST" ]] && return 0
  find "$ROOT/packages/mcp/src" "$ROOT/packages/analyzer/src" -name "*.ts" -newer "$DIST" \
    | grep -q . && return 0
  return 1
}

if needs_build; then
  echo "==> Building..."
  (cd "$ROOT" && npm install --silent && npm run build)
  echo "==> Build complete."
  echo ""
fi

# ── Cleanup on exit ───────────────────────────────────────────────────────────

SERVER_PID=""
NEXT_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  [[ -n "$NEXT_PID" ]] && kill "$NEXT_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Register stdio MCP in global Claude settings ─────────────────────────────

STDIO_DIST="$ROOT/packages/mcp/dist/index.js"
CLAUDE_JSON="$HOME/.claude.json"

configure_global_mcp() {
  ENTRY_ARG="$STDIO_DIST" \
  SETTINGS_PATH="$CLAUDE_JSON" \
  node - <<'JSEOF'
const fs = require('fs');
const settingsPath = process.env.SETTINGS_PATH;
const entry = { type: 'stdio', command: 'node', args: [process.env.ENTRY_ARG], env: {} };

let config = {};
try { config = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

if (!config.mcpServers) config.mcpServers = {};
const existing = config.mcpServers['usage-analyzer'];
if (existing && existing.args?.[0] === entry.args[0]) {
  process.stdout.write('already_configured\n');
  process.exit(0);
}
config.mcpServers['usage-analyzer'] = entry;
fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n');
process.stdout.write('configured\n');
JSEOF
}

if [[ -f "$CLAUDE_JSON" ]]; then
  result=$(configure_global_mcp)
  if [[ "$result" == "configured" ]]; then
    echo "==> Registered usage-analyzer in $CLAUDE_JSON"
    echo "    Restart Claude Code to pick up the new MCP server."
    echo ""
  fi
else
  echo "Warning: $CLAUDE_JSON not found — skipping global MCP registration." >&2
  echo ""
fi

# ── Start MCP HTTP server ─────────────────────────────────────────────────────

MCP_HTTP_PORT="$PORT" node "$DIST" &
SERVER_PID=$!

# Give it a moment then verify it's running
sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "Error: MCP server failed to start." >&2
  exit 1
fi

echo "==> MCP server running on port $PORT (local only)"
echo "    For Claude Code: MCP is registered globally via ~/.claude.json"
echo ""

# ── Next.js dashboard (optional) ─────────────────────────────────────────────

if $WITH_DASHBOARD; then
  echo "==> Starting Next.js dashboard..."
  (cd "$ROOT" && npm run start -w next-app) &
  NEXT_PID=$!
  sleep 2
  if kill -0 "$NEXT_PID" 2>/dev/null; then
    echo "==> Dashboard running at http://localhost:3737"
    echo ""
  else
    echo "Warning: Next.js dashboard failed to start." >&2
  fi
fi

echo "Press Ctrl+C to stop."
echo ""

wait "$SERVER_PID"
