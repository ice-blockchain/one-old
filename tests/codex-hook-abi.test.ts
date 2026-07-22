import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { runGen } from '../src/gen';
import { CODEX_HOOK_ABI_VERSION } from '../src/gen/sources/hooks';
import {
  CODEX_HOOK_EXPECTED_COUNT,
  CODEX_TRAFFIC_ONE_HOOK_KEYS,
} from '../src/runners/doctor/codex-hook-trust';
import abiFixtureJson from './fixtures/codex-hook-abi.v1.json';

type Rec = Record<string, unknown>;
type CodexVersion = '0.133' | '0.145';

interface AbiEntry {
  key: string;
  eventName: string;
  matcher: string | null;
  subcommand: string;
  command: string;
  timeoutSec: number;
  async: false;
  statusMessage: string | null;
  additionalContextLimit: number | null;
  currentHash: string;
}

interface AbiFixture {
  version: number;
  entries: AbiEntry[];
}

const REPO_ROOT = path.resolve(__dirname, '..');
const ABI_FIXTURE = abiFixtureJson as AbiFixture;
const ABI_MIGRATION_GUIDANCE =
  'Codex hook ABI drift detected: bump CODEX_HOOK_ABI_VERSION and ship a trust-state migration.';
const DEFAULT_TIMEOUT_SEC = 600;
const CODEX_0145_DEFAULT_ADDITIONAL_CONTEXT_LIMIT = 2_500;
const HOOKS_JSON_SHA256 = 'fd232cf4f2fcfefc177f5f7762b2240fcbce45c5d9365e22e3ff5c527599bec7';

const EVENT_LABELS: Readonly<Record<string, string>> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
};

const CODEX_0133_EVENTS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
]);

const CODEX_0145_EVENTS = new Set([...CODEX_0133_EVENTS, 'SessionEnd']);
const MATCHER_EVENTS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
]);

function abiFailure(detail: string): never {
  throw new Error(`${ABI_MIGRATION_GUIDANCE}\n${detail}`);
}

function rec(value: unknown, label: string): Rec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return abiFailure(`${label} must be an object`);
  }
  return value as Rec;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) return abiFailure(`${label} must be an array`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return abiFailure(`${label} must be a string`);
  return value;
}

function unsignedInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return abiFailure(`${label} must be an unsigned integer`);
  }
  return value;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Rec)
      .sort()
      .map((key) => [key, canonicalJson((value as Rec)[key])]),
  );
}

function codexHash(identity: Rec): string {
  const canonical = JSON.stringify(canonicalJson(identity));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function subcommandFromCommand(command: string, key: string): string {
  const match = command.match(/\s([A-Za-z0-9][A-Za-z0-9-]*)$/);
  if (!match) abiFailure(`${key} command does not end in one portable subcommand`);
  return match[1]!;
}

// Mirrors codex-rs/hooks discovery at rust-v0.133.0 and rust-v0.145.0:
// resolve platform command, fill timeout=600 + async=false, isolate one handler,
// serialize the normalized TOML identity as canonical JSON, then hash it.
function normalizedCodexAbi(hooksFile: unknown, version: CodexVersion): AbiEntry[] {
  const root = rec(hooksFile, 'hooks.json');
  const hooks = rec(root.hooks, 'hooks.json hooks');
  const supportedEvents = version === '0.133' ? CODEX_0133_EVENTS : CODEX_0145_EVENTS;
  const entries: AbiEntry[] = [];

  for (const [eventName, groupsValue] of Object.entries(hooks)) {
    if (!supportedEvents.has(eventName)) {
      abiFailure(`Codex ${version} does not support hook event ${eventName}`);
    }
    const eventLabel = EVENT_LABELS[eventName];
    if (!eventLabel) abiFailure(`missing canonical Codex key for ${eventName}`);
    const groups = array(groupsValue, `${eventName} groups`);

    groups.forEach((groupValue, groupIndex) => {
      const group = rec(groupValue, `${eventName}[${groupIndex}]`);
      const matcher = optionalString(group.matcher, `${eventName}[${groupIndex}].matcher`);
      const effectiveMatcher = MATCHER_EVENTS.has(eventName) ? matcher : undefined;
      const handlers = array(group.hooks, `${eventName}[${groupIndex}].hooks`);

      handlers.forEach((handlerValue, handlerIndex) => {
        const handler = rec(
          handlerValue,
          `${eventName}[${groupIndex}].hooks[${handlerIndex}]`,
        );
        if (handler.type !== 'command') {
          abiFailure(`${eventName}:${groupIndex}:${handlerIndex} must remain a command hook`);
        }
        if (typeof handler.command !== 'string' || handler.command.trim() === '') {
          abiFailure(`${eventName}:${groupIndex}:${handlerIndex} must have a non-empty command`);
        }
        if (handler.async !== undefined && typeof handler.async !== 'boolean') {
          abiFailure(`${eventName}:${groupIndex}:${handlerIndex} async must be boolean`);
        }
        if (handler.async === true) {
          abiFailure(`${eventName}:${groupIndex}:${handlerIndex} is async and Codex skips it`);
        }

        const timeout = handler.timeout === undefined
          ? DEFAULT_TIMEOUT_SEC
          : Math.max(unsignedInteger(handler.timeout, `${eventName}:${groupIndex}:${handlerIndex} timeout`), 1);
        const statusMessage = optionalString(
          handler.statusMessage,
          `${eventName}:${groupIndex}:${handlerIndex} statusMessage`,
        );
        const normalizedHandler: Rec = {
          type: 'command',
          command: handler.command,
          timeout,
          async: false,
          ...(statusMessage === undefined ? {} : { statusMessage }),
        };

        let additionalContextLimit: number | null = null;
        if (version === '0.145' && handler.additionalContextLimit !== undefined) {
          additionalContextLimit = unsignedInteger(
            handler.additionalContextLimit,
            `${eventName}:${groupIndex}:${handlerIndex} additionalContextLimit`,
          );
          if (additionalContextLimit !== CODEX_0145_DEFAULT_ADDITIONAL_CONTEXT_LIMIT) {
            normalizedHandler.additionalContextLimit = additionalContextLimit;
          }
        }

        const identity: Rec = {
          event_name: eventLabel,
          ...(effectiveMatcher === undefined ? {} : { matcher: effectiveMatcher }),
          hooks: [normalizedHandler],
        };
        const key = `${eventLabel}:${groupIndex}:${handlerIndex}`;
        entries.push({
          key,
          eventName,
          matcher: effectiveMatcher ?? null,
          subcommand: subcommandFromCommand(handler.command, key),
          command: handler.command,
          timeoutSec: timeout,
          async: false,
          statusMessage: statusMessage ?? null,
          additionalContextLimit,
          currentHash: codexHash(identity),
        });
      });
    });
  }

  return entries;
}

function assertAbiMatches(actual: AbiEntry[], context: string): void {
  const expected = ABI_FIXTURE.entries;
  if (actual.length !== expected.length) {
    abiFailure(`${context}: expected ${expected.length} positional entries, got ${actual.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedEntry = expected[index]!;
    const actualEntry = actual[index]!;
    if (actualEntry.key !== expectedEntry.key) {
      abiFailure(
        `${context}: position ${index} expected ${expectedEntry.key}, got ${actualEntry.key}`,
      );
    }
    if (!isDeepStrictEqual(actualEntry, expectedEntry)) {
      abiFailure(
        `${context}: ${expectedEntry.key} normalized identity changed\n`
        + `expected ${JSON.stringify(expectedEntry)}\n`
        + `actual   ${JSON.stringify(actualEntry)}`,
      );
    }
  }
}

function generatedHooksArtifact(): { hooksFile: unknown; bytes: Buffer } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-hook-abi-'));
  try {
    runGen({ check: false, root: scratch, sourceRoot: REPO_ROOT });
    const bytes = fs.readFileSync(path.join(scratch, 'hooks', 'hooks.json'));
    return { hooksFile: JSON.parse(bytes.toString('utf8')) as unknown, bytes };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function generatedHooksFile(): unknown {
  return generatedHooksArtifact().hooksFile;
}

function hookTable(hooksFile: unknown): Rec {
  return rec(rec(hooksFile, 'hooks.json').hooks, 'hooks.json hooks');
}

function hookGroups(hooksFile: unknown, eventName: string): unknown[] {
  return array(hookTable(hooksFile)[eventName], `${eventName} groups`);
}

function hookGroup(hooksFile: unknown, eventName: string, groupIndex: number): Rec {
  return rec(hookGroups(hooksFile, eventName)[groupIndex], `${eventName}[${groupIndex}]`);
}

function hookHandler(
  hooksFile: unknown,
  eventName: string,
  groupIndex: number,
  handlerIndex: number,
): Rec {
  return rec(
    array(hookGroup(hooksFile, eventName, groupIndex).hooks, `${eventName} hooks`)[handlerIndex],
    `${eventName}:${groupIndex}:${handlerIndex}`,
  );
}

test('Codex hook ABI fixture v1 is complete and tied to the source version', () => {
  assert.equal(
    ABI_FIXTURE.version,
    CODEX_HOOK_ABI_VERSION,
    ABI_MIGRATION_GUIDANCE,
  );
  assert.equal(ABI_FIXTURE.entries.length, 15, 'ABI v1 must contain exactly 15 entries');
  assert.equal(
    new Set(ABI_FIXTURE.entries.map(({ key }) => key)).size,
    ABI_FIXTURE.entries.length,
    'ABI v1 keys must be unique',
  );
  assert.ok(
    ABI_FIXTURE.entries.some(({ key }) => key === 'pre_tool_use:2:1'),
    'ABI v1 must pin the second handler in PreToolUse group 2',
  );
  const entryFields = [
    'key',
    'eventName',
    'matcher',
    'subcommand',
    'command',
    'timeoutSec',
    'async',
    'statusMessage',
    'additionalContextLimit',
    'currentHash',
  ];
  for (const entry of ABI_FIXTURE.entries) {
    assert.deepEqual(Object.keys(entry), entryFields, `${entry.key} must pin every ABI field`);
    assert.match(entry.key, /^[a-z_]+:\d+:\d+$/);
    assert.ok(EVENT_LABELS[entry.eventName], `${entry.key} has an unknown eventName`);
    assert.ok(entry.matcher === null || typeof entry.matcher === 'string');
    assert.match(entry.subcommand, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(entry.command.endsWith(` ${entry.subcommand}`));
    assert.equal(entry.timeoutSec, 600);
    assert.equal(entry.async, false);
    assert.ok(entry.statusMessage === null || typeof entry.statusMessage === 'string');
    assert.equal(entry.additionalContextLimit, null);
    assert.match(entry.currentHash, /^sha256:[0-9a-f]{64}$/);
  }
});

test('doctor hook-trust expected keys stay in sync with ABI fixture v1', () => {
  assert.equal(
    CODEX_TRAFFIC_ONE_HOOK_KEYS.length,
    CODEX_HOOK_EXPECTED_COUNT,
    'CODEX_HOOK_EXPECTED_COUNT must match the doctor key list',
  );
  assert.deepEqual(
    [...CODEX_TRAFFIC_ONE_HOOK_KEYS].sort(),
    ABI_FIXTURE.entries
      .map(({ key }) => `traffic-one@traffic-one-local:hooks/hooks.json:${key}`)
      .sort(),
    `${ABI_MIGRATION_GUIDANCE}\n`
    + 'EXPECTED_SUFFIXES in src/runners/doctor/codex-hook-trust.ts must mirror the fixture keys',
  );
});

test('generated hooks preserve Codex hook ABI v1 under 0.133 and 0.145 normalization', () => {
  const { hooksFile, bytes } = generatedHooksArtifact();
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    HOOKS_JSON_SHA256,
    `${ABI_MIGRATION_GUIDANCE} hooks/hooks.json bytes changed`,
  );
  const codex0133 = normalizedCodexAbi(hooksFile, '0.133');
  const codex0145 = normalizedCodexAbi(hooksFile, '0.145');

  assert.deepEqual(codex0145, codex0133, '0.133 and 0.145 identities must converge');
  assertAbiMatches(codex0133, 'Codex 0.133');
  assertAbiMatches(codex0145, 'Codex 0.145');
});

test('legacy SessionStart trust vector remains reproducible', () => {
  // Literal recovered from ff110b58:src/gen/sources/hooks.ts, immediately before
  // fedd9f5a replaced the POSIX launcher. Keep independent of current sources.
  const legacySessionStartIdentity: Rec = {
    event_name: 'session_start',
    hooks: [{
      type: 'command',
      command: 'node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}}/scripts/hook-runtime.cjs" session-start',
      timeout: 600,
      async: false,
      statusMessage: 'Checking Traffic One auth...',
    }],
  };

  assert.equal(
    codexHash(legacySessionStartIdentity),
    'sha256:b709098165e46468dccfa5d9e63234eb75164ca47bffe7ff1c69c488d5433f28',
  );
});

test('ABI guard rejects positional and normalized-identity drift with migration guidance', async (t) => {
  const baseline = generatedHooksFile();
  const cases: Array<{ name: string; mutate: (hooksFile: unknown) => void }> = [
    {
      name: 'insertion',
      mutate: (hooksFile) => {
        const groups = hookGroups(hooksFile, 'PreToolUse');
        groups.splice(2, 0, structuredClone(groups[0]));
      },
    },
    {
      name: 'reordering',
      mutate: (hooksFile) => {
        const groups = hookGroups(hooksFile, 'PreToolUse');
        const first = groups[0];
        const second = groups[1];
        groups.splice(0, 2, second, first);
      },
    },
    {
      name: 'command',
      mutate: (hooksFile) => {
        hookHandler(hooksFile, 'SessionStart', 0, 0).command = 'node changed-command.cjs';
      },
    },
    {
      name: 'matcher',
      mutate: (hooksFile) => {
        hookGroup(hooksFile, 'PreToolUse', 0).matcher = 'Bash';
      },
    },
    {
      name: 'timeout',
      mutate: (hooksFile) => {
        hookHandler(hooksFile, 'SessionStart', 0, 0).timeout = 601;
      },
    },
    {
      name: 'status',
      mutate: (hooksFile) => {
        hookHandler(hooksFile, 'SessionStart', 0, 0).statusMessage = 'Changed status';
      },
    },
  ];

  for (const { name, mutate } of cases) {
    await t.test(name, () => {
      const candidate = structuredClone(baseline);
      mutate(candidate);
      assert.throws(
        () => {
          assertAbiMatches(normalizedCodexAbi(candidate, '0.145'), `mutation ${name}`);
        },
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /bump CODEX_HOOK_ABI_VERSION.*trust-state migration/i,
          );
          return true;
        },
      );
    });
  }
});
