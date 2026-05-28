"use strict";
// src/shared/config.ts
// Runtime constants + pitch helpers. Ported from scripts/hook-runtime/config.cjs
// (pluginRoot / cache helpers live in shared/paths.ts).
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
exports.INFRA_CONFIG = exports.WEB_STACKS = exports.RN_STACKS = exports.LEGACY_STACK_ALIASES = exports.STACK_IDS = exports.BUDGET_CHARS = exports.LEGACY_LOCK_FILE = exports.LEGACY_STATE_FILE = exports.STATE_FILE = exports.STATE_BASENAME = exports.STATE_DIR = exports.MAX_STDIN = void 0;
exports.isKnownStack = isKnownStack;
exports.defaultBackendValue = defaultBackendValue;
exports.pitchBackendLabel = pitchBackendLabel;
exports.pitchDeployLabel = pitchDeployLabel;
const path = __importStar(require("path"));
exports.MAX_STDIN = 1024 * 1024;
exports.STATE_DIR = '.traffic-one';
exports.STATE_BASENAME = '.one.json';
exports.STATE_FILE = path.join(exports.STATE_DIR, exports.STATE_BASENAME);
exports.LEGACY_STATE_FILE = '.traffic-one.json';
exports.LEGACY_LOCK_FILE = '.claude-plugin-mode';
exports.BUDGET_CHARS = 9500;
exports.STACK_IDS = new Set(['minimal', 'default', 'custom-frontend', 'custom-backend', 'custom-stack']);
exports.LEGACY_STACK_ALIASES = {
    'react-realtime-monorepo': 'default',
    'react-frontend-only': 'custom-backend',
    'react-native-expo-monorepo': 'custom-frontend',
    'react-native-expo-app': 'custom-frontend',
    'node-backend': 'custom-backend',
    'framework-web': 'custom-frontend',
};
// A stack id is "known" if it's a current id or a recognized legacy alias.
function isKnownStack(stack) {
    return typeof stack === 'string'
        && (exports.STACK_IDS.has(stack) || Object.prototype.hasOwnProperty.call(exports.LEGACY_STACK_ALIASES, stack));
}
exports.RN_STACKS = new Set(['react-native-expo-monorepo', 'react-native-expo-app']);
exports.WEB_STACKS = new Set([
    'default', 'custom-frontend', 'custom-backend', 'custom-stack', 'react-realtime-monorepo', 'react-frontend-only',
]);
exports.INFRA_CONFIG = { ourDeployConfigured: false };
function defaultBackendValue() {
    return 'supabase';
}
function pitchBackendLabel() {
    return 'Supabase (managed Postgres with Auth, Storage, Realtime, and RLS)';
}
function pitchDeployLabel() {
    return exports.INFRA_CONFIG.ourDeployConfigured
        ? '`/deploy` ships it live on our infra in one command'
        : "one short deploy command will ship it (we're wiring up `/deploy` next)";
}
