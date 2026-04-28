#!/usr/bin/env python3
"""Synchronize Traffic One rules and skills metadata for Cursor.

Source of truth:
  - rules/**/*.md
  - skills/*/SKILL.md

Generated / normalized artifacts:
  - .cursor/rules/*.mdc
  - .cursor-plugin/plugin.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
RULES_ROOT = ROOT / "rules"
CURSOR_RULES_ROOT = ROOT / ".cursor" / "rules"
CURSOR_PLUGIN_MANIFEST = ROOT / ".cursor-plugin" / "plugin.json"

GENERATED_MARKER = "<!-- GENERATED FROM:"
LEGACY_GENERATED_MARKER = "<!-- SOURCE OF TRUTH:"

MANIFEST_ORDER = [
    "name",
    "displayName",
    "description",
    "version",
    "author",
    "publisher",
    "homepage",
    "repository",
    "license",
    "logo",
    "keywords",
    "category",
    "tags",
    "commands",
    "agents",
    "skills",
    "rules",
    "hooks",
    "mcpServers",
]


@dataclass(frozen=True)
class RuleDocument:
    source_path: Path
    output_path: Path
    content: str


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text_if_changed(path: Path, content: str) -> bool:
    if path.exists() and read_text(path) == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


def split_frontmatter(markdown: str) -> tuple[list[str], str]:
    lines = markdown.splitlines()
    if not lines or lines[0].strip() != "---":
        return [], markdown

    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            body = "\n".join(lines[index + 1 :]).lstrip("\n")
            if markdown.endswith("\n"):
                body += "\n"
            return lines[1:index], body

    return [], markdown


def parse_scalar(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        return cleaned
    try:
        decoded = json.loads(cleaned)
    except json.JSONDecodeError:
        return cleaned.strip("\"'")
    if isinstance(decoded, str):
        return decoded
    return cleaned


def parse_inline_list(value: str) -> list[str]:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return []
    if not isinstance(decoded, list):
        return []
    return [item for item in decoded if isinstance(item, str)]


def parse_frontmatter(lines: Iterable[str]) -> tuple[list[str], str | None, bool | None]:
    paths: list[str] = []
    description: str | None = None
    always_apply: bool | None = None
    in_paths = False

    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        if stripped.startswith("paths:"):
            in_paths = True
            inline_value = stripped.partition(":")[2].strip()
            if inline_value.startswith("["):
                paths.extend(parse_inline_list(inline_value))
                in_paths = False
            continue

        if in_paths:
            item_match = re.match(r"^\s*-\s*(.+?)\s*$", raw_line)
            if item_match:
                paths.append(parse_scalar(item_match.group(1)))
                continue
            in_paths = False

        if stripped.startswith("description:"):
            description = parse_scalar(stripped.partition(":")[2])
            continue

        if stripped.startswith("alwaysApply:"):
            value = stripped.partition(":")[2].strip().lower()
            if value in {"true", "false"}:
                always_apply = value == "true"

    return paths, description, always_apply


def title_from_body(body: str, fallback: str) -> str:
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
    return fallback


def slug_for_source(source_path: Path) -> str:
    source_without_suffix = source_path.relative_to(RULES_ROOT).with_suffix("")
    parts = list(source_without_suffix.parts)

    if parts[:2] == ["frontend", "react"]:
        parts = parts[1:]
    elif parts[:2] == ["frontend", "react-native"]:
        parts = parts[1:]
    elif parts and parts[0] == "modes":
        parts = ["mode", *parts[1:]]

    return "-".join(parts)


def should_always_apply(source_path: Path, paths: list[str], explicit: bool | None) -> bool:
    if explicit is not None:
        return explicit
    if paths:
        return False
    relative_parts = source_path.relative_to(RULES_ROOT).parts
    return not relative_parts or relative_parts[0] != "modes"


def cursor_frontmatter(
    description: str,
    paths: list[str],
    always_apply: bool,
) -> list[str]:
    lines = ["---"]
    lines.append(f"description: {json.dumps(description, ensure_ascii=False)}")
    if paths:
        lines.append(f"globs: {json.dumps(paths, ensure_ascii=False)}")
    lines.append(f"alwaysApply: {str(always_apply).lower()}")
    lines.append("---")
    return lines


def render_cursor_rule(source_path: Path) -> RuleDocument:
    source_text = read_text(source_path)
    frontmatter_lines, body = split_frontmatter(source_text)
    paths, frontmatter_description, explicit_always_apply = parse_frontmatter(frontmatter_lines)
    source_relative = relative(source_path)
    title = title_from_body(body, source_path.stem.replace("-", " ").title())
    description = frontmatter_description or f"{title}. Generated from {source_relative}."
    always_apply = should_always_apply(source_path, paths, explicit_always_apply)
    output_path = CURSOR_RULES_ROOT / f"{slug_for_source(source_path)}.mdc"

    content_lines = [
        f"<!-- GENERATED FROM: {source_relative}; run `python3 scripts/sync-cursor.py` to update. -->",
        *cursor_frontmatter(description, paths, always_apply),
        "",
        body.rstrip(),
        "",
    ]
    return RuleDocument(source_path=source_path, output_path=output_path, content="\n".join(content_lines))


def generated_rule_documents() -> list[RuleDocument]:
    sources = sorted(RULES_ROOT.rglob("*.md"))
    return [render_cursor_rule(source) for source in sources]


def is_managed_cursor_rule(path: Path) -> bool:
    if not path.exists():
        return False
    start = read_text(path)[:300]
    return GENERATED_MARKER in start or LEGACY_GENERATED_MARKER in start


def stale_cursor_rules(expected_paths: set[Path]) -> list[Path]:
    if not CURSOR_RULES_ROOT.exists():
        return []
    stale: list[Path] = []
    for path in sorted(CURSOR_RULES_ROOT.glob("*.mdc")):
        if path not in expected_paths and is_managed_cursor_rule(path):
            stale.append(path)
    return stale


def load_existing_manifest() -> dict[str, object]:
    if not CURSOR_PLUGIN_MANIFEST.exists():
        return {}
    try:
        decoded = json.loads(read_text(CURSOR_PLUGIN_MANIFEST))
    except json.JSONDecodeError as error:
        raise ValueError(f"{relative(CURSOR_PLUGIN_MANIFEST)} is not valid JSON: {error}") from error
    if not isinstance(decoded, dict):
        raise ValueError(f"{relative(CURSOR_PLUGIN_MANIFEST)} must contain a JSON object.")
    return decoded


def normalized_cursor_manifest() -> str:
    existing = load_existing_manifest()
    interface = existing.get("interface")
    interface_data = interface if isinstance(interface, dict) else {}

    defaults: dict[str, object] = {
        "name": existing.get("name", "traffic-one"),
        "displayName": existing.get("displayName", interface_data.get("displayName", "Traffic One")),
        "description": existing.get(
            "description",
            interface_data.get(
                "shortDescription",
                "React and React Native TypeScript workflow rules and scaffolding skills.",
            ),
        ),
        "version": existing.get("version", "0.0.0"),
        "author": existing.get("author", {"name": "Traffic One"}),
        "keywords": existing.get(
            "keywords",
            [
                "react",
                "react-native",
                "typescript",
                "turborepo",
                "rtk-query",
                "cursor-rules",
            ],
        ),
        "category": existing.get("category", "engineering"),
        "tags": existing.get(
            "tags",
            ["react", "react-native", "typescript", "testing", "security"],
        ),
        "skills": "./skills/",
        "rules": "./.cursor/rules/",
    }

    for key in MANIFEST_ORDER:
        if key in existing and key not in defaults and key != "interface":
            defaults[key] = existing[key]

    ordered = {key: defaults[key] for key in MANIFEST_ORDER if key in defaults}
    return json.dumps(ordered, indent=2, ensure_ascii=False) + "\n"


def diff_summary(expected_rules: list[RuleDocument], stale_rules: list[Path], manifest: str) -> list[str]:
    differences: list[str] = []
    for document in expected_rules:
        if not document.output_path.exists():
            differences.append(f"missing {relative(document.output_path)}")
            continue
        if read_text(document.output_path) != document.content:
            differences.append(f"out of date {relative(document.output_path)}")

    for path in stale_rules:
        differences.append(f"stale {relative(path)}")

    if not CURSOR_PLUGIN_MANIFEST.exists() or read_text(CURSOR_PLUGIN_MANIFEST) != manifest:
        differences.append(f"out of date {relative(CURSOR_PLUGIN_MANIFEST)}")

    return differences


def sync_cursor(check: bool) -> int:
    expected_rules = generated_rule_documents()
    expected_paths = {document.output_path for document in expected_rules}
    stale_rules = stale_cursor_rules(expected_paths)
    manifest = normalized_cursor_manifest()
    differences = diff_summary(expected_rules, stale_rules, manifest)

    if check:
        if differences:
            print("Cursor sync is out of date:")
            for difference in differences:
                print(f"  - {difference}")
            print("\nRun: python3 scripts/sync-cursor.py")
            return 1
        print("Cursor sync is up to date.")
        return 0

    changed: list[str] = []
    for document in expected_rules:
        if write_text_if_changed(document.output_path, document.content):
            changed.append(relative(document.output_path))

    for path in stale_rules:
        path.unlink()
        changed.append(relative(path))

    if write_text_if_changed(CURSOR_PLUGIN_MANIFEST, manifest):
        changed.append(relative(CURSOR_PLUGIN_MANIFEST))

    if changed:
        print("Updated Cursor sync artifacts:")
        for path in changed:
            print(f"  - {path}")
    else:
        print("Cursor sync artifacts already up to date.")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync Cursor rules and plugin metadata.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify generated Cursor artifacts without writing changes.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        return sync_cursor(check=args.check)
    except Exception as error:
        print(f"cursor sync failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
