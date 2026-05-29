"use strict";
// src/shared/state/constants.ts
// Canonical id sets, alias maps, and staleness windows for the state machine.
// Ported 1:1 from scripts/hook-runtime/state/constants.cjs — behavior must match.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VALID_AGENT_ROLES = exports.PENDING_AGENT_CLAIM_STALE_MS = exports.SUBAGENT_STALE_MS = exports.KNOWN_ADDONS = exports.TEAM_SOURCE_ALIASES = exports.TEAM_MODE_ALIASES = exports.OPEN_CODE_SOURCE_IDS = exports.PERFORMANCE_SOURCE_IDS = exports.PERFORMANCE_LEVEL_IDS = exports.TEAM_SOURCE_IDS = exports.TEAM_MODE_IDS = exports.MOBILE_SOURCE_ALIASES = exports.MOBILE_SOURCE_IDS = exports.MOBILE_FRAMEWORK_IDS = exports.BACKEND_IDS = exports.FRONTEND_IDS = exports.RUNS_REL_DIR = void 0;
const path = __importStar(require("path"));
exports.RUNS_REL_DIR = path.join('.traffic-one', 'runs');
exports.FRONTEND_IDS = new Set(['none', 'react-vite', 'nextjs', 'vue', 'svelte', 'angular', 'astro', 'solid', 'remix', 'other']);
exports.BACKEND_IDS = new Set([
    'none', 'supabase', 'external-api', 'node', 'nestjs', 'python', 'django', 'fastapi',
    'go', 'rust', 'java', 'kotlin', 'php', 'laravel', 'dotnet', 'firebase', 'mongo', 'other',
]);
exports.MOBILE_FRAMEWORK_IDS = new Set(['ionic-capacitor', 'react-native-expo', 'none']);
exports.MOBILE_SOURCE_IDS = new Set(['explicit', 'prompted', 'none']);
exports.MOBILE_SOURCE_ALIASES = new Map([
    ['asked', 'prompted'],
    ['chat', 'prompted'],
    ['fallback-chat', 'prompted'],
    ['onboarding', 'prompted'],
    ['popup', 'prompted'],
    ['prompt', 'prompted'],
    ['user-onboarding', 'prompted'],
    ['user-prompted', 'prompted'],
    ['disabled', 'none'],
    ['n/a', 'none'],
    ['na', 'none'],
    ['not-applicable', 'none'],
    ['web', 'none'],
    ['web-only', 'none'],
    ['explicit-user-request', 'explicit'],
    ['explicitly-requested', 'explicit'],
    ['requested', 'explicit'],
    ['user-requested', 'explicit'],
]);
exports.TEAM_MODE_IDS = new Set(['subagents', 'main-agent']);
exports.TEAM_SOURCE_IDS = new Set(['prompted', 'explicit', 'unavailable']);
exports.PERFORMANCE_LEVEL_IDS = new Set(['low', 'balanced', 'high']);
exports.PERFORMANCE_SOURCE_IDS = new Set(['prompted', 'explicit']);
// OpenCode "token economy" opt-in. Same source vocabulary as team/performance.
exports.OPEN_CODE_SOURCE_IDS = new Set(['prompted', 'explicit', 'unavailable']);
exports.TEAM_MODE_ALIASES = new Map([
    ['enabled', 'subagents'],
    ['true', 'subagents'],
    ['yes', 'subagents'],
    ['run-team', 'subagents'],
    ['team', 'subagents'],
    ['traffic-one', 'subagents'],
    ['traffic-one-team', 'subagents'],
    ['subagent', 'subagents'],
    ['subagents-only', 'subagents'],
    ['disabled', 'main-agent'],
    ['false', 'main-agent'],
    ['no', 'main-agent'],
    ['main', 'main-agent'],
    ['main-agent-only', 'main-agent'],
    ['manual', 'main-agent'],
    ['same-thread', 'main-agent'],
]);
exports.TEAM_SOURCE_ALIASES = new Map([
    ['chat', 'prompted'],
    ['fallback-chat', 'prompted'],
    ['onboarding', 'prompted'],
    ['popup', 'prompted'],
    ['prompt', 'prompted'],
    ['user-onboarding', 'prompted'],
    ['blocked', 'unavailable'],
    ['not-available', 'unavailable'],
    ['runtime-unavailable', 'unavailable'],
    ['explicit-user-request', 'explicit'],
    ['requested', 'explicit'],
    ['user-requested', 'explicit'],
]);
// Supabase add-on approval gate vocabulary. Statuses: "pending" | "approved" | "skipped".
exports.KNOWN_ADDONS = new Set([
    'storage', 'auth', 'realtime', 'vector', 'pg_cron', 'pg_net', 'edge_functions',
]);
// Subagent freshness windows.
exports.SUBAGENT_STALE_MS = 30 * 60 * 1000;
exports.PENDING_AGENT_CLAIM_STALE_MS = 5 * 60 * 1000;
exports.VALID_AGENT_ROLES = new Set([
    'senior-architect',
    'senior-frontend',
    'senior-backend',
    'senior-reviewer',
    'senior-tester',
    'senior-shipper',
]);
