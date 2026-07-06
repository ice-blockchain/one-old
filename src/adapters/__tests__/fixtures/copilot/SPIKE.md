# Copilot hook I/O spike (Phase 0)

Copilot CLI was not available in the maintainer CI environment at spike time. Wire shapes below are taken from official docs and drive adapter fixtures + unit tests. Re-validate on a machine with `copilot plugin install` and VS Code Copilot before tightening model gates.

## Surfaces

| Surface | Install | Hook config |
|---------|---------|-------------|
| Copilot CLI | `copilot plugin install <plugin-dir>` | `hooks/hooks-copilot.json` in plugin |
| VS Code | Customizations → Plugins → folder | Same plugin tree |

## Input (shared)

- `hook_event_name` / `hookEventName`: PascalCase or camelCase
- `tool_name` / `toolName`: e.g. `bash`, `edit`, `view`
- `tool_args` / `toolArgs`: JSON **string** on CLI (parse before reading fields)
- `workspace_roots` / `workspaceRoots`: VS Code workspace boundary
- `cwd`: working directory when present

## Output (diverges by surface)

### Copilot CLI (flat)

SessionStart / context:

```json
{ "additionalContext": "..." }
```

PreToolUse deny:

```json
{
  "permissionDecision": "deny",
  "permissionDecisionReason": "blocked reason",
  "additionalContext": "optional context"
}
```

### VS Code (hookSpecificOutput wrapper)

Same semantics as Claude Code nested shape:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "..."
  }
}
```

PreToolUse deny:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "blocked reason"
  }
}
```

## PLUGIN_ROOT

Emitted hooks use `cwd: "${PLUGIN_ROOT}"` and optional:

```json
"env": { "TRAFFIC_ONE_PLUGIN_ROOT": "${PLUGIN_ROOT}" }
```

`COPILOT_PLUGIN_ROOT` is **not** assumed until confirmed on a live install.

## Model slugs

Placeholder tier families in config (`claude-opus-4-8`, `claude-sonnet-4-6`, `gpt-5.4-mini`) — validate via `/model` on target Copilot build before strict agent-model enforcement.
