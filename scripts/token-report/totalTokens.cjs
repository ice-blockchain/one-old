'use strict';

function totalTokens(stats) {
  return stats.inputTokens + stats.cacheCreationInputTokens + stats.cacheReadInputTokens + stats.outputTokens;
}

module.exports = { totalTokens };
