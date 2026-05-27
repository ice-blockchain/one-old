'use strict';

const { hasCommand } = require('./_helpers.cjs');

function missingToolInstallPrompt(missingTools, cwd = process.cwd()) {
  const brew = hasCommand('brew', cwd, process.env);
  const installCommand = brew.found
    ? `brew install ${missingTools.join(' ')}`
    : '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n'
      + `brew install ${missingTools.join(' ')}`;

  return [
    'Traffic One needs local security scanners before it can run the pre-deployment gate.',
    '',
    `Missing: ${missingTools.join(', ')}`,
    '',
    'Benefits of installing them:',
    '- gitleaks scans the working tree and full git history for API keys, service-role keys, tokens, and committed .env secrets before they reach production.',
    '- trufflehog verifies/flags known and unknown secrets across git history, catching leaks that simple pattern matching misses.',
    '- Together they make the local deploy gate match CI instead of discovering credential leaks only after a push.',
    '',
    brew.found
      ? 'Recommended install command:'
      : 'Homebrew was not found. Ask the user to install Homebrew first, then install the scanners:',
    '',
    installCommand,
  ].join('\n');
}

module.exports = { missingToolInstallPrompt };
