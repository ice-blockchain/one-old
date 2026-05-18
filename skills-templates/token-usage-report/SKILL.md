---
name: token-usage-report
description: Use when the user asks about token usage, cost, billing, "how many tokens did we use", "show token report", "where are tokens going", "token breakdown by subagent", "which phase spent most tokens", or wants an analysis of cache hit rate, subagent costs, or per-tool tokens. Produces an exact breakdown by phase/role/tool from Claude Code's on-disk transcripts. Also covers the opt-in TRAFFIC_ONE_TOKEN_LOG=1 env var for in-flight per-tool logging.
metadata:
  type: skill
  source: traffic-one
---

# Token usage report

Generates an exact token-usage breakdown for the current Claude Code session
(or any past session in this project). Parses the authoritative transcripts
under `~/.claude/projects/<slug>/` — same data the Anthropic console bills
from — and groups by main agent + each subagent, by role, by tool, and by
model. Reports cache hit rate and an estimated cost.

## When to invoke

Trigger on phrases like:

- "how many tokens did we use"
- "show token usage / token report / token breakdown"
- "which phase spent the most tokens"
- "how much did the orchestrator cost"
- "what's our cache hit rate"
- "where are tokens going"
- "tokens by subagent"

## How to run

```bash
# Latest session for the current project (auto-detects from cwd)
node "$CLAUDE_PLUGIN_ROOT/scripts/token-report.cjs"

# Specific session
node "$CLAUDE_PLUGIN_ROOT/scripts/token-report.cjs" --session <session-id>

# All sessions for the project
node "$CLAUDE_PLUGIN_ROOT/scripts/token-report.cjs" --all

# JSON output (machine-readable)
node "$CLAUDE_PLUGIN_ROOT/scripts/token-report.cjs" --json

# Save to file
node "$CLAUDE_PLUGIN_ROOT/scripts/token-report.cjs" --out .traffic-one/reports/tokens.md
```

When `$CLAUDE_PLUGIN_ROOT` is not set, use the absolute path that
`/Users/<you>/.claude/plugins/cache/...` resolves to, or run the script
from the plugin source.

## What the report contains

- **Totals**: total tokens, input/cache-write/cache-read/output split, cache
  hit rate, message count, tool-use count, estimated cost.
- **By phase / role**: main agent (parent transcript) + each subagent spawn
  (one row per `subagents/agent-*.jsonl`), attributed by the `agentType`
  recorded in the matching `.meta.json`.
- **By role aggregated**: collapses multiple spawns of the same role.
- **Tool calls**: total invocations of each tool across all phases.
- **By model**: per-model totals and cost estimates.
- **Notes**: largest single message, subagent spawn count, source pointer.

## Optional: in-flight per-tool log (`TRAFFIC_ONE_TOKEN_LOG=1`)

For real-time visibility into per-tool byte counts and phase attribution,
set the env var before starting Claude Code:

```bash
export TRAFFIC_ONE_TOKEN_LOG=1
```

When enabled, the PostToolUse hook appends one JSONL line per Bash / Write /
Edit call to `.traffic-one/token-log.jsonl`:

```json
{"ts":"2026-05-17T12:00:00.000Z","runId":"2026-05-17T11-58-00Z","role":"senior-frontend","hookEvent":"PostToolUse","toolName":"Write","inputBytes":1842,"outputBytes":215,"estTokens":515}
```

The log is complementary to the transcript-based report: transcripts give
billed-token ground truth, the log gives per-tool byte-level attribution and
the role context at the moment of each call.

The log appends only. To rotate, simply delete the file.

## Output

Default output is markdown printed to stdout. Suggest the user pipe to a
file (`--out .traffic-one/reports/tokens-<date>.md`) for archiving. When
JSON is requested, the script emits a structured object suitable for
further analysis or dashboarding.

## What to do with the numbers

When token totals are high, follow up with one or more of:

- **High cache hit rate (>80%)** + high total → bulk of cost is cache reads
  (~10% list price); not necessarily a problem. Consider reducing total
  number of API calls (fewer subagent spawns, shorter turns).
- **Low cache hit rate (<50%)** → cache is being invalidated between turns.
  Check for hook output that grows per-turn (PostToolUse re-pack, etc.).
- **One subagent dominates** → its role-scoped rule set may be too broad,
  or it's doing repeated file reads. Inspect its `subagents/agent-*.jsonl`
  for the largest tool outputs.
- **Output-token spike** → look for very long model responses; consider
  breaking into smaller steps.
