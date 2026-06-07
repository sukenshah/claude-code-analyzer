# Claude Code Usage Analyzer

Local app to inspect Claude Code JSONL session logs for token usage and cost per session, per prompt, and per project.

## Working Style

## Exploration Discipline
- Before running multiple bash/Read commands to explore, state your hypothesis and the minimum commands needed
- If the user asks for analysis based on existing context, answer from context first — do not re-read files unless necessary

## Project Memory MCP
- ALWAYS use the project-memory MCP tools to list/save insights — do NOT query the DB directly or use ToolSearch
- If project-memory MCP tools are unavailable, STOP and report the server health issue rather than attempting workarounds
- After adding a new tool to an MCP server, the server MUST be reloaded before the tool can be used

## Architecture

```
packages/analyzer/   Core JSONL parser + SQLite cache (~/.claude-analyzer/cache.db)
packages/mcp/        MCP server (11 tools, stdio transport)
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
- `get_spend_trend` — daily burn rate, week-over-week, projected monthly spend
- `get_model_breakdown` — cost/token share per model + cross-model cost simulator
- `get_session_quality` — success rate, friction, distributions, feature adoption, friction notes (reads facet/session-meta files)
- `get_compaction_stats` — compaction frequency, tokens lost, triggers, compacted-vs-not cost
- `get_context_limit_stats` — context-limit hits, CLAUDE.md token cost per session, top offending sessions
- `get_active_sessions` — currently-running sessions (modified within threshold)
- `refresh_cache` — re-scan JSONL files

## Skill

`/usage-report` — invoke from any Claude Code session to get a cost report. Requires the `usage-analyzer` MCP to be configured.

## Data sources

JSONL files read from `~/.claude/projects/`. Cache stored at `~/.claude-analyzer/cache.db`. Only changed files (by mtime + size) are re-parsed on subsequent runs.

## Glossary

- **Cache efficiency**: ratio of cache-read tokens to total input tokens for a session; higher means cheaper per-token cost, driven by prompt caching and CLAUDE.md size.
- **CLAUDE.md overhead**: estimated token cost that project CLAUDE.md files add to every session's context, computed from char count via `CHARS_PER_TOKEN` (3.5).
- **Compaction**: automatic context-window compression triggered when context fills; each `CompactEvent` records trigger, tokens before/after, and duration. Treated as context-management friction.
- **Context-limit hit**: a session event where the context window maxed out ("you've hit your limit"); counted per session as a difficulty/overhead signal.
- **Entrypoint**: how a session was started (e.g. CLI command, a specific skill), extracted into session metadata for classification.
- **Facet**: session-quality data Claude Code writes to `~/.claude/usage-data/facets/` — outcome, helpfulness, session type, friction types, primary success, summary. Source for all quality metrics.
- **Feature adoption**: share of sessions that used a given Claude Code capability (subagents, MCP tools, web search/fetch); an ecosystem-maturity metric.
- **Friction**: a quality dimension capturing impediments hit during a session (tooling, UX, refusals), tracked as friction counts + detail from facets.
- **Helpfulness**: a subjective Claude-helpfulness rating pulled from facets (`claude_helpfulness`), complementing Outcome as a perceived-value signal.
- **Interruption**: a user interrupting Claude mid-session, counted from session-meta as an interaction-friction signal.
- **Model breakdown**: cost/token share per model plus a cross-model cost simulator ("what if this ran on Sonnet instead").
- **Outcome**: a session's goal achievement, one of `fully_achieved` / `mostly_achieved` / `partially_achieved` / `not_achieved` / `unclear_from_transcript`; `fully`+`mostly` count as ACHIEVED for success rate.
- **Permission mode**: the permission-handling mode active during a session (e.g. allow/prompt/deny), captured in session metadata.
- **Project**: a top-level grouping = one Claude Code workspace/directory; aggregates its sessions and tracks cost, CLAUDE.md files, and context-limit hits. Project key derived from the `~/.claude/projects/` directory name.
- **Session**: one conversation context within a project; aggregates turns and session-level metrics (compaction events, limit hits, subagent presence).
- **Session quality**: the composite of success rate, friction, interruptions, outcome/helpfulness distributions, and feature adoption derived from facet + session-meta files.
- **SessionMeta**: metadata parsed from a session log's headers — AI title, entrypoint, git branch, permission mode, version, MCP tools, tool-call counts, compaction events, limit-hit count.
- **Spend trend**: daily burn rate with week-over-week change and projected monthly spend.
- **Subagent**: a task-agent spawned within a session (`isSubagent` / `agentId` on turns); its turns roll up to the parent session.
- **Turn**: a single user↔assistant exchange within a session; the atomic record carrying model, token usage, cost, and subagent attribution.
