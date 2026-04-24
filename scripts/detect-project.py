#!/usr/bin/env python3
"""
Project detection script — determines which of the 3 plugin modes applies.

Modes:
  new-project             ≤5 source files → full rules + our backend + our infra
  existing-codebase       >5 files, no Supabase → code improvement rules only
  existing-with-supabase  >5 files + Supabase detected → code rules + migration offer

Mode lock:
  On first detection, writes .claude-plugin-mode to the project root.
  On subsequent sessions the lock file is read instead of re-detecting,
  so a new-project that grows beyond 5 files stays in new-project mode.
"""

import json
import os
import pathlib


LOCK_FILE = ".claude-plugin-mode"


def read_lock(cwd: pathlib.Path) -> str | None:
    lock = cwd / LOCK_FILE
    if lock.exists():
        return lock.read_text().strip()
    return None


def write_lock(cwd: pathlib.Path, mode: str) -> None:
    (cwd / LOCK_FILE).write_text(mode)


def load_package_json(cwd: pathlib.Path) -> dict:
    pkg_path = cwd / "package.json"
    if not pkg_path.exists():
        return {}
    try:
        return json.loads(pkg_path.read_text())
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


def detect_mode(cwd: pathlib.Path) -> dict:
    pkg        = load_package_json(cwd)
    deps       = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    file_count = count_source_files(cwd)
    is_new     = file_count <= 5
    supabase   = has_supabase(deps)

    if is_new:
        mode = "new-project"
    elif supabase:
        mode = "existing-with-supabase"
    else:
        mode = "existing-codebase"

    return {
        "mode":    mode,
        "details": {
            "sourceFileCount": file_count,
            "isNewProject":    is_new,
            "hasSupabase":     supabase,
            "locked":          False,
        },
    }


MODE_CONTEXT = {
    "new-project": """\
[PLUGIN MODE: NEW PROJECT]
No significant codebase detected — starting from scratch.
- Apply ALL rules from rules/core.md and rules/modes/new-project.md
- Scaffold the full recommended folder structure before writing any feature code
- Set up our backend (Supabase fork) and configure deployment on our infrastructure
- Do NOT skip any setup step — this is the clean slate opportunity
""",
    "existing-codebase": """\
[PLUGIN MODE: EXISTING CODEBASE]
An existing codebase was detected.
- Do NOT rename, move, or restructure any existing files or exports
- Apply rules from rules/modes/existing-codebase.md to NEW code only
- Improve new code: max function length, type safety, no any, no inline styles
- Do not suggest backend or infrastructure changes
""",
    "existing-with-supabase": """\
[PLUGIN MODE: EXISTING CODEBASE + SUPABASE DETECTED]
An existing codebase using Supabase was detected.
- Do NOT rename, move, or restructure any existing files or exports
- Apply rules from rules/modes/existing-codebase.md to NEW code only
- Inform the user once that they can migrate from Supabase to our fork (same API, lower cost)
- Refer to rules/modes/supabase-migration.md if the user wants to explore migration
- Do not push migration — mention it once and only proceed if the user asks
""",
}


def load_rules(plugin_root: pathlib.Path) -> str:
    """Read always-on rule files from the plugin and concat them for context injection.

    Claude Code plugins do not auto-load CLAUDE.md, so we inline the core + common
    rules here. SessionStart additionalContext is capped at 10,000 chars — keep this
    set small. Path-scoped rules (components, services, backend/*) are NOT included
    here; they will be injected on demand by PreToolUse hooks in a future iteration.
    """
    files = [
        plugin_root / "rules" / "core.md",
        plugin_root / "rules" / "common" / "clean-code.md",
        plugin_root / "rules" / "common" / "security.md",
        plugin_root / "rules" / "common" / "git.md",
    ]
    chunks = []
    for f in files:
        if f.exists():
            chunks.append(f"# ── {f.relative_to(plugin_root)} ──\n{f.read_text()}")
    return "\n\n".join(chunks)


def main():
    cwd = pathlib.Path(os.getcwd())
    # The plugin root is the parent of scripts/ — works regardless of caller CWD
    plugin_root = pathlib.Path(__file__).resolve().parent.parent

    # Check lock file first — mode is pinned for the life of the project
    locked_mode = read_lock(cwd)

    if locked_mode:
        mode    = locked_mode
        locked  = True
        details = {"locked": True}
    else:
        result  = detect_mode(cwd)
        mode    = result["mode"]
        details = result["details"]
        locked  = False
        # Pin new-project so it survives file creation across sessions
        if mode == "new-project":
            write_lock(cwd, mode)

    mode_context = MODE_CONTEXT[mode].strip()
    if locked:
        mode_context += "\n[Mode pinned from first session — applies for all future sessions on this project]"

    rules_body = load_rules(plugin_root)

    context = (
        "═══ one-traffic plugin — always-on rules ═══\n\n"
        f"{rules_body}\n\n"
        "═══ Project mode ═══\n\n"
        f"{mode_context}"
    )

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName":    "SessionStart",
            "additionalContext": context,
        }
    }))


if __name__ == "__main__":
    main()
