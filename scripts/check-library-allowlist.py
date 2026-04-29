#!/usr/bin/env python3
"""PreToolUse install-command guard for traffic-one stacks."""

from __future__ import annotations  # allow `str | None` on Python 3.9 (macOS system Python)

import json
import pathlib
import re
import sys


INSTALL_RE = re.compile(r"(npm (install|i|add)|yarn add|pnpm add|bun add)")
RN_STACKS = {"react-native-expo-monorepo", "react-native-expo-app"}
WEB_STACKS = {"react-realtime-monorepo", "react-frontend-only"}


def read_state() -> dict:
    state_path = pathlib.Path(".traffic-one.json")
    if not state_path.exists():
        return {}
    try:
        return json.loads(state_path.read_text())
    except Exception:
        return {}


def read_stack(state: dict) -> str | None:
    stack = state.get("stack")
    return stack if isinstance(stack, str) else None


def package_json_has_next() -> bool:
    package_path = pathlib.Path("package.json")
    if not package_path.exists():
        return False
    try:
        package = json.loads(package_path.read_text())
    except Exception:
        return False
    deps = {
        **package.get("dependencies", {}),
        **package.get("devDependencies", {}),
    }
    return "next" in deps


def allows_nextjs(state: dict) -> bool:
    return state.get("frontend") == "nextjs" or package_json_has_next()


def forbidden_for_stack(stack: str | None, *, allow_nextjs: bool) -> list[tuple[str, str]]:
    common = [
        ("mobx", "Use Redux Toolkit for global business state and zustand for ephemeral UI state."),
        ("recoil", "Use Redux Toolkit for global business state and zustand for ephemeral UI state."),
        ("jotai", "Use Redux Toolkit for global business state and zustand for ephemeral UI state."),
        ("swr", "Use RTK Query for cached server state."),
        (r"(?<!tanstack/)(?<!\w)react-query(?!-)", "Use RTK Query for cached server state."),
    ]
    web = [
        ("vitest", "This stack uses Jest for unit/integration tests."),
        ("@vitest/", "This stack uses Jest for unit/integration tests."),
        ("styled-components", "Use vanilla-extract for build-time static CSS."),
        ("@emotion", "Use vanilla-extract for build-time static CSS."),
        ("tailwindcss", "Use vanilla-extract; no runtime CSS framework on this stack."),
        ("nativewind", "Use vanilla-extract for React web, not NativeWind."),
        ("@mui/", "Build shared primitives in packages/ui on top of vanilla-extract."),
        ("antd", "Build shared primitives in packages/ui on top of vanilla-extract."),
        ("material-ui", "Build shared primitives in packages/ui on top of vanilla-extract."),
        ("chakra-ui", "Build shared primitives in packages/ui on top of vanilla-extract."),
        ("bootstrap", "Build shared primitives in packages/ui on top of vanilla-extract."),
    ]
    if not allow_nextjs:
        web.append(
            (
                r"(^|\s)(next|next-auth)(@[\w.-]+)?(\s|$)",
                "Use the React/Vite stack unless the user explicitly chose Next.js; Next.js auth uses NextAuth/Auth.js only in a Next.js project.",
            )
        )
    native = [
        ("vitest", "This stack uses Jest for unit/integration tests."),
        ("@vitest/", "This stack uses Jest for unit/integration tests."),
        ("styled-components", "Use React Native StyleSheet.create with design tokens."),
        ("@emotion", "Use React Native StyleSheet.create with design tokens."),
        ("tailwindcss", "Use StyleSheet.create and design tokens; no Tailwind on the Expo stack."),
        ("nativewind", "Use StyleSheet.create and design tokens; NativeWind is not in the approved stack."),
        ("react-router-dom", "Use Expo Router for React Native navigation."),
        ("framer-motion", "Use react-native-reanimated for React Native animations."),
        ("@mui/", "Build shared native primitives in packages/ui-native."),
        ("antd", "Build shared native primitives in packages/ui-native."),
        ("material-ui", "Build shared native primitives in packages/ui-native."),
        ("chakra-ui", "Build shared native primitives in packages/ui-native."),
        ("bootstrap", "Build shared native primitives in packages/ui-native."),
    ]
    if stack in RN_STACKS:
        return common + native
    if stack in WEB_STACKS or stack is None:
        return common + web
    return common


def main() -> None:
    data = json.load(sys.stdin)
    command = data.get("tool_input", {}).get("command", "")
    if not INSTALL_RE.search(command):
        return

    state = read_state()
    hits = [
        (pattern, tip)
        for pattern, tip in forbidden_for_stack(read_stack(state), allow_nextjs=allows_nextjs(state))
        if re.search(pattern, command)
    ]
    if not hits:
        return

    lines = "\n".join(f"  - {pattern}: {tip}" for pattern, tip in hits)
    reason = f"Forbidden library:\n{lines}\n\nSee rules/core.md and the active stack core for the approved stack."
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


if __name__ == "__main__":
    main()
