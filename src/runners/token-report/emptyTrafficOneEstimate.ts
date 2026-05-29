// src/runners/token-report/emptyTrafficOneEstimate.ts
// Ported 1:1 from token-report/emptyTrafficOneEstimate.cjs.

export interface TrafficOneEstimate {
  directToolOutputTokens: number;
  directToolOutputs: number;
  instructionApproxTokens: number;
}

export function emptyTrafficOneEstimate(): TrafficOneEstimate {
  return { directToolOutputTokens: 0, directToolOutputs: 0, instructionApproxTokens: 0 };
}
