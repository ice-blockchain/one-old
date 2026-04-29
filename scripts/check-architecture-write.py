#!/usr/bin/env python3
"""PreToolUse write/edit guard for traffic-one architecture constraints."""

from __future__ import annotations  # allow `str | None` on Python 3.9 (macOS system Python)

import json
import pathlib
import re
import sys


RN_STACKS = {"react-native-expo-monorepo", "react-native-expo-app"}


def read_stack() -> str | None:
    state_path = pathlib.Path(".traffic-one.json")
    if not state_path.exists():
        return None
    try:
        state = json.loads(state_path.read_text())
    except Exception:
        return None
    stack = state.get("stack")
    return stack if isinstance(stack, str) else None


def main() -> None:
    data = json.load(sys.stdin)
    tool_input = data.get("tool_input", {})
    file_path = tool_input.get("file_path", "")
    content = tool_input.get("content", "") or tool_input.get("new_string", "")
    stack = read_stack()
    is_native = stack in RN_STACKS

    violations: list[str] = []

    if re.search(r"(apps/[^/]+/)?src/pages/.*\.(service|store|hook|query|slice|api)\.(ts|tsx)$", file_path):
        violations.append("Service/store/hook/slice files belong in src/services/, src/features/<name>/, or packages/* — not in src/pages/.")

    if re.search(r"(apps/[^/]+/)?app/.*\.(service|store|hook|query|slice|api)\.(ts|tsx)$", file_path):
        violations.append("Expo Router route files must stay thin. Service/store/hook/slice files belong in src/features/, src/services/, or packages/*.")

    if re.search(r"(apps/[^/]+/)?src/[A-Z][a-zA-Z]+\.(tsx|ts)$", file_path):
        target = "src/components/, src/features/<name>/components/, or packages/ui-native/*" if is_native else "src/components/, src/features/<name>/components/, or packages/ui/*"
        violations.append(f"Components must live in {target} — not directly in src/.")

    feature_match = re.search(r"src/features/([^/]+)", file_path)
    if feature_match:
        current = feature_match.group(1)
        cross = [
            match
            for match in re.findall(r"from ['\"]@/features/([^/'\"]+)", content)
            if match != current
        ]
        if cross:
            violations.append(f"Cross-feature import detected ({current} -> {cross}). Share via packages/ui, packages/ui-native, packages/utils, or a feature-agnostic store slice.")

    if re.search(r"from ['\"]\.\./\.\./\.\./packages/", content):
        violations.append("Use the workspace package name (`@app/ui`, `@app/ui-native`, `@app/utils`) instead of a deep relative path across packages.")

    if file_path.endswith(".tsx") and re.search(r"(src|packages/(ui|ui-native))/(components|features|pages)/", file_path):
        if re.search(r"^export default ", content, re.MULTILINE):
            violations.append("Use named exports only for reusable components. Expo Router route files under app/ are the default-export exception.")

    if is_native:
        if file_path.endswith(".tsx") and "style={{" in content:
            violations.append("No inline object styles — define styles in a sibling .styles.ts file with StyleSheet.create.")
        if file_path.endswith(".tsx") and re.search(r"\b(div|span|button|a|input)\b", content):
            violations.append("React Native UI must use native primitives (`View`, `Text`, `Pressable`, `TextInput`, etc.), not DOM tags.")
        if file_path.endswith(".tsx") and re.search(r"className=\"[^\"]*(bg-|text-|p[xytrbl]?-|m[xytrbl]?-|flex\b|grid\b)", content):
            violations.append("NativeWind/Tailwind classes detected — this Expo stack uses StyleSheet.create and design tokens.")
    else:
        if file_path.endswith(".tsx") and "style={{" in content:
            violations.append("No inline styles — define styles in a sibling .css.ts file (vanilla-extract).")
        if file_path.endswith(".tsx") and re.search(r"className=\"[^\"]*\b(bg-|text-|p[xytrbl]?-|m[xytrbl]?-|flex\b|grid\b)[^\"]*\s+[^\"]*\b(bg-|text-|p[xytrbl]?-|m[xytrbl]?-|flex\b|grid\b)", content):
            violations.append("Tailwind utility classes detected — this stack uses vanilla-extract. Move styles into a .css.ts file.")

    if file_path.endswith((".ts", ".tsx")) and re.search(r":\s*any\b", content):
        violations.append("Avoid `any` — use `unknown` and narrow types, or define a discriminated union.")

    allowed_ws_paths = r"(packages/ws-client|src/services/ws)"
    if file_path.endswith((".ts", ".tsx")) and "new WebSocket(" in content and not re.search(allowed_ws_paths, file_path):
        violations.append("Open WebSocket connections only inside packages/ws-client/ or src/services/ws/. Components must subscribe via hooks.")

    if not violations:
        return

    reason = "traffic-one — architecture violation(s):\n" + "\n".join(f"  - {violation}" for violation in violations)
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


if __name__ == "__main__":
    main()
