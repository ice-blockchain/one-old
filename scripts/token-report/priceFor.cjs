'use strict';

const { PRICING } = require('./_helpers.cjs');

function priceFor(model) {
  if (!model || typeof model !== 'string') return PRICING._default;
  // Match longest prefix first.
  const matches = Object.keys(PRICING).filter((k) => k !== '_default' && model.startsWith(k));
  if (matches.length === 0) return PRICING._default;
  matches.sort((a, b) => b.length - a.length);
  return PRICING[matches[0]];
}

module.exports = { priceFor };
