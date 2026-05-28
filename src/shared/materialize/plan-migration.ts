import * as fs from 'fs';
import * as path from 'path';

import { readText } from '../fsjson';

export interface PlanMigrationResult {
  changed: boolean;
  migrated: string[];
  planPath: string;
}

interface LegacyDoc {
  absPath: string;
  relPath: string;
  content: string;
}

const PLAN_TEMPLATE = `# Traffic One Plan

## Goal
Unverified. Review the migrated legacy plan notes below.

## Stack & rationale
Unverified. Review the migrated legacy plan notes below.

## Module map
Unverified. Review the migrated legacy plan notes below.

## Public contracts
Unverified. Review the migrated legacy plan notes below.

## Risks
- Unverified. Review the migrated legacy plan notes below.

## Cut-list
Unverified. Review the migrated legacy plan notes below.
`;

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function legacyArchitectureDocs(cwd: string): LegacyDoc[] {
  const candidates = [
    path.join(cwd, '.traffic-one', 'architecture.md'),
    path.join(cwd, 'architecture.md'),
  ];
  const packagesRoot = path.join(cwd, 'packages');
  if (fs.existsSync(packagesRoot)) {
    for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(path.join(packagesRoot, entry.name, 'architecture.md'));
    }
  }

  return candidates
    .filter((absPath) => fs.existsSync(absPath) && !fs.lstatSync(absPath).isDirectory())
    .map((absPath) => ({
      absPath,
      relPath: toPosix(path.relative(cwd, absPath)),
      content: readText(absPath) ?? '',
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function migratedBlock(docs: LegacyDoc[], existingPlan: string): string {
  const chunks = docs
    .filter((doc) => !existingPlan.includes(`### ${doc.relPath}`))
    .map((doc) => [
      `### ${doc.relPath}`,
      '',
      doc.content.trim() || '_Empty legacy file._',
      '',
    ].join('\n'));
  if (chunks.length === 0) return '';
  return [
    '## Migrated Legacy Plan Notes',
    '',
    'The sections below were migrated from legacy `architecture.md` files. Keep future planning, package responsibilities, and public contracts in this `plan.md` file.',
    '',
    ...chunks,
  ].join('\n').trimEnd();
}

export function migrateArchitectureDocsToPlan(cwd: string): PlanMigrationResult | null {
  const docs = legacyArchitectureDocs(cwd);
  if (docs.length === 0) return null;

  const planPath = path.join(cwd, '.traffic-one', 'plan.md');
  const existingPlan = readText(planPath);
  const basePlan = (existingPlan && existingPlan.trim()) ? existingPlan.trimEnd() : PLAN_TEMPLATE.trimEnd();
  const block = migratedBlock(docs, basePlan);
  const nextPlan = block ? `${basePlan}\n\n${block}\n` : `${basePlan}\n`;

  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  if (nextPlan !== existingPlan) fs.writeFileSync(planPath, nextPlan, 'utf8');

  for (const doc of docs) fs.rmSync(doc.absPath, { force: true });

  return {
    changed: nextPlan !== existingPlan || docs.length > 0,
    migrated: docs.map((doc) => doc.relPath),
    planPath,
  };
}
