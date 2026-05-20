'use strict';

// scripts/hook-runtime/model-tiers.cjs
// Host-agnostic capability tiers. Performance levels (low/balanced/high) assign
// each agent a TIER; the resolver then picks the right model identifier for the
// active host (claude / codex / cursor).
//
// FUTURE-PROOFING: to adopt newer models, edit ONLY the HOST_MODELS table below.
// Claude/Cursor use the Anthropic family aliases (opus/sonnet/haiku) which the
// host auto-resolves to the newest version of that family — no edits needed when
// a new Opus/Sonnet/Haiku ships. Update the Codex row when OpenAI ships newer
// coding models.

// Canonical tiers, ordered most → least capable.
const TIER_IDS = ['highest', 'balanced', 'cheapest'];

// Common variations normalise to a canonical tier.
const TIER_ALIASES = {
  max: 'highest', maximum: 'highest', top: 'highest', best: 'highest', high: 'highest',
  mid: 'balanced', medium: 'balanced', standard: 'balanced', default: 'balanced', balance: 'balanced',
  low: 'cheapest', min: 'cheapest', minimal: 'cheapest', cheap: 'cheapest', fast: 'cheapest', lite: 'cheapest',
};

const HOST_IDS = ['claude', 'codex', 'cursor'];

// Per-host model identifier for each tier. This is the single source of truth.
const HOST_MODELS = {
  claude: { highest: 'opus',        balanced: 'sonnet', cheapest: 'haiku' },
  cursor: { highest: 'opus',        balanced: 'sonnet', cheapest: 'haiku' },
  codex:  { highest: 'gpt-5-codex', balanced: 'gpt-5',  cheapest: 'gpt-5-mini' },
};

function canonicalTier(tier) {
  if (typeof tier !== 'string') return null;
  const t = tier.trim().toLowerCase();
  if (TIER_IDS.includes(t)) return t;
  return TIER_ALIASES[t] || null;
}

function canonicalHost(host) {
  if (typeof host !== 'string') return 'claude';
  const h = host.trim().toLowerCase();
  return HOST_IDS.includes(h) ? h : 'claude';
}

// Resolve a tier to a concrete model id for one host. Returns null for an
// unknown tier.
function resolveModel(tier, host) {
  const t = canonicalTier(tier);
  if (!t) return null;
  return HOST_MODELS[canonicalHost(host)][t];
}

// Returns { tier, claude, codex, cursor } — the per-host models for a tier.
// Hook text is injected into every host, so directives show all columns and the
// orchestrator picks its own host's value.
function tierModelTable(tier) {
  const t = canonicalTier(tier);
  if (!t) return null;
  return {
    tier: t,
    claude: HOST_MODELS.claude[t],
    codex: HOST_MODELS.codex[t],
    cursor: HOST_MODELS.cursor[t],
  };
}

module.exports = {
  TIER_IDS,
  TIER_ALIASES,
  HOST_IDS,
  HOST_MODELS,
  canonicalTier,
  canonicalHost,
  resolveModel,
  tierModelTable,
};
