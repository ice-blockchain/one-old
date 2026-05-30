"use strict";
// src/shared/model-tiers.ts
// Host-agnostic capability tiers. Ported 1:1 from scripts/hook-runtime/model-tiers.cjs.
// To adopt newer models, edit ONLY HOST_MODELS.
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_MODELS = exports.HOST_IDS = exports.TIER_IDS = void 0;
exports.canonicalTier = canonicalTier;
exports.canonicalHost = canonicalHost;
exports.resolveModel = resolveModel;
exports.tierModelTable = tierModelTable;
exports.TIER_IDS = ['highest', 'balanced', 'cheapest'];
const TIER_ALIASES = {
    max: 'highest', maximum: 'highest', top: 'highest', best: 'highest', high: 'highest',
    mid: 'balanced', medium: 'balanced', standard: 'balanced', default: 'balanced', balance: 'balanced',
    low: 'cheapest', min: 'cheapest', minimal: 'cheapest', cheap: 'cheapest', fast: 'cheapest', lite: 'cheapest',
};
exports.HOST_IDS = ['claude', 'codex', 'cursor'];
exports.HOST_MODELS = {
    claude: { highest: 'opus', balanced: 'sonnet', cheapest: 'haiku' },
    cursor: { highest: 'opus', balanced: 'sonnet', cheapest: 'haiku' },
    codex: { highest: 'gpt-5.5', balanced: 'gpt-5', cheapest: 'gpt-5-mini' },
};
function canonicalTier(tier) {
    if (typeof tier !== 'string')
        return null;
    const value = tier.trim().toLowerCase();
    if (exports.TIER_IDS.includes(value))
        return value;
    return TIER_ALIASES[value] ?? null;
}
function canonicalHost(host) {
    if (typeof host !== 'string')
        return 'claude';
    const value = host.trim().toLowerCase();
    return exports.HOST_IDS.includes(value) ? value : 'claude';
}
function resolveModel(tier, host) {
    const canonical = canonicalTier(tier);
    if (!canonical)
        return null;
    return exports.HOST_MODELS[canonicalHost(host)][canonical];
}
function tierModelTable(tier) {
    const canonical = canonicalTier(tier);
    if (!canonical)
        return null;
    return {
        tier: canonical,
        claude: exports.HOST_MODELS.claude[canonical],
        codex: exports.HOST_MODELS.codex[canonical],
        cursor: exports.HOST_MODELS.cursor[canonical],
    };
}
