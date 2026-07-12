// src/shared/feature-source.ts
// Feature-source write-ownership helpers used by the plan-write gate:
// which paths count as feature source, which Traffic One role owns a path, and
// how to extract write targets from apply_patch text / shell commands.
// Ported 1:1 from scripts/hook-runtime/handlers/_helpers.cjs.

import { activeAgentRole, isSubagentSession } from './state';
import type { RunAgentContext } from './state/run-agent';

// Paths the architecture gate treats as "feature source" (monorepo + flat layouts).
export const FEATURE_SOURCE_RE =
  /^(apps\/[^/]+\/(src|app)\/|packages\/[^/]+\/src\/|src\/|services\/[^/]+\/src\/)/;

// Build/config/public artifacts that are part of an implementation surface even
// when they are not under src/. In subagent team mode these must be owned by a
// role, not edited directly by the parent/orchestrator.
export const BUILD_ARTIFACT_RE =
  /^(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|turbo\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json|(?:apps|packages|services)\/[^/]+\/(?:package\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json|src\/vite-env\.d\.ts|public\/.+))$/;

const FLAT_FRONTEND_SOURCE_RE =
  /^src\/(?:app\/(?!api\/)|pages\/(?!api\/)|components\/|features\/|hooks\/|i18n\/|locales\/|messages\/|styles\/|assets\/|lib\/(?!(?:db|server|auth)(?:\/|\.))|utils\/|providers\/|contexts\/|layouts\/|routes\/|theme\/|types\/|config\/|App\.[^/]+$|main\.[^/]+$|index\.[^/]+$|entry\.[^/]+$|client\.[^/]+$)/;

const FLAT_BACKEND_SOURCE_RE =
  /^src\/(?:app\/api\/|pages\/api\/|api\/|server\/|services\/|store\/|stores\/|db\/|database\/|prisma\/|supabase\/|middleware\.[cm]?[jt]sx?$|lib\/(?:db|server|auth)(?:\/|\.))/;

export function roleCanWriteFeatureSource(role: unknown, filePath: string): boolean {
  if (role === 'senior-frontend') {
    return /^(apps\/[^/]+\/(src|app)\/|packages\/(ui|i18n|utils)\/src\/)/.test(filePath)
      || FLAT_FRONTEND_SOURCE_RE.test(filePath);
  }
  if (role === 'senior-backend') {
    return /^(packages\/(api-client|ws-client|utils)\/src\/|services\/[^/]+\/src\/|apps\/[^/]+\/src\/(services|store)\/)/.test(filePath)
      || FLAT_BACKEND_SOURCE_RE.test(filePath);
  }
  // The post-build maintenance worker fixes trivial issues anywhere an
  // implementer could write — its scope is bounded by the triage spawn prompt
  // (named files, no exploration), not by the frontend/backend layer split.
  if (role === 'quick-fix') {
    return roleCanWriteFeatureSource('senior-frontend', filePath)
      || roleCanWriteFeatureSource('senior-backend', filePath);
  }
  return false;
}

// Role ownership check. Prefer the per-agent run claim resolved from the current
// hook session id; fall back to the legacy shared activeAgentRole only for older
// projects that do not have .traffic-one/runs/<runId>/ state yet.
export function subagentMayWriteFeatureSource(
  state: unknown,
  filePath: string,
  agentContext: RunAgentContext | null = null,
): boolean {
  if (agentContext && agentContext.role) {
    return roleCanWriteFeatureSource(agentContext.role, filePath);
  }
  if (!isSubagentSession(state)) return false;
  const role = activeAgentRole(state);
  if (role && roleCanWriteFeatureSource(role, filePath)) return true;
  return roleCanWriteFeatureSource('senior-frontend', filePath)
      || roleCanWriteFeatureSource('senior-backend', filePath);
}

export function commandAppearsToWriteFeatureSource(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const hasOutputRedirect = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*(?!&?\d\b)(?!\/dev\/null\b)/.test(command);
  const hasWritePrimitive = hasOutputRedirect
    || /\btee\b/.test(command)
    || /\bcat\b[\s\S]*<</.test(command)
    || /\bpython3?\b|\bnode\b|\bperl\b|\bsed\b[\s\S]*-i/.test(command)
    // mkdir creates no file content and carries no implementation ownership.
    // Treating it as a source write rejects foreground architect scaffolding in
    // Devin Local. Destructive/copying/content primitives remain gated.
    || /(?:^|[\s;&|])(?:rm|mv|cp|touch|truncate)\b/.test(command)
    || /(?:^|[\s;&|])find\b[\s\S]*\s-delete\b/.test(command);
  const mentionsFeaturePath = /(?:^|[\s'"`/])(?:apps\/[^/\s'"`]+\/(?:src|app)(?:\/|(?=$|[\s'"`]))|packages\/[^/\s'"`]+\/src(?:\/|(?=$|[\s'"`]))|src(?:\/|(?=$|[\s'"`]))|services\/[^/\s'"`]+\/src(?:\/|(?=$|[\s'"`])))/.test(command);
  return hasWritePrimitive && mentionsFeaturePath;
}

export function commandAppearsToWriteBuildArtifact(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const hasOutputRedirect = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*(?!&?\d\b)(?!\/dev\/null\b)/.test(command);
  const hasWritePrimitive = hasOutputRedirect
    || /\btee\b/.test(command)
    || /\bcat\b[\s\S]*<</.test(command)
    || /\bpython3?\b|\bnode\b|\bperl\b|\bsed\b[\s\S]*-i/.test(command)
    || /(?:^|[\s;&|])(?:rm|mv|cp|touch|truncate)\b/.test(command)
    || /(?:^|[\s;&|])find\b[\s\S]*\s-delete\b/.test(command);
  const mentionsBuildArtifact = /(?:^|[\s'"`])(?:(?:apps|packages|services)\/[^/\s'"`]+\/(?:package\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json|src\/vite-env\.d\.ts|public\/[^\s'"`]+)|(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|turbo\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json))(?:$|[\s'"`])/.test(command);
  return hasWritePrimitive && mentionsBuildArtifact;
}

export function commandAppearsToWriteExternalTemp(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const tempPath = "(?:/tmp|/private/tmp|/var/tmp)/[^\\s'\"`;|&>]+";
  const outputToTemp = new RegExp(String.raw`(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*` + tempPath).test(command);
  const teeToTemp = new RegExp(String.raw`\btee\b[\s\S]*` + tempPath).test(command);
  const writePrimitiveToTemp = new RegExp(String.raw`(?:^|[\s;&|])(?:touch|truncate|mkdir|rm|mv|cp)\b[\s\S]*` + tempPath).test(command);
  return outputToTemp || teeToTemp || writePrimitiveToTemp;
}

export function applyPatchTargetPaths(patchText: unknown): string[] {
  if (typeof patchText !== 'string' || !patchText.trim()) return [];
  const paths: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
      || line.match(/^\*\*\* Move to: (.+)$/);
    if (match && match[1]) {
      paths.push(match[1].trim().replace(/\\/g, '/').replace(/^\.\//, ''));
    }
  }
  return paths;
}
