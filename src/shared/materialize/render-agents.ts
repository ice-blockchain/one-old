// src/shared/materialize/render-agents.ts
// Renders the project-local AGENTS.md (+ CLAUDE.md symlink). Ported 1:1 from the
// renderAgents family in scripts/hook-runtime/materialize/_helpers.cjs. The
// kernel/read-routing prose is parity-critical — kept verbatim.

import * as fs from 'fs';
import * as path from 'path';

import { readText } from '../fsjson';
import { writeTextIfChanged } from '../fs-text';
import { detectHost } from '../host';
import { detectHostPlan } from '../host-plan';
import { buildTeamLineup } from '../onboarding-server/flow';
import { pluginRoot } from '../paths';
import { openCodeDelegationActive } from '../performance';
import { templatePath } from '../stacks';
import { GENERATED_MARKER, isGenerated } from './generated';
import { isLeanMaterialization } from './has-assets';

type Rec = Record<string, unknown>;

// Team / delegation / role→model lines for the Active State section. Without
// these the orchestrator hash-hunts ~/.traffic-one/projects/ for its own team
// mode and guesses spawn models until the performance gate corrects it
// (observed live: 4 foreign pref files read + 2 gate-deny round-trips in one
// build). Best-effort: renders nothing it can't resolve.
function activeTeamLines(state: Rec): string[] {
  const team = state.team && typeof state.team === 'object' ? (state.team as Rec) : null;
  const performance = state.performance && typeof state.performance === 'object' ? (state.performance as Rec) : null;
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  const lines: string[] = [];
  const mode = team && typeof team.mode === 'string' ? team.mode : null;
  const level = performance && typeof performance.level === 'string' ? performance.level : null;
  const host = detectHost();
  if (mode) {
    const approved = team?.approved === true ? ', approved' : '';
    lines.push(`- Team: ${mode}${level ? ` (${level}${approved})` : ''}`);
  }
  if (openCode) lines.push(`- OpenCode delegation: ${openCodeDelegationActive(state, host) ? 'enabled' : 'off'}`);
  if (mode === 'subagents' && level) {
    try {
      if (host === 'kilo') {
        lines.push('- Kilo subagents: use `task` with `subagent_type: "general"` when only `general`/`explore` are offered; put `[t1-role: senior-<role>]` first and omit `model` in v1.');
        return lines;
      }
      const overrides = team && team.overrides && typeof team.overrides === 'object' ? (team.overrides as Rec) : null;
      const planCtx = { host, plan: detectHostPlan(host), useOpenCode: openCodeDelegationActive(state, host) };
      const lineup = buildTeamLineup(level, host, overrides, planCtx);
      if (lineup.length > 0) {
        lines.push(`- Role models (pass as \`model\` when spawning): ${lineup.map((m) => `${m.role.replace(/^senior-/, '')}=${m.model}`).join(', ')}`);
      }
    } catch {
      // best-effort; the performance gate still corrects a missing line-up
    }
  }
  return lines;
}

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
    '- When local preferences record `team.mode: "subagents"` with `team.approved: true`, AUTO-RUN the senior role team for multi-layer builds (architect first, frontend + backend in parallel, reviewer + tester after) without re-asking — and the parent/orchestrator never writes feature source itself. Read `rules/common/senior-engineer-team.md` before the first spawn.',
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
    '- Starting/scaffolding/onboarding: `rules/common/senior-engineer-team.md` (FIRST — it decides who builds), then `rules/common/setup-gate.md`, `rules/modes/new-project.md`, `rules/common/stack-recommendations.md`, `rules/common/project-memory.md`, `rules/common/documentation.md`.',
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
    ...activeTeamLines(state),
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

export function preserveManualRootContext(cwd: string, fileName: string, state: Rec): boolean {
  const rootPath = path.join(cwd, fileName);
  if (!fs.existsSync(rootPath)) return false;
  const stat = fs.lstatSync(rootPath);
  if (stat.isSymbolicLink() || isGenerated(rootPath)) return false;
  if (!state || state.mode !== 'new-project') return false;

  const localPath = path.join(cwd, '.traffic-one', localContextName(fileName));
  const existing = (readText(rootPath) || '').replace(TOOL_MANAGED_BLOCK_RE, '').trim();
  // Nothing but tool-managed blocks → nothing user-authored to preserve.
  if (existing) {
    const preserved = [
      `# Preserved ${fileName}`,
      '',
      `This content existed before Traffic One generated root ${fileName}.`,
      '',
      '---',
      '',
      existing,
      '',
    ].join('\n');
    if (!fs.existsSync(localPath)) writeTextIfChanged(localPath, preserved);
  }
  fs.rmSync(rootPath, { force: true });
  return true;
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

export function renderAgentsWithLocalContext(cwd: string, state: Rec, rules: string[], skills: string[], options: RenderOptions = {}): string {
  const base = renderAgents(state, rules, skills, { leanMode: isLeanMaterialization(cwd, state), ...options }).trimEnd();
  const localBlocks = localContextBlocks(cwd);
  if (localBlocks.length === 0) return `${base}\n`;
  return [base, '', '## Preserved Project Notes', '', ...localBlocks, ''].join('\n');
}

export function renderClaudeFallback(): string {
  return `${['# Traffic One Claude Context', '', GENERATED_MARKER, '', 'Read the canonical root agent context:', '', '@AGENTS.md', ''].join('\n')}\n`;
}

export function writeRootAgents(cwd: string, content: string): boolean {
  const rootAgents = path.join(cwd, 'AGENTS.md');
  if (fs.existsSync(rootAgents) && !fs.lstatSync(rootAgents).isSymbolicLink() && !isGenerated(rootAgents)) return false;
  if (fs.existsSync(rootAgents)) fs.rmSync(rootAgents, { force: true });
  return writeTextIfChanged(rootAgents, content);
}

export function writeRootClaude(cwd: string): boolean {
  const rootClaude = path.join(cwd, 'CLAUDE.md');
  if (fs.existsSync(rootClaude) && !fs.lstatSync(rootClaude).isSymbolicLink() && !isGenerated(rootClaude)) return false;
  if (fs.existsSync(rootClaude)) fs.rmSync(rootClaude, { force: true });
  try {
    fs.symlinkSync('AGENTS.md', rootClaude);
    return true;
  } catch {
    return writeTextIfChanged(rootClaude, renderClaudeFallback());
  }
}
