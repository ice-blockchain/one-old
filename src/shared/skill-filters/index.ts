// src/shared/skill-filters/index.ts
// Stack-aware skill filtering. Ported 1:1 from scripts/hook-runtime/skill-filters/*.
//   - activeSkillsFor(state) → the skill set for a stack (_common ∪ stack sets).
//   - pruneSkillsDirective → the [ACTIVE SKILLS]/[DO NOT INVOKE] SessionStart block.
//   - cleanActiveSkills/copyActiveSkills → cache surgery (plugin install path only).

import * as fs from 'fs';
import * as path from 'path';

import {
  BOOTSTRAP_SKILLS,
  HOST_SKILL_FILTERS,
  PROJECT_UNAVAILABLE_SKILLS,
  SKILL_FILTERS,
} from '../../config/skill-filters';
import type { HostId } from '../../core/types';
import {
  defaultStateForStack,
  skillBucketsForState,
  type CapabilityProfileV1,
} from '../capabilities';
import { capabilityProfileForRun } from '../architecture-contract';
import { isInPluginCache, pluginRoot, pluginRootInfo } from '../paths';

const SKILLS_TEMPLATES_DIR = 'skills-catalog';
const SKILLS_ACTIVE_DIR = 'skills';

function addSkillSet(out: Set<string>, name: string): void {
  const stackSet = SKILL_FILTERS[name];
  if (!stackSet) return;
  for (const skillName of stackSet) out.add(skillName);
}

function finalizeProjectSkills(out: Set<string>, host?: HostId): Set<string> {
  if (host) {
    for (const skillName of HOST_SKILL_FILTERS[host] || []) out.add(skillName);
  }
  for (const skillName of PROJECT_UNAVAILABLE_SKILLS) out.delete(skillName);
  return out;
}

interface SkillState {
  mode: string;
  stack: string;
  frontend: string;
  backend: string;
  onboardingComplete: boolean;
  mobile: { enabled?: boolean; framework?: string; source?: string };
  capabilitySurfaces: string[];
  capabilitySkillBuckets: string[];
  databaseProvider: string;
}

function normalizedSkillState(input: unknown): SkillState {
  if (input && typeof input === 'object') {
    const i = input as Record<string, unknown>;
    return {
      mode: (i.mode as string) || 'unknown',
      stack: (i.stack as string) || 'minimal',
      frontend: (i.frontend as string) || 'none',
      backend: (i.backend as string) || 'none',
      onboardingComplete: i.onboardingComplete === true,
      capabilitySurfaces: Array.isArray(i.capabilitySurfaces)
        ? i.capabilitySurfaces.filter((value): value is string => typeof value === 'string')
        : Array.isArray(i.surfaces)
          ? i.surfaces.filter((value): value is string => typeof value === 'string')
          : [],
      capabilitySkillBuckets: Array.isArray(i.capabilitySkillBuckets)
        ? i.capabilitySkillBuckets.filter((value): value is string => typeof value === 'string')
        : [],
      databaseProvider: [
        i.databaseProvider,
        i.database_provider,
        i.database,
        i.dbProvider,
        i.db,
      ].find((value): value is string => typeof value === 'string') || '',
      mobile: i.mobile && typeof i.mobile === 'object'
        ? (i.mobile as SkillState['mobile'])
        : { enabled: false, framework: 'none', source: 'none' },
    };
  }
  const stack = typeof input === 'string' ? input : 'minimal';
  if (stack === 'react-native-expo-monorepo' || stack === 'react-native-expo-app') {
    return {
      mode: 'unknown',
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'supabase',
      onboardingComplete: true,
      capabilitySurfaces: [],
      capabilitySkillBuckets: [],
      databaseProvider: '',
      mobile: { enabled: true, framework: 'react-native-expo', source: 'explicit' },
    };
  }
  if (stack === 'react-realtime-monorepo' || stack === 'react-frontend-only') {
    return {
      mode: 'unknown',
      stack: stack === 'react-realtime-monorepo' ? 'default' : 'custom-backend',
      frontend: 'react-vite',
      backend: stack === 'react-realtime-monorepo' ? 'supabase' : 'none',
      onboardingComplete: true,
      capabilitySurfaces: [],
      capabilitySkillBuckets: [],
      databaseProvider: '',
      mobile: { enabled: false, framework: 'none', source: 'none' },
    };
  }
  const defaults = defaultStateForStack(stack);
  return {
    mode: 'unknown',
    stack,
    frontend: String(defaults.frontend || 'none'),
    backend: String(defaults.backend || 'none'),
    onboardingComplete: true,
    capabilitySurfaces: [],
    capabilitySkillBuckets: [],
    databaseProvider: '',
    mobile: defaults.mobile as SkillState['mobile'],
  };
}

export function activeSkillsFor(stackOrState: unknown, host?: HostId): Set<string> {
  const state = normalizedSkillState(stackOrState);
  if (state.mode === 'new-project' && state.onboardingComplete !== true) {
    return new Set(BOOTSTRAP_SKILLS);
  }
  const out = new Set(SKILL_FILTERS._common);
  for (const bucket of skillBucketsForState(state)) addSkillSet(out, bucket);
  return finalizeProjectSkills(out, host);
}

export function activeSkillsForProject(cwd: string, state: unknown, host?: HostId): Set<string> {
  return activeSkillsForProfile(capabilityProfileForRun(cwd, state), host);
}

export function activeSkillsForProfile(profile: CapabilityProfileV1, host?: HostId): Set<string> {
  const out = new Set(SKILL_FILTERS._common);
  for (const bucket of profile.skillBuckets) addSkillSet(out, bucket);
  return finalizeProjectSkills(out, host);
}

export function pruneSkillsDirective(
  stackOrState: unknown,
  allSkills: Iterable<string>,
  host?: HostId,
): string {
  const active = activeSkillsFor(stackOrState, host);
  const wrongStack: string[] = [];
  for (const name of allSkills) {
    if (!active.has(name)) wrongStack.push(name);
  }
  const activeList = [...active].sort();
  if (activeList.length === 0) return '';
  const wrongStackPreview = wrongStack.slice(0, 30).join(', ');
  const wrongStackSuffix = wrongStack.length > 30 ? `, ... +${wrongStack.length - 30} more` : '';
  let directive = `[ACTIVE SKILLS for stack=${normalizedSkillState(stackOrState).stack}]: ${activeList.join(', ')}\n`;
  if (wrongStack.length > 0) {
    directive += `[DO NOT INVOKE — wrong stack]: ${wrongStackPreview}${wrongStackSuffix}\n`;
  }
  return directive;
}

// The shipped agent doc for a role, across every layout. Authoring source
// (`src/modules/<role>/agent.md`) is tried FIRST, same precedent as
// makeSkillBlock preferring `<root>/src` over `<root>/scripts`: a generated
// artifact must never outrank the truth it was generated from. Then the
// installed-plugin layout (`agents/<role>.md`) — an install ships no `src/`,
// so it falls through to here unchanged. Last, the source repo's own BUILT
// tree (`dist/agents/<role>.md`), which can go stale between builds and is
// only a fallback of last resort. Empty for a malformed role name.
//
// Deliberately NOT gated on pluginRootInfo().layout here (unlike
// materializeProjectAssets, which refuses an 'unverified' root outright — see
// materialize.ts): every caller of this candidate list (roleAgentBody,
// roleDeclaredSkills, and roleKernel/roleSkillsDirective built on them) is a
// pure read that already returns null when nothing resolves — there is no
// cleanupPrevious-style "empty list ⇒ delete what's on disk" step downstream
// of a prose lookup, so an unverified root costs nothing worse than the same
// null a missing file already produces. That null IS the honest "I cannot
// resolve this text" answer, and it is also exactly the signal the later
// deny()-empty-guard work item keys off to substitute its own generated
// fallback (naming the deny id + resolved root) — this function must keep
// returning null/empty on a miss, not start throwing or faking content, for
// that guard to compose cleanly on top. Hard-gating on layout would also be
// wrong in practice: a caller may legitimately point one of the four
// *_PLUGIN_ROOT env vars at a directory that carries only `agents/` or only
// `src/modules/<role>/agent.md` (every fixture in this file's own test suite
// does exactly that) — a shape the installed/source classifier calls
// 'unverified' even though the requested content is genuinely present and
// resolvable.
function roleAgentDocCandidates(role: string): string[] {
  if (!/^[a-z0-9-]+$/.test(role)) return [];
  const root = pluginRoot();
  return [
    path.join(root, 'src', 'modules', role, 'agent.md'),
    path.join(root, 'agents', `${role}.md`),
    path.join(root, 'dist', 'agents', `${role}.md`),
  ];
}

// The role's full agent-doc BODY (everything after the YAML frontmatter), or null
// when the doc is missing/empty. This is the SAME contract Claude/Codex receive as
// the spawned subagent doc; the Cursor materializer inlines it so Cursor's per-role
// agent file carries every MUST/gate, not just identity/scope.
export function roleAgentBody(role: string): string | null {
  for (const candidate of roleAgentDocCandidates(role)) {
    let text = '';
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    if (body) return body;
  }
  return null;
}

// The compact role contract delimited by T1KERNEL markers inside the role's
// agent doc. Served in the child SessionStart header on hosts whose spawn does
// NOT deliver the agent doc natively (envelope roleSource
// 'plugin-injected-fallback' — e.g. Codex spawn_agent children, which used to
// receive the role text only through the removed context-pack pager).
// Fail-open: a doc without markers yields null and the child still has its
// spawn prompt plus the rule/skill index.
export function roleKernel(role: string): string | null {
  const body = roleAgentBody(role);
  if (!body) return null;
  const match = /<!-- T1KERNEL:BEGIN -->\r?\n?([\s\S]*?)<!-- T1KERNEL:END -->/.exec(body);
  const kernel = match?.[1]?.trim();
  return kernel || null;
}

// Skills a role's agent doc declares in its `skills:` frontmatter. The agent doc
// is the single source of truth for a role's skill set — parsing it here (instead
// of mirroring a TS map) means the subagent directive can never drift from what
// the role document ships. Returns null when the doc/frontmatter is missing so
// callers can fall back to the stack-wide directive.
export function roleDeclaredSkills(role: string): Set<string> | null {
  for (const candidate of roleAgentDocCandidates(role)) {
    let text = '';
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    const fmBody = fm?.[1];
    if (!fmBody) continue;
    const lines = fmBody.split('\n');
    const out = new Set<string>();
    let inSkills = false;
    for (const line of lines) {
      if (/^skills:\s*$/.test(line)) { inSkills = true; continue; }
      if (inSkills) {
        const item = line.match(/^\s+-\s+([A-Za-z0-9_-]+)\s*$/);
        if (item?.[1]) { out.add(item[1]); continue; }
        if (/^\S/.test(line)) inSkills = false; // next top-level key ends the list
      }
    }
    if (out.size > 0) return out;
  }
  return null;
}

// Role-scoped variant of pruneSkillsDirective: only the intersection of the
// stack-active skills and the role's declared skills is listed, and the long
// [DO NOT INVOKE] name dump is replaced by one sentence — a subagent's spawn
// context should not pay ~30 wrong-stack skill names every time.
export function roleSkillsDirective(
  stackOrState: unknown,
  role: string,
  allSkills: Iterable<string>,
  host?: HostId,
): string {
  const declared = roleDeclaredSkills(role);
  if (!declared) return pruneSkillsDirective(stackOrState, allSkills, host);
  const active = activeSkillsFor(stackOrState, host);
  const roleActive = [...active].filter((name) => declared.has(name)).sort();
  if (roleActive.length === 0) return pruneSkillsDirective(stackOrState, allSkills, host);
  return `[ACTIVE SKILLS for ${role} on stack=${normalizedSkillState(stackOrState).stack}]: ${roleActive.join(', ')}\n`
    + '[SKILL SCOPE]: other materialized skills are out of scope for this role — do not invoke them.\n';
}

export function listAllSkills(): Set<string> {
  const skillsDir = path.join(pluginRoot(), SKILLS_ACTIVE_DIR);
  const out = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) out.add(entry.name);
  }
  return out;
}

function copyDirSync(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// Cache surgery is scoped to the plugin's OWN cache-managed active-skills
// mirror (never a user project — isInPluginCache() gates on that first), and
// is self-healing every SessionStart, unlike the project incident this work
// item targets. Guarded on 'unverified' anyway: cleanActiveSkills always wipes
// this dir before copyActiveSkills re-populates it from skills-catalog, so a
// transiently unverified root (e.g. mid host cache update) would otherwise
// wipe the mirror with nothing to re-copy from until the next successful run.
export function cleanActiveSkills(): number {
  if (!isInPluginCache() || pluginRootInfo().layout === 'unverified') return 0;
  const skillsDir = path.join(pluginRoot(), SKILLS_ACTIVE_DIR);
  if (!fs.existsSync(skillsDir)) return 0;
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || BOOTSTRAP_SKILLS.has(entry.name)) continue;
    try {
      fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort
    }
  }
  return removed;
}

export function copyActiveSkills(stackOrState: unknown, host?: HostId): number {
  if (!isInPluginCache() || pluginRootInfo().layout === 'unverified') return 0;
  const templatesDir = path.join(pluginRoot(), SKILLS_TEMPLATES_DIR);
  const activeDir = path.join(pluginRoot(), SKILLS_ACTIVE_DIR);
  if (!fs.existsSync(templatesDir)) return 0;
  if (!fs.existsSync(activeDir)) {
    try {
      fs.mkdirSync(activeDir, { recursive: true });
    } catch {
      return 0;
    }
  }
  let copied = 0;
  for (const name of activeSkillsFor(stackOrState, host)) {
    if (BOOTSTRAP_SKILLS.has(name)) continue;
    const src = path.join(templatesDir, name);
    const dst = path.join(activeDir, name);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try {
      copyDirSync(src, dst);
      copied += 1;
    } catch {
      // best-effort
    }
  }
  return copied;
}
