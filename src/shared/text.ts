// src/shared/text.ts
// The ONE home for time + hash utilities (legacy had nowIso in 6 files and
// crypto.sha256 duplicated for auth-choice digests + project fingerprints).

import { createHash } from 'crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function shortHash(input: string, length = 12): string {
  return sha256(input).slice(0, length);
}
