'use strict';

function emptyStats() {
  return {
    messages: 0,
    toolUses: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    firstAt: null,
    lastAt: null,
    byTool: {},        // toolName -> count
    byModel: {},       // model -> { inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens, messages }
    largestMessage: null, // { tokens, timestamp, role }
    modelContextWindow: null,
  };
}

module.exports = { emptyStats };
