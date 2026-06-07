// src/runners/onboarding-server/seed-provider.ts
// Binary-detect seeding for the machine-wide code-graph provider. When one.json has
// no provider yet, probe for an ALREADY-INSTALLED gitnexus/graphify (skipInstall —
// detection only, NO install is triggered) and seed the global setting so onboarding
// skips the code-graph prompt for this and every future project. gitnexus takes
// precedence when both are present.
//
// Runs once per real (standalone) wizard-server launch — see server.ts. It is NOT
// run in the in-process test server (standalone:false), so `which gitnexus` on a
// developer machine cannot non-deterministically seed a provider during tests.

import { ensureGitnexusTool } from '../gitnexus';
import { ensureGraphifyTool } from '../graphify';
import { readGlobalCodeGraphProvider, writeGlobalCodeGraphProvider } from '../../shared/state';

export function seedGlobalCodeGraphProviderIfInstalled(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const existing = readGlobalCodeGraphProvider(env);
  if (existing) return existing;
  // skipInstall:true → detection only; ok===true means the tool is already usable.
  if (ensureGitnexusTool(cwd, { skipInstall: true }).ok) return writeGlobalCodeGraphProvider('gitnexus', env);
  if (ensureGraphifyTool(cwd, { skipInstall: true }).ok) return writeGlobalCodeGraphProvider('graphify', env);
  return null;
}
