// src/shared/capabilities/hybrid-target.ts
// When both a web UI and a native UI are on disk and no architectureTarget
// has been chosen, capabilityProfileForProject returns unsupported-hybrid and
// compileArchitecture refuses. The wizard and doctor ask here, with the two
// answers (web-ui / native-ui). Split layouts (apps/web + apps/mobile) also
// get an offer to register those directories as workspace members so each is
// a single-surface project. Single-surface runs stay the design.

import { obj } from '../obj';

import { detectFrontendFramework } from './detect-frontend';
import { detectedNativeFramework } from './detect-backend';
import { capabilityProfileForProject } from './profile';
import { architectureTarget } from './profiles-native';

export interface SplitHybridLayout {
  readonly webRoot: string;
  readonly nativeRoot: string;
}

export interface HybridUiTargetAsk {
  readonly webFramework: string;
  readonly nativeFramework: string;
  /** Distinct on-disk roots — the workspace-member offer applies only then. */
  readonly split: SplitHybridLayout | null;
}

/**
 * Null when a target is already chosen or the project is not a hybrid.
 * The architectureTarget short-circuit avoids a tree walk on every later
 * computeOnboarding call once the user has answered.
 */
export function hybridUiTargetAsk(cwd: string, input: unknown): HybridUiTargetAsk | null {
  const state = obj(input) || {};
  if (architectureTarget(state)) return null;
  const profile = capabilityProfileForProject(cwd, state);
  if (profile.profileId !== 'unsupported-hybrid') return null;
  const frontend = detectFrontendFramework(cwd, state);
  const native = detectedNativeFramework(cwd, state);
  const webRoot = frontend.webRoot || '.';
  const nativeRoot = native.root || '.';
  const split = webRoot !== '.' && nativeRoot !== '.' && webRoot !== nativeRoot
    ? { webRoot, nativeRoot }
    : null;
  return {
    webFramework: profile.uiFrameworks?.web || frontend.frontend,
    nativeFramework: profile.uiFrameworks?.native || native.framework,
    split,
  };
}

export function splitHybridOfferText(split: SplitHybridLayout): string {
  return ` This looks like a split layout (${split.webRoot} + ${split.nativeRoot}). `
    + 'You can also register those directories as Traffic One workspace members so each is its own '
    + 'single-surface project — run setup inside each member after the parent is a workspace container. '
    + 'Traffic One still drives one surface per project.';
}
