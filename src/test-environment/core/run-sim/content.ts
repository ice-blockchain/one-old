// src/test-environment/core/run-sim/content.ts
// Deterministic bodies for the artifacts a role would author. Nothing here is
// random or time-derived: the same case must produce byte-identical files on
// every run, or contract hashes drift and `--reassert` stops meaning anything.
//
// Content is generated to SATISFY the real gates, which is the point — the
// thresholds below are the gates' own, quoted at their source:
//   - project-memory files: trimmed length >= 16 (>=1 for .agentignore)
//     (plan-guard/plan-readiness/architect.ts:50-53, :94)
//   - "not applicable" bodies: >= 32 chars, the phrase, AND a reason word
//     (architect.ts:55-60)
//   - ADRs: >= 32 chars (architect.ts:62-78)

import type { Rec } from '../../../shared/obj';

export const MEMORY_FILES = [
  'product.md',
  'stack.md',
  'coding.md',
  'security.md',
  'known-issues.md',
  'deployment.md',
  'environment-setup.md',
  'agent-log.md',
] as const;

const MEMORY_HEADINGS: Record<string, string> = {
  'product.md': 'Product',
  'stack.md': 'Stack',
  'coding.md': 'Coding conventions',
  'security.md': 'Security',
  'known-issues.md': 'Known issues',
  'deployment.md': 'Deployment',
  'environment-setup.md': 'Environment setup',
  'agent-log.md': 'Agent log',
};

const MEMORY_BODIES: Record<string, (brief: string, state: Rec) => string> = {
  'product.md': (brief) => `${brief}\n\nScope is limited to what the brief names; anything not listed is out of scope for this run.`,
  'stack.md': (_brief, state) => `Frontend: ${String(state.frontend ?? 'none')}. Backend: ${String(state.backend ?? 'none')}. Stack profile: ${String(state.stack ?? 'default')}.\n\nThe compiled architecture contract owns roots, outputs, and roles; this file records the semantic choice only.`,
  'coding.md': () => 'Small modules, one responsibility each. Route pages are separate compiled modules; the app shell only bootstraps and routes.\n\nFormatting and size limits come from the compiled project config, not from prose.',
  'security.md': () => 'Validate every input at the boundary. Secrets come from environment variables and never from source.\n\nNo credentials, tokens, or personal data are committed.',
  'known-issues.md': () => 'None recorded yet for this run. Findings raised by the reviewer or tester are appended here as they are confirmed.',
  'deployment.md': () => 'Deploy from the built production artifact. The public origin is Unverified until the user supplies it.\n\nCrawl assets are generated from the public site-url environment variable.',
  'environment-setup.md': () => 'Install dependencies with the package manager the workspace declares, then run the build, typecheck, and test scripts.\n\nNo machine-global tooling is assumed.',
  'agent-log.md': () => 'Architect initialised project memory and emitted the semantic architecture input for this run.',
};

export function memoryBody(file: string, brief: string, state: Rec): string {
  const heading = MEMORY_HEADINGS[file] || file.replace(/\.md$/, '');
  const body = MEMORY_BODIES[file]?.(brief, state) ?? `Recorded for this run: ${brief}`;
  return `# ${heading}\n\n${body}\n`;
}

export const AGENTIGNORE_BODY = 'node_modules\ndist\n.output\nvendor\n';

// Backends that own no API/database of their own. `external-api` and `none` get
// the "Not applicable + reason" form the gate accepts instead of invented docs.
export function hasOwnedBackend(state: Rec): boolean {
  const backend = typeof state.backend === 'string' ? state.backend : '';
  return backend !== '' && backend !== 'none' && backend !== 'external-api';
}

export function backendDocBody(file: string, state: Rec): string {
  if (!hasOwnedBackend(state)) {
    // Must satisfy hasNotApplicableReason: the phrase, >= 32 chars, a reason word.
    const subject = file === 'schema.sql' ? 'database schema' : file.replace(/\.md$/, '');
    const line = `Not applicable because this project has no owned ${subject}; data comes from an external service.`;
    return file === 'schema.sql' ? `-- ${line}\n` : `${line}\n`;
  }
  if (file === 'schema.sql') {
    return '-- Schema snapshot for this run.\ncreate table if not exists healthcheck (\n  id uuid primary key,\n  observed_at timestamptz not null default now()\n);\n';
  }
  if (file === 'database.md') {
    return '# Database\n\nTables and persistence contracts owned by this project are tracked here, mirroring `schema.sql`.\n';
  }
  return '# API\n\nOwned backend API contracts are tracked here: one section per resource, with its request and response shape.\n';
}

export function adrBody(state: Rec, brief: string): string {
  return [
    '# Architecture decision: stack selection',
    '',
    `Context: ${brief}`,
    '',
    `Decision: frontend \`${String(state.frontend ?? 'none')}\` with backend \`${String(state.backend ?? 'none')}\`,`,
    'because the brief names that toolchain explicitly.',
    '',
    'Consequences: the compiled contract targets that framework profile, and the',
    'project quality configs are compiled for the same stack.',
    '',
  ].join('\n');
}

export function planBody(brief: string, state: Rec): string {
  return [
    '# Plan',
    '',
    `## Brief`,
    '',
    brief,
    '',
    '## Approach',
    '',
    `Build the surfaces the brief names on \`${String(state.frontend ?? 'none')}\` with`,
    `\`${String(state.backend ?? 'none')}\`. Each route page is its own compiled module;`,
    'shared UI lives in components, data access in the planned API modules.',
    '',
    '## Out of scope',
    '',
    'Anything the brief does not name. No surface is added speculatively.',
    '',
  ].join('\n');
}

export function digestBody(opts: {
  role: string;
  runId: string;
  verdict: string;
  summary: string;
  touched?: readonly string[];
}): string {
  const touched = opts.touched && opts.touched.length > 0
    ? opts.touched.map((file) => `- ${file}`).join('\n')
    : '- (no files in this phase)';
  return [
    `# ${opts.role} — run ${opts.runId}`,
    '',
    `verdict: ${opts.verdict}`,
    '',
    '## Summary',
    '',
    opts.summary,
    '',
    '## Files',
    '',
    touched,
    '',
  ].join('\n');
}
