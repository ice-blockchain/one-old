// src/shared/feature-source.ts
// Feature-source write-ownership helpers used by the plan-write gate:
// which paths count as feature source, which Traffic One role owns a path, and
// how to extract write targets from apply_patch text / shell commands.
// Ported 1:1 from scripts/hook-runtime/handlers/_helpers.cjs.

import { activeAgentRole, isSubagentSession } from './state';
import type { RunAgentContext } from './state/run-agent';
import { parseApplyPatch, patchOperationPaths } from './apply-patch';

// Paths the architecture gate treats as "feature source" (monorepo + flat layouts).
export const FEATURE_SOURCE_RE =
  /^(apps\/[^/]+\/(src|app)\/|packages\/[^/]+\/src\/|src\/|services\/[^/]+\/src\/)/;

// Build/config/public artifacts that are part of an implementation surface even
// when they are not under src/. In subagent team mode these must be owned by a
// role, not edited directly by the parent/orchestrator.
export const BUILD_ARTIFACT_RE =
  /^(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|turbo\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json|(?:apps|packages|services)\/[^/]+\/(?:package\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json|src\/vite-env\.d\.ts|public\/.+))$/;

const FLAT_FRONTEND_SOURCE_RE =
  /^src\/(?:app\/(?!api\/)|pages\/(?!api\/)|components\/|features\/|hooks\/|i18n\/|locales\/|messages\/|styles\/|assets\/|lib\/(?!(?:db|server|auth)(?:\/|\.))|utils\/|providers\/|contexts\/|layouts\/|routes\/|theme\/|types\/|config\/|App\.[^/]+$|main\.[^/]+$|index\.[^/]+$|entry\.[^/]+$|client\.[^/]+$)/;

const FLAT_BACKEND_SOURCE_RE =
  /^src\/(?:app\/api\/|pages\/api\/|api\/|server\/|services\/|store\/|stores\/|db\/|database\/|prisma\/|supabase\/|middleware\.[cm]?[jt]sx?$|lib\/(?:db|server|auth)(?:\/|\.))/;

export function roleCanWriteFeatureSource(role: unknown, filePath: string): boolean {
  if (role === 'senior-frontend') {
    return /^(apps\/[^/]+\/(src|app)\/|packages\/(ui|i18n|utils)\/src\/)/.test(filePath)
      || FLAT_FRONTEND_SOURCE_RE.test(filePath);
  }
  if (role === 'senior-backend') {
    return /^(packages\/(api-client|ws-client|utils)\/src\/|services\/[^/]+\/src\/|apps\/[^/]+\/src\/(services|store)\/)/.test(filePath)
      || FLAT_BACKEND_SOURCE_RE.test(filePath);
  }
  // The post-build maintenance worker fixes trivial issues anywhere an
  // implementer could write — its scope is bounded by the triage spawn prompt
  // (named files, no exploration), not by the frontend/backend layer split.
  if (role === 'quick-fix') {
    return roleCanWriteFeatureSource('senior-frontend', filePath)
      || roleCanWriteFeatureSource('senior-backend', filePath);
  }
  return false;
}

// Role ownership check. Prefer the per-agent run claim resolved from the current
// hook session id; fall back to the legacy shared activeAgentRole only for older
// projects that do not have .traffic-one/runs/<runId>/ state yet.
export function subagentMayWriteFeatureSource(
  state: unknown,
  filePath: string,
  agentContext: RunAgentContext | null = null,
): boolean {
  if (agentContext && agentContext.role) {
    return roleCanWriteFeatureSource(agentContext.role, filePath);
  }
  if (!isSubagentSession(state)) return false;
  const role = activeAgentRole(state);
  if (role && roleCanWriteFeatureSource(role, filePath)) return true;
  return roleCanWriteFeatureSource('senior-frontend', filePath)
      || roleCanWriteFeatureSource('senior-backend', filePath);
}

// A bare interpreter token is not a write: `python3 -c "…json.load(open(...))"`
// and `node -e "console.log(...)"` are routine read/inspect commands (the B5
// false-positive). Interpreters count as a write primitive only when an
// eval/exec flag is paired with file-writing vocabulary in the eval body —
// redirected interpreter output is still caught by the redirect check.
const INTERPRETER_EVAL_WRITE_RE = new RegExp(
  String.raw`\b(?:python3?|node|perl)\b[\s\S]*(?:^|\s)(?:-c|-e|-r|--eval|--exec)\b[\s\S]*`
  + String.raw`(?:\bopen\s*\([^)]*,\s*['"][wax]|\.write(?:_text|_bytes)?\s*\(|\bwrite(?:File|FileSync)\s*\(`
  + String.raw`|\bfs\.(?:write|append|rm|unlink|rename|mkdir|cp|copy)|\bappendFile|\bcreateWriteStream`
  + String.raw`|\bunlink\b|\bos\.(?:remove|rename|replace)\b|\bshutil\b|['"]>{1,2}['"])`,
);

// `sed` is a write only when an actual in-place flag appears among the option
// tokens that PRECEDE its script/file arguments. The old free-span match
// (`/\bsed\b[\s\S]*-i/`) turned pure reads into writes whenever ANY later text
// merely contained "-i" — observed 8c-codex: `sed -n '1,240p' … known-issues.md`
// (the "-i" inside the filename) denied the tester's read-only orientation, and
// the same pattern inside a heredoc BODY voided the digest carve-out below.
// GNU's postfix form (`sed 's/…/…/' -i file`) is deliberately not chased — the
// canonical `sed -i` spelling stays caught without the filename false positives.
function sedInPlaceFlag(command: string): boolean {
  const sedRe = /\bsed\b/g;
  for (let match = sedRe.exec(command); match; match = sedRe.exec(command)) {
    for (const token of command.slice(match.index + match[0].length).split(/\s+/)) {
      if (!token) continue;
      if (!token.startsWith('-') || token === '--') break; // script/file args end the option run
      if (token === '--in-place' || token.startsWith('--in-place=')) return true;
      if (/^-[a-zA-Z]*i/.test(token)) return true; // -i, -i.bak, -ni, -Ei…
    }
  }
  return false;
}

function shellCommandHasWritePrimitive(command: string): boolean {
  const hasOutputRedirect = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*(?!&?\d\b)(?!\/dev\/null\b)/.test(command);
  return hasOutputRedirect
    || /\btee\b/.test(command)
    || /\bcat\b[\s\S]*<</.test(command)
    || INTERPRETER_EVAL_WRITE_RE.test(command)
    || sedInPlaceFlag(command)
    // mkdir creates no file content and carries no implementation ownership.
    // Treating it as a source write rejects foreground architect scaffolding in
    // Devin Local. Destructive/copying/content primitives remain gated.
    || /(?:^|[\s;&|])(?:rm|mv|cp|touch|truncate)\b/.test(command)
    || /(?:^|[\s;&|])find\b[\s\S]*\s-delete\b/.test(command);
}

export function commandAppearsToWriteFeatureSource(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const mentionsFeaturePath = /(?:^|[\s'"`/])(?:apps\/[^/\s'"`]+\/(?:src|app)(?:\/|(?=$|[\s'"`]))|packages\/[^/\s'"`]+\/src(?:\/|(?=$|[\s'"`]))|src(?:\/|(?=$|[\s'"`]))|services\/[^/\s'"`]+\/src(?:\/|(?=$|[\s'"`])))/.test(command);
  return shellCommandHasWritePrimitive(command) && mentionsFeaturePath;
}

export function commandAppearsToWriteBuildArtifact(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const hasWritePrimitive = shellCommandHasWritePrimitive(command);
  const mentionsBuildArtifact = /(?:^|[\s'"`])(?:(?:apps|packages|services)\/[^/\s'"`]+\/(?:package\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json|src\/vite-env\.d\.ts|public\/[^\s'"`]+)|(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|turbo\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json))(?:$|[\s'"`])/.test(command);
  return hasWritePrimitive && mentionsBuildArtifact;
}

// Run-state shell writes: reviewer digests and orchestrator fix-cycle notes are
// heredocs whose BODY cites source paths, but whose write TARGET is under
// `.traffic-one/{digests,fix-cycles,runs}/`. Write/Edit are already exempt by
// target path; this restores the same exemption for Bash by anchoring on the
// redirect/tee target instead of the command body. Strict on purpose:
//   - every extracted redirect/tee target must be a run-state path;
//   - any other write primitive class (rm/mv/cp/touch/truncate, find -delete,
//     sed -i, interpreter eval writes) disables the carve-out — a compound
//     command that also mutates feature source stays gated.
// `.traffic-one/plan.md` is intentionally NOT carved out: plan writes must go
// through the Write tool so plan-content validation still runs.
const RUN_STATE_TARGET_RE = /^(?:\.\/)?\.traffic-one\/(?:digests|fix-cycles|runs)\/|\/\.traffic-one\/(?:digests|fix-cycles|runs)\//;

// Heredoc BODIES are quoted data, not commands. A reviewer digest whose text
// merely cites `sed -i`, `rm`, or an output redirect must not void the
// run-state carve-out (observed 8c-codex: the digest heredoc was denied because
// a finding mentioned `sed -i`). Remove each `<<TERM … TERM` body before the
// disqualifier/target scans; the redirect that feeds the heredoc target
// (`cat > path <<'EOF'`) precedes the operator, so it survives the strip.
function stripHeredocBodies(command: string): string {
  const heredocRe = /<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g;
  let result = '';
  let cursor = 0;
  for (let m = heredocRe.exec(command); m; m = heredocRe.exec(command)) {
    if (m.index < cursor) continue; // operator text inside an already-stripped body
    const term = m[1] || m[2] || m[3] || '';
    const operatorEnd = m.index + m[0].length;
    const bodyStart = command.indexOf('\n', operatorEnd);
    if (bodyStart === -1) { result += command.slice(cursor, operatorEnd); cursor = command.length; break; }
    result += command.slice(cursor, bodyStart);
    const termRe = new RegExp(`\\n[\\t ]*${term}[\\t ]*(?=\\n|$)`);
    const terminator = termRe.exec(command.slice(bodyStart));
    if (!terminator) { cursor = command.length; break; } // unterminated: body runs to the end
    cursor = bodyStart + terminator.index; // resume at the newline before TERM
    heredocRe.lastIndex = cursor;
  }
  return result + command.slice(cursor);
}

export function shellWriteTargetsStateDir(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const scanned = stripHeredocBodies(command);
  if (INTERPRETER_EVAL_WRITE_RE.test(scanned)) return false;
  if (sedInPlaceFlag(scanned)) return false;
  if (/(?:^|[\s;&|])(?:rm|mv|cp|touch|truncate)\b/.test(scanned)) return false;
  if (/(?:^|[\s;&|])find\b[\s\S]*\s-delete\b/.test(scanned)) return false;
  const targets: string[] = [];
  const redirectRe = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*(?!&?\d\b)(?!\/dev\/null\b)((?:"[^"]+")|(?:'[^']+')|[^\s;&|<>]+)/g;
  for (let m = redirectRe.exec(scanned); m; m = redirectRe.exec(scanned)) { if (m[1]) targets.push(m[1]); }
  const teeRe = /\btee\b(?:\s+-[a-zA-Z]+)*\s+((?:"[^"]+")|(?:'[^']+')|[^\s;&|]+)/g;
  for (let m = teeRe.exec(scanned); m; m = teeRe.exec(scanned)) { if (m[1]) targets.push(m[1]); }
  if (targets.length === 0) return false;
  return targets.every((raw) => {
    const target = raw.replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
    return RUN_STATE_TARGET_RE.test(target);
  });
}

// Test-scope paths are owned by `senior-tester` regardless of which implementer
// assignment covers the surrounding directory (tests are interleaved inside
// frontend/backend scopes — carving them out of every assignment glob would be
// fragile). Covers *.test.*/*.spec.* files plus conventional test directories,
// including the singular `test/` segment for JVM `src/test/` layouts.
// Test files by directory convention or filename convention. The filename arm
// covers dot-infix JS/TS (`.test.` / `.spec.`) AND the side-by-side suffix/
// prefix conventions of Go (`*_test.go` lives NEXT to the source package —
// observed 13c: the tester was denied on services/api/internal/middleware/
// middleware_test.go as backend-owned and dropped the test) and pytest
// (`test_*.py` / `*_test.py`).
export const TEST_SCOPE_RE =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests|test|e2e|cypress|playwright|\.maestro)\/|\.(?:test|spec)\.[^/]+$|_test\.go$|(?:^|\/)test_[^/]+\.py$|_test\.py$/;

export function isTestScopePath(filePath: unknown): boolean {
  const p = String(filePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  return p.length > 0 && TEST_SCOPE_RE.test(p);
}

// Canonical test-runner config/setup files (any directory level): vitest,
// playwright, jest, cypress `.config`/`.setup`/`.workspace` in every JS/TS
// flavour. Deliberately NOT part of TEST_SCOPE_RE: that regex also feeds the
// no-any style exemption, while this predicate exists for the run-team tester
// overlay — the tester owns test INFRA, not just test files (observed 8c
// apps/web/jest.config.js, 11c playwright.config.ts, 12c vitest.setup.ts +
// playwright.config.ts: all correctly-scoped tester writes denied as
// frontend-owned, forcing fix-cycle detours for test wiring). App bundler
// configs (next.config, vite.config) stay implementer-owned.
export const TEST_INFRA_CONFIG_RE =
  /(?:^|\/)(?:vitest|playwright|jest|cypress)\.(?:config|setup|workspace)\.[cm]?[jt]s$/;

export function isTestInfraConfigPath(filePath: unknown): boolean {
  const p = String(filePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  return p.length > 0 && TEST_INFRA_CONFIG_RE.test(p);
}

// A single simple `cp`/`mv` that IMPORTS a read-only file from OUTSIDE the
// project into a project path is a verifiable per-target write, not an opaque
// shell mutation: the plan-write gate re-routes its DEST through the same
// ownership checks as Write/Edit instead of the blanket shell-write deny.
// Observed 10c-codex: a generated OG raster could never be placed — `cp` was
// denied as a shell write and Write/Edit are text-only — so the deliverable
// shipped without its asset. Strict on purpose; return null (= no carve-out,
// normal shell-write handling) unless ALL of:
//   - exactly one simple command: no separators, pipes, redirects, subshells,
//     command substitution, or glob characters;
//   - plain `cp`/`mv` with optional flags;
//   - every SOURCE is an absolute path OUTSIDE the project root (a read-only
//     import — sources inside the project stay on the shell-write deny so
//     in-repo moves cannot dodge per-file gates);
//   - the DEST (resolved against the command's workdir) lands INSIDE the
//     project and never under a dot-directory (`.git/`, `.traffic-one/` keep
//     their own rules).
// Returns the project-relative DEST path.
export function shellAssetImportDest(command: unknown, workdir: unknown, projectRoot: unknown): string | null {
  if (typeof command !== 'string' || !command.trim()) return null;
  if (typeof workdir !== 'string' || !workdir.startsWith('/')) return null;
  if (typeof projectRoot !== 'string' || !projectRoot.startsWith('/')) return null;
  if (/[\n;|&<>`]|\$\(/.test(command)) return null;
  if (/[*?{}[\]~]/.test(command)) return null;
  const tokens: string[] = [];
  const tokenRe = /'([^']*)'|"([^"]*)"|(\S+)/g;
  for (let m = tokenRe.exec(command); m; m = tokenRe.exec(command)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  if (tokens.length < 3) return null;
  const [cmd, ...rest] = tokens;
  if (cmd !== 'cp' && cmd !== 'mv') return null;
  const args: string[] = [];
  let flagsDone = false;
  for (const token of rest) {
    if (!flagsDone && token === '--') { flagsDone = true; continue; }
    if (!flagsDone && token.startsWith('-') && token.length > 1) continue;
    args.push(token);
  }
  if (args.length < 2) return null;
  const root = projectRoot.replace(/\/+$/, '');
  const base = workdir.replace(/\/+$/, '');
  const literalAbsolute = (p: string): string | null => {
    const abs = p.startsWith('/') ? p : `${base}/${p}`;
    // literal paths only: reject `..`/`.` segments and empty segments (`//`);
    // the leading '' from splitting the root slash is expected
    const segments = abs.split('/');
    if (segments[0] !== '' || segments.slice(1).some((s) => s === '' || s === '.' || s === '..')) return null;
    return abs;
  };
  const relativeToRoot = (abs: string): string | null => (
    abs !== root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null
  );
  const dest = args[args.length - 1]!;
  for (const source of args.slice(0, -1)) {
    if (!source.startsWith('/')) return null;
    const abs = literalAbsolute(source);
    if (!abs || relativeToRoot(abs) !== null) return null;
  }
  const destAbs = literalAbsolute(dest);
  if (!destAbs) return null;
  const rel = relativeToRoot(destAbs);
  if (!rel) return null;
  if (rel.split('/').some((segment) => segment.startsWith('.'))) return null;
  return rel;
}

export function commandAppearsToWriteExternalTemp(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const tempPath = "(?:/tmp|/private/tmp|/var/tmp)/[^\\s'\"`;|&>]+";
  const outputToTemp = new RegExp(String.raw`(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*` + tempPath).test(command);
  const teeToTemp = new RegExp(String.raw`\btee\b[\s\S]*` + tempPath).test(command);
  const writePrimitiveToTemp = new RegExp(String.raw`(?:^|[\s;&|])(?:touch|truncate|mkdir|rm|mv|cp)\b[\s\S]*` + tempPath).test(command);
  return outputToTemp || teeToTemp || writePrimitiveToTemp;
}

export function applyPatchTargetPaths(patchText: unknown): string[] {
  if (typeof patchText !== 'string' || !patchText.trim()) return [];
  const parsed = parseApplyPatch(patchText);
  return parsed.ok ? patchOperationPaths(parsed.operations) : [];
}
