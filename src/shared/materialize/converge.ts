// src/shared/materialize/converge.ts
// Materialization convergence: the `materialize-project` body and the
// hook-time "materialize if needed" guard. Ported 1:1 from
// materializeProjectFromState + materializeProjectIfNeeded (_helpers.cjs).
//
// Returns a plain MaterializeOutcome (domain result) instead of host-shaped
// stdout — the calling module maps it to a canonical HookResult. The one-mcp
// background reporter is injected (default no-op) so this service stays free of
// the runner layer.

import { isKnownStack } from '../config';
import { postWriteIncompleteWarning } from '../directives';
import { isNonProjectRoot } from '../authoring-root';
import { doctorCommand } from '../doctor-command';
import { ensureRunnerShims } from '../runner-shims';
import { isRegisteredWorkspaceMember, isUnclaimedWorkspaceSubPackage } from '../hook/paths';
import { hasStateFile } from '../tool-classify';
import { detectMode } from '../detection';
import { pluginRootInfo } from '../paths';
import { STACKS } from '../stacks';
import { nowIsoNoMs } from '../text';
import {
  isMaterialized,
  hasLocalPreferenceFields,
  normalizeState,
  readEffectiveState,
  stackFingerprint,
  stateVersion,
  trafficOneStateValidationIssues,
  writeState,
} from '../state';
import {
  hasMaterializedProjectAssets,
  materializedContentIsIncomplete,
  materializedFromDifferentPluginBuild,
} from './has-assets';
import { roleContractShortfallSentence, roleContractsNeedConvergence } from './role-contract-status';
import { materializeProjectAssets, type MaterializeResult, type TornRootEvidence } from './materialize';
import { migrateArchitectureDocsToPlan, planMigrationNotice } from './plan-migration';

type Rec = Record<string, unknown>;

export type MaterializeStatus =
  | 'authoring-root'
  | 'missing-state'
  | 'incomplete'
  | 'failed'
  | 'materialized'
  | 'current'
  | 'skipped';

export interface MaterializeOutcome {
  status: MaterializeStatus;
  systemMessage: string;
  context: string;
  result: MaterializeResult | null;
}

interface ConvergeOptions {
  trigger?: string;
  // Fire-and-forget one-mcp first-look reporter; injected so shared/ stays
  // free of the runner layer. Defaults to a no-op.
  reportOneMcp?: (cwd: string, state: Rec, trigger: string) => void;
  /**
   * What the legacy-plan migration did, when a CALLER already ran it.
   *
   * `materializeProjectIfNeeded` migrates before its own branches — it has to,
   * because three of them return `null` and the plan gate still needs the plan —
   * and only then may it delegate here. Without this the fold would be reported
   * by nobody: the second (idempotent) migration below finds the document
   * already gone and has nothing to say about it. Internal to this module; not
   * part of the `materialize-project` subcommand's surface.
   */
  migrationNotice?: string;
}

const noopReporter: NonNullable<ConvergeOptions['reportOneMcp']> = () => {};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * WHICH emptiness happened. One `skipped` id covers three different facts, and
 * a single sentence describing all three describes none of them: "the plugin
 * root resolved no rules/skills" is simply false for a root that resolved the
 * whole 45-rule spine and lost only `skills-catalog/`, and "too few to be a real
 * materialization" reads as nonsense next to `rules: 45`. The counts are already
 * in the result, so the reason can just be read off them instead of hedged.
 */
function emptyContentClause(result: MaterializeResult): string {
  if (result.rules === 0 && result.skills === 0) return 'resolved nothing at all — not one rule file, not one skill';
  if (result.skills === 0) return `resolved ${plural(result.rules, 'rule file')} but not a single skill`;
  return `resolved ${plural(result.skills, 'skill')} but not a single rule file`;
}

// The torn-root diagnosis, in the terms an operator can check: how much of what
// this project needs each tree was missing, and enough names to grep the tree
// with. Bounded, because the missing list can be the whole catalog.
function tornContentClause(torn: TornRootEvidence): string {
  const parts: string[] = [];
  for (const [label, kind] of [['rules/', torn.rules], ['skills-catalog/', torn.skills]] as const) {
    if (kind.missing.length === 0) continue;
    const shown = kind.missing.slice(0, 5).join(', ');
    const rest = kind.missing.length > 5 ? `, … +${kind.missing.length - 5} more` : '';
    parts.push(`\`${label}\` resolved ${kind.resolved} of the ${kind.candidates} entries this project needs, missing ${shown}${rest}`);
  }
  return parts.join('; ');
}

function outcome(status: MaterializeStatus, systemMessage: string, context: string, result: MaterializeResult | null = null): MaterializeOutcome {
  return { status, systemMessage, context, result };
}

/**
 * THE HOST ROLE CONTRACTS ARE MISSING, and until this existed nothing said so.
 *
 * Rules and skills are the two things every other message in this file is
 * about; the per-role contracts are the third artifact a materialization
 * writes, and they are what a host loads to KNOW what `senior-architect` is.
 * Six writers used to swallow the failed `mkdirSync` and return a count, so a
 * project whose `.cursor/agents` was (say) a plain file got the ordinary
 * `materialized` line, a stamped state, and — because
 * `hasMaterializedProjectAssets` validates rules/skills/AGENTS.md/CLAUDE.md and
 * has never looked at role contracts — no further attempt for the life of that
 * plugin build. Measured: healthy run 102 written / six contracts; the same run
 * with the directory refused, 96 written / ZERO contracts and every reported
 * field otherwise identical.
 *
 * Reported rather than thrown, and reported WITHOUT moving the status. Throwing
 * puts an error into the hook runtime, where it becomes a fail-closed deny that
 * can wedge a session — a defect this repo has taken before. Moving the status
 * off `materialized` would not merely relabel: onboarding-gate/handler.ts turns
 * a status other than `materialized`/`current` on a mutating PreToolUse into the
 * `materialization-not-converged` deny, whose CAUSE (a plugin root or a state
 * file that is broken) and whose REMEDY are not these — this file's naming rule
 * for deny ids forbids the merge, and the diagnosis would send an operator to
 * re-check a plugin tree that is perfectly fine.
 *
 * WHETHER AN ABSENT HOST CONTRACT SHOULD REFUSE WORK is now settled — it does,
 * for file-changing tools only, under its own deny id
 * (`host-role-contracts-unwritable`, onboarding-gate/handler.ts) — and this
 * function is still not where that happens. The gate asks
 * role-contract-status.ts, which reads the directory instead of a run's result,
 * for the reason the two cannot be the same answer: a refused directory outlives
 * the run that discovered it, and the run that discovered it may be the only one
 * that ever ran. What this function owes is the DIAGNOSIS, in the channel that
 * already carries every other materialization message.
 *
 * The retry it used to disclaim is real now: `materializeProjectIfNeeded` below
 * carries `roleContractsNeedConvergence` as a term, so every later hook attempts
 * these contracts again and this notice repeats until the path is cleared — which
 * is also what writes them the moment it is.
 */
function roleContractShortfallNotice(cwd: string, result: MaterializeResult | null): string {
  const shortfall = result?.roleContracts;
  if (!shortfall) return '';
  return `Traffic One role contracts are missing: ${roleContractShortfallSentence(cwd, shortfall)} `
    + 'The rules and skills above are on disk; these are not. '
    + 'The usual causes are a file or a symlink planted at that path, a directory this user cannot write, '
    + 'or a read-only checkout. Clear the path — every later hook re-attempts the contracts on its own, and '
    + 'until one succeeds, file-changing tool calls are refused (`host-role-contracts-unwritable`) while '
    + 'read-only work continues.';
}

/**
 * Fold a role-contract shortfall into an outcome a DIFFERENT reporter built.
 *
 * Exported for the same reason `materializeRefusedOutcome` and
 * `stateWriteRefusedOutcome` are: modules/materialize/converge-from-write.ts
 * assembles its own `materialized`/null answers for the project-memory-write
 * path, and it discarded this fact outright — a write that converged a project
 * whose role contracts were refused reported the ordinary success line. One
 * renderer, so the two routes cannot drift into two different accounts of one
 * condition.
 */
export function withRoleContractShortfall(cwd: string, outcome: MaterializeOutcome): MaterializeOutcome {
  const notice = roleContractShortfallNotice(cwd, outcome.result);
  if (!notice) return outcome;
  return {
    ...outcome,
    systemMessage: `${outcome.systemMessage} — but this host's per-role contracts were NOT written`,
    context: `${outcome.context} ${notice}`,
  };
}

// materializeProjectAssets refuses to touch disk whenever it cannot resolve the
// content it would otherwise sweep — a plugin root that is 'unverified' or a
// 'source' checkout, a resolved rule/skill set that came back empty while the
// project's manifest still tracks content, or a root that resolved only SOME of
// what the project needs — and, before any of those, when the project has not
// consented to Traffic One at all (see materialize.ts for all five). In every
// case existing .traffic-one/rules and .traffic-one/skills
// are left exactly as they were. Surface that here, with the one diagnostic that
// actually explains it — which of the four *_PLUGIN_ROOT env vars supplied the
// root, or that none did (pluginRootInfo().source) — instead of the generic
// 'current' outcome the written<=0/removed<=0 fallback below would otherwise
// report, which would read as "nothing to do" rather than "the plugin could not
// be read". Exported so every direct materializeProjectAssets caller
// (converge-from-write.ts's project-memory-write path included) reports the
// same diagnostic instead of falling through to its own generic no-op handling.
export function materializeRefusedOutcome(result: MaterializeResult): MaterializeOutcome {
  const info = pluginRootInfo();
  const sourceLabel = info.source === 'default' ? "the runtime's own location" : info.source;
  const preserved = 'Nothing was deleted or rewritten: `.traffic-one/rules`, `.traffic-one/skills`, `.traffic-one/manifest.json` and root `AGENTS.md` are unchanged.';
  const doctor = `Run the read-only Traffic One doctor to diagnose the plugin root: ${doctorCommand()}.`;
  // Not a plugin-root problem, and it must not be described as one: this project
  // either has not answered "use Traffic One here?" yet or answered no, so
  // nothing about the plugin tree needs fixing and the doctor has nothing to
  // diagnose. Handled before the root branches below so the generic
  // fallback — "plugin root could not be verified" — can never claim it.
  if (result.skipped === 'plugin-use-not-permitted') {
    return outcome(
      'skipped',
      'traffic-one — this project has not opted in to Traffic One; materialization skipped',
      'Nothing was created, rewritten, or deleted anywhere in the project: no `.traffic-one/**`, no root `AGENTS.md`/`CLAUDE.md`/`.gitignore`, no host role files. A project whose use-plugin question is unanswered stays byte-identical, and a project that declined is left untouched (see `shared/state/plugin-use.ts`). Answer the question to materialize.',
      result,
    );
  }
  if (result.skipped === 'plugin-root-source-checkout') {
    return outcome(
      'skipped',
      'traffic-one — plugin root is a source checkout, not a built plugin; project materialization skipped',
      `Resolved plugin root \`${info.root}\` (from ${sourceLabel}) is the Traffic One SOURCE checkout: its rules live under \`src/modules/*/rules/**\` and its skills under \`src/modules/skills/skills-catalog/**\`, neither of which is the shipped tree — \`npm run gen\` composes \`rules/\` and \`skills-catalog/\` from every content module. Materializing from a checkout would write content that differs from the released plugin, so it was skipped. ${preserved} Fix it by building the plugin (\`npm run gen && npm run build\`) and pointing the plugin root at the generated \`dist/\`, or by installing the plugin through its marketplace. ${doctor}`,
      result,
    );
  }
  if (result.skipped === 'resolved-content-empty') {
    const emptyKind = result.rules === 0 && result.skills === 0
      ? 'no rules and no skills'
      : result.skills === 0 ? 'no skills' : 'no rules';
    return outcome(
      'skipped',
      `traffic-one — the plugin root resolved ${emptyKind} for this project; materialization skipped to preserve the existing ones`,
      `Resolved plugin root \`${info.root}\` (from ${sourceLabel}) classifies as an installed plugin, but it ${emptyContentClause(result)} for this project, and continuing would have deleted the project's only copy of whatever \`.traffic-one/manifest.json\` still tracks. ${preserved} This is what a partially written or partially copied plugin tree looks like (an interrupted install, a \`dist/\` caught mid-\`npm run gen\`, an in-flight \`rsync\`), so re-check the plugin root's \`rules/\` and \`skills-catalog/\` trees, then retry \`materialize-project\`. ${doctor}`,
      result,
    );
  }
  // The torn root: enough content to look healthy to every count-based check,
  // not enough to be the release it claims to be. Named separately from the
  // emptiness above because the operator symptom is different — the trees are
  // THERE, they are just short — and because a reader who is told "resolved no
  // rules/skills" about a root that resolved 45 of 47 will go looking for the
  // wrong fault.
  if (result.skipped === 'plugin-root-content-incomplete' && result.torn) {
    return outcome(
      'skipped',
      'traffic-one — the plugin root is incomplete (a partially copied plugin tree); materialization skipped to preserve the existing rules/skills',
      `Resolved plugin root \`${info.root}\` (from ${sourceLabel}) classifies as an installed plugin and resolved SOME of this project's content, but its content trees are incomplete: ${tornContentClause(result.torn)}. A complete install always satisfies every entry its own runtime asks for — the rule manifests and skill buckets are compiled from the same commit that emits \`rules/\` and \`skills-catalog/\` — so a shortfall means the tree and the runtime did not come from one build. Continuing would have deleted every manifest-tracked rule and skill absent from that partial set: \`.traffic-one/rules\` and \`.traffic-one/skills\` are the project's ONLY copy. ${preserved} Re-check the plugin root for an interrupted install, an in-flight \`rsync\`, a \`dist/\` caught mid-\`npm run gen\`, or a host plugin cache mid-update, then retry \`materialize-project\`. ${doctor}`,
      result,
    );
  }
  return outcome(
    'skipped',
    'traffic-one — plugin root could not be verified; project materialization skipped',
    `Resolved plugin root \`${info.root}\` (from ${sourceLabel}) carries neither a compiled runtime (\`scripts/hook-runtime.cjs\`) alongside non-empty generated content (\`rules/\` or \`skills-catalog/\`) nor the source checkout markers, so materialization was skipped instead of risking deletion of \`.traffic-one/rules\` and \`.traffic-one/skills\` already on disk. ${preserved} ${doctor} Retry \`materialize-project\` once the root resolves to an installed plugin.`,
    result,
  );
}

/**
 * The state file could not be written, so this convergence is not RECORDED — and
 * unlike a lost artifact that is the one loss which cannot heal itself.
 *
 * `materializedStack`/`materializedAt`/`materializedVersion` are the whole record
 * that materialization happened; `isMaterialized()` reads them to decide whether
 * to converge again, so without them `materializeProjectIfNeeded` re-materializes
 * on every call and keeps returning a NON-NULL outcome. Its consumer in
 * onboarding-gate/handler.ts denies EVERY non-null outcome on a mutating
 * PreToolUse; it picks the id by STATUS — `repaired-materialization` ("we just
 * repaired it, retry") for the two that converged, `materialization-not-converged`
 * for the rest — so a refused stamp turns a self-healing condition into a
 * permanent deny loop over assets that are already on disk, with nothing in
 * either message naming the write that was refused. Reported as `failed` and
 * naming the fence and the exact path, the way persistCompiledArchitecture does:
 * `failed` lands in that second bucket, so the refusal an operator can act on is
 * what the deny quotes instead of a repair instruction that cannot work.
 *
 * Exported so converge-from-write.ts's project-memory path reports the identical
 * diagnostic, exactly as it already shares materializeRefusedOutcome above.
 */
export function stateWriteRefusedOutcome(result: MaterializeResult | null = null): MaterializeOutcome {
  return outcome(
    'failed',
    'traffic-one — project state could not be written, so this materialization is not recorded',
    'The project-local rules/skills and `.traffic-one/manifest.json` were written, but the state write fence refused '
    + '`.traffic-one/.one.json`, so `materializedStack`/`materializedAt`/`materializedVersion` were NOT stamped. Nothing '
    + 'reads the materialization as current without them, so every later hook re-converges and re-reports this — the '
    + 'assets on disk are fine and the state file is what needs fixing. A planted symlink at `.traffic-one/.one.json` is '
    + 'the usual cause (the fence refuses writing through a link, dangling or not); restore it as a regular file, or if '
    + `this project has not answered "use Traffic One here?" answer it, then retry.`,
    result,
  );
}

// The `materialize-project` subcommand body: validate state, write
// .traffic-one/** rules+skills + root AGENTS.md/CLAUDE.md, stamp the state, and
// kick the background reporter.
export function materializeProjectFromState(cwd: string, opts: ConvergeOptions = {}): MaterializeOutcome {
  const trigger = opts.trigger || 'manual materialize-project';
  const reportOneMcp = opts.reportOneMcp || noopReporter;

  // THE MIGRATION'S RETURN VALUE HAS A READER, and this is it. It folds a legacy
  // `architecture.md` into `.traffic-one/plan.md` and REMOVES the file, and both
  // call sites here used to discard what it reported — so its own docblock
  // reasoned at length about which paths `migrated` may name while nothing read
  // the answer. `report` carries it into the `context` of every outcome this
  // function returns, which is the text onboarding-gate/handler.ts puts in front
  // of the agent. Read at CALL time, not captured: a caller that already migrated
  // (see `migrationNotice`) has its notice on the early returns below too, which
  // happen before this function's own migration and would otherwise drop it.
  let notice = opts.migrationNotice || '';
  // The role-contract shortfall rides the same channel as the migration notice
  // and is read at CALL time for the same reason: it is discovered by the writer
  // partway through, and every outcome returned after that must carry it.
  const report = (result: MaterializeOutcome): MaterializeOutcome => {
    const withShortfall = withRoleContractShortfall(cwd, result);
    if (!notice) return withShortfall;
    return { ...withShortfall, context: `${withShortfall.context} ${notice}` };
  };

  if (isNonProjectRoot(cwd)) {
    return report(outcome(
      'authoring-root',
      'traffic-one — plugin authoring root detected; project materialization skipped',
      'This directory is the Traffic One plugin source, not a generated Traffic One project. `materialize-project` only rewrites `.traffic-one/**`, root `AGENTS.md`, and root `CLAUDE.md` inside projects created with the plugin.',
    ));
  }

  try { ensureRunnerShims(); } catch { /* best-effort; MCP may load before sessionStart */ }

  const state = readEffectiveState(cwd);
  const validStackIds = Object.keys(STACKS);
  const validCodeGraphProviders = ['gitnexus', 'graphify'];

  if (!state || typeof state !== 'object') {
    return report(outcome(
      'missing-state',
      'traffic-one — `.traffic-one/.one.json` is missing or invalid; cannot materialize project rules',
      'Write the complete Traffic One state file first, then run `node -e "const p=require(\'node:path\'),e=process.env,r=p.resolve(e.TRAFFIC_ONE_PLUGIN_ROOT||e.CURSOR_PLUGIN_ROOT||e.CODEX_PLUGIN_ROOT||e.CLAUDE_PLUGIN_ROOT||process.cwd());process.argv.splice(1,0,\'traffic-one-runtime\');require(p.join(r,\'scripts\',\'hook-runtime.cjs\'))" materialize-project` from the project root.',
    ));
  }

  const hadLocalPreferenceFields = hasLocalPreferenceFields(state);
  const normalizedBeforeValidation = normalizeState(state, (state.mode as string) || detectMode(cwd));
  // Genuinely best-effort for the CANONICALIZATION itself — validation below runs
  // on the in-memory state either way — but a refusal here is the same durable
  // fact the stamp write hits at the end, so it is carried rather than dropped:
  // no point materializing and then reporting `materialized` when we already know
  // the stamp cannot land.
  let stateRecorded = true;
  if (normalizedBeforeValidation || hadLocalPreferenceFields) {
    try {
      stateRecorded = writeState(cwd, state);
    } catch {
      // best-effort; validation below still reports any missing fields.
    }
  }

  const cgProvider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  const validationIssues = trafficOneStateValidationIssues(state, validCodeGraphProviders);
  if (validationIssues.length > 0) {
    const context = postWriteIncompleteWarning({
      stack: (state.stack as string) || null,
      validStackIds,
      codeGraphProvider: cgProvider,
      validCodeGraphProviders,
      validationIssues,
    });
    return report(outcome(
      'incomplete',
      'traffic-one — `.traffic-one/.one.json` is incomplete; cannot materialize project rules yet',
      context,
    ));
  }

  // The migration runs HERE and not earlier: it writes into `.traffic-one/` and
  // removes a file, and a project whose state is missing or incomplete has not
  // established that Traffic One may do either. A caller that already migrated
  // supplied its notice above; this is the direct-call path.
  notice = notice || planMigrationNotice(migrateArchitectureDocsToPlan(cwd));

  let materialized: MaterializeResult | null = null;
  try {
    materialized = materializeProjectAssets(cwd, state);
  } catch (error) {
    const detail = error && (error as Error).message ? (error as Error).message : String(error || 'unknown error');
    return report(outcome(
      'failed',
      'traffic-one — project-local materialization failed',
      `traffic-one could not materialize .traffic-one/rules, .traffic-one/skills, and .traffic-one/manifest.json: ${detail}`,
    ));
  }

  // A refused run materialized NOTHING, so the state stamp must not claim it
  // did. materializedStack/materializedAt/materializedVersion are what
  // isMaterialized() reads to short-circuit later convergence attempts; stamping
  // them here would turn a transient, self-healing condition (a plugin root that
  // is mid-write, misconfigured, or a source checkout) into a project that never
  // tries again — the "never self-heals" half of the incident. Leaving them
  // untouched keeps every later hook re-attempting until a real materialization
  // succeeds. `skipped: 'plugin-authoring-root'` cannot appear here: this
  // function returns the authoring-root outcome above before calling the writer.
  if (materialized?.skipped) {
    return report(materializeRefusedOutcome(materialized));
  }

  try {
    state.materializedStack = stackFingerprint(state);
    state.materializedAt = nowIsoNoMs();
    state.materializedVersion = stateVersion();
    if (!writeState(cwd, state)) stateRecorded = false;
  } catch {
    // best-effort; the copied local assets are still usable.
  }
  if (!stateRecorded) return report(stateWriteRefusedOutcome(materialized));

  reportOneMcp(cwd, state, trigger);

  if (!materialized || (materialized.written <= 0 && materialized.removed <= 0)) {
    return report(outcome(
      'current',
      'traffic-one — project-local rules/skills already materialized',
      `Project-local rules/skills are current for ${stackFingerprint(state)}. Root AGENTS.md contains or preserves existing content with the Traffic One active rule kernel/index; root CLAUDE.md symlinks to AGENTS.md only when no CLAUDE.md exists.`,
      materialized,
    ));
  }

  return report(outcome(
    'materialized',
    'traffic-one — project-local rules/skills materialized',
    `Project-local rules/skills materialized after ${trigger}: ${materialized.rules} rule files, ${materialized.skills} skills, manifest .traffic-one/manifest.json. Root AGENTS.md contains or preserves existing content with the Traffic One active rule kernel/index; root CLAUDE.md symlinks to AGENTS.md only when no CLAUDE.md exists.`,
    materialized,
  ));
}

/**
 * Never auto-converge a WORKSPACE SUB-PACKAGE THAT HOLDS NO STATE OF ITS OWN,
 * whether the workspace merely GLOBBED it or actually REGISTERED it.
 *
 * The first arm is the incumbent rule and unchanged: when `cwd` owns no Traffic
 * One state but sits inside a workspace (an ancestor declares package.json
 * workspaces / pnpm-workspace.yaml / a Gradle settings file), it belongs to
 * that workspace root, and converging it would mint a stray shallow
 * `.traffic-one/.one.json` here (detectMode labels any sparse dir
 * 'new-project'). resolveProjectRoot already anchors callers at the real root;
 * this is the write-side backstop for a caller that passes a raw sub-package
 * cwd.
 *
 * The second arm is the workspace clause, and it is a REFUSAL rather than an
 * exemption because the exemption spelling was measurably wrong. Spelled as
 * `if (isRegisteredWorkspaceMember(cwd)) return false`, it did not grant a
 * registered member a materialization — the member still has no stack, no mode
 * and no `onboardingComplete`, so every branch below still returns null — it
 * only let execution WALK FURTHER DOWN THIS FUNCTION. And a few lines below the
 * refusal sat `migrateArchitectureDocsToPlan`, at the time an ungated raw-`fs`
 * writer. MEASURED on a registered member holding a hand-written
 * `architecture.md`, against its unregistered sibling in the same container:
 *
 *                                    unregistered   registered (exemption)
 *   converge return                  null           null
 *   member architecture.md survives  true           FALSE
 *   member .traffic-one/plan.md      absent         MINTED
 *
 * Identical return, opposite effect on the user's file. An exemption whose only
 * observable consequence is that more code runs is not an exemption, so the
 * clause now exits where the incumbent rule exits and the exempt directory is
 * genuinely left alone: after the change both columns read null / true / absent.
 *
 * The migration has since been gated on READABLE STATE at its own definition,
 * which independently closes those two rows for a stateless member and for
 * every other caller — the fix belongs there, because the directory it must not
 * touch is not always a workspace member.
 *
 * WHAT THIS REFUSAL ALONE STILL HOLDS IS THE RETURN VALUE, and the previous
 * version of this docblock named the wrong row. It claimed the refusal was the
 * only thing standing between a stateless member and `writeState` minting a
 * stray shallow `<member>/.traffic-one/.one.json`. Measured with the refusal
 * mutated off, that row does not move: `readEffectiveState` answers `{}` for a
 * stateless directory, `normalizeState` finds nothing to canonicalize, and the
 * unknown-stack branch returns null long before any writer. All three disk rows
 * of the pin were byte-identical with the refusal deleted — it was unmeasured,
 * not defence in depth.
 *
 * The shape that does move is the one directory that HAS state and no state
 * FILE: a member carrying the pre-`.one.json` legacy lock (`.claude-plugin-mode`)
 * naming `new-project`. `readEffectiveState` honours that file, `hasStateFile`
 * does not, so the mode branch is satisfied and `materializeProjectFromState`
 * runs and returns `incomplete` about a directory that is not a project. That
 * return is not cosmetic: onboarding-gate/handler.ts turns any non-null outcome
 * on a mutating PreToolUse into a deny, and a non-converged one into
 * `materialization-not-converged`, which repeats byte-identically for as long as
 * the file is there. MEASURED on that member, refusal on vs off:
 *
 *                                    refusal on   refusal off
 *   converge return                  null         outcome:incomplete
 *   member architecture.md survives  true         true
 *   member .traffic-one/.one.json    absent       absent
 *
 * So the pin reads the RETURN for that shape, which is the row this guard
 * decides, and keeps the three disk rows for the shapes above — where they pin
 * the migration's own gate rather than this one.
 *
 * KEYED ON HOLDING NO STATE, which is what keeps this a refusal of NOTHING a
 * member wants. A registered member that HAS committed state fails both arms —
 * `isUnclaimedWorkspaceSubPackage` returns false for any directory with a state
 * file, and so does this one — so it converges and materializes exactly as it
 * does today. What is refused is only the cell that had nothing to do anyway.
 *
 * IT ALSO CLOSES A SHAPE THE INCUMBENT RULE NEVER COVERED. A container that
 * registers members WITHOUT declaring package-manager workspaces (a Go or Maven
 * workspace) makes `isUnclaimedWorkspaceSubPackage` answer false, so its
 * stateless members walked down to the same deletion with the exemption absent
 * entirely. The registry arm catches them.
 *
 * `indeterminate` folds to false inside `isRegisteredWorkspaceMember`, so an
 * unreadable registry grants nothing and leaves the incumbent rule in charge —
 * the same direction as before, now meaning "refuse only what the glob refuses"
 * instead of "allow only what the glob allows".
 *
 * NAMED AND EXPORTED rather than inlined at the call site, so the composed
 * decision is the thing a test holds to account. The behavioural pin lives in
 * __tests__/workspace-member-converge.test.ts and is the `architecture.md` table
 * above: it is what proves the two arms agree on effects and not merely on
 * return values.
 */
export function isStatelessWorkspaceSubPackage(cwd: string): boolean {
  if (isUnclaimedWorkspaceSubPackage(cwd)) return true;
  return !hasStateFile(cwd) && isRegisteredWorkspaceMember(cwd);
}

// Hook-time convergence guard: ensure a project's .traffic-one/** is current
// for its state, materializing on demand. Returns null when nothing is needed
// (the common case); callers that only want the side-effect ignore the return.
export function materializeProjectIfNeeded(cwd: string, opts: ConvergeOptions = {}): MaterializeOutcome | null {
  const trigger = opts.trigger || 'generic hook convergence';
  const reportOneMcp = opts.reportOneMcp || noopReporter;

  if (isNonProjectRoot(cwd)) return null;

  // Ahead of EVERY mutation below, `migrateArchitectureDocsToPlan` included.
  if (isStatelessWorkspaceSubPackage(cwd)) return null;

  const state = readEffectiveState(cwd);
  if (!state || typeof state !== 'object') return null;

  // Ahead of the branches below, three of which return `null`: the plan gate asks
  // for a plan even on a project this function finds nothing else to do for. The
  // notice is threaded into every delegation so the fold is reported by the
  // outcome this convergence produces rather than by the second, idempotent
  // migration inside it, which finds the document already gone.
  const migrationNotice = planMigrationNotice(migrateArchitectureDocsToPlan(cwd));
  const delegate = (): MaterializeOutcome => materializeProjectFromState(cwd, { trigger, reportOneMcp, migrationNotice });

  const normalized = normalizeState(state, (state.mode as string) || detectMode(cwd));
  if (normalized) {
    let canonicalized = true;
    try {
      canonicalized = writeState(cwd, state);
    } catch {
      // Let the materializer surface a validation or write failure below.
    }
    // The canonicalization itself is best-effort — every branch below reads the
    // normalized IN-MEMORY copy, so the decision is the same either way — but the
    // refusal is a durable fact about `.one.json`, and three of those branches
    // return `null`, i.e. "nothing needed", about a project whose state file
    // cannot be written at all. Hand it to materializeProjectFromState, this
    // module's single reporter for that condition.
    if (!canonicalized) return delegate();
  }

  if (!state.stack || !isKnownStack(state.stack)) {
    if (state.mode === 'new-project' || state.onboardingComplete === true) {
      return delegate();
    }
    return null;
  }
  if (state.onboardingComplete !== true) return null;

  // `materializedContentIsIncomplete` is the third condition and not a
  // refinement of the second: hasMaterializedProjectAssets validates the
  // manifest against DISK, which is exactly what a project truncated by a
  // partially copied plugin root passes — its one skill is present, its stamp is
  // current, and nothing looks wrong. Without this the other 46 never return.
  // See has-assets.ts for why it is a subset check and why it cannot loop.
  //
  // `materializedFromDifferentPluginBuild` is the fourth, and it is the one
  // that makes an UPGRADE visible. The first three all pass for a project whose
  // content is complete, present, and simply from the previous release: the
  // stack fingerprint did not move, every manifest-tracked file is on disk, and
  // the runtime's declared set is satisfied. Only the plugin build changed —
  // and `isMaterialized`'s version comparison misses that whenever the release
  // shipped without a hand-bump, which is 11 of the last 14 content commits in
  // this repo (shared/build-provenance.ts). This is where a user who upgraded stops
  // silently serving the previous release's rules and skills.
  //
  // `roleContractsNeedConvergence` is the fifth, and it is the term that makes
  // the host's per-role contracts a first-class part of "is this project
  // current". The four above cannot see them: `hasMaterializedProjectAssets`
  // validates the manifest, root AGENTS.md/CLAUDE.md and every tracked rule and
  // skill, and role contracts are in none of those — so a project whose
  // `.cursor/agents` is a plain file passes all four, forever, and the contracts
  // that define every spawned role stay absent for the life of the plugin build.
  // Measured before this existed: `materialized` with ZERO contracts on disk and
  // `materializeProjectIfNeeded` returning null on the very next hook.
  //
  // It answers true for a REFUSED directory and for an EMPTY one, and both arms
  // are load-bearing in opposite directions. The refused arm makes the run report
  // the fault every time instead of once — which is what the pre-tool deny reads.
  // The empty arm is the self-heal: the hook after a human clears the path finds
  // an empty directory, converges, and the contracts land. Without it the refusal
  // would go quiet the instant the path was cleared and leave the contracts
  // missing, which is the original defect with an extra step.
  //
  // Self-limiting, like the two disk-reading terms beside it: a successful write
  // makes it false, and a profile with no eligible roles never makes it true (see
  // role-contract-status.ts), so it cannot spin on a project that legitimately
  // has no contracts to write.
  //
  // AND ASKED ONLY OF A PROJECT WHOSE STATE IS OTHERWISE VALID, which is not
  // fastidiousness — it bounds the blast radius to the condition it is about.
  // `delegate()` validates the state before it writes anything, so on a project
  // carrying a pre-migration `.one.json` (no `projectContext`, no `mobile.source`,
  // legacy top-level `team`/`performance`) it answers `incomplete` — and
  // onboarding-gate/handler.ts turns any non-`materialized`/`current` outcome on a
  // mutating tool use into the `materialization-not-converged` deny. Without this
  // guard, adding a term about ROLE CONTRACTS would newly refuse file-changing work
  // on a class of project that has never been refused and whose contracts are not
  // even the problem. MEASURED while landing this: two existing converge tests
  // moved from `null` to a full state-validation wall, one of them the
  // already-materialized short-circuit. A project in that state keeps the behaviour
  // it had; the dangerous shape — a directory that is REFUSED rather than
  // empty — is still refused at the gate, which reads disk and does not consult
  // this conjunction at all.
  const roleContractsShort = trafficOneStateValidationIssues(state, ['gitnexus', 'graphify']).length === 0
    && roleContractsNeedConvergence(cwd, state);
  if (isMaterialized(state)
    && hasMaterializedProjectAssets(cwd, state)
    && !materializedContentIsIncomplete(cwd, state)
    && !materializedFromDifferentPluginBuild(cwd)
    && !roleContractsShort) {
    reportOneMcp(cwd, state, trigger);
    return null;
  }

  return delegate();
}
