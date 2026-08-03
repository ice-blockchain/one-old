// src/modules/materialize/index.ts
// Materialize module: the PostToolUse `post-stack-setup` dispatcher (Handler)
// + the `materialize-project` manual command (exported action, routed by the
// host entry — not a gate).

import { noop } from '../../core/result';
import type { Handler } from '../../core/types';
import { runMaterializeProject } from './materialize-project';
import { runPostStackSetup } from './post-stack-setup';
import { maybeStartOneMcpReport } from '../../runners/one-mcp-report';

export { runMaterializeProject } from './materialize-project';
export { runPostStackSetup } from './post-stack-setup';

export const handlers: Handler[] = [
  {
    // The manual remediation command gate denials point at. Subcommand routing
    // only sees handler.subcommands (module.json `commands` is descriptive), so
    // without this entry `hook-runtime.cjs materialize-project` matched ZERO
    // handlers and exited silently. Manual invocations parse to PreToolUse with
    // NO tool (real PreToolUse payloads always carry one) — that guard keeps the
    // handler inert in Cursor's full-pipeline fan-out. The action auth-gates itself.
    id: 'materialize.materialize-project',
    event: 'PreToolUse',
    subcommands: ['materialize-project'],
    priority: 50,
    run: (ctx) => (ctx.input.tool ? noop() : runMaterializeProject(ctx)),
  },
  {
    id: 'materialize.post-stack-setup',
    event: 'PostToolUse',
    tools: ['file-write', 'file-edit', 'shell', 'spawn-agent'],
    subcommands: ['post-stack-setup'],
    priority: 60,
    run: (ctx) => runPostStackSetup(ctx, {
      // Single onboarding-finalized report gate (see runPostStackSetup).
      // prepareReport owns exact plugin-use consent and codebase checks.
      reportOneMcp: (cwd, state, trigger) => {
        maybeStartOneMcpReport(cwd, { state, trigger });
      },
    }),
  },
];
