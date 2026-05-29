// src/shared/text.ts
// The ONE home for time + hash utilities (legacy had nowIso in 6 files and
// crypto.sha256 duplicated for auth-choice digests + project fingerprints).

import { createHash } from 'crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

// Millisecond-stripped ISO (2026-05-28T12:00:00Z). The legacy state + auth
// writers used this on-disk format; keep it so stamped values match.
export function nowIsoNoMs(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function shortHash(input: string, length = 12): string {
  return sha256(input).slice(0, length);
}
