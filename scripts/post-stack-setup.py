#!/usr/bin/env python3
"""traffic-one PostToolUse hook (Write|Edit).

Fires after every Write/Edit. Fast-exits unless the file just written is
`.traffic-one.json` with `onboardingComplete: true`. When it matches, runs the
detect-project bundle packer and injects the full stack rule bundle as
`additionalContext` — so the model gets stack rules immediately, without a
session restart.

This is the seamless-onboarding glue: the model writes the config, the hook
delivers the rule bundle, the very next tool call has the rules in context.
"""

import json
import os
import pathlib
import subprocess
import sys


# Read the tool-call payload from stdin
try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

fp = payload.get("tool_input", {}).get("file_path", "")

# Fast exit — only fire when the state file is the one just written
if not fp.endswith(".traffic-one.json"):
    sys.exit(0)

state_path = pathlib.Path(fp)
if not state_path.exists():
    sys.exit(0)

# Only fire when onboarding has just completed
try:
    state = json.loads(state_path.read_text())
except Exception:
    sys.exit(0)

if not state.get("onboardingComplete"):
    sys.exit(0)

stack = state.get("stack", "(unknown)")

# Re-run detect-project from the project root to get the packed bundle
plugin_root = pathlib.Path(__file__).resolve().parent.parent
detect_script = plugin_root / "scripts" / "detect-project.py"

res = subprocess.run(
    ["python3", str(detect_script)],
    capture_output=True,
    text=True,
    cwd=str(state_path.parent),
)
if res.returncode != 0:
    sys.exit(0)

try:
    parsed = json.loads(res.stdout)
    bundle = parsed["hookSpecificOutput"]["additionalContext"]
except Exception:
    sys.exit(0)

# Replace the SessionStart-style header with a PostToolUse-friendly one so the
# model knows these are "newly arrived" rules, not the original SessionStart
# context that's been there since turn 1.
banner = (
    f"═══ traffic-one — stack rules now active ({stack}) ═══\n"
    f"Continue with the user's request applying these rules. No restart needed.\n\n"
)
# Strip the original wrapper header (first 3-4 lines) and prepend our banner
lines = bundle.splitlines()
# Drop until first "# ── rules/" header (skip wrapper)
for i, line in enumerate(lines):
    if line.startswith("# ── rules/"):
        bundle_body = "\n".join(lines[i:])
        break
else:
    bundle_body = bundle

context = banner + bundle_body

print(json.dumps({
    "systemMessage": f"traffic-one rules loaded for stack: {stack} (no restart needed)",
    "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": context,
    },
}))
