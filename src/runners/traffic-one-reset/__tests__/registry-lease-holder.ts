// A SECOND PROCESS that holds one of the three locks the carry now takes, across
// a read-modify-write shaped exactly like the product writer that lives inside
// that lock — only slower, so the window is observable from the process under
// test.
//
// Deliberately NOT a `*.test.ts`: the runner's glob is `src/**/*.test.ts`, so a
// file that must be SPAWNED rather than collected has to be spelled this way, or
// every suite run would execute it with no arguments.
//
// It writes two artifacts the caller reads as fixture guards: `holder-inside`
// once it is demonstrably within its critical section, and `holder-read.json`
// with the base it read there — the evidence that its read really did precede
// whatever the other process did next. A carry that writes THROUGH the lease
// loses everything the base does not mention.
//
//   argv[2]  project root
//   argv[3]  milliseconds to hold the lock inside the critical section
//   argv[4]  which lock: agents | spawns | exhausted | project
//
// `project` is not one of the carry's stores: it is the PROJECT STATE LOCK the
// transaction itself takes, held here so the reset's own contention path can be
// driven from a second real process. That lock's contenders throw at their
// one-second deadline, and until there was a boundary the loser of two racing
// operator invocations got a stack trace instead of the refusal its own code
// already had ready.

import * as fs from 'fs';
import * as path from 'path';

import { withExhaustedModelsLock } from '../../../modules/agent-model/exhausted-models';
import { resetPluginUseCache } from '../../../shared/state/plugin-use';
import {
  readCursorSpawnObservationStore,
  withCursorSpawnObservationLock,
  writeCursorSpawnObservationStore,
} from '../../../shared/state/run-agent/cursor-observations';
import { withAgentRegistryLock } from '../../../shared/state/run-agent/registry';
import { withProjectStateLock } from '../../../shared/state/project-state-lock';

const dir = process.argv[2] as string;
const holdMs = Number(process.argv[3] ?? 0);
const store = (process.argv[4] || 'agents') as 'agents' | 'spawns' | 'exhausted' | 'project';

process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
resetPluginUseCache();

const runDir = path.join(dir, '.traffic-one', 'runs', 'NEW');
const wait = new Int32Array(new SharedArrayBuffer(4));

/** The base this process read, and the pause, published together so the caller
 *  can tell a genuine race from a fixture that never overlapped. */
function announce(base: readonly string[]): void {
  fs.writeFileSync(path.join(dir, 'holder-read.json'), JSON.stringify([...base].sort()), 'utf8');
  fs.writeFileSync(path.join(dir, 'holder-inside'), 'y', 'utf8');
  if (holdMs > 0) Atomics.wait(wait, 0, 0, holdMs);
}

function readJson(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const HOLDERS: Record<typeof store, () => boolean> = {
  // The registry, written the way `recordRunAgentUnlocked` writes it.
  agents: () => withAgentRegistryLock(dir, 'NEW', () => {
    const file = path.join(runDir, 'agents.json');
    const base = readJson(file);
    const agents = (base.agents as Record<string, unknown>) || {};
    announce(Object.keys(agents));
    agents['senior-tester'] = {
      agentId: 'live-child-tester',
      resumeId: 'live-child-tester',
      role: 'senior-tester',
      model: null,
      agentType: null,
      parentSessionId: 'parent-A',
      recordedAt: new Date().toISOString(),
      tasks: 1,
      replaced: false,
    };
    fs.writeFileSync(file, JSON.stringify({ ...base, version: 1, agents }), 'utf8');
  }) !== null,

  // The spawn store, through its own (unlocked) reader and writer — the same two
  // calls every product mutation of this file makes inside this lock.
  //
  // The writer's boolean is the EXIT CODE here, unlike the two rows around it
  // (one writes through raw `fs`, which throws; one has no boolean to consult).
  // A refused write would otherwise leave this process exiting 0 having planted
  // no live-child row, and the caller's next assertion — the deepEqual over the
  // successor's rows — would blame the carry for a row the fence declined.
  spawns: () => withCursorSpawnObservationLock(dir, 'NEW', () => {
    const rows = readCursorSpawnObservationStore(dir, 'NEW').observations;
    announce(rows.map((row) => row.toolCallId));
    return writeCursorSpawnObservationStore(dir, 'NEW', [...rows, {
      parentSessionId: 'parent-A',
      toolCallId: 'tool_live_child',
      role: 'senior-tester',
      requestedModel: 'composer-2.5-fast',
      tier: 'cheapest',
      expectedModel: 'composer-2.5-fast',
      startedAtMs: Date.now(),
      carriedFromRunId: null,
    } as Parameters<typeof writeCursorSpawnObservationStore>[2][number]]);
  }) === true,

  // The exhaustion ledger. Its v2 shape is `{version, roles}`; the reader also
  // accepts the flat legacy spelling, so writing the current one is enough.
  exhausted: () => withExhaustedModelsLock(dir, 'NEW', false, () => {
    const file = path.join(runDir, 'exhausted-models.json');
    const base = readJson(file);
    const roles = (base.roles as Record<string, unknown>) || {};
    announce(Object.keys(roles));
    roles['senior-tester'] = { entries: [{ model: 'composer-2.5-fast', at: new Date().toISOString() }] };
    fs.writeFileSync(file, JSON.stringify({ version: 2, roles }), 'utf8');
    return true;
  }),

  // The transaction's own lock, held with nothing written: what is under test is
  // the contender's answer, not a lost update.
  project: () => {
    withProjectStateLock(dir, () => { announce([]); });
    return true;
  },
};

process.exit(HOLDERS[store]() ? 0 : 1);
