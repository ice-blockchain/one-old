// src/modules/materialize/index.ts
// Materialize module. The `materialize-project` manual command is exported as an
// action (routed by the host entry, not the gate pipeline). The PostToolUse
// `post-stack-setup` dispatcher lands here next as a Handler.

import type { Handler } from '../../core/types';

export { runMaterializeProject } from './materialize-project';

export const handlers: Handler[] = [];
