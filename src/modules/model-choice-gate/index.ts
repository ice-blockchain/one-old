import { asString } from '../../adapters/coerce';
import { deny, noop } from '../../core/result';
import type { Ctx, Handler, HookResult } from '../../core/types';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { projectRelativeHookPath, resolveProjectRoot } from '../../shared/hook-paths';
import { formatModelChoiceRequiredStop } from '../../shared/materialize/cursor-eligibility';
import { obj } from '../../shared/obj';
import { firstEmitThisSession } from '../../shared/once';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import { hookSessionIdentity, readEffectiveState } from '../../shared/state';
import {
  canonicalToolName,
  isModelGateCommand,
  isOnboardingWaitCommand,
  isReadOnlyOrientationToolUse,
  parsedToolInput,
} from '../../shared/tool-classify';
import { authChoiceAllowsContinue } from '../session/auth-choice';
import { modelChoiceReplyPending } from '../agent-model/model-choice';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string =>
  skillBlock('model-choice-gate', name, vars);

export function modelChoiceGate(ctx: Ctx): HookResult {
  if (ctx.host !== 'cursor') return noop();
  const raw = obj(ctx.input.raw) || {};
  const toolName = canonicalToolName(ctx.input.tool) || asString(raw.tool_name ?? raw.toolName);
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};
  const filePath = ctx.input.tool?.filePath || asString(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);

  if (isPluginAuthoringRoot(ctx.cwd)) return noop();
  const root = resolveProjectRoot(ctx.cwd, filePath, { ceiling: ctx.input.workspaceRoot });
  if (isPluginAuthoringRoot(root)) return noop();
  if (authChoiceAllowsContinue(root)) return noop();

  const state = readEffectiveState(root);
  if (!state || !modelChoiceReplyPending(root, state as Record<string, unknown>)) return noop();

  if (isModelGateCommand(toolName, toolInput) || isOnboardingWaitCommand(toolName, toolInput)) return noop();

  const table = formatModelChoiceRequiredStop(root, state as Record<string, unknown>)
    || 'traffic-one model-gate: STOP — model choice required (build paused). Reply `fallback` or `enable`.';
  const sessionId = hookSessionIdentity(raw).sessionId;
  if (firstEmitThisSession(root, 'model-choice-deny-tool', sessionId)) {
    return deny(block('model-choice-stop-first', {
      TABLE: table,
      PROJECT_ROOT: root,
      PATH: projectRelativeHookPath(ctx.cwd, root, filePath),
    }));
  }

  if (isReadOnlyOrientationToolUse(toolName, toolInput)) return noop();
  return deny(block('model-choice-stop-repeat', { PROJECT_ROOT: root }));
}

export const handlers: Handler[] = [
  {
    id: 'model-choice-gate.pre-tool',
    event: 'PreToolUse',
    tools: ['shell', 'file-write', 'file-edit', 'file-read', 'spawn-agent', 'search'],
    subcommands: ['check-model-choice-gate'],
    priority: 15,
    run: (ctx: Ctx) => modelChoiceGate(ctx),
  },
];
