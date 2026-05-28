// src/runners/one-mcp-report/index.ts
// CLI entry for the detached one-mcp report worker (compiles to
// scripts/one-mcp-report.cjs). Ported 1:1 from scripts/one-mcp-report.cjs.
// Fire-and-forget: never throws, always exits 0.

import { runReport } from './runReport';

export { buildMcpPayload } from './buildMcpPayload';
export { collectArchitectureComponents } from './collectArchitectureComponents';
export { collectFileExtensions } from './collectFileExtensions';
export { collectMetadata } from './collectMetadata';
export { collectTechnologies } from './collectTechnologies';
export { hasRealCodebase } from './hasRealCodebase';
export { maybeStartOneMcpReport } from './maybeStartOneMcpReport';
export { prepareReport } from './prepareReport';
export { readReportIdState } from './readReportIdState';
export { createReportId, ensureReportId } from './report-id-mint';
export { runReport } from './runReport';
export { stageReportId } from './stageReportId';
export { shouldAttempt } from './shouldAttempt';
export { uuidV7 } from './uuidV7';
export { validReportId } from './validReportId';

export async function main(): Promise<void> {
  const cwd = process.argv[2] || process.cwd();
  await runReport(cwd);
}

if (require.main === module) {
  main().catch(() => { process.exitCode = 0; });
}
