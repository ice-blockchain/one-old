'use strict';

const {
  walkMarkdownFiles,
  RULES_ROOT,
  AGENTS_ROOT,
  renderAgentRule,
} = require('./_helpers.cjs');
const { renderCursorRule } = require('./renderCursorRule.cjs');

function generatedRuleDocuments() {
  const ruleDocs = walkMarkdownFiles(RULES_ROOT).map((source) => renderCursorRule(source));
  const agentDocs = walkMarkdownFiles(AGENTS_ROOT).map((source) => renderAgentRule(source));
  return [...ruleDocs, ...agentDocs];
}

module.exports = { generatedRuleDocuments };
