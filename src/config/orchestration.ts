// src/config/orchestration.ts
// Master switch for the LLM-authority orchestration layer (per-prompt directive +
// run-scoped plan declaration + spawn-gate/subagent enforcement). When disabled the
// feature is inert: the directive is never injected, the spawn gate ignores any
// declared plan (static per-role tiers as before), and subagent rule/skill scoping
// falls back to the static role-scoped bundle. Mirrors the TRAFFIC_ONE_DISABLE_ONE_MCP
// env kill-switch (see config/reporting.ts) — flip the const OR set the env var.

export const ORCHESTRATION_CONFIG = { enabled: true } as const;

// The ONE helper every new orchestration code path reads. Env var wins over the
// source flag so ops can disable the feature without a rebuild.
export function orchestrationEnabled(): boolean {
  if (process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION === '1') return false;
  return ORCHESTRATION_CONFIG.enabled;
}
