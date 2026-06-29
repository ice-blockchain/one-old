// src/test-environment/core/preseed.ts
// "Onboarding pre-completed": produce an AUTHENTIC .one.json + preferences.json
// for a case by reusing the REAL source writers (writeState splits local prefs
// out automatically; mergeProjectPrefs stamps toolchain; writeGlobalCodeGraphProvider
// sets the machine-wide provider). The caller MUST run this inside withCaseEnv so
// every src/ writer lands in the isolated per-case paths.

import type { Rec } from '../../shared/obj';
import { writeState } from '../../shared/state/normalize';
import { mergeProjectPrefs, writeGlobalCodeGraphProvider } from '../../shared/state/local-prefs';
import { stateTimestamp } from '../../shared/state/io';
import { teamModeForLevel } from '../../shared/performance';
import type { PreSeed } from './types';

export function preseed(cwd: string, ps: PreSeed): void {
  const level = ps.performance ?? 'balanced';
  const teamMode = ps.team?.mode ?? teamModeForLevel(level);
  const teamApproved = ps.team?.approved ?? teamMode === 'subagents';

  // 1) Machine-wide code-graph provider first, so readEffectiveState injects it.
  if (ps.codeGraphProvider) writeGlobalCodeGraphProvider(ps.codeGraphProvider);

  // 2) Full shared state. writeState() canonicalizes the stack, normalizes, and
  //    routes openCode/performance/team into preferences.json via
  //    splitLocalPreferences — so a single call yields authentic split files.
  const state: Rec = {
    mode: ps.mode,
    confirmed: true,
    onboardingComplete: true,
  };
  if (ps.stack) state.stack = ps.stack;
  if (ps.frontend) state.frontend = ps.frontend;
  if (ps.backend) state.backend = ps.backend;
  if (ps.mobile) {
    state.mobile = { enabled: ps.mobile.enabled, framework: ps.mobile.framework, source: 'prompted' };
  }
  if (ps.performance) state.performance = { level, source: 'prompted' };

  const team: Rec = { mode: teamMode, source: 'prompted' };
  if (teamApproved) team.approved = true;
  if (ps.team?.overrides) team.overrides = { ...ps.team.overrides };
  state.team = team;

  if (ps.openCode !== undefined) {
    state.openCode = { enabled: ps.openCode, source: 'prompted', decidedAt: stateTimestamp() };
    // Durable authorization record (stays in .one.json; spawn gates read it).
    state.openCodeDelegation = { approved: ps.openCode, source: 'onboarding', decidedAt: stateTimestamp() };
  }

  if (ps.projectContext) {
    state.projectContext = {
      source: 'prompted',
      originalPrompt: ps.projectContext.originalPrompt,
      summary: ps.projectContext.summary ?? ps.projectContext.originalPrompt,
      answers: {},
      collectedAt: stateTimestamp(),
    };
  }

  writeState(cwd, state);

  // 3) Stamp an installed OpenCode toolchain version — delegation is double-gated
  //    (openCode.enabled AND toolchain.opencode.installedVersion). writeState does
  //    not set the install stamp, so do it explicitly when the case wants "on".
  if (ps.openCodeInstalled) {
    mergeProjectPrefs(cwd, {
      toolchain: {
        opencode: { installedVersion: '9.9.9-test', installedAt: stateTimestamp(), binPath: '/tmp/opencode-test-bin' },
      },
    });
  }
}
