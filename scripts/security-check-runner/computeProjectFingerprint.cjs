'use strict';

const crypto = require('crypto');
const path = require('path');
const {
  isInsideGitWorkTree,
  gitOutput,
  listFingerprintFiles,
  hashFileForFingerprint,
} = require('./_helpers.cjs');

function computeProjectFingerprint(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const hash = crypto.createHash('sha256');
  const gitHead = isInsideGitWorkTree(root)
    ? gitOutput(root, ['rev-parse', 'HEAD']).trim() || 'no-head'
    : 'no-git';
  const files = listFingerprintFiles(root);

  hash.update(`head\0${gitHead}\0`);
  for (const relPath of files) {
    hash.update(`path\0${relPath}\0`);
    hash.update(hashFileForFingerprint(root, relPath));
    hash.update('\0');
  }

  return {
    fingerprint: hash.digest('hex'),
    head: gitHead,
    fileCount: files.length,
  };
}

module.exports = { computeProjectFingerprint };
