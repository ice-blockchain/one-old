import * as path from 'path';

import { documentedBinDir, runnerShimDirs } from './runner-shims';
import { shellQuote } from './shell-quote';

// The known wart this closes: pluginRootInfo() can resolve an 'unverified'
// root — one of the four *_PLUGIN_ROOT env vars (paths.ts's PLUGIN_ROOT_ENV)
// set to a stale or wrong path, which `pluginRoot()` still returns UNCHANGED
// (its own contract: "never throws… only a content consumer may refuse to
// treat it as authoritative" — see paths.ts). A naive
// `<pluginRoot()>/scripts/doctor.cjs` in that state silently names a file
// that does not exist: the one recovery command the product hands a stuck
// user would itself fail to launch, on the exact class of failure ("my
// plugin root is broken") doctor exists to diagnose.
//
// The fix leans on one structural fact: build-runtime.ts's SHIMS map writes
// `scripts/hook-runtime.cjs` and `scripts/doctor.cjs` together, in the same
// pass, as siblings under the same output root (see SHIMS in
// src/build/build-runtime.ts) — never one without the other. So wherever
// *this* module is actually executing from (doctor-command.ts itself,
// compiled 1:1 to dist/scripts/shared/doctor-command.js), a doctor.cjs two
// directories up is guaranteed to exist, because the running process could
// not have loaded this code otherwise. That self-relative resolution is
// exactly pluginRootInfo()'s own env-var-absent default (see its header:
// "src/shared/paths.ts -> ../../ = source root; dist/scripts/shared/paths.js
// -> ../../ = generated plugin root") — recomputed independently here so a
// stale env override can never shadow the one root known to be real.
//
// A source checkout has no scripts/doctor.cjs until it is built — that is
// pluginRootInfo()'s own documented, unrelated case, not this wart.
export function selfRelativePluginRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

// Self-relative UNCONDITIONALLY, never through pluginRootInfo(), because this
// path is also the gate's exemption anchor (gateExemptDoctorScriptPaths below)
// and the two must not be able to disagree. Honouring an env-supplied root
// here reintroduced the exact defect this whole area exists to remove: hosts
// DO set CLAUDE_PLUGIN_ROOT/CODEX_PLUGIN_ROOT, so a root that differs from the
// running code made doctorCommand() print `node <that root>/scripts/doctor.cjs`
// while the grammar — correctly refusing to trust env — denied it. The product
// told a stuck user to run a command the product then blocked.
//
// Nothing is lost by ignoring env. A host launches the hook runtime FROM the
// plugin directory it installed, so in every real install the env root and the
// self-relative root are the same directory. They diverge only when an
// override points somewhere the running code does not live — and then the
// self-relative path is the correct one to print, because it names the doctor
// that is actually executing.
export function doctorScriptPath(): string {
  return path.join(selfRelativePluginRoot(), 'scripts', 'doctor.cjs');
}

// The version-stable shim (runner-shims.ts's RUNNER_SHIMS ships `doctor.cjs`),
// which is the form shipped prose hands an agent: its path never changes
// across plugin bumps, so a host's stored command approval survives an update.
//
// documentedBinDir(), not stableBinDir(): this is the path we PRINT, and every
// shipped spelling of it is the hardcoded literal `~/.traffic-one/bin/
// doctor.cjs`. Following XDG_STATE_HOME/TRAFFIC_ONE_TOOLCHAIN_ROOT here made
// the printed path and the documented one diverge on any machine that sets
// either — the same prose-versus-runtime split doctorScriptPath() already
// closed on the plugin-root side.
export function doctorShimPath(): string {
  return path.join(documentedBinDir(), 'doctor.cjs');
}

// The ONLY spellings a gate may treat as "this is doctor, let it through" —
// and, by construction, exactly the spellings ensureRunnerShims() writes and
// the runtime ever prints (doctorCommand / doctorShimCommand). Deriving them
// from this one list is what makes "we never tell a user to run a command we
// block" a structural property rather than something several functions have to
// keep agreeing about.
//
// No entry reads a *_PLUGIN_ROOT env var. Env is an INPUT to the hook process,
// so anchoring a gate exemption on it would make the exemption's identity check
// forgeable in principle (point a root at a directory holding an arbitrary
// `scripts/doctor.cjs`):
//   1. doctorScriptPath() — `__dirname`-relative, so it names the doctor that
//      ships with the runtime executing this check. build-runtime.ts emits
//      scripts/hook-runtime.cjs and scripts/doctor.cjs together as siblings,
//      so if this code loaded, that file is there.
//   2. every runnerShimDirs() entry — `~/.traffic-one/bin/doctor.cjs` (the
//      literal all shipped prose prints) plus, on a machine that relocated its
//      state, <state-home>/bin/doctor.cjs. Both come from HOME/XDG only
//      (toolchain-paths.ts), and ensureRunnerShims() writes BOTH, so the set
//      the grammar admits is exactly the set that exists on disk.
export function gateExemptDoctorScriptPaths(): readonly string[] {
  return [doctorScriptPath(), ...runnerShimDirs().map((dir) => path.join(dir, 'doctor.cjs'))];
}

// The plugin-root runner remains available even when ~/.traffic-one itself is
// the malformed state being diagnosed and the stable ~/.traffic-one/bin shim
// therefore cannot be read or created.
export function doctorCommand(): string {
  return `node ${shellQuote(doctorScriptPath())}`;
}

// The shim spelling of the same command, for prose that wants the path that
// survives a plugin bump.
export function doctorShimCommand(): string {
  return `node ${shellQuote(doctorShimPath())}`;
}

// An opaque id (a run id for `--run`, a Codex session id for `--session`) as it
// may appear on an argv the doctor gate-exemption admits. Bounded to the
// charset run-paths.ts's safePathSegment already treats as a safe on-disk
// segment (run ids are epoch-ms strings by construction — runIdNow(); Codex
// session ids are UUIDs), and shaped as alnum runs joined by SINGLE `.`/`_`/`-`
// separators, so every traversal-flavoured spelling a flat character class
// would have waved through (`a..-..-..`, `..`, `a..b`, a trailing dot) fails
// here instead of relying on the downstream reader to be safe. Anchored on
// alnum at both ends, which also means no `-`-prefixed flag (`--bundle`) can
// ever parse as an id.
//
// This is a GATE grammar, not a validity check — doctor's own `--run` handling
// tolerates any string (including one that names no run) and reports "not
// found"; this only decides whether the shell command is EXEMPT from other
// gates, never whether the id is real. It lives HERE, beside the command
// PRINTERS, rather than in tool-classify.ts beside the single consumer,
// because the two must not be able to disagree: a report that interpolates an
// id the grammar then rejects is the same "we printed a command we block"
// defect this module exists to make impossible.
const DOCTOR_ID_PATTERN = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const DOCTOR_ID_MAX_LENGTH = 160;

export function isDoctorIdArgument(value: string): boolean {
  return value.length <= DOCTOR_ID_MAX_LENGTH && DOCTOR_ID_PATTERN.test(value);
}

// The bug-report command, runnable as printed. Falls back to the bare
// `--bundle` form for an id the grammar would reject: `--bundle` alone already
// resolves the project's currentRunId (runners/doctor/index.ts), so the
// operator still gets a run-scoped bundle instead of a command the gate denies.
export function doctorBundleCommand(runId: string | null): string {
  const base = doctorShimCommand();
  return runId && isDoctorIdArgument(runId) ? `${base} --run ${runId} --bundle` : `${base} --bundle`;
}
