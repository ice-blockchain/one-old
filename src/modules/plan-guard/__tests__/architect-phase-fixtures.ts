// Shared fixtures for architect-phase-complete probes in plan-guard + agent-model tests.
import * as fs from 'fs';
import * as path from 'path';

import {
  architectureInputPath,
  compileArchitectureForRun,
  publishRuntimeAssignments,
  type ArchitectureInputV1,
} from '../../../shared/architecture-contract';
import { compileVerificationContract } from '../../../shared/verification-contract';

const DEFAULT_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

export function writeRequiredScaffold(dir: string): void {
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'turbo.json'), '{"tasks":{}}', 'utf8');
  fs.writeFileSync(path.join(dir, 'tsconfig.base.json'), '{"compilerOptions":{}}', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    private: true,
    packageManager: 'pnpm@10.12.1',
    workspaces: ['apps/*', 'packages/*'],
    scripts: { 'format:check': 'prettier --check .' },
    // Script/config parity: the fixture declares the tool its script names,
    // matching the owner-scoped implementer-format-parity-gate contract.
    devDependencies: { prettier: '^3.0.0' },
  }), 'utf8');
  fs.writeFileSync(path.join(dir, '.prettierrc'), '{ "printWidth": 100, "singleQuote": true }\n', 'utf8');
  for (const rel of ['apps/web', 'packages/ui/src', 'packages/tailwind-config/src', 'packages/i18n/src']) {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'apps/web/package.json'), '{"name":"web","private":true}', 'utf8');
  fs.writeFileSync(path.join(dir, 'packages/ui/package.json'), '{"name":"@app/ui","private":true}', 'utf8');
  fs.writeFileSync(path.join(dir, 'packages/ui/src/index.ts'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'packages/tailwind-config/package.json'), '{"name":"@app/tailwind-config","private":true}', 'utf8');
  fs.writeFileSync(path.join(dir, 'packages/tailwind-config/src/globals.css'), '@import "tailwindcss";\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'packages/i18n/package.json'), '{"name":"@app/i18n","private":true}', 'utf8');
  fs.writeFileSync(path.join(dir, 'packages/i18n/src/index.ts'), '', 'utf8');
}

export function writeRequiredMemory(dir: string, state: Record<string, unknown> = DEFAULT_STATE): void {
  const t1 = path.join(dir, '.traffic-one');
  fs.mkdirSync(path.join(t1, 'decisions'), { recursive: true });
  for (const [rel, content] of Object.entries({
    'product.md': '# Product\nBuild an education platform MVP.',
    'stack.md': '# Stack\nReact/Vite frontend with the selected backend.',
    'coding.md': '# Coding\nUse TypeScript and the Traffic One conventions.',
    'security.md': '# Security\nValidate inputs and keep secrets out of source.',
    'known-issues.md': '# Known issues\nNone known yet.',
    'deployment.md': '# Deployment\nDeploy from the built production artifact.',
    'environment-setup.md': '# Environment setup\nInstall dependencies and configure environment variables.',
    'agent-log.md': '# Agent log\nArchitect initialized project memory.',
    '.agentignore': 'node_modules\n',
  })) {
    fs.writeFileSync(path.join(t1, rel), content, 'utf8');
  }
  const backend = typeof state.backend === 'string' ? state.backend : 'supabase';
  const noOwnedBackend = backend === 'none' || backend === 'external-api';
  fs.writeFileSync(path.join(t1, 'api.md'), noOwnedBackend
    ? 'Not applicable because this project has no owned backend API.'
    : '# API\nOwned backend API contracts will be tracked here.', 'utf8');
  fs.writeFileSync(path.join(t1, 'database.md'), noOwnedBackend
    ? 'Not applicable because this project has no owned database.'
    : '# Database\nDatabase tables and persistence contracts will be tracked here.', 'utf8');
  fs.writeFileSync(path.join(t1, 'schema.sql'), noOwnedBackend
    ? '-- Not applicable because this project has no owned database schema.'
    : '-- schema snapshot\ncreate table if not exists healthcheck (id uuid primary key);', 'utf8');
}

export function writeArchitectPhaseComplete(dir: string, runId: string, state: Record<string, unknown> = DEFAULT_STATE): void {
  writeRequiredScaffold(dir);
  writeRequiredMemory(dir, state);
  const t1 = path.join(dir, '.traffic-one');
  fs.mkdirSync(path.join(t1, 'runs', runId), { recursive: true });
  fs.mkdirSync(path.join(t1, 'digests', runId), { recursive: true });
  const hasUi = typeof state.frontend !== 'string' || state.frontend !== 'none'
    || (typeof state.mobile === 'object' && state.mobile !== null
      && (state.mobile as Record<string, unknown>).framework !== 'none');
  const architecture: ArchitectureInputV1 = hasUi ? {
    schemaVersion: 1,
    routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
    modules: [
      { id: 'app-shell', name: 'App', kind: 'app-shell' },
      { id: 'home', name: 'Home', kind: 'page' },
    ],
  } : {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'app-service', name: 'App Service', kind: 'service' }],
  };
  fs.writeFileSync(architectureInputPath(dir, runId), JSON.stringify(architecture), 'utf8');
  const compiled = compileArchitectureForRun(dir, runId, state);
  const verification = compileVerificationContract(dir, runId, state, compiled, { changedPaths: [] });
  publishRuntimeAssignments(dir, compiled, verification.contractHash);
  fs.writeFileSync(path.join(t1, 'digests', runId, 'architect.md'), 'verdict: PLAN_READY\n', 'utf8');
}
