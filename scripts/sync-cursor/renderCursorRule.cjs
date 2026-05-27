'use strict';

const path = require('path');

const {
  readText,
  splitFrontmatter,
  parseFrontmatter,
  relative,
  titleFromBody,
  shouldAlwaysApply,
  CURSOR_RULES_ROOT,
  slugForSource,
  cursorFrontmatter,
} = require('./_helpers.cjs');

function renderCursorRule(sourcePath) {
  const sourceText = readText(sourcePath);
  const { frontmatterLines, body } = splitFrontmatter(sourceText);
  const { paths, description: frontmatterDescription, alwaysApply: explicitAlwaysApply } = parseFrontmatter(frontmatterLines);
  const sourceRelative = relative(sourcePath);
  const fallbackTitle = path.basename(sourcePath, '.md').replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const title = titleFromBody(body, fallbackTitle);
  const description = frontmatterDescription || `${title}. Generated from ${sourceRelative}.`;
  const alwaysApply = shouldAlwaysApply(sourcePath, paths, explicitAlwaysApply);
  const outputPath = path.join(CURSOR_RULES_ROOT, `${slugForSource(sourcePath)}.mdc`);

  const contentLines = [
    `<!-- GENERATED FROM: ${sourceRelative}; run \`node scripts/sync-cursor.cjs\` to update. -->`,
    ...cursorFrontmatter(description, paths, alwaysApply),
    '',
    body.trimEnd(),
    '',
  ];

  return { sourcePath, outputPath, content: contentLines.join('\n') };
}

module.exports = { renderCursorRule };
