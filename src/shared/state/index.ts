// src/shared/state/index.ts
// Aggregating entry for the state machine (mirrors the legacy state.cjs surface).

export * from '../../config/state';
export * from './io';
export * from './toolchain';
export * from './validate';
export * from './canonicalize';
export * from './local-prefs';
export * from './normalize';
export * from './materialization';
export * from './run-agent';
export * from './orchestration-plan';
export * from './web';
