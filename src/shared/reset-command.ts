// src/shared/reset-command.ts
// Path anchors and command printers for `traffic-one-reset`, the one sanctioned
// recovery edge out of a `failed` run.
//
// Structured exactly like doctor-command.ts, and for the same reason: the
// spelling the runtime PRINTS and the spelling the gate grammar ADMITS are both
// derived from the one list below, so the product can never hand a wedged user
// a command it then blocks.
//
// This header used to claim the anchors were "self-relative or HOME/XDG derived
// — never a *_PLUGIN_ROOT env var … which would make the exemption's identity
// check forgeable in principle". Both halves were wrong. THREE environment
// variables moved the anchor set, measured — HOME, XDG_STATE_HOME and
// TRAFFIC_ONE_TOOLCHAIN_ROOT, the last two through runnerShimDirs() ->
// toolchain-paths.ts — and "not a *_PLUGIN_ROOT var" was never the property
// that mattered: any env-derived anchor is an input to the hook process, so the
// distinction the sentence drew was between two shapes of the same exposure.
// And there was no identity check to forge. The set was a list of paths;
// nothing asked whether the file at one of them was the shipped runner, so a
// planted file at a moved anchor was admitted.
//
// Both are closed rather than re-worded: the exemption anchors are now
// doctor-command.ts's gateExemptShimDirs() (documentedBinDir only — see its
// header for what was measured before dropping the relocatable one), and
// tool-classify.ts's isGateExemptScript verifies the shim's generated identity
// before admitting it. The shims are still WRITTEN everywhere; the write set
// and the exemption set are deliberately no longer the same set.

import * as path from 'path';

import { gateExemptShimDirs, isDoctorIdArgument, selfRelativePluginRoot } from './doctor-command';
import { documentedBinDir } from './runner-shims';
import { shellQuote } from './shell-quote';

const RESET_RUNNER = 'traffic-one-reset.cjs';

// build-runtime.ts's SHIMS map writes every runner forwarder into the same
// output root as `scripts/doctor.cjs`, in the same pass, so resolving this
// self-relatively from the running runtime is as sound here as it is there.
export function resetScriptPath(): string {
  return path.join(selfRelativePluginRoot(), 'scripts', RESET_RUNNER);
}

// The version-stable shim (runner-shims.ts's RUNNER_SHIMS ships it): its path
// survives a plugin bump, so a host's stored command approval for it is not
// invalidated by an update.
//
// NOT "the form shipped prose prints", which is what this said and what the
// same false claim on resetShimCommand() below said: nothing in `src/**` printed
// a reset command in any spelling. It is an ADMITTED spelling, not a printed
// one — the gate must recognise it because an operator or a stored approval can
// type it, and the product's own printer (resetRecoveryLine) prints the
// self-relative runner instead.
export function resetShimPath(): string {
  return path.join(documentedBinDir(), RESET_RUNNER);
}

// The ONLY spellings a gate may treat as "this is the reset runner" — a subset
// of the ones ensureRunnerShims() writes, and by construction a superset of the
// one resetCommand() prints. See gateExemptShimDirs() for why those are not the
// same set, and isGateExemptScript for the identity check that stands behind
// the path match.
export function gateExemptResetScriptPaths(): readonly string[] {
  return [resetScriptPath(), ...gateExemptShimDirs().map((dir) => path.join(dir, RESET_RUNNER))];
}

// The recovery command as a deny/report may print it, runnable as printed.
//
// THE SELF-RELATIVE RUNNER, not the shim, and this is the one place the two
// spellings are not interchangeable. Both are gate-exempt anchors, but only one
// of them is exempt UNCONDITIONALLY: the self-relative path names the runner
// inside the tree the code doing the printing was loaded from, so
// isGateExemptScript admits it with no content test at all. The shim has to
// pass a byte-comparison against `shimSource()`, and `~/.traffic-one/bin` is
// user-scoped and version-agnostic — one directory shared by every installed
// plugin version, whose contents belong to whichever version ran SessionStart
// last. One template constant moving (a Node-floor bump is exactly that diff)
// is enough: on a machine with two installed versions, the other version's gate
// refuses the shim, and this printer was handing a wedged caller the one
// command that gets refused. Measured with a one-byte floor difference: refused.
//
// The identity check is NOT the thing to relax — a shape test there was a real
// hole and is mutation-covered dead. What was wrong was printing the spelling
// that can be refused when an unrefusable one exists. This is also what
// doctor-command.ts has always done: `doctorCommand()` prints the self-relative
// runner and `doctorShimCommand()` is the separate, approval-stable spelling.
//
// The run id is interpolated raw rather than quoted on purpose: the grammar
// admits only DOCTOR_ID_PATTERN ids (alnum runs joined by single `.`/`_`/`-`),
// and a quoted word would not match the argv the grammar tokenizes.
export function resetCommand(runId: string): string {
  return `node ${shellQuote(resetScriptPath())} --run-id ${runId}`;
}

/**
 * The sentence a gate hands an agent whose run is terminally `failed`.
 *
 * THIS IS THE PRODUCT HALF THAT WAS MISSING. The fail-closed table keeps a
 * mutating row reachable for this command, behind a grammar, an identity check
 * and an anchor suite — and until this function had a caller, nothing in the
 * product ever told an agent or an operator that the recovery exists or what to
 * type. A recovery edge nobody is handed is not a recovery edge; it is an
 * exemption with no beneficiary.
 *
 * THE ID IS CHECKED BY THE GRAMMAR'S OWN AUTHORITY, and that is what makes "we
 * never print a command we block" a property of the printer rather than a hope
 * about its inputs. `isDoctorIdArgument` is the same predicate
 * tool-classify.ts's reset grammar applies to argv word four, so an id it would
 * refuse prints NOTHING here — a deny that renders no command is a deny that
 * cannot hand out a blocked one. Everything else the grammar checks is fixed by
 * this template: the word count, `node`, `--run-id`, and a script path that
 * `gateExemptResetScriptPaths()` contains by construction.
 *
 * Empty string on refusal rather than a placeholder, so an interpolating caller
 * degrades to the prose it already had.
 */
export function resetRecoveryLine(runId: string): string {
  if (!isDoctorIdArgument(runId)) return '';
  return `A terminally \`failed\` run has ONE sanctioned recovery: \`${resetCommand(runId)}\` retires run `
    + `\`${runId}\`, points the project at a fresh successor and carries this run's bounds forward. `
    + 'It destroys nothing — the retired run keeps its directory, its digests and its evidence — and it is the '
    + 'only command that moves the run pointer without minting a verdict.';
}

// The shim spelling of the same command: the path that survives a plugin bump,
// so a host's stored approval for it is not invalidated by an update.
//
// THAT JUSTIFICATION USED TO READ "that is what shipped PROSE prints", and it
// was false: no SKILL.md, rule or runtime string printed a reset command at all
// — this printer and its sibling had zero non-test callers anywhere in `src/`.
// The recovery now has exactly one caller and it is not this spelling:
// `resetRecoveryLine()` above prints the SELF-RELATIVE runner, for the reason
// stated on `resetCommand()` (only that spelling is exempt unconditionally).
// So this function is kept for the case the self-relative path cannot serve — a
// command an operator STORES rather than runs once, where surviving a plugin
// bump is worth the shim's conditional exemption — and it is deliberately not
// what a deny prints. If prose ever does print it, prose must also say what to
// do when a stale install's shim is refused: start a session (SessionStart
// rewrites the shim from the running version) or run it outside a session,
// where no hook fires.
export function resetShimCommand(runId: string): string {
  return `node ${shellQuote(resetShimPath())} --run-id ${runId}`;
}
