// src/modules/materialize/index.ts
// Materialize module: the PostToolUse `post-stack-setup` dispatcher (Handler)
// + the `materialize-project` manual command (exported action, routed by the
// host entry — not a gate).

import type { Handler } from '../../core/types';
import { runPostStackSetup } from './post-stack-setup';
import { maybeStartOneMcpReport } from '../../runners/one-mcp-report';

export { runMaterializeProject } from './materialize-project';
export { runPostStackSetup } from './post-stack-setup';

export const handlers: Handler[] = [
  {
    id: 'materialize.post-stack-setup',
    event: 'PostToolUse',
    tools: ['file-write', 'file-edit', 'shell', 'spawn-agent'],
    subcommands: ['post-stack-setup'],
    priority: 60,
    run: (ctx) => runPostStackSetup(ctx, {
      // Single onboarding-finalized report gate (see runPostStackSetup). Auth is
      // enforced inside prepareReport and bypassed when AUTH_ENABLED is off, so no
      // per-trigger allowUnauthenticated flag is needed here.
      reportOneMcp: (cwd, state, trigger) => {
        maybeStartOneMcpReport(cwd, { state, trigger });
      },
    }),
  },
];
