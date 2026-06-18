// src/modules/session/session-start-lib.ts
// Local SessionStart helpers: digest retention sweep, graph-preview read, the
// token-economy banner, and session-time materialization convergence. Ported
// 1:1 from session-start.cjs + tokenEconomyBanner (_helpers.cjs). The toolchain
// drift probe + the one-mcp reporter are Step-5 runner concerns, injected here
// as optional dependencies (default: no-op) so this stays runner-free.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { GITNEXUS_REL, GRAPHIFY_REPORT_REL, codeGraphIsEmpty } from '../../shared/codegraph';
import { STACK_IDS } from '../../config/stacks';
import { ensureCodexMcpServerRegistered } from '../../shared/codex-mcp';
import { detectMode } from '../../shared/detection';
import { exec } from '../../shared/exec';
import { hasMaterializedProjectAssets, materializeProjectAssets } from '../../shared/materialize';
import { pluginRoot } from '../../shared/paths';
import { nowIsoNoMs } from '../../shared/text';
import { managedNpmBin } from '../../shared/toolchain-paths';
import {
  isMaintenancePhase,
  isMaterialized,
  normalizeState,
  readEffectiveState,
  readState,
  stackFingerprint,
  stateVersion,
  writeState,
} from '../../shared/state';
import { ensureInitialCommit } from '../../shared/git-init';

type Rec = Record<string, unknown>;

// Keep the newest `keepCount` orchestrator digest runs; remove older ones.
export function sweepOldDigests(cwd: string, keepCount = 5): number {
  const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
  if (!fs.existsSync(digestsRoot)) return 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(digestsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries.slice(keepCount)) {
    try {
      fs.rmSync(path.join(digestsRoot, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort; never block SessionStart on retention sweep
    }
  }
  return removed;
}

// Re-attempt a missing code-graph build at most once per this window. Covers an
// in-flight detached build and backs off after a failed attempt. Tracked via a
// disk lock under .traffic-one/ (gitignored) — NOT state, because pref timestamps
// are filtered out of the effective state and would not round-trip.
const CODE_GRAPH_SELF_HEAL_COOLDOWN_MS = 30 * 60 * 1000;
const CODE_GRAPH_BUILD_LOCK = '.codegraph-build-lock';

function codeGraphBuildLockMs(cwd: string): number {
  return diskLockMs(path.join(cwd, '.traffic-one', CODE_GRAPH_BUILD_LOCK));
}

// Should we (re)build the code graph at SessionStart? Auto-detected existing projects
// (Flow 2) never run the wizard's onboarding scan, and a project onboarded before that
// scan existed has no graph either — so without this, the codebase-graph token economy
// (read the map once instead of Glob/Grep) never activates. True only when: the project
// is in scope (existing-codebase, OR a new-project whose onboarding is COMPLETE — so a
// degraded/deferred build still self-heals its graph), a provider is set, auto-run isn't
// disabled, the artifact is missing/empty, and no build ran within the cooldown (disk lock).
export function shouldBuildCodeGraph(cwd: string, state: Rec, nowMs: number): boolean {
  const mode = state.mode;
  const isExisting = mode === 'existing-codebase' || mode === 'existing-with-supabase';
  // Also self-heal a NEW project once onboarding is complete and a provider is set but the
  // graph is missing/empty. This covers BOTH (a) a deferred onboarding graph install
  // (offline / transient / no runtime yet) AND (b) a build that DEGRADED before its Phase-5
  // parent-side graph refresh — observed on Cursor (tests/4b): the run blocked mid-stream and
  // the orchestrator only emitted a "no provider configured, skipped" no-op, so the graph
  // never landed in-run. Previously this required the `graphDeferredAt` marker; dropping that
  // makes the NEXT SessionStart land the graph the same way Codex's Phase 5 did. Gated on
  // onboardingComplete so a mid-onboarding scaffold isn't scanned early; the hasGraph +
  // cooldown guards below keep it a cheap no-op once a non-empty graph exists.
  const isNewProjectNeedingGraph = mode === 'new-project' && state.onboardingComplete === true;
  if (!isExisting && !isNewProjectNeedingGraph) return false;
  if (state.codeGraphAutoRun === false || state.graphifyAutoRun === false) return false;
  const provider = state.codeGraphProvider;
  if (provider !== 'graphify' && provider !== 'gitnexus') return false;
  // Present AND non-empty: a 0-node onboarding-scan artefact exists on disk but
  // is useless, so it must NOT count as "has graph" — otherwise the self-heal
  // never fires and the empty index lingers.
  const artefactExists = provider === 'graphify'
    ? fs.existsSync(path.join(cwd, GRAPHIFY_REPORT_REL))
    : fs.existsSync(path.join(cwd, GITNEXUS_REL));
  const hasGraph = artefactExists && !codeGraphIsEmpty(cwd, provider);
  if (hasGraph) return false;
  const lockMs = codeGraphBuildLockMs(cwd);
  if (lockMs && (nowMs - lockMs) < CODE_GRAPH_SELF_HEAL_COOLDOWN_MS) return false;
  return true;
}

// Best-effort, NON-BLOCKING self-heal: when an existing project is missing its
// code graph, fire the provider's runner DETACHED (same pattern as the onboarding
// server / one-mcp worker) so the graph lands by the next turn/session without
// blocking SessionStart. Writes the cooldown lock BEFORE spawning so a rapid
// second call (or a concurrent session) won't double-spawn. Never throws.
// Returns true if a build was spawned (used by tests).
export function ensureCodeGraphForExistingProject(cwd: string, state: Rec): boolean {
  try {
    if (!shouldBuildCodeGraph(cwd, state, Date.now())) return false;
    const provider = String(state.codeGraphProvider);
    const runner = provider === 'graphify' ? 'graphify-runner.cjs' : 'gitnexus-runner.cjs';
    const entry = path.join(pluginRoot(), 'scripts', runner);
    if (!fs.existsSync(entry)) return false;
    const lock = path.join(cwd, '.traffic-one', CODE_GRAPH_BUILD_LOCK);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, nowIsoNoMs(), 'utf8');
    const child = spawn(process.execPath, [entry], { cwd, detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false; // self-heal is best-effort; never block or throw in SessionStart
  }
}

// ── OpenCode delegation readiness (zero-touch) ──────────────────────────────
// Two session-start self-heals so OpenCode delegation needs NOTHING manual
// beyond the onboarding wizard answer:
//   1. Codex MCP registration: Codex only launches MCP servers from its own
//      ~/.codex/config.toml — projects onboarded before that registration
//      existed (or whose onboarding runner died early) never got the entry.
//      Re-ensure it every session (idempotent: a single config.toml read).
//      A FRESH registration needs a one-time Codex restart to load — that's
//      the returned notice. (Codex Desktop without CODEX_PLUGIN_ROOT in the
//      env resolves no stable root and stays 'skipped-no-root' — out of scope.)
//   2. Missing CLI install: onboarding's OpenCode install is warn-and-proceed
//      (e.g. npm wasn't on PATH), which left `openCode.enabled` projects
//      silently skipping every delegation. Spawn the managed install DETACHED
//      (same pattern as the code-graph self-heal) behind a disk-lock cooldown.
const OPENCODE_HEAL_COOLDOWN_MS = 30 * 60 * 1000;
const OPENCODE_HEAL_LOCK = '.opencode-heal-lock';

function diskLockMs(lock: string): number {
  try {
    if (!fs.existsSync(lock)) return 0;
    const t = Date.parse(fs.readFileSync(lock, 'utf8').trim());
    return Number.isNaN(t) ? fs.statSync(lock).mtimeMs : t;
  } catch {
    return 0;
  }
}

export function ensureOpenCodeDelegationReady(cwd: string, state: Rec): string {
  try {
    const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
    if (openCode?.enabled !== true) return '';
    // Catch-up for the build-time commit: a maintenance-phase project that OpenCode
    // will delegate into needs a git HEAD to sandbox — a never-committed scaffold (or
    // one that flipped to maintenance on an older build) makes every delegation decline
    // and fall back to a paid worker. Give it the initial commit now. Gated on
    // maintenance so a mid-build scaffold isn't committed out from under the
    // orchestrator; idempotent (skips committed repos / non-git dirs).
    if (isMaintenancePhase(state, typeof state.mode === 'string' ? state.mode : undefined)) {
      ensureInitialCommit(cwd);
    }
    let notice = '';
    if (ensureCodexMcpServerRegistered() === 'registered') {
      notice += '[opencode] opencode-worker MCP server registered in ~/.codex/config.toml — restart Codex once to load it.\n';
    }
    // Durable authorization record (.one.json `openCodeDelegation`): hosts with
    // an action-level safety reviewer (Codex) reject opencode_delegate as "not
    // explicitly authorized" unless the user's consent is visible, so the gate
    // cites this field. The wizard writes it at onboarding; BACKFILL it for
    // projects enabled before the field existed — the wizard's OpenCode opt-in
    // WAS the consent, this only makes it machine-readable. Mutate the passed
    // state too: the SessionStart flows call writeState(cwd, state) afterwards,
    // which would otherwise clobber the committed write below.
    const delegation = state.openCodeDelegation && typeof state.openCodeDelegation === 'object' ? (state.openCodeDelegation as Rec) : null;
    if (delegation?.approved !== true) {
      const record = { approved: true, source: 'backfilled-from-enabled-pref', decidedAt: nowIsoNoMs() };
      state.openCodeDelegation = record;
      try {
        writeState(cwd, { ...readState(cwd), openCodeDelegation: record });
      } catch { /* best-effort */ }
    }
    // Cheap presence check only (existsSync + PATH lookup) — a version probe can
    // stall SessionStart. The spawned runner does the real probe + stamp.
    const installed = fs.existsSync(managedNpmBin('opencode', 'opencode')) || Boolean(exec.which('opencode'));
    // openCodeDelegationActive() — which gates the maintenance-triage OpenCode-first
    // clause AND the spawn gate's free-delegation push — requires a non-empty
    // toolchain.opencode.installedVersion. A user's GLOBAL opencode (on PATH, not a
    // Traffic One managed install) is present but onboarding's managed-only stamp
    // skips it, so it stays unstamped and delegation SILENTLY never fires (the worker
    // goes straight to the paid model). Heal that case too — not just a missing CLI:
    // the spawned runner's ensureOpenCodeTool probes the present bin (managed OR on
    // PATH) and stamps it, so the next prompt's directive/gate finally see it.
    const tc = state.toolchain && typeof state.toolchain === 'object' ? (state.toolchain as Rec) : null;
    const ocStamp = tc && tc.opencode && typeof tc.opencode === 'object' ? (tc.opencode as Rec) : null;
    const stamped = typeof ocStamp?.installedVersion === 'string' && (ocStamp.installedVersion as string).length > 0;
    if (!installed || !stamped) {
      const lock = path.join(cwd, '.traffic-one', OPENCODE_HEAL_LOCK);
      if (!diskLockMs(lock) || (Date.now() - diskLockMs(lock)) >= OPENCODE_HEAL_COOLDOWN_MS) {
        const entry = path.join(pluginRoot(), 'scripts', 'onboarding-toolchain-runner.cjs');
        if (fs.existsSync(entry)) {
          fs.mkdirSync(path.dirname(lock), { recursive: true });
          fs.writeFileSync(lock, nowIsoNoMs(), 'utf8');
          const child = spawn(process.execPath, [entry, '--opencode-only'], { cwd, detached: true, stdio: 'ignore' });
          child.unref();
          // Only a MISSING CLI warrants a user-facing "installing" notice; a
          // present-but-unstamped heal is a silent background stamp.
          if (!installed) notice += '[opencode] OpenCode CLI missing — managed install started in the background (ready next session).\n';
        }
      }
    }
    return notice;
  } catch {
    return ''; // best-effort; never block or throw in SessionStart
  }
}

// The ~500-token graph preview written by the gitnexus/graphify runners.
export function readGraphPreview(cwd: string): string {
  const previewPath = path.join(cwd, '.traffic-one', 'graph-preview.md');
  if (!fs.existsSync(previewPath)) return '';
  try {
    return `\n${fs.readFileSync(previewPath, 'utf8').trimEnd()}\n`;
  } catch {
    return '';
  }
}

export interface ToolStatus {
  status: string;
  installed?: string;
  minimum?: string;
  recommended?: string;
}
export interface ToolchainProbe {
  toolStatus(name: string, installedVersion: unknown): ToolStatus;
  getToolSpec(name: string): { installCommand?: string } | null;
}

// Memory / codebase-graph / digest / toolchain-drift hints injected at session
// start. The toolchain drift hints require a probe (Step-5 toolchain runner);
// when omitted, only the memory/graph/digest banners are emitted.
export function tokenEconomyBanner(cwd: string, probe?: ToolchainProbe | null): string {
  const lines: string[] = [];
  const memoryPaths = [
    '.traffic-one/product.md', '.traffic-one/stack.md', '.traffic-one/coding.md',
    '.traffic-one/security.md', '.traffic-one/known-issues.md', '.traffic-one/agent-log.md',
  ];
  if (memoryPaths.some((relPath) => fs.existsSync(path.join(cwd, relPath)))) {
    lines.push('[memory] .traffic-one/ project memory present — read product/stack/rules/known-issues before broad source reads.');
  }
  // Only advertise a graph worth consulting — an empty (0-node) artefact would
  // send agents to read useless files before falling back to grep/glob anyway.
  if (fs.existsSync(path.join(cwd, GRAPHIFY_REPORT_REL)) && !codeGraphIsEmpty(cwd, 'graphify')) {
    lines.push(`[graph: graphify] ${GRAPHIFY_REPORT_REL} present — consult before grep/glob for module/structure questions.`);
  }
  if (fs.existsSync(path.join(cwd, GITNEXUS_REL)) && !codeGraphIsEmpty(cwd, 'gitnexus')) {
    lines.push(`[graph: gitnexus] ${GITNEXUS_REL} present — consult before grep/glob for module/structure questions.`);
  }
  try {
    const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
    if (fs.existsSync(digestsRoot)) {
      const runs = fs.readdirSync(digestsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
      if (runs.length > 0) {
        lines.push(`[digests] Latest orchestrator run: .traffic-one/digests/${runs[0]}/ — read predecessor digests before re-reading the diff.`);
      }
    }
  } catch {
    // best-effort; banner is informational
  }
  if (probe) {
    try {
      const state = readEffectiveState(cwd);
      const toolchain = (state && (state.toolchain as Rec)) || {};
      for (const [name, stamp] of Object.entries(toolchain)) {
        const installedVersion = stamp && typeof stamp === 'object' ? (stamp as Rec).installedVersion : null;
        const status = probe.toolStatus(name, installedVersion);
        if (status.status === 'too-old') {
          const spec = probe.getToolSpec(name) || {};
          lines.push(`[toolchain] ${name} ${status.installed} is below the minimum supported (${status.minimum}). Upgrade: \`${spec.installCommand || `<upgrade ${name}>`}\`.`);
        } else if (status.status === 'outdated') {
          lines.push(`[toolchain] ${name} ${status.installed} installed; recommended is ${status.recommended}.`);
        }
      }
    } catch {
      // best-effort; banner is informational
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// Converge session-time materialization for an onboarded project. Returns true
// when it (re)materialized. The one-mcp reporter is injected (default no-op).
export function ensureSessionMaterialization(
  cwd: string,
  state: Rec,
  reportOneMcp: (cwd: string, state: Rec, trigger: string) => void = () => {},
): boolean {
  if (isPluginAuthoringRoot(cwd)) return false;
  if (!state || typeof state !== 'object') return false;
  if (state.onboardingComplete !== true) return false;
  if (!state.stack || !STACK_IDS.has(state.stack as string)) return false;

  if (isMaterialized(state) && hasMaterializedProjectAssets(cwd, state)) {
    reportOneMcp(cwd, state, 'session materialization already current');
    return false;
  }

  normalizeState(state, (state.mode as string) || detectMode(cwd));
  const materialized = materializeProjectAssets(cwd, state);
  if (materialized.skipped) {
    reportOneMcp(cwd, state, 'session materialization skipped');
    return false;
  }
  state.materializedStack = stackFingerprint(state);
  state.materializedAt = nowIsoNoMs();
  state.materializedVersion = stateVersion();
  writeState(cwd, state);
  reportOneMcp(cwd, state, 'session materialization');
  return true;
}
