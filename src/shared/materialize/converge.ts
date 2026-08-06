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
import { isUnclaimedWorkspaceSubPackage } from '../hook/paths';
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
import { hasMaterializedProjectAssets, materializedContentIsIncomplete } from './has-assets';
import { materializeProjectAssets, type MaterializeResult, type TornRootEvidence } from './materialize';
import { migrateArchitectureDocsToPlan } from './plan-migration';

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
 * onboarding-gate/handler.ts reads any non-null outcome on a mutating PreToolUse
 * as `deny('repaired-materialization')` — "we just repaired it, retry" — so a
 * refused stamp turns a self-healing condition into a permanent deny loop over
 * assets that are already on disk, with nothing in either message naming the
 * write that was refused. Reported as `failed` and naming the fence and the exact
 * path, the way persistCompiledArchitecture does: no consumer branches on the
 * status, so this changes no control flow — it stops the outcome claiming
 * `materialized`/`current` and puts the cause in the message an operator reads.
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

  if (isNonProjectRoot(cwd)) {
    return outcome(
      'authoring-root',
      'traffic-one — plugin authoring root detected; project materialization skipped',
      'This directory is the Traffic One plugin source, not a generated Traffic One project. `materialize-project` only rewrites `.traffic-one/**`, root `AGENTS.md`, and root `CLAUDE.md` inside projects created with the plugin.',
    );
  }

  try { ensureRunnerShims(); } catch { /* best-effort; MCP may load before sessionStart */ }

  const state = readEffectiveState(cwd);
  const validStackIds = Object.keys(STACKS);
  const validCodeGraphProviders = ['gitnexus', 'graphify'];

  if (!state || typeof state !== 'object') {
    return outcome(
      'missing-state',
      'traffic-one — `.traffic-one/.one.json` is missing or invalid; cannot materialize project rules',
      'Write the complete Traffic One state file first, then run `node -e "const p=require(\'node:path\'),e=process.env,r=p.resolve(e.TRAFFIC_ONE_PLUGIN_ROOT||e.CURSOR_PLUGIN_ROOT||e.CODEX_PLUGIN_ROOT||e.CLAUDE_PLUGIN_ROOT||process.cwd());process.argv.splice(1,0,\'traffic-one-runtime\');require(p.join(r,\'scripts\',\'hook-runtime.cjs\'))" materialize-project` from the project root.',
    );
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
    return outcome(
      'incomplete',
      'traffic-one — `.traffic-one/.one.json` is incomplete; cannot materialize project rules yet',
      context,
    );
  }
  migrateArchitectureDocsToPlan(cwd);

  let materialized: MaterializeResult | null = null;
  try {
    materialized = materializeProjectAssets(cwd, state);
  } catch (error) {
    const detail = error && (error as Error).message ? (error as Error).message : String(error || 'unknown error');
    return outcome(
      'failed',
      'traffic-one — project-local materialization failed',
      `traffic-one could not materialize .traffic-one/rules, .traffic-one/skills, and .traffic-one/manifest.json: ${detail}`,
    );
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
    return materializeRefusedOutcome(materialized);
  }

  try {
    state.materializedStack = stackFingerprint(state);
    state.materializedAt = nowIsoNoMs();
    state.materializedVersion = stateVersion();
    if (!writeState(cwd, state)) stateRecorded = false;
  } catch {
    // best-effort; the copied local assets are still usable.
  }
  if (!stateRecorded) return stateWriteRefusedOutcome(materialized);

  reportOneMcp(cwd, state, trigger);

  if (!materialized || (materialized.written <= 0 && materialized.removed <= 0)) {
    return outcome(
      'current',
      'traffic-one — project-local rules/skills already materialized',
      `Project-local rules/skills are current for ${stackFingerprint(state)}. Root AGENTS.md contains or preserves existing content with the Traffic One active rule kernel/index; root CLAUDE.md symlinks to AGENTS.md only when no CLAUDE.md exists.`,
      materialized,
    );
  }

  return outcome(
    'materialized',
    'traffic-one — project-local rules/skills materialized',
    `Project-local rules/skills materialized after ${trigger}: ${materialized.rules} rule files, ${materialized.skills} skills, manifest .traffic-one/manifest.json. Root AGENTS.md contains or preserves existing content with the Traffic One active rule kernel/index; root CLAUDE.md symlinks to AGENTS.md only when no CLAUDE.md exists.`,
    materialized,
  );
}

// Hook-time convergence guard: ensure a project's .traffic-one/** is current
// for its state, materializing on demand. Returns null when nothing is needed
// (the common case); callers that only want the side-effect ignore the return.
export function materializeProjectIfNeeded(cwd: string, opts: ConvergeOptions = {}): MaterializeOutcome | null {
  const trigger = opts.trigger || 'generic hook convergence';
  const reportOneMcp = opts.reportOneMcp || noopReporter;

  if (isNonProjectRoot(cwd)) return null;

  // Never auto-converge a monorepo SUB-PACKAGE as its own project. When `cwd` owns
  // no Traffic One state but sits inside a workspace (an ancestor declares
  // package.json workspaces / pnpm-workspace.yaml), it belongs to that workspace
  // root — bail before normalizeState/writeState below would mint a stray shallow
  // .traffic-one/.one.json here (detectMode labels any sparse dir 'new-project').
  // resolveProjectRoot already anchors callers at the real root; this is the
  // write-side backstop for a caller that passes a raw sub-package cwd.
  if (isUnclaimedWorkspaceSubPackage(cwd)) return null;

  const state = readEffectiveState(cwd);
  if (!state || typeof state !== 'object') return null;

  migrateArchitectureDocsToPlan(cwd);

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
    if (!canonicalized) return materializeProjectFromState(cwd, { trigger, reportOneMcp });
  }

  if (!state.stack || !isKnownStack(state.stack)) {
    if (state.mode === 'new-project' || state.onboardingComplete === true) {
      return materializeProjectFromState(cwd, { trigger, reportOneMcp });
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
  if (isMaterialized(state)
    && hasMaterializedProjectAssets(cwd, state)
    && !materializedContentIsIncomplete(cwd, state)) {
    reportOneMcp(cwd, state, trigger);
    return null;
  }

  return materializeProjectFromState(cwd, { trigger, reportOneMcp });
}
