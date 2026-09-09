// src/modules/session/session-start-lib.ts
// Local SessionStart helpers: digest retention sweep, graph-preview read, the
// token-economy banner, and session-time materialization convergence. Ported
// 1:1 from session-start.cjs + tokenEconomyBanner (_helpers.cjs). The toolchain
// drift probe + the one-mcp reporter are Step-5 runner concerns, injected here
// as optional dependencies (default: no-op) so this stays runner-free.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { readRegularFile } from '../../shared/bounded-read';

import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { trustworthyAgeSince } from '../../shared/clock-skew';
import { removePath, writeTextFile } from '../../shared/fsjson';
import { GITNEXUS_REL, GRAPHIFY_REPORT_REL, codeGraphIndexIsStale, codeGraphIsEmpty } from '../../shared/codegraph';
import { STACK_IDS } from '../../config/stacks';
import { ensureCodexMcpServerRegistered } from '../../shared/codex-mcp';
import { detectMode } from '../../shared/detection';
import { exec } from '../../shared/exec';
import { hasMaterializedProjectAssets, materializedFileHashesDrifted, materializedFromDifferentPluginBuild, materializeProjectAssets, roleContractDirectoryRefusal, roleContractShortfallSentence, writeOpenCodeHostAssets } from '../../shared/materialize';
import { detectHost } from '../../shared/host';
import { isUncertifiedHost, uncertifiedHostSessionBanner } from '../../shared/host/tiers';
import { firstEmitThisSession } from '../../shared/once';
import { pluginRoot } from '../../shared/paths';
import { nowIsoNoMs } from '../../shared/text';
import { managedNpmBin } from '../../shared/toolchain-paths';
import {
  isMaintenancePhase,
  isMaterialized,
  isExistingProjectMode,
  isNewProjectMode,
  normalizeState,
  readEffectiveState,
  stackFingerprint,
  stateVersion,
  writeState,
} from '../../shared/state';
import { persistWizardSharedFields } from '../../shared/onboarding-server/wizard-state-write';
import { projectWritesPermitted } from '../../shared/state/plugin-use';
import { ensureInitialCommit } from '../../shared/git-init';
import { obj } from '../../shared/obj';

type Rec = Record<string, unknown>;

// The Claude Code feature flag that registers the `SendMessage` tool and powers
// the senior-team's one-agent-per-role continuation (see senior-engineer-team).
const AGENT_TEAMS_FLAG = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';

// Make the senior-team's subagent reuse work without the user knowing the flag
// exists: persist CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 into the project's
// .claude/settings.local.json `env` (the officially-supported enable path —
// https://code.claude.com/docs/en/agent-teams). Claude reads settings `env` at
// STARTUP, so it activates on the NEXT launch — we return a one-time restart
// nudge while the flag is set in settings but not yet live in this process. Once
// the env var is present (post-restart) we stay silent. Claude-only: Codex uses
// native followup_task/send_message, Cursor has no such flag. Merge-preserving, best-effort, and
// never touches an explicit user value (including a deliberate "0" to disable).
export function ensureAgentTeamsEnv(cwd: string, host: string, env: NodeJS.ProcessEnv = process.env): string {
  if (host !== 'claude') return '';
  if (isPluginAuthoringRoot(cwd)) return '';
  const live = String(env[AGENT_TEAMS_FLAG] ?? '').trim().toLowerCase();
  if (live === '0' || live === 'false' || live === 'off') return ''; // user explicitly disabled — respect it
  const alreadyLive = live !== '';

  const file = path.join(cwd, '.claude', 'settings.local.json');
  let settings: Rec = {};
  try {
    // BOUNDED (shared/bounded-read.ts), and this one runs on SessionStart — the
    // FIRST hook after a clone, which is exactly when a repository-carried shape
    // fires.
    //
    // A non-regular object here RETURNS rather than joining the "start fresh"
    // arm below, and that is not the reflexive adoption. This reader is half of
    // a read-modify-WRITE, and the write is a raw `fs.writeFileSync` on a path
    // outside `.traffic-one/` that no fence covers — so folding a FIFO into
    // "nothing parseable, start fresh" would carry the hang from the read
    // STRAIGHT INTO THE WRITE (`write(2)` on a FIFO with no reader blocks the
    // same way `open(2)` does) and, on a device node, would destroy a target
    // nobody classified. Bounding a read by moving the block ten lines down is
    // not bounding it.
    const raw = readRegularFile(file);
    if (raw === null) return '';
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Rec;
  } catch {
    // missing or invalid → start fresh (preserving nothing we can't parse)
  }
  const envBlock = obj(settings.env) || {};
  // Only ADD when the key is absent — an explicit value (even "0") is the user's.
  if (!Object.prototype.hasOwnProperty.call(envBlock, AGENT_TEAMS_FLAG)) {
    envBlock[AGENT_TEAMS_FLAG] = '1';
    settings.env = envBlock;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    } catch {
      return ''; // unwritable → silent; the orchestrator falls back to fresh spawns
    }
  }
  if (alreadyLive) return ''; // flag is live in this process → feature already active
  // Respect an explicit disable that lives only in settings (process env unset).
  const effective = String(envBlock[AGENT_TEAMS_FLAG] ?? '').trim().toLowerCase();
  if (effective !== '1' && effective !== 'true' && effective !== 'on') return '';
  return '[agent teams] Enabled senior-team continuation in .claude/settings.local.json — '
    + 'restart Claude Code once to activate it, so agents reuse one worker per role instead of re-spawning each task.\n';
}

// An already-installed uncertified host's SessionStart reminder (item 3 of the
// host-tier decision — see shared/host/tiers.ts). Visible, never a deny: once
// installed and running, Traffic One still injects context here regardless of
// tier, so there is no separate blocking gate to add.
//
// TWO throttles, because neither alone covers the product:
//
//  1. `firstEmitThisSession` — the durable once-per-(project, session) marker
//     every other advisory nudge here uses (onboarding-deny, run-id-announce,
//     model-choice-deny-tool, pagespeed-advisory, …). It lives under
//     `.traffic-one/runs/.once/`, so the default-closed consent fence in
//     shared/fsjson.ts refuses to write it until the use-plugin question is
//     answered — and `firstEmitThisSession` correctly returns TRUE in that
//     window rather than silencing the product.
//
//  2. `emittedInProcess` — an in-memory set, which is what actually covers the
//     pre-consent window. Pre-consent is the DEFAULT state of every fresh
//     project, i.e. exactly the first-contact window this banner exists for, so
//     "no marker on disk" is the common case, not the edge case: the banner
//     re-emitted on every single SessionStart there. On OpenCode and Kilo, whose
//     long-lived wrappers invoke the SessionStart-compatible transform more than
//     once per chat IN ONE PROCESS (see session-start.ts), that was a
//     four-paragraph banner per prompt. It also fixes the post-consent payload
//     that carries no session id, which `firstEmitThisSession` throttles on a
//     30-minute TTL rather than per session.
//
// A process-scoped set is the right shape and not a workaround: hooks are one
// process per event on Claude/Codex/Cursor/Copilot, so there it IS once per
// SessionStart, and it writes nothing to a project that has not consented.
const emittedInProcess = new Set<string>();

/** Forget this process's banner emissions. Exported for tests, which drive many
 *  projects/sessions through one process. */
export function resetUncertifiedHostBannerThrottle(): void {
  emittedInProcess.clear();
}

export function uncertifiedHostBanner(cwd: string, host: string, sessionId: string | null | undefined): string {
  if (!isUncertifiedHost(host)) return '';
  const banner = uncertifiedHostSessionBanner(host) || '';
  if (!banner) return '';
  const processKey = `${path.resolve(cwd)}\u0000${host}\u0000${sessionId || ''}`;
  if (emittedInProcess.has(processKey)) return '';
  // Pre-consent: the project must stay byte-identical, so no marker may be
  // written. The banner still emits ONCE — an uncertified host is material to
  // the very decision the user is being asked to make, so withholding it until
  // after consent would hide it exactly when it matters.
  if (projectWritesPermitted(cwd)
    && !firstEmitThisSession(cwd, `uncertified-host-banner-${host}`, sessionId)) return '';
  emittedInProcess.add(processKey);
  return banner;
}

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
      // Guarded: a project that has not answered the use-plugin question keeps
      // every digest it has, however old.
      if (removePath(path.join(digestsRoot, name))) removed += 1;
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
  const isExisting = isExistingProjectMode({ mode });
  // Also self-heal a NEW project once onboarding is complete and a provider is set but the
  // graph is missing/empty. This covers BOTH (a) a deferred onboarding graph install
  // (offline / transient / no runtime yet) AND (b) a build that DEGRADED before its Phase-5
  // parent-side graph refresh — observed on Cursor (tests/4b): the run blocked mid-stream and
  // the orchestrator only emitted a "no provider configured, skipped" no-op, so the graph
  // never landed in-run. Previously this required the `graphDeferredAt` marker; dropping that
  // makes the NEXT SessionStart land the graph the same way Codex's Phase 5 did. Gated on
  // onboardingComplete so a mid-onboarding scaffold isn't scanned early; the hasGraph +
  // cooldown guards below keep it a cheap no-op once a non-empty graph exists.
  const isNewProjectNeedingGraph = isNewProjectMode({ mode }) && state.onboardingComplete === true;
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
  let artefactMtime = 0;
  if (artefactExists) {
    const artefactPath = provider === 'graphify' ? path.join(cwd, GRAPHIFY_REPORT_REL) : path.join(cwd, GITNEXUS_REL);
    try { artefactMtime = fs.statSync(artefactPath).mtimeMs; } catch { artefactMtime = 0; }
  }
  const hasGraph = artefactExists && !codeGraphIsEmpty(cwd, provider);
  if (hasGraph && !codeGraphIndexIsStale(cwd, artefactMtime)) return false;
  const lockMs = codeGraphBuildLockMs(cwd);
  // The cooldown is a BLOCK, and it used to be permanent whenever the lock's
  // stamp sat ahead of `nowMs`: the lock stores an ISO string this process
  // wrote, so a clock that stepped backwards (or a hand-edited lock) makes
  // `nowMs - lockMs` negative, which is below the cooldown by a margin that only
  // grows — and the self-heal this function exists to trigger never runs again.
  // An age no clock could have produced ends the cooldown; the spawn re-stamps
  // the lock with the current time, so the cooldown starts working again.
  const cooldownAgeMs = lockMs ? trustworthyAgeSince(lockMs, nowMs) : null;
  if (cooldownAgeMs !== null && cooldownAgeMs < CODE_GRAPH_SELF_HEAL_COOLDOWN_MS) return false;
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
    // Refused → the use-plugin question is unanswered. Do not spawn: a detached
    // graph build would write the whole artefact tree into a project that has
    // not consented, and it would do it after this hook has already returned.
    if (!writeTextFile(lock, nowIsoNoMs())) return false;
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
    // BOUNDED. A non-regular object at the lock path falls through to the mtime,
    // which is the same answer an unparseable lock body already gets.
    const body = readRegularFile(lock);
    const t = body === null ? NaN : Date.parse(body.trim());
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
      try {
        // The whole point of this write is that the field is MACHINE-READABLE at
        // call time — the spawn gate cites it to prove the user authorized
        // delegation. A write that does not land leaves the authorization
        // invisible, so opencode_delegate keeps being rejected as unauthorized,
        // and the caller's own writeState(cwd, state) lands on the same path. Say
        // so in the notice this function exists to return, next to the heal
        // notices; there is no silent recovery to fall back on.
        //
        // `persistWizardSharedFields`, not a bare `patchState`: a first-time
        // empty / torn file with no `"stack"` in the RAW bytes heals through
        // `writeState` (quarantine to `.one.json.corrupt`). A stacked-torn or
        // unreadable file is refused — `readState` answers those with `{}`, and
        // replacing a stacked project with one authorization record would
        // destroy it. Assign the in-memory field only after the persist
        // succeeds: a refused write must not leave SessionStart's later
        // `writeState(cwd, state)` claiming a field that is not on disk.
        if (!persistWizardSharedFields(cwd, { openCodeDelegation: record })) {
          notice += '[opencode] delegation authorization could not be recorded — `.traffic-one/.one.json` did not '
            + 'accept the write (the state write fence refused it, or its current contents could not be read), '
            + 'so `opencode_delegate` may still be rejected as not explicitly authorized.\n';
        } else {
          state.openCodeDelegation = record;
        }
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
      const lockMs = diskLockMs(lock);
      // Same cooldown-is-a-block reasoning as shouldBuildCodeGraph above: a lock
      // stamped ahead of now made this heal unreachable forever.
      const healAgeMs = lockMs ? trustworthyAgeSince(lockMs, Date.now()) : null;
      if (healAgeMs === null || healAgeMs >= OPENCODE_HEAL_COOLDOWN_MS) {
        const entry = path.join(pluginRoot(), 'scripts', 'onboarding-toolchain-runner.cjs');
        // Same reasoning as the code-graph self-heal: a refused lock means no
        // consent, so the detached installer must not be spawned either.
        if (fs.existsSync(entry) && writeTextFile(lock, nowIsoNoMs())) {
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
export function readGraphPreview(cwd: string, provider?: unknown): string {
  const previewPath = path.join(cwd, '.traffic-one', 'graph-preview.md');
  if (!fs.existsSync(previewPath)) return '';
  try {
    // BOUNDED. `.traffic-one/graph-preview.md` is project-controlled and this
    // runs on SessionStart; `null` returns the empty string, which is the arm a
    // stale preview already takes — nothing gets injected.
    const body = readRegularFile(previewPath)?.trimEnd();
    if (body === undefined) return '';
    // A provider switch can leave the previous provider's compact preview on
    // disk while the newly selected graph builds in the background. Never inject
    // that stale preview; the new runner will replace it after a successful scan.
    if ((provider === 'gitnexus' || provider === 'graphify')
      && !body.includes(`Provider: ${provider}`)) return '';
    return `\n${body}\n`;
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
interface ToolchainProbe {
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

/**
 * THE SESSION'S OWN DISCLOSURE that this host's per-role contracts are missing.
 *
 * SessionStart is the one route where a refused role directory used to be
 * completely silent, and the silence was total in both directions:
 * `ensureSessionMaterialization` below returns a BOOLEAN, so the writer's report
 * had nowhere to go, and on the already-current path the writer does not even
 * run — a session that opens against a project refused three weeks ago converged
 * nothing, so there was no report to drop. A healthy session and a refused one
 * were byte-identical.
 *
 * So this reads DISK (role-contract-status.ts) rather than a materialization
 * result, and it is emitted into the SessionStart header — the agent-facing
 * `additionalContext` every branch of runSessionStartInner assembles — which is
 * the channel the token-economy, toolchain and graph banners beside it already
 * use. That is the point of putting it here rather than logging it: this repo's
 * most repeated failure is a disclosure written to a channel nobody reads, and a
 * `console.error` on this path reaches no agent and no user at all.
 *
 * Deliberately NOT gated on whether this session materialized: the condition is
 * persistent and the whole defect was that the quiet path is the common one.
 */
export function roleContractBanner(cwd: string, state: Rec): string {
  if (!state || typeof state !== 'object' || state.onboardingComplete !== true) return '';
  const shortfall = roleContractDirectoryRefusal(cwd);
  if (!shortfall) return '';
  return `[role contracts] ${roleContractShortfallSentence(cwd, shortfall)} `
    + 'Clear that path, then any tool call re-materializes them. Until then file-changing tools are refused '
    + '(`host-role-contracts-unwritable`) and a spawned child must be given its role inline: keep '
    + '`[t1-role: senior-<role>]` as the first prompt line and do NOT tell it to read a contract file.\n';
}

// Converge session-time materialization for an onboarded project. Returns true
// when it (re)materialized AND recorded that in the project state. The one-mcp
// reporter is injected (default no-op).
export function ensureSessionMaterialization(
  cwd: string,
  state: Rec,
  reportOneMcp: (cwd: string, state: Rec, trigger: string) => void = () => {},
): boolean {
  if (isPluginAuthoringRoot(cwd)) return false;
  // Sits beside the authoring-root refusal because it is the same KIND of
  // refusal: not "this project is not ready", but "this project is not ours to
  // write to yet". materializeProjectAssets creates ~50 skill directories with
  // raw fs.mkdirSync and writes AGENTS.md/CLAUDE.md at the project root, none of
  // which the path-addressed fence in shared/fsjson.ts can see (it guards file
  // content under `<project>/.traffic-one/`, and mkdirSync/root files are
  // neither). SessionStart already returns before reaching here when consent is
  // pending, so this is the second lock on the same door — the one that holds
  // when a future caller is added without reading that comment.
  if (!projectWritesPermitted(cwd)) return false;
  if (!state || typeof state !== 'object') return false;
  if (state.onboardingComplete !== true) return false;
  if (!state.stack || !STACK_IDS.has(state.stack as string)) return false;

  // OpenCode's model-pinned agents are user-local and depend on the active
  // host preference snapshot, which is intentionally absent from the shared
  // materialization fingerprint. Refresh them even when project artifacts are
  // already current (catalog/plan/performance changes must not be skipped).
  if (detectHost() === 'opencode') {
    // The outcome is discarded HERE and reported by `roleContractBanner` from
    // disk instead, which is strictly more than this value can say: this call is
    // skipped entirely on every host but OpenCode and on every session where
    // this function returns early, while the banner runs on both SessionStart
    // headers unconditionally. What the type change bought is that a refusal can
    // no longer be MISTAKEN for "nothing to do" — before, this returned a plain
    // number that added a project-local sweep count to a user-local write count.
    try { writeOpenCodeHostAssets(cwd, state, []); } catch { /* best-effort */ }
  }

  // `materializedFromDifferentPluginBuild` is the third term because SessionStart
  // is the EARLIEST point in a session that can notice an upgrade, and the two
  // before it cannot: a project from the previous release has an unchanged stack
  // fingerprint and every tracked file on disk, and `isMaterialized`'s version
  // comparison only moves when a human remembered to bump package.json — 11 of
  // the last 14 content commits in this repo did not (shared/build-provenance.ts).
  //
  // Redundant with the same term in materializeProjectIfNeeded, which every host
  // reaches at UserPromptSubmit — and deliberately kept anyway, because that
  // guarantee has two holes this one covers: a HEADLESS session never fires
  // UserPromptSubmit at all (see modules/onboarding-gate/handler.ts's note on the
  // same fact), and neither does a subagent's session. Converging here means the
  // first tool call of such a session already sees the new build's rules.
  //
  // `materializedFileHashesDrifted` sits beside it for the same reason: a
  // still-present rule/skill/AGENTS.md whose bytes moved is invisible to
  // presence and to the build stamp, and SessionStart is the earliest repair.
  //
  // Safe to make stricter HERE, unlike the spawn gate (modules/agent-model/
  // converge.ts, which deliberately does NOT carry this term): nothing on this
  // path denies. A root that cannot converge — torn, unverified, a source
  // checkout — comes back `skipped`, and the caller treats that exactly like the
  // already-current answer above.
  if (isMaterialized(state)
    && hasMaterializedProjectAssets(cwd, state)
    && !materializedFromDifferentPluginBuild(cwd)
    && !materializedFileHashesDrifted(cwd)) {
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
  // The three stamps are the whole record that this convergence happened:
  // `isMaterialized` reads them next session, and `materializedVersion` is what
  // the version-drift heal compares. A refused write loses all three, so the
  // answer to "is the session's materialization recorded" is no — and the
  // reporter must not announce a state change that is not in the state. The
  // ARTIFACTS survive either way (materializeProjectAssets already wrote them
  // with raw fs), which is why an unrecorded pass is convergent rather than
  // broken: the next session simply re-materializes.
  if (!writeState(cwd, state)) {
    reportOneMcp(cwd, state, 'session materialization not recorded');
    return false;
  }
  reportOneMcp(cwd, state, 'session materialization');
  return true;
}
