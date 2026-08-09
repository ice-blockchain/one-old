// src/shared/materialize/materialize.ts
// The materialization writer: copies the active rules + skills into the project's
// .traffic-one/, renders AGENTS.md/CLAUDE.md, writes the manifest, and cleans up
// stale generated assets. Ported 1:1 from materializeProjectAssets.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { isNonProjectRoot } from '../authoring-root';
import { toPosix, writeTextIfChanged } from '../fs-text';
import { readText } from '../fsjson';
import { pluginRootInfo } from '../paths';
import { BOOTSTRAP_SKILLS, PROJECT_UNAVAILABLE_SKILLS } from '../../config/skill-filters';
import { activeSkillsForProject } from '../skill-filters';
import { capabilityProfileForRun, capabilityStateForRun, ensureProjectGitignore } from '../architecture-contract';
import {
  capabilityProfileForProject,
  eligibleRolesForProfile,
  runtimeCapabilityStateFromProfile,
} from '../capabilities';
import { roleScopedRuleUnion, stackSpecForState, templatePath } from '../stacks';
import { nowIsoNoMs } from '../text';
import { detectHost } from '../host';
import { projectWritesPermitted } from '../state/plugin-use';
import {
  cleanupPrevious,
  loadPreviousManifest,
  modeReferenceRulesForState,
  modeRuleCandidatesForState,
  modeRulesForState,
} from './cleanup';
import { writeCursorAgentFiles } from './cursor-agents';
import { writeCopilotAgentFiles } from './copilot-agents';
import { GENERATED_MARKER, copySkillDir } from './generated';
import { isLeanMaterialization } from './has-assets';
import { pluginContentHash } from '../build-provenance';
import { writeCodexAgentFiles } from './codex-agents';
import { writeKiloAgentFiles } from './kilo-agents';
import { cleanupLegacyOpenCodeProjectAssets, refreshOpenCodeGlobalAgentFiles } from './opencode-assets';
import { preserveManualRootContext, renderAgentsWithLocalContext, writeRootAgents, writeRootClaude } from './render-agents';
import { writeWindsurfAgentFiles } from './windsurf-agents';
import { writeWindsurfHostAssets } from './windsurf-assets';

type Rec = Record<string, unknown>;

// Maintainer-only catalog tooling is classified centrally and must never be
// copied into a user's shared project artifacts, even if a future bucket is
// configured incorrectly.
export interface MaterializeResult {
  rules: number;
  skills: number;
  written: number;
  removed: number;
  contextProfile: string;
  skipped?: string;
  // Evidence for the refusal in `skipped`, when naming the numbers is the whole
  // diagnostic — see tornRootRefusal. Absent on every successful run.
  torn?: TornRootEvidence;
}

// What a complete install was asked for versus what the root actually gave back,
// per kind. `missing` is the WHOLE list, not a sample: "46 of 47 skills are
// missing, starting with accessibility, api-design, …" is a diagnosis an
// operator can act on where a bare count is only an alarm, and the reporter
// (converge.ts) is the right place to decide how many of them to print.
export interface TornRootKind {
  readonly candidates: number;
  readonly resolved: number;
  readonly missing: readonly string[];
}

export interface TornRootEvidence {
  readonly rules: TornRootKind;
  readonly skills: TornRootKind;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function manifestList(previous: Rec, key: 'rules' | 'skills'): string[] {
  const value = previous[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

/**
 * SECOND, load-bearing refusal — and the only one that does not depend on a
 * classification being right.
 *
 * The destructive condition in this writer was never "the layout is X". It is
 * "the resolved content set came back EMPTY while the project's own manifest
 * still tracks content". cleanupPrevious(cwd, previous, rules, skills) deletes
 * every manifest-tracked rule/skill that is absent from the new sets, so an
 * empty set means delete ALL of them — and `.traffic-one/rules` +
 * `.traffic-one/skills` are the project's ONLY copy (the plugin ships
 * templates, not the project's materialized state). Whatever makes the sets
 * resolve empty — an unclassifiable root, a root a future classifier bug calls
 * healthy, a relative env value resolved against the wrong cwd, a plugin tree
 * being rewritten underneath a running hook, or a `skills-catalog/` that lost
 * a race with an rsync — the answer is the same: refuse, keep what is on disk,
 * and let the run report why. Nothing is lost by refusing; the next run
 * against a resolvable root converges normally.
 *
 * Checked per KIND, because a tree can be half-resolvable (`rules/` complete,
 * `skills-catalog/` still empty) and losing every skill is the same permanent
 * capability loss as losing every rule.
 *
 * The second clause covers the same broken root reaching a project that has
 * nothing to lose YET. A run that resolves zero rules AND zero skills is not a
 * materialization at all — a healthy installed root always resolves the stack's
 * mandatory rule spine and the `_common` skill set (config/skill-filters.ts) —
 * and completing it would write a manifest claiming `rules: []` plus an
 * AGENTS.md with an empty rule index, then let the caller stamp the project
 * "materialized" over nothing. Refusing keeps the run retryable instead.
 */
function contentLossRefusal(previous: Rec, rules: readonly string[], skills: readonly string[]): string | null {
  const rulesWouldBeSwept = rules.length === 0 && manifestList(previous, 'rules').length > 0;
  const skillsWouldBeSwept = skills.length === 0 && manifestList(previous, 'skills').length > 0;
  const nothingResolved = rules.length === 0 && skills.length === 0;
  return rulesWouldBeSwept || skillsWouldBeSwept || nothingResolved ? 'resolved-content-empty' : null;
}

/**
 * THIRD refusal: the SOURCE-SIDE COMPLETENESS check — the one that catches a
 * root which is torn rather than empty.
 *
 * Every clause of contentLossRefusal above keys on `length === 0`, and that is
 * not where the destructive window is. A plugin root caught mid-`rsync`,
 * half-extracted, or copied by an interrupted host cache update resolves SOME
 * of what this project needs — say 1 of 47 skills. No emptiness clause fires,
 * cleanupPrevious deletes the other 46 previously-materialized skills (they are
 * manifest-tracked and absent from the new set), the manifest is rewritten to
 * claim 1 skill, and converge.ts stamps `materializedAt` over it. The project
 * lost 46 skills and the stamp suppresses the retry that would heal it.
 *
 * The tempting check — resolved count versus the PREVIOUS MANIFEST's count — is
 * wrong and must not be added. A plugin upgrade removes rules and skills on
 * purpose (a retired skill, a rule folded into another), so "fewer than last
 * time" is the shape of a HEALTHY upgrade. Refusing on it would trade a rare
 * data loss for a false refusal on every legitimate upgrade.
 *
 * What is honest instead: ask the root for the whole candidate set the running
 * runtime declares, and refuse when the root cannot satisfy it. The candidate
 * set is not read from the root's own trees — it is CONFIG:
 *
 *   - rules: stackSpecForState (shared/stacks/index.ts) composes the mandatory
 *     spine and the reference set from the project's capability state, and
 *     roleScopedRuleUnion the envelope-referenced union. Pure functions of
 *     state; they never stat the plugin tree.
 *   - skills: activeSkillsForProject resolves SKILL_FILTERS buckets
 *     (config/skill-filters.ts) from the capability profile. Also pure.
 *
 * That is what makes it upgrade-proof, and the reason is worth stating plainly:
 * the config and the content SHIP TOGETHER IN ONE ARTIFACT. `rules/**` and
 * `skills-catalog/**` are emitted by `npm run gen` from the same commit that
 * compiles these tables into `dist/scripts/**`. A release that retires a skill
 * deletes both its catalog directory and its SKILL_FILTERS entry, so the
 * candidate set shrinks in lockstep with the tree and this predicate sees
 * nothing missing. Divergence means the two halves did not come from the same
 * build — a partially copied tree, or content and runtime from different
 * versions — which is exactly the condition where a sweep must not run.
 * Measured on this checkout: across 18,468 stack/frontend/backend/mobile/mode
 * combinations, every config-declared rule candidate exists in `rules/**` and
 * every bucket name in `skills-catalog/**`, with zero misses. That invariant is
 * enforced by content-completeness.test.ts, not assumed — if it ever breaks,
 * that test fails long before this refusal can fire on a healthy install.
 *
 * Checked per kind (a complete `rules/` beside a torn `skills-catalog/` is the
 * ordinary rsync shape), and it deliberately does NOT consult the previous
 * manifest: a first run against a torn root must not be stamped "materialized"
 * over a partial copy either, which is the half that never self-heals.
 */
// What the running runtime asked the plugin root for, and what came back.
interface ContentSet {
  readonly candidates: readonly string[];
  readonly resolved: readonly string[];
}

function tornKind(set: ContentSet): TornRootKind {
  const resolved = new Set(set.resolved);
  return {
    candidates: set.candidates.length,
    resolved: set.resolved.length,
    // Sorted, so the report is stable across runs and platforms.
    missing: set.candidates.filter((name) => !resolved.has(name)).sort(),
  };
}

function tornRootRefusal(rules: ContentSet, skills: ContentSet): TornRootEvidence | null {
  const evidence: TornRootEvidence = { rules: tornKind(rules), skills: tornKind(skills) };
  return evidence.rules.missing.length > 0 || evidence.skills.missing.length > 0 ? evidence : null;
}


// On-disk skill dirs (containing SKILL.md) that the manifest doesn't track.
function extraSkillDirs(skillsRoot: string, tracked: ReadonlySet<string>): string[] {
  try {
    return fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !tracked.has(entry.name))
      .filter((entry) => fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function materializeProjectAssets(cwd: string, state: Rec): MaterializeResult {
  if (isNonProjectRoot(cwd)) {
    return { rules: 0, skills: 0, written: 0, removed: 0, contextProfile: 'plugin-authoring', skipped: 'plugin-authoring-root' };
  }

  /**
   * The consent refusal, and the one place it can live for this writer.
   *
   * shared/fsjson.ts fences by PATH — `<project>/.traffic-one/**` — which makes
   * refusing the default for anything that goes through the codebase's own IO
   * helpers. This function is the one writer that path cannot describe. Measured
   * on a pending project against an installed plugin root, a single direct call
   * produced 51 paths plus two rewrites that the path fence is structurally
   * blind to, because they are not under the state dir at all:
   *
   *   - root `AGENTS.md` — `preserveManualRootContext` deletes the user's own
   *     file with raw `fs.rmSync`, then `writeRootAgents` writes 8.5 KB of
   *     generated context in its place;
   *   - root `CLAUDE.md` — same delete, then `writeRootClaude` replaces it with
   *     a symlink to AGENTS.md;
   *   - root `api.md`/`database.md`/`deployment.md`/`environment-setup.md`/
   *     `security.md` — `cleanupPrevious` COPIES them into `.traffic-one/` and
   *     leaves the root file where its owner put it (cleanup.ts
   *     adoptLegacyRootDocumentation). These carry no generated marker, so
   *     nothing on disk separates Traffic One's own legacy output from a docs
   *     repository's API reference;
   *   - root `.gitignore` — `ensureProjectGitignore`, below;
   *   - `.cursor/agents/**`, `.github/agents/**`, `.devin/agents/**`,
   *     `.windsurf/**`, the Kilo and OpenCode host project dirs — the
   *     host-native role writers further down;
   *   - 51 skill directories, created by `copySkillDir`'s raw `fs.mkdirSync`
   *     before its fenced file writes are refused one by one.
   *
   * The first two are the reason this refusal is not merely tidiness. On a
   * pending project the delete still landed while the preserving copy into
   * `.traffic-one/AGENTS.local.md` was refused by the path fence — so a
   * hand-written root AGENTS.md was not overwritten, it was DESTROYED, with the
   * only surviving copy suppressed. Fencing the writer closes the window that
   * split those two halves apart.
   *
   * `projectWritesPermitted` (caller-addressed) rather than
   * `projectStateWritable` (path-addressed): what is being asked here is not
   * "may I write this file" — there are 50+ files across five directories — but
   * "is this project ours to write into yet". Both read the same recorded answer
   * and the same ask-first flag, so they cannot disagree.
   *
   * It sits above the plugin-root check on purpose: consent is a fact about the
   * PROJECT and does not depend on the plugin tree, so a pending project gets
   * the honest reason instead of a plugin-root diagnostic it cannot act on.
   */
  if (!projectWritesPermitted(cwd)) {
    return { rules: 0, skills: 0, written: 0, removed: 0, contextProfile: 'unresolved', skipped: 'plugin-use-not-permitted' };
  }

  // FIRST of the three refusals that keep this writer from deleting a project's
  // only copy of its rules and skills. This one is cheap and by LAYOUT; the
  // load-bearing pair (contentLossRefusal, tornRootRefusal) below does not trust
  // any layout verdict. pluginRoot() never throws (paths.ts), but only an
  // 'installed' root — a generated AND built plugin distribution — carries the
  // tree the existsSync filters below read. Any other layout resolves `rules`
  // and `skills` empty, and cleanupPrevious then reads that emptiness as
  // "nothing is active" and deletes every previously materialized rule/skill
  // on disk. So:
  //   - 'unverified' (nonexistent, empty, a file, an unrelated dir, a partial
  //     or mid-write plugin tree): there is nothing to read.
  //   - 'source' (a TypeScript authoring checkout, including this repo under
  //     tsx): its rule/skill trees are NOT the shipped ones and no path join
  //     from it can be. `npm run gen` UNIONS `rules/**` across every content
  //     module that declares one in module.json and strips the provenance
  //     frontmatter from every SKILL.md (src/gen/emit/{rules,skills}.ts), so a
  //     `src/modules/...` fallback would copy near-miss bytes into a user's
  //     project and would silently go PARTIAL the moment rules are re-split
  //     across modules — a refactor gen supports with zero output diff. The
  //     three-candidate lookup in run-bootstrap-policy/materials.ts is not a
  //     precedent for adding one here: that resolver hashes prose and fails
  //     closed to null, while this one deletes files. Refusing also keeps the
  //     invariant AGENTS.md already documents (test:env builds `dist` first
  //     precisely because materialization has no `src/` fallback) enforced
  //     instead of merely assumed. `npm run gen && npm run build` — or
  //     pointing the env var at `dist/` — turns the root into an 'installed'
  //     one and this converges normally on the next run.
  // Either way: preserve what is there and let the caller (converge.ts) name
  // the root, the env var that supplied it, and the fix.
  const rootInfo = pluginRootInfo();
  if (rootInfo.layout !== 'installed') {
    return {
      rules: 0,
      skills: 0,
      written: 0,
      removed: 0,
      contextProfile: 'unresolved',
      skipped: rootInfo.layout === 'source' ? 'plugin-root-source-checkout' : 'plugin-root-unverified',
    };
  }

  // Precondition for the decision-log work item (`.traffic-one/runs/<id>/debug/`,
  // `.traffic-one/debug/`): every mode's first real materialization call is the
  // one place that reaches BOTH greenfield and existing-codebase projects, so
  // it is where `.gitignore` gets converged too — the compiler's own scaffold
  // path only ever fires on `new-project` (see `scaffold.ts` REPOSITORY_SCAFFOLD_OUTPUTS
  // + `compile.ts` isNewProject). Consent is already settled above, so this is
  // unconditional here; ensureProjectGitignore performs no consent check of its
  // own and its doc comment names this call site as the gate.
  //
  // `newProject` only selects the body of a block being CREATED. A block that
  // already exists records its own scope on disk (`GitignoreScope` in
  // architecture-contract/scaffold-content.ts) and THAT record, not this flag,
  // decides the refresh — so a later call cannot narrow an established full
  // block. That is what makes passing a re-derived mode harmless here:
  // onboarding/repair.ts re-derives a lost mode with `detectMode(cwd)`, which
  // answers `existing-codebase` for a populated scaffolded directory, so
  // `state.mode` is NOT stable for a project's lifetime.
  ensureProjectGitignore(cwd, { newProject: state.mode === 'new-project' });

  const root = rootInfo.root;
  const capabilityProfile = capabilityProfileForRun(cwd, state);
  const capabilityState = capabilityStateForRun(cwd, state);
  const leanMode = isLeanMaterialization(cwd, state);
  const spec = stackSpecForState(capabilityState);
  const inRoot = (relPath: string): boolean => fs.existsSync(path.join(root, templatePath(relPath)));
  const mandatoryRules = unique([
    ...spec.mandatory,
    ...modeRulesForState(root, capabilityState, capabilityProfile.profileId),
  ])
    .filter(inRoot);
  const referenceRules = unique([
    ...spec.optional,
    ...modeReferenceRulesForState(root, capabilityState, capabilityProfile.profileId),
  ])
    .filter(inRoot);
  // Envelope-referenced rules: hash-only bootstrap envelopes carry no bodies,
  // so every rule id a role envelope can reference must stay readable under
  // .traffic-one/rules/**. capabilityProfile is already the active run's frozen
  // snapshot profile when a run is in flight (capabilityProfileForRun); union
  // in the live project profile so the NEXT run's envelopes are covered too.
  // Both resolve with frozen state={}, mirroring resolvedRoleMaterials
  // (run-bootstrap-policy.ts). Bodies for superseded non-current runs may
  // lapse after a profile change — gate validation is unaffected (it reads the
  // plugin), only the local copy.
  const envelopeProfiles = [capabilityProfile, capabilityProfileForProject(cwd, state)];
  const envelopeCandidates = unique(envelopeProfiles.flatMap((profile) => roleScopedRuleUnion(
    [...eligibleRolesForProfile(profile), 'quick-fix'],
    runtimeCapabilityStateFromProfile(profile, {}),
  )));
  const envelopeRules = envelopeCandidates.filter(inRoot);
  const rules = unique([...mandatoryRules, ...referenceRules, ...envelopeRules]);
  const host = detectHost();
  // Split from the existsSync filter below, because the unfiltered list is the
  // CANDIDATE SET tornRootRefusal compares against.
  //
  // Mode rules are in it via modeRuleCandidatesForState, which is config-only by
  // construction (no `root` parameter). The two resolvers above cannot supply
  // them: both filter by existsSync, so a mode rule a torn tree lost simply
  // drops out of their result and the shortfall is invisible — the resolved set
  // narrows, cleanupPrevious sweeps the project's only copy, and the manifest is
  // rewritten without it. Measured on a root with `rules/modes/` intact except
  // one profile rule: the run proceeded, removed=1, and the manifest dropped the
  // entry. The declared halves (spine, profile rule, architecture, setup) are
  // covered; the slice family is not and cannot be — see cleanup.ts.
  const ruleCandidates = unique([
    ...spec.mandatory,
    ...spec.optional,
    ...modeRuleCandidatesForState(capabilityState, capabilityProfile.profileId),
    ...envelopeCandidates,
  ]);
  const skillCandidates = [...activeSkillsForProject(cwd, state, host)]
    .filter((name) => !BOOTSTRAP_SKILLS.has(name)) // bootstrap skills live in the host skills/ dir, not per-project
    .filter((name) => !PROJECT_UNAVAILABLE_SKILLS.has(name))
    .sort();
  const skills = skillCandidates.filter((name) => fs.existsSync(path.join(root, 'skills-catalog', name, 'SKILL.md')));

  const previous = loadPreviousManifest(cwd);
  // The refusal that makes the destructive condition unreachable, whatever the
  // layout verdict above was — see contentLossRefusal. It sits here, between
  // resolution and the first delete, because this is the only point where both
  // "what did the plugin root actually resolve to" and "what does this project
  // already have" are known. Nothing below it may run: cleanupPrevious deletes,
  // and the AGENTS.md/manifest writes further down would replace the project's
  // rule index and manifest with empty ones, which is the same capability loss
  // by a slower route.
  const contentLoss = contentLossRefusal(previous, rules, skills);
  if (contentLoss) {
    return {
      rules: rules.length,
      skills: skills.length,
      written: 0,
      removed: 0,
      contextProfile: 'unresolved',
      skipped: contentLoss,
    };
  }
  // The same refusal for the root that is torn rather than empty — checked
  // after the emptiness clauses so a root that resolved NOTHING keeps its more
  // specific reason instead of being reported as merely incomplete.
  const torn = tornRootRefusal(
    { candidates: ruleCandidates, resolved: rules },
    { candidates: skillCandidates, resolved: skills },
  );
  if (torn) {
    return {
      rules: rules.length,
      skills: skills.length,
      written: 0,
      removed: 0,
      contextProfile: 'unresolved',
      skipped: 'plugin-root-content-incomplete',
      torn,
    };
  }
  let removed = cleanupPrevious(cwd, previous, new Set(rules), new Set(skills));

  let written = 0;
  const projectMemoryRoot = path.join(cwd, '.traffic-one');
  for (const relPath of rules) {
    const source = fs.readFileSync(path.join(root, templatePath(relPath)), 'utf8').trimEnd();
    const content = `${GENERATED_MARKER}\n<!-- SOURCE: ${templatePath(relPath)} -->\n\n${source}\n`;
    if (writeTextIfChanged(path.join(projectMemoryRoot, relPath), content)) written += 1;
  }

  const skillsRoot = path.join(cwd, '.traffic-one', 'skills');
  for (const name of skills) {
    if (copySkillDir(path.join(root, 'skills-catalog', name), path.join(skillsRoot, name))) written += 1;
  }

  if (preserveManualRootContext(cwd, 'AGENTS.md', state)) written += 1;
  if (preserveManualRootContext(cwd, 'CLAUDE.md', state)) written += 1;

  // Provider-adopted skills (e.g. gitnexus's, relocated by the graph runners)
  // live on disk but are deliberately NOT manifest-tracked (cleanup never sweeps
  // them). List them in the Active Skills index so agents discover them.
  const indexSkills = [...skills, ...extraSkillDirs(skillsRoot, new Set(skills))].sort();
  const localAgents = renderAgentsWithLocalContext(cwd, capabilityState, rules, indexSkills, {
    mandatoryRules,
    referenceRules: unique([...referenceRules, ...envelopeRules]),
  });
  if (writeRootAgents(cwd, localAgents)) written += 1;
  if (writeRootClaude(cwd)) written += 1;

  // Host-native project role files are model-agnostic contracts. The active
  // user's plan, performance choice, and model lineup are injected at runtime
  // from local preferences rather than persisted in the shared project.
  if (detectHost() === 'cursor') written += writeCursorAgentFiles(cwd, capabilityState);
  if (detectHost() === 'copilot') written += writeCopilotAgentFiles(cwd, capabilityState);
  if (detectHost() === 'kilo') written += writeKiloAgentFiles(cwd, capabilityState);
  if (detectHost() === 'codex') written += writeCodexAgentFiles(cwd, capabilityState);
  // Legacy project-local OpenCode assets are shared, so every host removes only
  // Traffic One-generated copies. Model-pinned replacements are user-local and
  // are written exclusively by the active OpenCode host.
  removed += cleanupLegacyOpenCodeProjectAssets(cwd);
  if (detectHost() === 'opencode') written += refreshOpenCodeGlobalAgentFiles(cwd, capabilityState);
  let windsurfAssets: ReturnType<typeof writeWindsurfHostAssets> | null = null;
  let windsurfAgents = 0;
  if (detectHost() === 'windsurf') {
    windsurfAssets = writeWindsurfHostAssets(cwd, rules);
    windsurfAgents = writeWindsurfAgentFiles(cwd, capabilityState);
    written += windsurfAssets.written;
    written += windsurfAgents;
    removed += windsurfAssets.removed;
  }

  const mobile = capabilityState.mobile as Rec | undefined;
  // WHICH plugin build these bytes came from — the freshness signal
  // materializedFromDifferentPluginBuild (has-assets.ts) compares on the hook
  // path, and the same string doctor prints as `plugin.contentHash`. Resolved
  // from `root`, the layout-verified root this run actually copied from, not
  // from the ambient default: reporting a build other than the one that
  // supplied the files would make the stamp a fiction. The key is OMITTED when
  // the root cannot state one (a fixture or partial tree) rather than written
  // as null — absence says "unknown", and a null would be a claim.
  const buildHash = pluginContentHash(root);
  const manifestJson = (generatedAt: string): string => `${JSON.stringify({
    generatedBy: 'traffic-one',
    generatedAt,
    ...(buildHash ? { pluginContentHash: buildHash } : {}),
    contextProfile: leanMode ? 'lean' : 'full',
    stack: (capabilityState.stack as string) || 'minimal',
    frontend: (capabilityState.frontend as string) || 'none',
    backend: (capabilityState.backend as string) || 'none',
    mobile: (mobile && (mobile.framework as string)) || 'none',
    rules: rules.map(toPosix),
    skills,
    ...(windsurfAssets ? { windsurf: { rules: windsurfAssets.rules, skills: windsurfAssets.skills, agents: windsurfAgents } } : {}),
  }, null, 2)}\n`;
  // `generatedAt` refreshes only when the manifest CONTENT changed — otherwise a
  // repeat materialization would rewrite the file every wall-clock second and
  // defeat writeTextIfChanged. Compare against the canonical path only (a
  // legacy rules/manifest.json simply rewrites once).
  const manifestPath = path.join(cwd, '.traffic-one', 'manifest.json');
  const prevGeneratedAt = typeof previous.generatedAt === 'string' ? previous.generatedAt : '';
  const manifestUnchanged = Boolean(prevGeneratedAt) && readText(manifestPath) === manifestJson(prevGeneratedAt);
  if (!manifestUnchanged && writeTextIfChanged(manifestPath, manifestJson(nowIsoNoMs()))) {
    written += 1;
  }

  return { rules: rules.length, skills: skills.length, written, removed, contextProfile: leanMode ? 'lean' : 'full' };
}
