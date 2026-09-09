// src/shared/capabilities/index.ts
// Capability profile barrel: implementation lives in the sibling modules;
// this index re-exports the original public surface.


export {
  CAPABILITY_SCHEMA_VERSION,
  STRUCTURAL_PROFILE_IDS,
  type ArchitectureTargetSurface,
  type CapabilityProfileV1,
  type ProjectSurface,
  type ShadcnAdapterId,
  type StructuralProfileId,
  type WebUiSystemV1,
} from './types';
export {
  detectFrontendFramework,
} from './detect-frontend';
export {
  frontendArtifactsPresent,
} from './web-roots';
export {
  defaultStateForStack,
} from './detect-backend';
export {
  capabilityProfileForProject,
} from './profile';
export {
  hybridUiTargetAsk,
  splitHybridOfferText,
  type HybridUiTargetAsk,
  type SplitHybridLayout,
} from './hybrid-target';
export {
  profileSupportsShadcnWorkspace,
  resolveWebUiSystem,
  uiLibraryFromPrompt,
} from './ui-system';
export {
  eligibleRolesForProfile,
  profileHasNativeUi,
  profileHasWebUi,
  runtimeCapabilityState,
  runtimeCapabilityStateFromProfile,
  skillBucketsForState,
} from './queries';
