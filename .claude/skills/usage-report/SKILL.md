---
name: usage-report
description: Show token usage and cost breakdown for Claude Code sessions. Use to check spending, identify expensive sessions, or see cache efficiency stats.
user-invocable: true
allowed-tools:
  - mcp__usage-analyzer__get_usage_summary
  - mcp__usage-analyzer__get_session_detail
  - mcp__usage-analyzer__get_project_breakdown
  - mcp__usage-analyzer__get_cost_forecast
---

# usage-report skill

Generate a concise usage report for the current Claude Code session and project.

## Steps

1. Call `get_usage_summary` with the current project name (derive from $CWD — take the last path segment). Use `days: 30`.

2. Call `get_project_breakdown` with `sort_by: "cost"` to see the relative spend across all projects.

3. Call `get_cost_forecast` with `days: 7` to get the weekly/monthly projection.

4. Format and present the report in this structure:

```
## Usage Report

**Project**: <project-name>
**Last 30 days**: <cost> across <N> sessions

**Token breakdown**:
- Input: <N>
- Output: <N>
- Cache read: <N> (<X>% hit rate)
- Cache write: <N>

**Cost forecast**:
- Avg daily: <cost>
- Projected monthly: <cost>

**All projects** (ranked by cost):
<table>

**Cache advice**: [Only include if cache_read << cache_creation]
> Your cache hit rate is low. Consider longer sessions or reusing context windows to benefit from prompt caching.
```

Keep the report tight — one screen. Skip sections that have no data.
