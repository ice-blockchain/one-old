// src/runners/onboarding-server/seed-provider.ts
// Detection-only: which code-graph binary is already on PATH. Installed
// binaries are hints, never a default — this helper must not write one.json.
// gitnexus is reported when both are present. The wizard always asks until
// THIS project acknowledges.

import { ensureGitnexusTool } from '../gitnexus';
import { ensureGraphifyTool } from '../graphify';
import { readGlobalCodeGraphProvider } from '../../shared/state';

export function seedGlobalCodeGraphProviderIfInstalled(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const existing = readGlobalCodeGraphProvider(env);
  if (existing) return existing;
  // skipInstall:true → detection only; ok===true means the tool is already usable.
  if (ensureGitnexusTool(cwd, { skipInstall: true }).ok) return 'gitnexus';
  if (ensureGraphifyTool(cwd, { skipInstall: true }).ok) return 'graphify';
  return null;
}
