// src/shared/materialize/render-agents.ts
// Renders the project-local AGENTS.md (+ CLAUDE.md symlink). Ported 1:1 from the
// renderAgents family in scripts/hook-runtime/materialize/_helpers.cjs. The
// kernel/read-routing prose is parity-critical — kept verbatim.

import * as fs from 'fs';
import * as path from 'path';

import { readText, removePath } from '../fsjson';
import { writeTextIfChanged } from '../fs-text';
import { pluginRoot } from '../paths';
import { templatePath } from '../stacks';
import { GENERATED_MARKER, isGenerated } from './generated';
import { isLeanMaterialization } from './has-assets';

type Rec = Record<string, unknown>;

interface RenderOptions {
  leanMode?: boolean;
  mandatoryRules?: string[];
  referenceRules?: string[];
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

function compactRuleKernel(): string[] {
  return [
    '## Active Rule Kernel',
    '',
    'This compact kernel is always-on. Full rule bodies are materialized under `.traffic-one/rules/**`; read the matching rule before work whose behavior, security, data shape, architecture, or UX depends on it.',
    '',
    '- This context is auto-loaded every session: never re-read root `AGENTS.md`/`CLAUDE.md`, and never enumerate `.traffic-one/**` (`ls -R`, `rg --files`) — the skill list and rule index below are already complete.',
    '- Read project memory first for non-trivial work: `.traffic-one/.agentignore`, product/stack/coding/security notes, known issues, schema, and recent agent log when present.',
    '- Keep changes surgical: preserve existing structure, avoid unrelated refactors, never revert user edits, and match local style even when a different style would be tempting.',
    '- Prefer the selected Traffic One stack and local helpers. Do not add libraries, abstractions, alternate modes, or extension points without a real current caller.',
    '- Versions come from the active stack rules — never probe package registries (`npm view`, `npm outdated`, registry curls) to pick them; "latest tech" means the latest within the pinned stack contract.',
    '- Security stays active: no secrets in source or memory, validate input at boundaries, enforce auth and authorization server-side, avoid credentialed wildcard CORS, use parameterized SQL, and keep production errors sanitized.',
    '- Traffic One setup gates are blocking before mutating work: shared project state plus per-user local preferences (`openCode`, `performance`/`team`, `codeGraphProvider`) must be complete. Existing projects skip new-project MVP/mobile prompts but still require local preferences.',
    '- When local preferences record `team.mode: "subagents"` with `team.approved: true`, AUTO-RUN only the roles eligible in the runtime-owned capability profile and compiled work units (architect first, eligible implementers in parallel when independent, reviewer + tester after) without re-asking — and the parent/orchestrator never writes feature source itself. Never invent a frontend/backend/browser/native role for an absent surface. Read `rules/common/senior-engineer-team.md` before the first spawn.',
    '- In `lifecycle.phase: "maintenance"`, run maintenance triage before that greenfield team flow: trivial/small work bypasses architect and feature plans, and goes directly to the capability-eligible owning role; architect is reserved for complex cross-layer work.',
    '- UI work must satisfy i18n, SEO for public routes, accessibility, responsive layout, real visual polish, stable dimensions, and verification screenshots when the change is visual.',
    '- Backend/data work must keep API contracts explicit, schema changes reviewed, migrations reversible where practical, RLS/storage policies safe, and generated clients or schema snapshots refreshed when applicable.',
    '- Verification should match risk: reproduce bugs when practical, run focused tests/build/lint for touched surfaces, and report any skipped check with the exact reason.',
    '- External or destructive actions still need explicit current confirmation: deploy, publish, push protected environments, run shared/prod migrations, send messages, delete data/files, or call side-effecting external APIs.',
    '- Nested plugin-authoring repos are exempt: a subdirectory that is itself the Traffic One plugin source or an installed plugin tree is never part of this project — do not create `.traffic-one/**` or generated agent-context files inside it.',
    '',
  ];
}

function compactReadRouting(): string[] {
  return [
    '## Read Rules When',
    '',
    '- Starting/scaffolding/onboarding: `rules/common/senior-engineer-team.md` (FIRST — it decides who builds), then `rules/common/setup-gate.md`, `rules/modes/new-project.md`, `rules/common/stack-recommendations.md`, `rules/common/project-memory.md`, `rules/common/documentation.md`. Read a profile-specific new-project rule only when runtime placed it in the Active Rule Index.',
    '- Editing existing code: `rules/common/setup-gate.md`, `rules/modes/existing-codebase.md`, `rules/common/execution-discipline.md`, `rules/common/clean-code.md`, plus the stack rule for touched files.',
    '- Building UI/pages/components/styles: `rules/frontend/ui-quality.md`, `rules/frontend/typography.md`, `rules/frontend/i18n.md`, `rules/frontend/accessibility.md`, and the framework-specific frontend rules.',
    '- Working on React/Vite state, services, realtime, testing, performance, or security: read the matching `rules/frontend/react/*.md` file before editing.',
    '- Touching Supabase, auth, storage, RLS, SQL, migrations, or schema snapshots: `rules/common/security.md`, `rules/frontend/react/supabase-client.md`, and `rules/backend/postgres.md`.',
    '- Adding APIs, connectors, libraries, observability, docs, SEO, tests, release, or deployment work: read the matching common rule and trigger the matching skill from `.traffic-one/skills/**`.',
    '- Running subagents or fix cycles: `rules/common/agent-handoff-digests.md`, `rules/common/codebase-graph.md`, and the role-scoped rules named in the task prompt.',
    '',
  ];
}

function renderRuleIndexSection(title: string, relPaths: string[]): string[] {
  if (!Array.isArray(relPaths) || relPaths.length === 0) return [];
  return [`### ${title}`, '', ...relPaths.map((relPath) => `- .traffic-one/${relPath}`), ''];
}

function ruleGroupsForOptions(rules: string[], options: RenderOptions): { mandatory: string[]; reference: string[] } {
  const mandatory = unique(options.mandatoryRules || []);
  const reference = unique(options.referenceRules || []).filter((relPath) => !mandatory.includes(relPath));
  if (mandatory.length > 0 || reference.length > 0) return { mandatory, reference };
  return { mandatory: unique(rules), reference: [] };
}

export function renderAgents(state: Rec, rules: string[], skills: string[], options: RenderOptions = {}): string {
  const leanMode = options.leanMode === true;
  const mobile = state.mobile as Rec | undefined;
  const lines = [
    '# Traffic One Local Agent Context',
    '',
    GENERATED_MARKER,
    '',
    leanMode
      ? 'Use the compact project-local rule kernel and index below before falling back to plugin-root rules.'
      : 'Use the project-local active rule bundle below before falling back to plugin-root rules.',
    leanMode
      ? 'Compact context mode keeps critical guidance always-on and reads full `.traffic-one` rules on demand.'
      : 'Host runtimes may read AGENTS.md directly, so active rule contents are inlined instead of relying on host-specific import syntax.',
    '',
    '## Active State',
    '',
    `- Stack: ${(state.stack as string) || 'minimal'}`,
    `- Frontend: ${(state.frontend as string) || 'none'}`,
    `- Backend: ${(state.backend as string) || 'none'}`,
    `- Mobile: ${(mobile && (mobile.framework as string)) || 'none'}`,
    '',
    // Lean mode lists the active rules exactly once — in the "Active Rule Index"
    // below (with read-on-demand guidance). Non-lean mode lists them here, where
    // the full bodies follow under "Active Rule Contents". Emitting a bare list
    // here in lean mode too would duplicate the same paths in every generated
    // AGENTS.md/CLAUDE.md, on every session.
    ...(leanMode ? [] : ['## Active Rules', '', ...rules.map((relPath) => `- .traffic-one/${relPath}`), '']),
    '## Active Skills',
    '',
    // One compact paragraph, not one path per line: the skill list is in every
    // session's context, and ~35 full paths cost ~8× the tokens of a name list.
    'Read `.traffic-one/skills/<name>/SKILL.md` when a task matches that skill. Active:',
    skills.join(', ') || '(none)',
    '',
  ];

  if (leanMode) {
    const { mandatory, reference } = ruleGroupsForOptions(rules, options);
    lines.push(
      ...compactRuleKernel(),
      ...compactReadRouting(),
      '## Active Rule Index',
      '',
      'Full rule content is materialized under `.traffic-one/<path>`.',
      'Read only the specific rules needed for the current file or task; the kernel above is the always-on baseline.',
      '',
      ...renderRuleIndexSection('Mandatory Baseline', mandatory),
      ...renderRuleIndexSection('Reference On Demand', reference),
    );
    return `${lines.join('\n')}\n`;
  }

  const root = pluginRoot();
  lines.push('## Active Rule Contents', '');
  for (const relPath of rules) {
    const source = readText(path.join(root, templatePath(relPath)));
    lines.push(`### ${relPath}`, '');
    if (typeof source === 'string' && source.trim()) {
      lines.push(source.trimEnd(), '');
    } else {
      lines.push(`Rule source missing in plugin root: ${templatePath(relPath)}`, '');
    }
  }
  return `${lines.join('\n')}\n`;
}

function localContextName(fileName: string): string {
  return fileName === 'CLAUDE.md' ? 'CLAUDE.local.md' : 'AGENTS.local.md';
}

// Tool-managed agent-context blocks (gitnexus injects its "Code Intelligence"
// section into root AGENTS.md/CLAUDE.md, creating the files on fresh projects).
// These are regenerable boilerplate, not user content — preserving them would
// re-render ~2.5 KB of duplicated guidance into every generated AGENTS.md.
const TOOL_MANAGED_BLOCK_RE = /<!--\s*gitnexus:start\s*-->[\s\S]*?<!--\s*gitnexus:end\s*-->/g;

// Compared and STORED normalized. An editor that rewrites the root file's line
// endings must not read as "this content is not preserved yet" — that answer
// appends a second, byte-identical copy of the same notes on every single run,
// forever, and the file it grows is the one the generated context inlines.
function normalizeBody(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function firstPreservedDocument(fileName: string, body: string): string {
  return [
    `# Preserved ${fileName}`,
    '',
    `This content existed before Traffic One generated root ${fileName}.`,
    '',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

// A LATER hand-written root file, preserved NEXT TO the earlier one. Same shape
// migrateLegacyRootDocumentationFile uses for the same reason: the copy already
// on disk is also content nobody agreed to lose, so a second takeover appends
// rather than overwrites.
function additionalPreservedBlock(fileName: string, body: string): string {
  return [
    '---',
    '',
    `## Also Preserved From Root \`${fileName}\``,
    '',
    `Root ${fileName} was hand-written again after an earlier takeover; this is that content.`,
    '',
    body,
    '',
  ].join('\n');
}

/**
 * Put `body` in the preserved copy, and PROVE it is there.
 *
 * The precondition for the delete below is that THIS content is on disk — not
 * that some file exists at `localPath`. Checking existence instead is how a
 * project taken over twice lost the second version: the owner hand-wrote a new
 * root AGENTS.md, the stale `AGENTS.local.md` from the first takeover satisfied
 * the existence check, nothing was written, and the delete landed anyway — the
 * new content then existed nowhere, not in the preserved copy and not in the
 * generated context that inlines it (measured: preserved copy still carried
 * "VERSION ONE (stale)", `VERSION TWO recoverable anywhere? false`).
 *
 * Re-reading after the write is deliberate rather than trusting the writer's
 * return value: writeTextIfChanged also answers `false` for "already
 * identical", and the consent fence answers `false` without writing.
 */
function preserveBody(localPath: string, fileName: string, body: string): boolean {
  const carriesBody = (): boolean => normalizeBody(readText(localPath) ?? '').includes(body);
  if (carriesBody()) return true;
  const existing = readText(localPath);
  writeTextIfChanged(
    localPath,
    existing && existing.trim()
      ? `${existing.trimEnd()}\n\n${additionalPreservedBlock(fileName, body)}`
      : firstPreservedDocument(fileName, body),
  );
  return carriesBody();
}

/**
 * Take over a hand-written root AGENTS.md/CLAUDE.md, preserving its content in
 * `.traffic-one/AGENTS.local.md` first.
 *
 * The ONLY function permitted to delete a user-authored root context file:
 * writeRootAgents/writeRootClaude below both stand down on anything that is not
 * already generated (or a symlink). So the delete here is what licenses the
 * generated write that follows, and its precondition is that the CONTENT
 * replacing it is on disk — see preserveBody, which re-reads to prove it rather
 * than inferring it from a writer's return value or from a file merely existing
 * at the preserved path.
 *
 * That ordering is the fix for observed data loss, not a hypothetical: on a
 * project whose use-plugin question was unanswered the copy was refused by the
 * consent fence (`.traffic-one/**`, shared/fsjson.ts) while this delete still
 * landed with a raw `fs.rmSync` — so a hand-written root AGENTS.md was not
 * overwritten, it was DESTROYED, with the only surviving copy suppressed. The
 * refusal at the top of materializeProjectAssets now stops this function from
 * running at all before consent, but the same split can be produced by any other
 * write failure (EACCES, EROFS, ENOSPC), and there is no recovery from it: the
 * content exists nowhere else. Declining to delete instead costs only the
 * generated context — writeRootAgents sees a non-generated file and stands down,
 * leaving the project exactly as the user left it.
 *
 * `state.mode` is a WEAK gate and is not what makes this safe. `detectMode`
 * answers `new-project` for any repository with five or fewer files whose
 * extension is in SOURCE_EXTS, so a Terraform stack, a dbt project, a docs site
 * or a shell-tooling repo with real committed history arrives here as
 * greenfield (measured: a 3-file Terraform repo, one commit, hand-written root
 * AGENTS.md → 56 bytes replaced by 8790 generated ones). Narrowing that guess
 * with on-disk evidence — the `greenfieldEvidence` predicate
 * architecture-contract/scaffold-content.ts already uses for `.gitignore` —
 * would shrink the blast radius but cannot close it: a genuinely greenfield
 * project (no commits, no `.gitignore`) can still have a root AGENTS.md its
 * owner wrote by hand five minutes ago. So the invariant this function keeps is
 * the content one, and it holds for every mode: nothing is deleted until the
 * bytes are provably reachable somewhere else.
 */
export function preserveManualRootContext(cwd: string, fileName: string, state: Rec): boolean {
  const rootPath = path.join(cwd, fileName);
  if (!fs.existsSync(rootPath)) return false;
  const stat = fs.lstatSync(rootPath);
  if (stat.isSymbolicLink() || isGenerated(rootPath)) return false;
  if (!state || state.mode !== 'new-project') return false;

  const localPath = path.join(cwd, '.traffic-one', localContextName(fileName));
  const body = normalizeBody((readText(rootPath) || '').replace(TOOL_MANAGED_BLOCK_RE, ''));
  // Nothing but tool-managed blocks → nothing user-authored to preserve.
  if (body && !preserveBody(localPath, fileName, body)) return false;
  // `removePath` cannot fence a project-root path — the fence is addressed by
  // `.traffic-one/**` and this file is outside it — but routing the delete
  // through the chokepoint anyway means a fence that ever grows to cover root
  // files covers this one too, instead of this being the site that remembers to
  // opt in.
  return removePath(rootPath);
}

function localContextBlocks(cwd: string): string[] {
  const blocks: string[] = [];
  const seenBodies: string[] = [];
  for (const fileName of ['AGENTS.local.md', 'CLAUDE.local.md']) {
    const content = readText(path.join(cwd, '.traffic-one', fileName));
    if (typeof content === 'string' && content.trim()) {
      // A pre-existing CLAUDE.md is very often a copy/symlink of AGENTS.md, so
      // both preserved files carry the same body after their differing headers —
      // render it once, not twice. Compare past the first `---` separator.
      const body = content.includes('\n---\n') ? content.slice(content.indexOf('\n---\n') + 5).trim() : content.trim();
      if (seenBodies.includes(body)) continue;
      seenBodies.push(body);
      blocks.push(`### .traffic-one/${fileName}\n\n${content.trimEnd()}`);
    }
  }
  return blocks;
}

// The takeover, announced in the file it took over.
//
// `.traffic-one/AGENTS.local.md` exists for exactly one reason —
// preserveManualRootContext replaced a hand-written root context file with this
// generated one — and until now nothing said so anywhere the user looks. The
// content was reachable (here, and in the preserved copy) but the REPLACEMENT
// was silent: 56 bytes of "ask @sre before applying" became 8790 bytes of
// generated context, and the only hint was a `M AGENTS.md` in `git status`,
// which an untracked file does not even produce. This section is the one
// surface this module owns that the user reads: it is the file whose disappearance
// they are investigating. A run-level notice (SessionStart output, the
// materialize outcome) needs MaterializeResult/converge.ts and is not this
// module's to add.
const TAKEOVER_NOTICE = 'Traffic One generated this file over a hand-written root `AGENTS.md`/`CLAUDE.md`. Nothing was discarded: the original content is reproduced verbatim below and kept at `.traffic-one/AGENTS.local.md` (`CLAUDE.local.md` for CLAUDE.md). Delete those files to drop it from this context.';

export function renderAgentsWithLocalContext(cwd: string, state: Rec, rules: string[], skills: string[], options: RenderOptions = {}): string {
  const base = renderAgents(state, rules, skills, { leanMode: isLeanMaterialization(cwd, state), ...options }).trimEnd();
  const localBlocks = localContextBlocks(cwd);
  if (localBlocks.length === 0) return `${base}\n`;
  return [base, '', '## Preserved Project Notes', '', TAKEOVER_NOTICE, '', ...localBlocks, ''].join('\n');
}

function renderClaudeFallback(): string {
  return `${['# Traffic One Claude Context', '', GENERATED_MARKER, '', 'Read the canonical root agent context:', '', '@AGENTS.md', ''].join('\n')}\n`;
}

export function writeRootAgents(cwd: string, content: string): boolean {
  const rootAgents = path.join(cwd, 'AGENTS.md');
  if (fs.existsSync(rootAgents) && !fs.lstatSync(rootAgents).isSymbolicLink()) {
    if (!isGenerated(rootAgents)) return false;
    // Same generated content → leave the file (and its mtime) alone.
    if (readText(rootAgents) === content) return false;
  }
  if (fs.existsSync(rootAgents)) fs.rmSync(rootAgents, { force: true });
  return writeTextIfChanged(rootAgents, content);
}

export function writeRootClaude(cwd: string): boolean {
  const rootClaude = path.join(cwd, 'CLAUDE.md');
  if (fs.existsSync(rootClaude) && !fs.lstatSync(rootClaude).isSymbolicLink() && !isGenerated(rootClaude)) return false;
  try {
    // Already the canonical symlink → nothing to do.
    if (fs.lstatSync(rootClaude).isSymbolicLink() && fs.readlinkSync(rootClaude) === 'AGENTS.md') return false;
  } catch {
    // missing file → fall through and create it
  }
  if (fs.existsSync(rootClaude)) fs.rmSync(rootClaude, { force: true });
  try {
    fs.symlinkSync('AGENTS.md', rootClaude);
    return true;
  } catch {
    return writeTextIfChanged(rootClaude, renderClaudeFallback());
  }
}
