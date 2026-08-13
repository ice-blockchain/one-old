// src/shared/materialize/role-contract-status.ts
// WHERE the active host reads its per-role contracts, and whether that place is
// usable — answered from DISK, with no materialization and no write.
//
// ── why this exists next to role-contracts.ts ────────────────────────────────
// role-contracts.ts reports what ONE write attempt achieved. That answer only
// exists while a materialization is running, and the failure it reports is
// PERSISTENT: a `.cursor/agents` that is a plain file stays a plain file. Every
// consumer that has to act on the condition — the pre-tool gate, the SessionStart
// banner, the spawn directives — runs at moments when no materialization is in
// flight, and the steady state is exactly the dangerous one:
// `hasMaterializedProjectAssets` validates rules/skills/AGENTS.md/CLAUDE.md and
// has never looked at role contracts, so a project whose contracts were refused
// once is short forever while every convergence short-circuits.
//
// So the question is asked of the filesystem instead, which cannot forget:
//
//   roleContractDirectoryRefusal  — the place is OCCUPIED or UNWRITABLE. A fact
//                                   about the install that no run can fix; this
//                                   is what refuses file-changing work.
//   roleContractsNeedConvergence  — that, OR the contracts are simply not there.
//                                   Permission to run the writer again, which is
//                                   what makes the condition heal on the hook
//                                   after a human clears the path.
//
// Two functions and not one, because the two answers prescribe opposite things:
// an empty-but-writable directory is repaired by the convergence that runs in
// the same hook, so refusing work over it would be a refusal with no remedy.
//
// ── read-only, and cheap enough for every hook ───────────────────────────────
// One `statSync` on the healthy path (plus one `readdirSync` for the
// convergence question), no mkdir, no write, no probe file. A gate that had to
// WRITE to discover whether it may write would be its own hazard, and `access`
// answers the same question `mkdir` would without touching the tree. It never
// throws: this runs inside the hook runtime, where an escaping error becomes a
// fail-closed deny.

import * as fs from 'fs';
import * as path from 'path';

import { KILO_HOST_AGENTS_REL } from '../../config/kilo-host';
import { capabilityProfileForRun } from '../architecture-contract';
import { eligibleRolesForProfile } from '../capabilities';
import { detectHost } from '../host';
import { errnoOf } from '../state/state-write-log';
import { CODEX_AGENTS_REL } from './codex-agents';
import { COPILOT_AGENTS_REL } from './copilot-agents';
import { CURSOR_AGENTS_REL } from './cursor-agent-model';
import { openCodeGlobalAgentsDir } from './opencode-assets';
import { type RoleContractFailure, type RoleContractShortfall } from './role-contracts';
import { WINDSURF_AGENTS_REL } from './windsurf-agents';

type Rec = Record<string, unknown>;

/** The one place each host's per-role contracts live, and how to read it. */
export interface RoleContractLocation {
  readonly host: string;
  /** Absolute directory. */
  readonly dir: string;
  /** How the location reads in prose an operator has to act on. */
  readonly label: string;
  /**
   * Whether an EMPTY directory is evidence of a shortfall for this host.
   *
   * False for OpenCode alone, and not as a courtesy: its profiles are
   * user-local, project-hash-prefixed, and written ONLY in `subagents` team mode
   * (opencode-assets.ts sweeps and writes nothing in main-agent mode). An
   * emptiness rule there would fire on every healthy main-agent project, and the
   * directory is shared with every other project on the machine besides.
   */
  readonly emptyMeansMissing: boolean;
}

/**
 * The role-contract directory for `host`, or null for a host that has none.
 *
 * Claude is the null case that matters: it loads the plugin's own agent files,
 * so nothing is materialized per project and there is nothing to be short of.
 * Every relative constant is imported from the writer that owns it rather than
 * restated, so a renamed directory moves both at once — the defect that put
 * Copilot's contract path at `.copilot/` (a HOME location spelled as a
 * project-relative one) for as long as it went unread.
 */
export function roleContractLocation(
  cwd: string,
  host: string = detectHost(),
  env: NodeJS.ProcessEnv = process.env,
): RoleContractLocation | null {
  const project = (rel: string, label: string): RoleContractLocation =>
    ({ host, dir: path.join(cwd, rel), label, emptyMeansMissing: true });
  switch (host) {
    case 'cursor': return project(CURSOR_AGENTS_REL, '`.cursor/agents/<role>.md`');
    // Copilot's repository-level location, per GitHub's own "about custom agents"
    // documentation. QUALIFIED on purpose: the same documentation states that a
    // USER-level agent of the same filename (`~/.copilot/agents/<name>.agent.md`)
    // OVERRIDES the repository-level one, so a directory that is present and
    // writable does not prove the contract this product wrote is the contract the
    // host loaded. Nothing here can see the user-level file, and this function is
    // deliberately about the place rather than the winner: it answers "can the
    // product write its contracts", which is the only one of the two questions a
    // project-local check can honestly answer.
    case 'copilot': return project(COPILOT_AGENTS_REL, '`.github/agents/<role>.agent.md`');
    case 'kilo': return project(KILO_HOST_AGENTS_REL, '`.kilo/agents/<role>.md`');
    case 'codex': return project(CODEX_AGENTS_REL, '`.traffic-one/agents/<role>.md`');
    case 'windsurf': return project(WINDSURF_AGENTS_REL, '`.devin/agents/<role>/AGENT.md`');
    case 'opencode': return {
      host,
      dir: openCodeGlobalAgentsDir(env),
      label: "OpenCode's global agent profiles",
      emptyMeansMissing: false,
    };
    default: return null;
  }
}

/**
 * The errno `mkdirSync(dir, { recursive: true })` answers for a path already
 * occupied by something that is not a directory.
 *
 * MEASURED rather than assumed, and re-measured this round: a plain FILE at the
 * path yields EEXIST, not ENOTDIR — recursive mkdir reports ENOTDIR only when a
 * non-directory sits at an INTERMEDIATE component, which the parent walk below
 * reports against that component instead. Using the writer's errno here is what
 * makes the gate's diagnosis and the writer's diagnosis the same string for the
 * same shape; a probe that invented its own would read as two different faults.
 */
const OCCUPIED_ERRNO = 'EEXIST';

function failure(target: string, errno: string | null | undefined): RoleContractFailure {
  return { path: target, errno: errno || 'unknown' };
}

/** Can this directory be created and written, and if not, what refused? */
function directoryRefusal(dir: string): RoleContractFailure | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir); // follows links: a symlink to a real directory is fine
  } catch (error) {
    const errno = errnoOf(error);
    // ELOOP, EACCES or ENOTDIR on a component: the path itself is the answer.
    if (errno !== 'ENOENT') return failure(dir, errno);
    // ENOENT from `stat` is two different facts. A DANGLING SYMLINK is there —
    // `lstat` sees it — and mkdir refuses it (measured: ENOENT). Nothing there
    // at all is not a refusal; it is a directory that has not been created yet,
    // and whether it CAN be is the parent's answer.
    try {
      fs.lstatSync(dir);
      return failure(dir, 'ENOENT');
    } catch { /* genuinely absent */ }
    return parentRefusal(dir);
  }
  if (!stat.isDirectory()) return failure(dir, OCCUPIED_ERRNO);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (error) {
    return failure(dir, errnoOf(error) || 'EACCES');
  }
  return null;
}

/**
 * The directory is absent — can the nearest existing ancestor create it?
 *
 * Walks up rather than testing only `dirname`, because `mkdir -p` does too: with
 * `.cursor` itself missing, the fact that decides the outcome is whether the
 * PROJECT ROOT is writable. A non-directory found on the way up is reported
 * against that component, which is both the actionable path and the one mkdir
 * blames (ENOTDIR at an intermediate component).
 */
function parentRefusal(dir: string): RoleContractFailure | null {
  let cursor = path.dirname(dir);
  for (;;) {
    try {
      const stat = fs.statSync(cursor);
      if (!stat.isDirectory()) return failure(cursor, 'ENOTDIR');
      try {
        fs.accessSync(cursor, fs.constants.W_OK);
        return null;
      } catch (error) {
        return failure(cursor, errnoOf(error) || 'EACCES');
      }
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') return failure(cursor, errnoOf(error));
      const next = path.dirname(cursor);
      if (next === cursor) return null; // walked off the top; nothing refused
      cursor = next;
    }
  }
}

/**
 * Any `.md` under `dir` — Windsurf nests one directory deeper per role.
 *
 * ANY, and not "any carrying the generated marker": the marker check would need
 * to read file contents on a path every hook takes, and a user-authored agent
 * file in the host's own agents directory means the directory is present and
 * usable, which is what this question is for. The residual is a project whose
 * generated contracts are absent while a hand-written one sits beside them — it
 * is not asked to converge. It is disclosed rather than closed because the
 * failure it belongs to (a refused directory) cannot produce it: a refused
 * directory holds nothing at all.
 */
function holdsAnyContract(dir: string, depth = 2): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) return true;
    if (entry.isDirectory() && depth > 1 && holdsAnyContract(path.join(dir, entry.name), depth - 1)) return true;
  }
  return false;
}

/**
 * The active host's role-contract directory cannot be written — a plain file, a
 * symlink, a directory this user cannot write, a read-only checkout.
 *
 * This is the refusal the product BLOCKS MUTATING WORK on
 * (onboarding-gate/handler.ts). Its population is deliberately narrow: every
 * shape here is a fact about the installation that no rerun, no retry and no
 * repair the agent can perform will change — `MUTATING_SHELL_COMMAND`
 * (tool-classify.ts) lists `rm`, `chmod`, `chown`, `mv` and `ln`, so every repair
 * for an occupied path is itself denied. A human clears the path.
 *
 * Never throws, and answers null for any host with no role contracts.
 */
export function roleContractDirectoryRefusal(
  cwd: string,
  host: string = detectHost(),
  env: NodeJS.ProcessEnv = process.env,
): RoleContractShortfall | null {
  try {
    const location = roleContractLocation(cwd, host, env);
    if (!location) return null;
    const refused = directoryRefusal(location.dir);
    return refused ? { host, kind: 'unwritable', failures: [refused] } : null;
  } catch {
    return null;
  }
}

/**
 * Should the writer be given another go at this host's role contracts?
 *
 * The convergence term (materializeProjectIfNeeded, shared/materialize/
 * converge.ts). True for a refused directory — so the run REPORTS it, every
 * time, instead of once — and true for a directory that is simply empty, which
 * is what makes the whole condition self-healing: the hook after a human clears
 * the path re-converges and the contracts land. Without the second arm the
 * refusal would go quiet the moment the path was cleared and leave the contracts
 * absent forever, which is the original defect with an extra step.
 *
 * The emptiness arm is ordered to cost nothing on a healthy project: one
 * `readdir` that finds a contract and returns. Only an EMPTY directory pays for
 * the capability profile, and only to establish that this project has roles to
 * write at all — a profile with no eligible roles legitimately produces no
 * contracts, and asking again forever over that would be the convergence loop
 * has-assets.ts is careful to avoid.
 */
export function roleContractsNeedConvergence(cwd: string, state: Rec, host: string = detectHost()): boolean {
  try {
    const location = roleContractLocation(cwd, host);
    if (!location) return false;
    if (directoryRefusal(location.dir)) return true;
    if (!location.emptyMeansMissing) return false;
    if (holdsAnyContract(location.dir)) return false;
    return eligibleRolesForProfile(capabilityProfileForRun(cwd, state)).size > 0;
  } catch {
    return false;
  }
}

/**
 * The shortfall as a sentence, for the several channels that have to say it.
 *
 * ONE renderer, because the fact is one fact and it has to arrive in the same
 * words wherever it lands — the pre-tool deny, the SessionStart banner, the
 * materialization report and the spawn directives. `where` is what an operator
 * checks; the errno is what tells them which of the four causes it is.
 */
export function roleContractShortfallSentence(cwd: string, shortfall: RoleContractShortfall): string {
  const location = roleContractLocation(cwd, shortfall.host);
  const where = location?.label || `this host's role contract directory`;
  const paths = shortfall.failures
    .slice(0, 3)
    .map((entry) => `\`${relativeToProject(cwd, entry.path)}\` (${entry.errno})`)
    .join(', ');
  const rest = shortfall.failures.length > 3 ? `, … +${shortfall.failures.length - 3} more` : '';
  const scope = shortfall.kind === 'unwritable'
    ? `NONE of host \`${shortfall.host}\`'s per-role contracts were written: the directory itself was refused`
    : `SOME of host \`${shortfall.host}\`'s per-role contracts could not be written`;
  return `${scope} — ${paths}${rest}. ${where} is what this host loads to define each spawned role, `
    + 'so a role spawned now runs without its contract.';
}

/**
 * Project-relative wherever possible, and absolute only when the path genuinely
 * is not in the project (OpenCode's global profile directory).
 *
 * Not cosmetic. Every reason string a gate renders becomes part of the
 * deny-repeat signature (shared/state/deny-repeat.ts), so a machine-local prefix
 * that moves — a home directory that differs between a CLI and an IDE session on
 * the same project — splits one refusal into two counters and escalation
 * silently stops arriving. `.cursor/agents` is the same bytes for every reader of
 * the same project.
 */
export function relativeToProject(cwd: string, target: string): string {
  const rel = path.relative(cwd, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : target;
}
