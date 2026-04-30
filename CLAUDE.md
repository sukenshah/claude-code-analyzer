# Claude Code Usage Analyzer

Local app to inspect Claude Code JSONL session logs for token usage and cost per session, per prompt, and per project.

## Architecture

```
packages/analyzer/   Core JSONL parser + SQLite cache (~/.claude-analyzer/cache.db)
packages/mcp/        MCP server (6 tools, stdio transport)
next-app/            Next.js app — API routes + React UI (localhost:3737)
```

## Running the app

```bash
# Install all deps
npm install

# Build everything
npm run build

# Start the Next.js dev server (single command)
npm run dev
# → http://localhost:3737
```

## MCP server

The `usage-analyzer` MCP is registered in `.mcp.json`. After `npm run build:mcp`, it's available as MCP tools in this project.

To use from another project, add to their `.mcp.json`:
```json
{
  "mcpServers": {
    "usage-analyzer": {
      "command": "node",
      "args": ["<COMPLETE_PATH_PARENT_DIRECTORY_OF_THE_REPO>/claude-code-analyzer/packages/mcp/dist/index.js"]
    }
  }
}
```

### Available MCP tools
- `get_usage_summary` — total tokens + cost, filterable by project and days
- `get_project_breakdown` — all projects ranked by cost/tokens/sessions
- `get_session_list` — sessions for a project
- `get_session_detail` — per-turn breakdown for a session
- `get_cost_forecast` — projected weekly/monthly cost
- `refresh_cache` — re-scan JSONL files

## Skill

`/usage-report` — invoke from any Claude Code session to get a cost report. Requires the `usage-analyzer` MCP to be configured.

## Data sources

JSONL files read from `~/.claude/projects/`. Cache stored at `~/.claude-analyzer/cache.db`. Only changed files (by mtime + size) are re-parsed on subsequent runs.
