#!/usr/bin/env node
// Bundled, dependency-free rules-ack runner: prints the role's compiled
// context pack ONE PART PER INVOCATION and records the read receipt.
//
// Why a pager: Codex truncates exec output middle-out at ~10K tokens, so a
// batched read of a role's rules silently loses the middle files (observed
// 8co: 7 of 25 survived). Every part is pre-budgeted under that ceiling, and
// serving a part IS the proof of ingestion — the implementer completion gate
// denies `IMPLEMENTED` until every part was served under the current pack
// hash.

import * as fs from 'fs';
import * as path from 'path';

import { writeJson } from '../../shared/fsjson';
import {
  CONTEXT_PACK_SCHEMA_VERSION,
  contextPackDir,
  contextPackPartDir,
  readContextPackManifest,
  readRulesAck,
  rulesAckPath,
  type RulesAckV1,
} from '../../shared/run-bootstrap-policy/context-pack';

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ROLE_RE = /^[a-z][a-z-]{1,64}$/;

function usage(): string {
  return [
    'traffic-one rules-ack runner',
    'Index (lists parts, records nothing):',
    '  node ~/.traffic-one/bin/rules-ack.cjs --run-id <id> --role <senior-role>',
    'Serve one part and record the read receipt:',
    '  node ~/.traffic-one/bin/rules-ack.cjs --run-id <id> --role <senior-role> --part <n>',
    'Read ONE part per command; never concatenate parts in a single shell call.',
  ].join('\n');
}

interface Args {
  runId: string;
  role: string;
  part: number | null;
}

function parseArgs(argv: readonly string[]): Args | null {
  let runId = '';
  let role = '';
  let part: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => String(argv[index + 1] ?? '');
    if (arg === '--run-id') { runId = next(); index += 1; }
    else if (arg === '--role') { role = next(); index += 1; }
    else if (arg === '--part') { part = Number.parseInt(next(), 10); index += 1; }
    else if (arg === 'help' || arg === '--help') return null;
  }
  if (!SAFE_ID_RE.test(runId) || !SAFE_ROLE_RE.test(role)) return null;
  if (part !== null && (!Number.isInteger(part) || part < 0)) return null;
  return { runId, role, part };
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): number {
  const args = parseArgs(argv);
  if (!args) {
    process.stdout.write(`${usage()}\n`);
    return 2;
  }
  const manifest = readContextPackManifest(cwd, args.runId, args.role);
  if (!manifest) {
    process.stderr.write(`rules-ack: no context pack compiled for role ${args.role} in run ${args.runId} (nothing to acknowledge).\n`);
    return 2;
  }
  const dir = contextPackDir(cwd, args.runId, args.role);

  if (args.part === null || args.part === 0) {
    let index = '';
    try {
      index = fs.readFileSync(path.join(dir, 'part-00.md'), 'utf8');
    } catch {
      index = `# Context pack — ${args.role}, run ${args.runId}\nParts: ${manifest.parts.length}.`;
    }
    process.stdout.write(`${index.trimEnd()}\n\n[rules-ack] ${manifest.parts.length} part(s); request each with --part <n>, ONE per command.\n`);
    return 0;
  }

  const entry = manifest.parts[args.part - 1];
  if (!entry) {
    process.stderr.write(`rules-ack: part ${args.part} does not exist (pack has ${manifest.parts.length}).\n`);
    return 2;
  }
  let body: string;
  try {
    // Shared parts live in the run-level content-addressed store. The directory
    // is computed here, never taken from the manifest, so a manifest can never
    // redirect this read at an arbitrary path.
    const partDir = contextPackPartDir(cwd, args.runId, args.role, entry);
    body = fs.readFileSync(path.join(partDir, entry.file), 'utf8');
  } catch {
    process.stderr.write(`rules-ack: pack file ${entry.file} is missing — recompile the run bootstrap.\n`);
    return 2;
  }

  const previous = readRulesAck(cwd, args.runId, args.role);
  // A regenerated pack (different hash) invalidates old receipts wholesale.
  const served = new Set(previous && previous.packHash === manifest.packHash ? previous.servedParts : []);
  served.add(args.part);
  const complete = manifest.parts.every((_, index) => served.has(index + 1));
  const ack: RulesAckV1 = {
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    runId: args.runId,
    role: args.role,
    packHash: manifest.packHash,
    servedParts: [...served].sort((a, b) => a - b),
    ...(complete ? { completedAt: new Date().toISOString() } : {}),
  };
  try {
    writeJson(rulesAckPath(cwd, args.runId, args.role), ack);
  } catch {
    process.stderr.write('rules-ack: could not persist the read receipt.\n');
    return 1;
  }
  const remaining = manifest.parts.length - served.size;
  process.stdout.write(`${body.trimEnd()}\n\n[rules-ack] recorded part ${args.part}/${manifest.parts.length}${complete ? ' — pack complete' : ` (${remaining} remaining)`}.\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}
