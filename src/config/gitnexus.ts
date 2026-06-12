// src/config/gitnexus.ts
// GitNexus bootstrap knobs: the output dir, report freshness window, the paths
// that conflict with an existing project, and the minimum Node major. The
// bootstrap + nvm discovery logic lives in runners/gitnexus/**.

// GitNexus writes ./.gitnexus in the project root (no output-dir flag); the
// runner relocates it here, under .traffic-one/ (gitignored), after each scan.
export const GITNEXUS_DIR = '.traffic-one/.gitnexus';
export const REPORT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
export const CONFLICT_PATHS = ['AGENTS.md', 'CLAUDE.md', '.claude/skills'];

// GitNexus's package.json declares `engines.node: ">=22"`. We pre-flight and
// refuse with a clean banner BEFORE wasting ~3 minutes on a doomed npm install.
export const GITNEXUS_MIN_NODE_MAJOR = 22;
