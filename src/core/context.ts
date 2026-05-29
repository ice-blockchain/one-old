// src/core/context.ts
// The composition root: assembles the Ctx (DI container) once per hook
// invocation. Handlers receive this and read ctx.fsjson/exec/paths/skillBlock
// instead of require()-ing siblings — which is what removes the duplicated
// helpers and the circular "hoisted forwarder" requires.

import type { Ctx, HookInput } from './types';
import { exec } from '../shared/exec';
import { fsjson } from '../shared/fsjson';
import { makeLogger } from '../shared/logger';
import { paths, pluginRoot } from '../shared/paths';
import { makeSkillBlock } from '../shared/skill-block';
import { nowIso } from '../shared/text';

const skillBlock = makeSkillBlock(pluginRoot);

export function buildContext(input: HookInput, opts: { debug?: boolean } = {}): Ctx {
  const projectRoot = paths.projectRoot(input);
  return {
    input,
    host: input.host,
    cwd: projectRoot,
    now: nowIso,
    log: makeLogger({ debug: opts.debug ?? false }),
    fsjson,
    exec,
    paths,
    skillBlock,
  };
}
