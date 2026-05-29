// src/runners/security-check/fingerprint.ts
// Deterministic project fingerprint (git HEAD + a stable hash of tracked file
// contents, with the traffic-one state stamp fields normalized out). Used by
// the security report + the deploy gate to detect "has anything changed since
// the last passing security check?". Ported 1:1 from
// scripts/security-check-runner/computeProjectFingerprint.cjs.

import * as crypto from 'crypto';
import * as path from 'path';

import { gitOutput, hashFileForFingerprint, isInsideGitWorkTree, listFingerprintFiles, type Fingerprint } from './lib';

export function computeProjectFingerprint(cwd: string = process.cwd()): Fingerprint {
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
