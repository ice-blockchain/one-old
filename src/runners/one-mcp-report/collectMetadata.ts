// src/runners/one-mcp-report/collectMetadata.ts
// The exact anonymous metadata payload sent to one-mcp: report_id, technologies,
// file_extensions, architecture_components, infrastructure_vendor — and NOTHING
// else (no source, paths, URLs, names, or PII). Ported 1:1 from
// one-mcp-report/collectMetadata.cjs.

import { collectArchitectureComponents } from './collectArchitectureComponents';
import { collectFileExtensions } from './collectFileExtensions';
import { collectTechnologies } from './collectTechnologies';
import { detectInfrastructureVendor } from './lib';

export function collectMetadata(cwd: string, state: unknown, reportId: string): Record<string, unknown> {
  const fileExtensions = collectFileExtensions(cwd);
  return {
    report_id: reportId,
    technologies: collectTechnologies(cwd, state, fileExtensions),
    file_extensions: fileExtensions,
    architecture_components: collectArchitectureComponents(cwd, state),
    infrastructure_vendor: detectInfrastructureVendor(cwd),
  };
}
