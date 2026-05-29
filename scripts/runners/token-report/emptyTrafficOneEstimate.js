"use strict";
// src/runners/token-report/emptyTrafficOneEstimate.ts
// Ported 1:1 from token-report/emptyTrafficOneEstimate.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyTrafficOneEstimate = emptyTrafficOneEstimate;
function emptyTrafficOneEstimate() {
    return { directToolOutputTokens: 0, directToolOutputs: 0, instructionApproxTokens: 0 };
}
