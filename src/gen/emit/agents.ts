// src/gen/emit/agents.ts
// Re-gathers the flat agents/ tree the hosts read (Claude loads agents/; the
// cursor-rules emitter mirrors them into .cursor/rules/00-agent-*.mdc) from the
// content modules that declare `agents` in their module.json. First slice of
// the content dissolution: the agent role docs now live in
// src/modules/<role>/agent.md (the source); gen re-emits agents/<id>.md
// byte-identical. Runs before emitCursorRules so the cursor mirror reads the
// freshly-emitted tree.

import * as fs from 'fs';
import * as path from 'path';

import { discoverDescriptors } from '../../core/registry';
import type { GenRun } from '../lib/run';

export interface AgentDoc { relPath: string; content: string; }

export function generatedAgents(repoRoot: string): AgentDoc[] {
  const modulesDir = path.join(repoRoot, 'src', 'modules');
  const docs: AgentDoc[] = [];
  for (const { descriptor, dir } of discoverDescriptors(modulesDir)) {
    if (!descriptor.agents || descriptor.agents.length === 0) continue;
    // One agent per content module (id = role stem → agents/<id>.md), matching
    // the legacy flat filenames.
    for (const agentPath of descriptor.agents) {
      const content = fs.readFileSync(path.join(dir, agentPath), 'utf8');
      docs.push({ relPath: path.join('agents', `${descriptor.id}.md`), content });
    }
  }
  return docs;
}

export function emitAgents(run: GenRun): void {
  for (const doc of generatedAgents(run.sourceRoot)) {
    run.file(doc.relPath, doc.content);
  }
}
