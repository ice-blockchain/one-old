'use strict';

const { priceFor } = require('./priceFor.cjs');

function estimateCost(stats) {
  let total = 0;
  for (const [model, m] of Object.entries(stats.byModel || {})) {
    const p = priceFor(model);
    total += (m.inputTokens / 1_000_000) * p.input;
    total += (m.cacheCreationInputTokens / 1_000_000) * p.cacheWrite;
    total += (m.cacheReadInputTokens / 1_000_000) * p.cacheRead;
    total += (m.outputTokens / 1_000_000) * p.output;
  }
  return total;
}

module.exports = { estimateCost };
