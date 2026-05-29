"use strict";
// src/shared/performance-config.ts
// Per-performance-level defaults. Ported 1:1 from
// scripts/hook-runtime/performance-config.cjs. `tier` is a host-agnostic
// capability tier (see model-tiers); the model id resolves per host at spawn.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PERFORMANCE_CONFIG = exports.PERFORMANCE_LEVEL_IDS = void 0;
exports.PERFORMANCE_LEVEL_IDS = new Set(['low', 'balanced', 'high']);
exports.PERFORMANCE_CONFIG = {
    low: {
        teamMode: 'main-agent',
        useRoadmapChecklist: true,
        agents: {},
    },
    balanced: {
        teamMode: 'subagents',
        useRoadmapChecklist: false,
        agents: {
            'senior-architect': { tier: 'balanced' },
            'senior-frontend': { tier: 'balanced' },
            'senior-backend': { tier: 'balanced' },
            'senior-reviewer': { tier: 'balanced' },
            'senior-tester': { tier: 'cheapest' },
            'senior-shipper': { tier: 'balanced' },
        },
    },
    high: {
        teamMode: 'subagents',
        useRoadmapChecklist: false,
        agents: {
            'senior-architect': { tier: 'highest' },
            'senior-frontend': { tier: 'highest' },
            'senior-backend': { tier: 'highest' },
            'senior-reviewer': { tier: 'highest' },
            'senior-tester': { tier: 'cheapest' },
            'senior-shipper': { tier: 'balanced' },
        },
    },
};
