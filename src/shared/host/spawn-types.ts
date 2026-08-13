// src/shared/host/spawn-types.ts
// The role → host spawn-type map: the single answer to "what exactly do I pass so
// this host starts THIS Traffic One role as a real subagent?".
//
// Until now that answer was implied by `typedSubagents ? role : null` — i.e. "a
// host with typed subagents accepts the role name verbatim". That held for the
// contract but not for the tool: a host builds its spawn tool's accepted-type set
// from whatever it had discovered when the session started, so freshly
// materialized role files can be absent from it. The spawn then fails inside the
// host's own schema validation, BEFORE any hook runs, and the orchestrator falls
// back to planning inline — exactly what subagents mode exists to prevent.
//
// Windsurf already carried a hand-written version of this (`Unknown subagent
// profile 'senior-architect'; Available: subagent_general, subagent_explore` →
// always use the built-in profile). This table generalizes it: every host gets a
// `primary` type and, where one exists, a built-in `fallback` to retry with. The
// fallback always travels with the `[t1-role: senior-<role>]` marker, which the
// role resolver accepts as first-class evidence, so a generic child still binds
// its role.

import { canonicalHost } from '../model-tiers';
import type { HostId } from '../../core/types';
import { openCodeGlobalAgentName } from '../materialize/opencode-assets';

interface HostSpawnType {
  /** Value to pass first. Null when the host exposes no typed subagents at all. */
  primary: string | null;
  /**
   * Built-in type to retry with when the host REJECTS `primary` (invalid enum,
   * unknown profile). Null when the host has no generic worker worth using.
   */
  fallback: string | null;
  /** The spawn tool's parameter name, for prose that has to name it. */
  parameter: string;
  /** Project-relative role contract the fallback child must be told to read. */
  contractPath: string | null;
}

// Codex takes the canonical underscore form as `task_name`.
function underscoreRole(role: string): string {
  return role.replace(/-/g, '_');
}

/**
 * Resolve the spawn type for `role` on `host`.
 *
 * `cwd` is only consulted for OpenCode, whose agent id is derived from the
 * project hash rather than the role name.
 */
export function hostSpawnType(host: HostId | string, role: string, cwd = ''): HostSpawnType {
  switch (canonicalHost(host)) {
    case 'cursor':
      // Cursor materializes `.cursor/agents/<role>.md`, and the file name IS the
      // type — but only for a session that already knew about the file. A build
      // that just onboarded wrote those files mid-session, so the role-named type
      // spawn can hit a type set that predates them. Both values stay
      // acceptable; which one a directive RECOMMENDS depends on whether the
      // files were just materialized (see `formatCursorSpawnMapLines`).
      return {
        primary: role,
        fallback: 'generalPurpose',
        parameter: 'subagent_type',
        contractPath: `.cursor/agents/${role}.md`,
      };
    case 'claude':
      return { primary: role, fallback: 'general-purpose', parameter: 'subagent_type', contractPath: null };
    case 'codex':
      // Codex spawns by task name, not by an agent type the host resolves, so
      // the role text has to arrive some other way. The per-run context pack that
      // used to carry the full `agent.md` was removed in 9cc08b53; this is the
      // materialized replacement the other fallback hosts already had.
      return {
        primary: underscoreRole(role),
        fallback: null,
        parameter: 'task_name',
        contractPath: `.traffic-one/agents/${role}.md`,
      };
    case 'copilot':
      // `.github/agents/` is where `writeCopilotAgentFiles` puts these, and this
      // path is only ever consulted through an `existsSync` — so a directory that
      // nothing writes does not fail loudly, it degrades to the kernel excerpt and
      // says nothing, which is the state the guard in session-start-setup.ts
      // records as observed on Codex. It read `.copilot/` until now, and no
      // project-local `.copilot/` is written anywhere in this product. Spelled as
      // a literal rather than imported from the writer because that module pulls
      // in the architecture contract, capabilities and skill filters, and this is
      // a leaf the hook runtime resolves everywhere; the two are held together in
      // host-spawn-types.test.ts, which derives the expectation from
      // COPILOT_AGENTS_REL so a rename of the directory cannot drift past here
      // again.
      return { primary: role, fallback: null, parameter: 'name', contractPath: `.github/agents/${role}.agent.md` };
    case 'kilo':
      // `.kilo/agents/*.md` are role-contract files, not Task type names, so the
      // built-in writable worker is the ONLY path — it is the primary, not a
      // fallback.
      return { primary: 'general', fallback: null, parameter: 'subagent_type', contractPath: `.kilo/agents/${role}.md` };
    case 'windsurf':
      // Custom profiles are not registered until a new Devin session.
      return { primary: 'subagent_general', fallback: null, parameter: 'profile', contractPath: `.devin/agents/${role}/AGENT.md` };
    case 'opencode':
      // The project-scoped global agent already carries the role contract, and
      // built-in `general` inherits the parent model — never a safe fallback here.
      return {
        primary: cwd ? openCodeGlobalAgentName(cwd, role) : null,
        fallback: null,
        parameter: 'subagent_type',
        contractPath: null,
      };
    default:
      return { primary: role, fallback: null, parameter: 'subagent_type', contractPath: null };
  }
}

/**
 * Every value this host may legitimately receive for `role`. The spawn gate
 * accepts any of them; anything else is a real misroute.
 */
export function acceptableSpawnTypes(host: HostId | string, role: string, cwd = ''): string[] {
  const spawn = hostSpawnType(host, role, cwd);
  return [spawn.primary, spawn.fallback].filter((value): value is string => Boolean(value));
}

/**
 * The host agent type to RECORD for a spawn that actually used `rawAgentType`.
 *
 * A spawn that fell back to the built-in generic worker is the same work unit as
 * the typed spawn — the fallback exists only because the host's accepted-type set
 * was stale. `hostAgentType` feeds the work-unit contract and the bootstrap
 * envelope hash, so recording the raw generic value would make the spawn miss the
 * bootstrap the parent already published for this role. Canonicalize it instead,
 * so BOTH spawn paths resolve the same pre-published bootstrap.
 */
export function canonicalHostAgentType(
  host: HostId | string,
  role: string,
  rawAgentType: string,
  typedSubagents: boolean,
  cwd = '',
): string | null {
  if (!typedSubagents || !rawAgentType) return null;
  const spawn = hostSpawnType(host, role, cwd);
  if (spawn.fallback && rawAgentType.trim().toLowerCase() === spawn.fallback.toLowerCase()) {
    return spawn.primary || rawAgentType;
  }
  return rawAgentType;
}

/** One `role → type` row for the maps printed before the first spawn. */
export function spawnTypeRow(host: HostId | string, role: string, cwd = ''): string {
  const spawn = hostSpawnType(host, role, cwd);
  if (!spawn.primary) return '';
  const fallback = spawn.fallback ? ` (if that type is rejected: \`${spawn.fallback}\` + the role marker)` : '';
  return `${spawn.parameter}: "${spawn.primary}"${fallback}`;
}
