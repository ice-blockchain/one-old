// Dependency-free, runtime-owned QA evidence primitives. The bundled QA runner
// uses these helpers to hash the actual build output, emit Playwright evidence,
// and derive Lighthouse evidence from the raw Lighthouse JSON artifact. The
// verifier recomputes every hash from disk; QaReportV2 booleans are never enough.
//
// Barrel: the implementation lives in the -types/-core/-images/-evidence
// siblings; this file re-exports exactly the original public surface so the
// existing import specifiers stay unchanged.

export {
  QA_BUILD_MANIFEST_MAX_BYTES,
  QA_BUILD_MANIFEST_MAX_FILES,
  QA_BUILD_MANIFEST_SCHEMA_VERSION,
  QA_LIGHTHOUSE_EVIDENCE_SCHEMA_VERSION,
  QA_MACHINE_EVIDENCE_SCHEMA_VERSION,
  QA_NATIVE_EVIDENCE_SCHEMA_VERSION,
  type BuildManifestFileV1,
  type BuildOutputManifestV1,
  type DecodedImageInfo,
  type LighthouseArtifactSummaryV1,
  type QaLighthouseEvidenceV1,
  type QaMachineEvidenceV1,
  type QaMachineRouteEvidenceV1,
  type QaMachineViewportEvidenceV1,
  type QaNativeArtifactV1,
  type QaNativeEvidenceV1,
  type QaNativeMachineParserV1,
  type QaNativeTestSummaryV1,
} from './types';
export {
  computeBuildOutputManifest,
  contentHash,
  readJsonFile,
} from './core';
export { decodeImageFile } from './images';
export {
  combineNativeSummaries,
  createQaLighthouseEvidence,
  createQaMachineEvidence,
  createQaNativeEvidence,
  parseAndroidJUnitXml,
  parseQaLighthouseEvidence,
  parseQaMachineEvidence,
  parseQaNativeEvidence,
  parseXcodeResultSummary,
  readLighthouseArtifact,
} from './evidence';
