'use strict';

function cacheHitRate(stats) {
  const cacheReads = stats.cacheReadInputTokens;
  const totalInput = stats.inputTokens + stats.cacheCreationInputTokens + stats.cacheReadInputTokens;
  if (totalInput === 0) return 0;
  return (cacheReads / totalInput) * 100;
}

module.exports = { cacheHitRate };
