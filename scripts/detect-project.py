#!/usr/bin/env python3
"""
traffic-one SessionStart hook.

Responsibilities on every session start:
  1. Detect project mode (new-project / existing-codebase / existing-with-supabase).
  2. Load or ask for the user's stack preference.
  3. Pack the right rule files into additionalContext, capped at ~9500 chars
     (the hook total is limited to 10,000 chars — leave ~500 for mode + wrapper).

State file — `.traffic-one.json` at the project root. Pinned across sessions.
Legacy `.claude-plugin-mode` is migrated on first read. File is gitignored.
"""

import datetime
import json
import os
import pathlib


# ── Constants ────────────────────────────────────────────────────────────────
STATE_FILE         = ".traffic-one.json"
LEGACY_LOCK_FILE   = ".claude-plugin-mode"
BUDGET_CHARS       = 9500          # leave headroom under the 10k cap
STATE_VERSION      = 2


# ── Stack registry ───────────────────────────────────────────────────────────
# Each stack lists rule files in descending priority order. The packer keeps
# adding files until it would exceed BUDGET_CHARS, then stops. Files late in
# the list may be dropped if the total would overflow.
STACKS = {
    "react-realtime-monorepo": {
        "label": "React + Supabase monorepo: Turborepo + RTK + RTK Query + zustand + vanilla-extract + Jest + Playwright (recommended default; Ionic/Capacitor mobile packaging available)",
        # Always loaded — the model needs these to know the stack and rules of the road.
        "mandatory": [
            "rules/core.md",                    # framework-agnostic project core
            "rules/common/clean-code.md",
            "rules/common/execution-discipline.md",
            "rules/common/security.md",
            "rules/frontend/react/core.md",     # React-web stack core (forced libs + absolute rules)
            "rules/frontend/ionic/core.md",     # Hybrid-mobile stack core (Ionic + Capacitor)
        ],
        # Filled in priority order until budget is hit; the rest defer to path-scoped attach.
        "optional": [
            "rules/frontend/accessibility.md",
            "rules/frontend/performance.md",
            "rules/frontend/realtime.md",
            "rules/frontend/services.md",
            "rules/frontend/testing.md",
            "rules/frontend/ionic/capacitor.md",
            "rules/frontend/ionic/navigation.md",
            "rules/frontend/ionic/components.md",
            "rules/frontend/ionic/styles.md",
            "rules/frontend/ionic/services.md",
            "rules/frontend/ionic/stores.md",
            "rules/frontend/ionic/realtime.md",
            "rules/frontend/ionic/performance.md",
            "rules/frontend/ionic/security.md",
            "rules/frontend/ionic/testing.md",
            "rules/frontend/ionic/accessibility.md",
            "rules/frontend/react/components.md",
            "rules/frontend/react/stores.md",
            "rules/frontend/react/services.md",
            "rules/frontend/react/realtime.md",
            "rules/frontend/react/performance.md",
            "rules/frontend/react/testing.md",
            "rules/frontend/react/security.md",
        ],
    },
    "react-frontend-only": {
        "label": "Single-app React: Vite + RTK + vanilla-extract (no backend, no monorepo; Ionic/Capacitor mobile packaging available)",
        "mandatory": [
            "rules/core.md",
            "rules/common/clean-code.md",
            "rules/common/execution-discipline.md",
            "rules/common/security.md",
            "rules/frontend/react/core.md",
            "rules/frontend/ionic/core.md",
        ],
        "optional": [
            "rules/frontend/accessibility.md",
            "rules/frontend/performance.md",
            "rules/frontend/services.md",
            "rules/frontend/testing.md",
            "rules/frontend/ionic/capacitor.md",
            "rules/frontend/ionic/navigation.md",
            "rules/frontend/ionic/components.md",
            "rules/frontend/ionic/styles.md",
            "rules/frontend/ionic/services.md",
            "rules/frontend/ionic/stores.md",
            "rules/frontend/ionic/realtime.md",
            "rules/frontend/ionic/performance.md",
            "rules/frontend/ionic/security.md",
            "rules/frontend/ionic/testing.md",
            "rules/frontend/ionic/accessibility.md",
            "rules/frontend/react/components.md",
            "rules/frontend/react/stores.md",
            "rules/frontend/react/services.md",
            "rules/frontend/react/performance.md",
            "rules/frontend/react/testing.md",
            "rules/frontend/react/security.md",
        ],
    },
    "react-native-expo-monorepo": {
        "label": "Expo React Native monorepo: apps/mobile + shared packages, Expo Router, RTK Query, zustand, Jest/RNTL, Maestro (explicit React Native / Expo only)",
        "mandatory": [
            "rules/core.md",
            "rules/common/clean-code.md",
            "rules/common/execution-discipline.md",
            "rules/common/security.md",
            "rules/frontend/react-native/core.md",
        ],
        "optional": [
            "rules/frontend/services.md",
            "rules/frontend/realtime.md",
            "rules/frontend/testing.md",
            "rules/frontend/react-native/navigation.md",
            "rules/frontend/react-native/components.md",
            "rules/frontend/react-native/styles.md",
            "rules/frontend/react-native/stores.md",
            "rules/frontend/react-native/services.md",
            "rules/frontend/react-native/realtime.md",
            "rules/frontend/react-native/performance.md",
            "rules/frontend/react-native/accessibility.md",
            "rules/frontend/react-native/testing.md",
            "rules/frontend/react-native/security.md",
        ],
    },
    "react-native-expo-app": {
        "label": "Single Expo React Native app: Expo Router, RTK Query, zustand, Jest/RNTL, Maestro (explicit React Native / Expo only)",
        "mandatory": [
            "rules/core.md",
            "rules/common/clean-code.md",
            "rules/common/execution-discipline.md",
            "rules/common/security.md",
            "rules/frontend/react-native/core.md",
        ],
        "optional": [
            "rules/frontend/services.md",
            "rules/frontend/testing.md",
            "rules/frontend/react-native/navigation.md",
            "rules/frontend/react-native/components.md",
            "rules/frontend/react-native/styles.md",
            "rules/frontend/react-native/stores.md",
            "rules/frontend/react-native/services.md",
            "rules/frontend/react-native/performance.md",
            "rules/frontend/react-native/accessibility.md",
            "rules/frontend/react-native/testing.md",
            "rules/frontend/react-native/security.md",
        ],
    },
    "node-backend": {
        "label": "Node + Postgres backend only",
        "mandatory": [
            "rules/core.md",
            "rules/common/clean-code.md",
            "rules/common/execution-discipline.md",
            "rules/common/security.md",
            "rules/backend/node.md",
            "rules/backend/postgres.md",
        ],
        "optional": [],
    },
    "minimal": {
        "label": "Clean-code + security + git baseline (no framework rules)",
        "mandatory": [
            "rules/common/clean-code.md",
            "rules/common/execution-discipline.md",
            "rules/common/security.md",
        ],
        "optional": [],
    },
}


# ── State I/O ────────────────────────────────────────────────────────────────
def read_state(cwd: pathlib.Path) -> dict:
    """Read .traffic-one.json; migrate legacy .claude-plugin-mode if present."""
    state_path = cwd / STATE_FILE
    if state_path.exists():
        try:
            return json.loads(state_path.read_text())
        except Exception:
            return {}
    # Legacy migration
    legacy = cwd / LEGACY_LOCK_FILE
    if legacy.exists():
        mode = legacy.read_text().strip()
        return {"version": STATE_VERSION, "mode": mode, "stack": None, "confirmed": False}
    return {}


def write_state(cwd: pathlib.Path, state: dict) -> None:
    state["version"] = STATE_VERSION
    (cwd / STATE_FILE).write_text(json.dumps(state, indent=2))


# ── Detection ────────────────────────────────────────────────────────────────
def load_package_json(cwd: pathlib.Path) -> dict:
    pkg = cwd / "package.json"
    if not pkg.exists():
        return {}
    try:
        return json.loads(pkg.read_text())
    except Exception:
        return {}


def count_source_files(cwd: pathlib.Path) -> int:
    count = 0
    for ext in ("*.tsx", "*.ts", "*.jsx", "*.js"):
        for f in cwd.rglob(ext):
            if "node_modules" not in str(f) and ".git" not in str(f):
                count += 1
    return count


def has_supabase(deps: dict) -> bool:
    return any(p in deps for p in ("@supabase/supabase-js", "@supabase/ssr"))


def detect_mode(cwd: pathlib.Path) -> str:
    pkg        = load_package_json(cwd)
    deps       = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    file_count = count_source_files(cwd)
    if file_count <= 5:
        return "new-project"
    if has_supabase(deps):
        return "existing-with-supabase"
    return "existing-codebase"


# ── Rule packing ─────────────────────────────────────────────────────────────
def pack_bundle(
    plugin_root: pathlib.Path,
    mandatory: list[str],
    optional:  list[str],
    budget:    int,
) -> tuple[str, list[str], list[str]]:
    """Concatenate rule files. Mandatory files are ALWAYS included even if they
    push past the budget; optional files fill remaining headroom in priority order.

    Returns (body_text, included_files, dropped_files).
    """
    body_parts: list[str] = []
    included:   list[str] = []
    dropped:    list[str] = []
    total = 0

    # Phase 1 — mandatory: load all, regardless of budget
    for rel in mandatory:
        f = plugin_root / rel
        if not f.exists():
            continue
        content = f.read_text()
        header  = f"# ── {rel} ──\n"
        body_parts.append(header + content)
        included.append(rel)
        total += len(header) + len(content) + 2

    # Phase 2 — optional: fill until budget hit
    for rel in optional:
        f = plugin_root / rel
        if not f.exists():
            continue
        content = f.read_text()
        header  = f"# ── {rel} ──\n"
        addition_size = len(header) + len(content) + 2
        if total + addition_size > budget:
            dropped.append(rel)
            continue
        body_parts.append(header + content)
        included.append(rel)
        total += addition_size
    return "\n\n".join(body_parts), included, dropped


# ── Context blocks ───────────────────────────────────────────────────────────
MODE_SUMMARY = {
    "new-project": "[PLUGIN MODE: NEW PROJECT]  No significant codebase detected.",
    "existing-codebase": "[PLUGIN MODE: EXISTING CODEBASE]  Apply rules to NEW code only; do NOT restructure existing files.",
    "existing-with-supabase": "[PLUGIN MODE: EXISTING CODEBASE + SUPABASE]  Apply to new code only. Mention the Supabase-fork migration ONCE if relevant.",
}


def onboarding_directive(mode: str) -> str:
    """Tell the model to run a short guided setup on turn 1 and write the config itself."""
    lines = [
        "═══ traffic-one — FIRST-RUN ONBOARDING REQUIRED ═══",
        "",
        f"{MODE_SUMMARY[mode]}",
        "",
        "This project has no saved traffic-one configuration yet.",
        "YOUR FIRST MESSAGE in this session MUST be a short onboarding Q&A.",
        "Do NOT start coding, scaffolding, or answering the user's original request",
        "until onboarding is complete. Greet briefly, then ask the questions below,",
        "ONE AT A TIME, and write the user's answers into `.traffic-one.json` yourself",
        "using the Write tool. Do not ask the user to edit any JSON.",
        "",
        "── Question 1 — What are you building? ──",
        "Offer these five options verbatim, with A first and recommended by default:",
        "  A) React + Supabase app or platform (multi-app, monorepo) — Turborepo + RTK + RTK Query + zustand + vanilla-extract + Jest + Playwright  ← recommended/default",
        "  B) Single React frontend app (one app, no monorepo) — Vite + RTK + vanilla-extract",
        "  C) Expo React Native app in a monorepo — only if they explicitly want React Native / Expo; apps/mobile + shared packages + Expo Router + RTK Query + Jest/RNTL + Maestro",
        "  D) Single Expo React Native app — only if they explicitly want React Native / Expo; Expo Router + RTK Query + Jest/RNTL + Maestro",
        "  E) Minimal — clean-code / security / git baseline (any language)",
        "",
        "Recommend A unless the user clearly chooses another stack.",
        "",
        "If the user wants a mobile app or mobile variant of a React web product but does not explicitly ask for React Native / Expo, recommend Ionic Framework with Capacitor packaging and map to A or B based on monorepo needs. Apply the `ionic-mobile` skill after onboarding.",
        "",
        "Map the answer to `stack`, `backend`, and `realtime` defaults:",
        "  A → stack: react-realtime-monorepo, backend: supabase, realtime: ask Question 2",
        "  B → stack: react-frontend-only, backend: external-api, realtime: none",
        "  C → stack: react-native-expo-monorepo, backend: external-api, realtime: ask Question 2",
        "  D → stack: react-native-expo-app, backend: external-api, realtime: none",
        "  E → stack: minimal, backend: none, realtime: none",
        "",
        "── Question 2 (skip for B, D, and E) — Real-time / data layer? ──",
        "If user chose A or C, ask:",
        "  1) Heavy real-time UI (gameplay, live markets, trading) — strict WS rules, frame back-pressure, Storybook",
        "  2) Mostly REST with occasional live updates — keep WS rules but lighter",
        "  3) Pure REST — skip the WebSocket rule bundle (saves ~1k tokens)",
        "",
        "Map to `realtime`:",
        "  1 → heavy",
        "  2 → light",
        "  3 → none",
        "Keep the backend default from Question 1; A always uses `backend: \"supabase\"`.",
        "",
        "── After both answers: write `.traffic-one.json` ──",
        "Use the Write tool to create EXACTLY this JSON (filling in values):",
        "```json",
        "{",
        "  \"version\": 2,",
        f"  \"mode\": \"{mode}\",",
        "  \"stack\": \"<chosen-id>\",",
        "  \"backend\": \"<chosen-backend>\",",
        "  \"realtime\": \"<heavy|light|none>\",",
        "  \"confirmed\": true,",
        "  \"onboardingComplete\": true,",
        "  \"confirmedAt\": \"<current ISO-8601 UTC timestamp>\"",
        "}",
        "```",
        "",
        "── Then tell the user (one short line) ──",
        "Confirm which stack was saved and that you'll continue with their original request.",
        "DO NOT mention restarting Claude Code — a PostToolUse hook auto-loads the full stack",
        "rule bundle into the same session immediately after `.traffic-one.json` is written.",
        "Look for a system message like 'traffic-one rules loaded for stack: <id>' — once you",
        "see it, the stack rules are active. Use them on the very next action.",
        "",
        "Until onboarding is complete, the minimal baseline rules below are in effect.",
        "Do not invoke scaffolding skills (create-component, create-feature, etc.) until done.",
    ]
    return "\n".join(lines)


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    cwd         = pathlib.Path(os.getcwd())
    plugin_root = pathlib.Path(__file__).resolve().parent.parent
    state       = read_state(cwd)

    # ── Mode (detect once, pin) ─────────────────────────────────────────────
    mode = state.get("mode") or detect_mode(cwd)
    state["mode"] = mode

    # ── Stack selection ──────────────────────────────────────────────────────
    stack_id            = state.get("stack")
    onboarding_complete = bool(state.get("onboardingComplete"))

    if onboarding_complete and stack_id in STACKS:
        # Fast path: onboarding done; pack the chosen stack's bundle.
        spec = STACKS[stack_id]
        body, included, dropped = pack_bundle(
            plugin_root, spec["mandatory"], spec["optional"], BUDGET_CHARS,
        )
        header = (
            f"═══ traffic-one plugin — always-on rules (stack: {stack_id}) ═══\n"
            f"{MODE_SUMMARY[mode]}\n"
        )
        if dropped:
            header += f"[budget {len(body)}/{BUDGET_CHARS}; {len(dropped)} rule file(s) deferred to path-scoped attach]\n"
        context = f"{header}\n{body}"
    else:
        # Slow path: onboarding not done. Tell the model to run the Q&A on turn 1.
        directive = onboarding_directive(mode)
        spec      = STACKS["minimal"]
        body, included, _ = pack_bundle(
            plugin_root, spec["mandatory"], spec["optional"], BUDGET_CHARS // 2,
        )
        context = f"{directive}\n\n═══ Baseline rules (in effect until onboarding completes) ═══\n{body}"

    # Persist state (mode + any defaults initialized)
    write_state(cwd, state)

    # Emit hook output
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName":    "SessionStart",
            "additionalContext": context,
        }
    }))


if __name__ == "__main__":
    main()
