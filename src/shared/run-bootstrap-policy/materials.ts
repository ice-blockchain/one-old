// src/shared/run-bootstrap-materials.ts
// Envelope hashing plus role material resolution: rule/skill bodies read
// from the installed plugin, deduplicated and capped.

import * as path from 'path';
import type { HostModelKey } from '../../config/model-tiers';
import { pluginRoot } from '../paths';
import {
  activeSkillsForProfile,
  activeSkillsForProject,
  roleAgentBody,
  roleDeclaredSkills,
} from '../skill-filters';
import {
  eligibleRolesForProfile,
  runtimeCapabilityStateFromProfile,
  type CapabilityProfileV1,
} from '../capabilities';
import { roleScopedRules, templatePath } from '../stacks';
import { sha256 } from '../text';

import {
  type BootstrapMaterialRefV2,
} from './types';
import { readRegularFileOrThrow } from '../bounded-read';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]),
  );
}

export function hashEnvelope(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

export function stableEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function readFirst(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      const text = readRegularFileOrThrow(candidate);
      if (text.trim()) return text;
    } catch {
      // try the next installed/source layout
    }
  }
  return null;
}

// Still takes the body read from disk: hashing it here is the fail-closed proof
// that the material is resolvable at publish time. Only the hash is stored.
function material(id: string, content: string): BootstrapMaterialRefV2 {
  return { id, contentHash: sha256(content) };
}

export function ruleContent(relPath: string): string | null {
  const root = pluginRoot();
  return readFirst([
    path.join(root, templatePath(relPath)),
    path.join(root, 'dist', templatePath(relPath)),
    path.join(root, 'src', 'modules', 'rules', templatePath(relPath)),
  ]);
}

export function skillContent(name: string): string | null {
  const root = pluginRoot();
  return readFirst([
    path.join(root, 'skills-catalog', name, 'SKILL.md'),
    path.join(root, 'dist', 'skills-catalog', name, 'SKILL.md'),
    path.join(root, 'src', 'modules', 'skills', 'skills-catalog', name, 'SKILL.md'),
  ]);
}

export function resolvedRoleSkillIds(
  active: Iterable<string>,
  declared: ReadonlySet<string> | null,
): string[] | null {
  if (!declared) return null;
  return [...active].filter((name) => declared.has(name)).sort();
}

export function resolvedRoleMaterials(
  cwd: string,
  role: string,
  state: unknown,
  host: HostModelKey,
  profile?: CapabilityProfileV1,
): { role: BootstrapMaterialRefV2; rules: BootstrapMaterialRefV2[]; skills: BootstrapMaterialRefV2[] } | null {
  if (role !== 'quick-fix' && !(profile
    ? eligibleRolesForProfile(profile)
    : new Set<string>()).has(role)) return null;
  const capabilityState = profile
    ? runtimeCapabilityStateFromProfile(profile, state)
    : state;
  const roleBody = roleAgentBody(role);
  if (!roleBody) return null;
  const ruleIds = roleScopedRules(role, capabilityState);
  if (!ruleIds) return null;
  const rules: BootstrapMaterialRefV2[] = [];
  for (const id of ruleIds) {
    const content = ruleContent(id);
    if (!content) return null;
    rules.push(material(id, content));
  }
  const active = profile
    ? activeSkillsForProfile(profile, host)
    : activeSkillsForProject(cwd, state, host);
  const declared = roleDeclaredSkills(role);
  // A missing/malformed role frontmatter is a policy compilation failure, not
  // permission to inherit every active project skill.
  const skillIds = resolvedRoleSkillIds(active, declared);
  if (!skillIds) return null;
  const skills: BootstrapMaterialRefV2[] = [];
  for (const id of skillIds) {
    const content = skillContent(id);
    if (!content) return null;
    skills.push(material(id, content));
  }
  return {
    role: material(role, roleBody),
    rules: rules.sort((a, b) => a.id.localeCompare(b.id)),
    skills,
  };
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

