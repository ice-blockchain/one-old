// src/shared/doctor-unblock-deny.ts
// Never-overridable PreToolUse refuse for an agent-issued `doctor --unblock`.
// One helper, called from onboarding-gate (every host's shell PreToolUse) and
// plan-write (hosts whose Bash path does not go through onboarding-gate). The
// predicate is tool-classify.ts `namesDoctorUnblock`; this module only
// assembles the deny. `--unblock` stays absent from isTrafficOneDoctorCommand.

import { deny } from '../core/result';
import type { HookResult } from '../core/types';
import { pluginRoot } from './paths';
import { makeSkillBlock } from './skill-block';
import { commandFromToolInput, isShellToolName, namesDoctorUnblock, normalizedToolName } from './tool-classify';

const skillBlock = makeSkillBlock(pluginRoot);

function isShellForUnblockDeny(toolName: unknown): boolean {
  if (isShellToolName(toolName)) return true;
  return /^(Shell|Terminal)$/i.test(normalizedToolName(toolName));
}

export function doctorUnblockAgentMintDenial(toolName: unknown, toolInput: unknown): HookResult | null {
  if (!isShellForUnblockDeny(toolName)) return null;
  if (!namesDoctorUnblock(commandFromToolInput(toolInput))) return null;
  return deny(
    skillBlock('onboarding-gate', 'doctor-unblock-agent-mint', {},
      'traffic-one — blocked: an agent must not mint its own operator override. `doctor --unblock` writes a token under ~/.traffic-one/overrides that lifts a gate for this run. That is a bypass, not a recovery. If a human intends to override, they run doctor themselves in their own terminal — not through this tool call, and not wrapped in expect, script, python pty, bash -c, or any other helper. Read-only doctor (`--bundle`, `--run`, `--session`) remains available.'),
    { denyId: 'doctor-unblock-agent-mint' },
  );
}
