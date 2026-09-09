// src/shared/security-check-command.ts
// Path anchors and command printers for `security-check-runner`, the one
// sanctioned shell writer of `.traffic-one/.one.json` (deploy `--stamp`).
//
// Structured like doctor-command.ts / reset-command.ts: the spelling the
// runtime PRINTS and the spelling the gate grammar ADMITS are both derived
// from the list below, so the product cannot hand a shipper a command it then
// blocks. The write set and the exemption set are not the same set — see
// doctor-command.ts's gateExemptShimDirs() for why, and tool-classify.ts's
// isGateExemptScript for the identity check that stands behind the path match.

import * as path from 'path';

import { gateExemptShimDirs, selfRelativePluginRoot } from './doctor-command';
import { documentedBinDir } from './runner-shims';
import { shellQuote } from './shell-quote';

const SECURITY_CHECK_RUNNER = 'security-check-runner.cjs';
const SECURITY_CHECK_REL = `scripts/${SECURITY_CHECK_RUNNER}`;

// build-runtime.ts's SHIMS map writes this forwarder into the same output root
// as `scripts/doctor.cjs`, in the same pass, so resolving it self-relatively
// from the running runtime is as sound here as it is there.
export function securityCheckScriptPath(): string {
  return path.join(selfRelativePluginRoot(), 'scripts', SECURITY_CHECK_RUNNER);
}

// The version-stable shim (runner-shims.ts's RUNNER_SHIMS ships it): its path
// survives a plugin bump, and it is the form shipped prose hardcodes
// (`node ~/.traffic-one/bin/security-check-runner.cjs --strict --stamp`).
export function securityCheckShimPath(): string {
  return path.join(documentedBinDir(), SECURITY_CHECK_RUNNER);
}

// The ONLY spellings a gate may treat as "this is the security-check runner" —
// a subset of the ones ensureRunnerShims() writes, and by construction a
// superset of the one securityCheckStampCommand() prints.
export function gateExemptSecurityCheckScriptPaths(): readonly string[] {
  return [
    securityCheckScriptPath(),
    ...gateExemptShimDirs().map((dir) => path.join(dir, SECURITY_CHECK_RUNNER)),
  ];
}

export function securityCheckRunnerRel(): string {
  return SECURITY_CHECK_REL;
}

// The deploy remediation as shipped prose prints it, runnable as printed.
// Self-relative: that spelling is exempt unconditionally (it is the runner
// inside the tree this code was loaded from). The shim has to pass a
// byte-comparison against `shimSource()`.
export function securityCheckStampCommand(): string {
  return `node ${shellQuote(securityCheckScriptPath())} --strict --stamp`;
}

export function securityCheckStampShimCommand(): string {
  return `node ${shellQuote(securityCheckShimPath())} --strict --stamp`;
}
