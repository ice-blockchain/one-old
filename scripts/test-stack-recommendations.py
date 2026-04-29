#!/usr/bin/env python3
"""Focused checks for provider-first stack recommendation behavior."""

from __future__ import annotations

import json
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
ALLOWLIST = ROOT / "scripts" / "check-library-allowlist.py"
DETECT_PROJECT = ROOT / "scripts" / "detect-project.py"


def write_json(path: pathlib.Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def run_allowlist(cwd: pathlib.Path, command: str) -> str:
    payload = {"tool_input": {"command": command}}
    result = subprocess.run(
        ["python3", str(ALLOWLIST)],
        cwd=str(cwd),
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def make_existing_project(cwd: pathlib.Path, deps: dict[str, str]) -> None:
    write_json(cwd / "package.json", {"dependencies": deps})
    for index in range(6):
        (cwd / f"file{index}.ts").write_text("export const value = 1\n", encoding="utf-8")


def run_detect_project(cwd: pathlib.Path) -> tuple[dict, dict]:
    result = subprocess.run(
        ["python3", str(DETECT_PROJECT)],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    state = json.loads((cwd / ".traffic-one.json").read_text(encoding="utf-8"))
    return payload, state


class StackRecommendationTests(unittest.TestCase):
    def test_react_stack_denies_next_packages(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = pathlib.Path(tmp)
            write_json(cwd / ".traffic-one.json", {"stack": "react-frontend-only"})

            output = run_allowlist(cwd, "pnpm add next next-auth")

        self.assertIn("permissionDecision", output)
        self.assertIn("Next.js auth uses NextAuth/Auth.js", output)

    def test_explicit_nextjs_state_allows_next_packages(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = pathlib.Path(tmp)
            write_json(cwd / ".traffic-one.json", {"stack": "minimal", "frontend": "nextjs"})

            output = run_allowlist(cwd, "pnpm add next next-auth vitest")

        self.assertEqual("", output)

    def test_existing_next_dependency_allows_next_auth(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = pathlib.Path(tmp)
            write_json(cwd / "package.json", {"dependencies": {"next": "^16.0.0"}})

            output = run_allowlist(cwd, "pnpm add next-auth")

        self.assertEqual("", output)

    def test_supabase_project_bundle_includes_supabase_auth_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = pathlib.Path(tmp)
            make_existing_project(cwd, {"react": "^18.0.0", "@supabase/supabase-js": "^2.0.0"})

            payload, state = run_detect_project(cwd)

        context = payload["hookSpecificOutput"]["additionalContext"]
        self.assertEqual("supabase", state["backend"])
        self.assertIn("Supabase Auth", context)
        self.assertIn("Library Catalog", context)

    def test_next_project_detects_frontend_without_react_stack(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = pathlib.Path(tmp)
            make_existing_project(cwd, {"next": "^16.0.0", "react": "^18.0.0"})

            payload, state = run_detect_project(cwd)

        context = payload["hookSpecificOutput"]["additionalContext"]
        self.assertEqual("minimal", state["stack"])
        self.assertEqual("nextjs", state["frontend"])
        self.assertIn("NextAuth/Auth.js", context)
        self.assertIn("date-fns", context)

    def test_python_rule_rejects_hand_rolled_jwt_default(self) -> None:
        python_rule = (ROOT / "rules" / "backend" / "python.md").read_text(encoding="utf-8")

        self.assertIn("do not default FastAPI apps to hand-rolled JWT auth", python_rule)

    def test_library_pick_checks_catalog_before_candidates(self) -> None:
        skill = (ROOT / "skills" / "library-pick" / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("rules/common/library-catalog.md", skill)
        self.assertIn("date-fns or dayjs", skill)


if __name__ == "__main__":
    unittest.main()
