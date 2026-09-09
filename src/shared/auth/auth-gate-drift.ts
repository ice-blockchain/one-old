// src/shared/auth/auth-gate-drift.ts
// A 401 whose error.code is not in AUTH_GATE_401_CODES is not a revocation
// this client can claim to understand. The probe still grants the offline
// grace window (validate-key.ts). This sidecar makes that choice visible:
// doctor reads it, and a log line is written at the moment of the 401.
//
// MACHINE sidecar, same reasoning as auth-revalidation.json: the key is one
// credential for the whole machine, and the envelope's auth record cannot
// grow a fifth field. Listed in MACHINE_OWNED_ENTRIES.

import * as fs from 'fs';

import { isoNoMs, machineSidecarPath, readMachineSidecar, writeMachineSidecar } from './machine-sidecar';

export const AUTH_GATE_DRIFT_FILE = 'auth-gate-401-drift.json';
const AUTH_GATE_DRIFT_VERSION = 1;

export interface UnknownAuthGate401 {
  readonly code: string;
  readonly seenAt: string;
  readonly logLine: string;
}

export function authGateUnknown401LogLine(code: string): string {
  return `[traffic-one] auth gate 401 code ${JSON.stringify(code)} is not in AUTH_GATE_401_CODES; granting offline grace`;
}

export function readUnknownAuthGate401(env: NodeJS.ProcessEnv = process.env): UnknownAuthGate401 | null {
  const raw = readMachineSidecar(AUTH_GATE_DRIFT_FILE, AUTH_GATE_DRIFT_VERSION, env);
  if (!raw) return null;
  const code = typeof raw.code === 'string' ? raw.code.trim() : '';
  if (!code) return null;
  const seenAt = typeof raw.seenAt === 'string' ? raw.seenAt.trim() : '';
  const logLine = typeof raw.logLine === 'string' && raw.logLine.trim()
    ? raw.logLine.trim()
    : authGateUnknown401LogLine(code);
  return { code, seenAt, logLine };
}

/**
 * Persist the unknown code and write the log line to stderr. FALSE when the
 * sidecar write was refused; the log line is still attempted. Never throws —
 * a visibility write must not change the grace verdict.
 */
export function recordUnknownAuthGate401(
  code: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): boolean {
  const trimmed = String(code || '').trim();
  if (!trimmed) return false;
  const logLine = authGateUnknown401LogLine(trimmed);
  try {
    process.stderr.write(`${logLine}\n`);
  } catch { /* stdio may be closed; the sidecar is the durable copy */ }
  try {
    return writeMachineSidecar(AUTH_GATE_DRIFT_FILE, AUTH_GATE_DRIFT_VERSION, {
      code: trimmed,
      seenAt: isoNoMs(nowMs),
      logLine,
    }, env);
  } catch {
    return false;
  }
}

/** Drop the record after a later probe that this client DID understand. */
export function clearUnknownAuthGate401(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    fs.rmSync(machineSidecarPath(AUTH_GATE_DRIFT_FILE, env), { force: true });
    return true;
  } catch {
    return false;
  }
}
