// src/shared/skill-filters/index.ts
// Stack-aware skill filtering. Ported 1:1 from scripts/hook-runtime/skill-filters/*.
//   - activeSkillsFor(state) → the skill set for a stack (_common ∪ stack sets).
//   - pruneSkillsDirective → the [ACTIVE SKILLS]/[DO NOT INVOKE] SessionStart block.
//   - cleanActiveSkills/copyActiveSkills → cache surgery (plugin install path only).

import * as fs from 'fs';
import * as path from 'path';

import { BOOTSTRAP_SKILLS, SKILL_FILTERS } from '../../config/skill-filters';
import { isInPluginCache, pluginRoot } from '../paths';

const SKILLS_TEMPLATES_DIR = 'skills-catalog';
const SKILLS_ACTIVE_DIR = 'skills';

function addSkillSet(out: Set<string>, name: string): void {
  const stackSet = SKILL_FILTERS[name];
  if (!stackSet) return;
  for (const skillName of stackSet) out.add(skillName);
}

interface SkillState {
  mode: string;
  stack: string;
  frontend: string;
  backend: string;
  onboardingComplete: boolean;
  mobile: { enabled?: boolean; framework?: string; source?: string };
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
      mobile: i.mobile && typeof i.mobile === 'object'
        ? (i.mobile as SkillState['mobile'])
        : { enabled: false, framework: 'none', source: 'none' },
    };
  }
  const stack = typeof input === 'string' ? input : 'minimal';
  const none = { enabled: false, framework: 'none', source: 'none' };
  if (stack === 'default' || stack === 'react-realtime-monorepo') {
    return { mode: 'unknown', stack: 'default', frontend: 'react-vite', backend: 'supabase', onboardingComplete: true, mobile: none };
  }
  if (stack === 'react-frontend-only') {
    return { mode: 'unknown', stack: 'custom-backend', frontend: 'react-vite', backend: 'none', onboardingComplete: true, mobile: none };
  }
  if (stack === 'react-native-expo-monorepo' || stack === 'react-native-expo-app') {
    return { mode: 'unknown', stack: 'custom-frontend', frontend: 'none', backend: 'supabase', onboardingComplete: true, mobile: { enabled: true, framework: 'react-native-expo', source: 'explicit' } };
  }
  return { mode: 'unknown', stack, frontend: 'none', backend: 'none', onboardingComplete: true, mobile: none };
}

export function activeSkillsFor(stackOrState: unknown): Set<string> {
  const state = normalizedSkillState(stackOrState);
  if (state.mode === 'new-project' && state.onboardingComplete !== true) {
    return new Set(BOOTSTRAP_SKILLS);
  }
  const out = new Set(SKILL_FILTERS._common);
  if (state.frontend === 'react-vite') addSkillSet(out, 'react-vite');
  else if (state.frontend === 'nextjs') addSkillSet(out, 'nextjs');
  else if (state.frontend && state.frontend !== 'none') addSkillSet(out, 'custom-web');

  if (state.mobile && state.mobile.framework === 'ionic-capacitor') addSkillSet(out, 'ionic-capacitor');
  if (state.mobile && state.mobile.framework === 'react-native-expo') addSkillSet(out, 'react-native-expo');

  if (state.backend === 'supabase' || state.backend === 'our-fork') addSkillSet(out, 'supabase');
  else if (state.backend === 'nestjs') addSkillSet(out, 'node');
  else if (state.backend === 'fastapi') addSkillSet(out, 'python');
  else if (state.backend === 'laravel') addSkillSet(out, 'php');
  else if (state.backend === 'csharp') addSkillSet(out, 'dotnet');
  else if (state.backend && state.backend !== 'none' && state.backend !== 'external-api' && state.backend !== 'other') {
    addSkillSet(out, state.backend);
  }
  return out;
}

export function pruneSkillsDirective(stackOrState: unknown, allSkills: Iterable<string>): string {
  const active = activeSkillsFor(stackOrState);
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

// Skills a role's agent doc declares in its `skills:` frontmatter. The agent doc
// is the single source of truth for a role's skill set — parsing it here (instead
// of mirroring a TS map) means the subagent directive can never drift from what
// the role document ships. Returns null when the doc/frontmatter is missing so
// callers can fall back to the stack-wide directive.
export function roleDeclaredSkills(role: string): Set<string> | null {
  if (!/^[a-z0-9-]+$/.test(role)) return null;
  const root = pluginRoot();
  const candidates = [
    path.join(root, 'agents', `${role}.md`),
    path.join(root, 'dist', 'agents', `${role}.md`),
    path.join(root, 'src', 'modules', role, 'agent.md'),
  ];
  for (const candidate of candidates) {
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
export function roleSkillsDirective(stackOrState: unknown, role: string, allSkills: Iterable<string>): string {
  const declared = roleDeclaredSkills(role);
  if (!declared) return pruneSkillsDirective(stackOrState, allSkills);
  const active = activeSkillsFor(stackOrState);
  const roleActive = [...active].filter((name) => declared.has(name)).sort();
  if (roleActive.length === 0) return pruneSkillsDirective(stackOrState, allSkills);
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

export function cleanActiveSkills(): number {
  if (!isInPluginCache()) return 0;
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

export function copyActiveSkills(stackOrState: unknown): number {
  if (!isInPluginCache()) return 0;
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
  for (const name of activeSkillsFor(stackOrState)) {
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
