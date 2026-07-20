// src/modules/session/authoring-guard.ts
// PreToolUse deny for MODEL-steered writes into the plugin's own repo. Hook-side
// writers all stand down at authoring roots (writeState / one-mcp / claims /
// wizard), but Codex merges ANCESTOR AGENTS.md files: a parent workspace's
// generated Traffic One context steers the model itself to create .traffic-one/**
// or rewrite the repo's AGENTS.md as project context. This gate blocks exactly
// those writes — strictly path-scoped, so ordinary source edits in the repo and
// .traffic-one writes in real projects (no authoring ancestor) are untouched.

import * as path from 'path';

import { asString } from '../../adapters/coerce';
import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { findAuthoringRootContaining } from '../../shared/authoring-root';
import { GENERATED_MARKER } from '../../shared/materialize/generated';
import { obj, type Rec } from '../../shared/obj';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import { parseApplyPatch, patchOperationPaths, patchTextFromToolInput } from '../../shared/apply-patch';
import { isMutatingPreToolUse, normalizedToolName, parsedToolInput } from '../../shared/tool-classify';

const skillBlock = makeSkillBlock(pluginRoot);

// Verbatim fallback: a missing T1BLOCK must never disable the gate.
const AUTHORING_DENY_FALLBACK = 'traffic-one — write blocked: "{{PATH}}" is inside the Traffic One plugin source repository ({{ROOT}}). '
  + 'This repo is the plugin\'s own codebase, never a Traffic One project: do not create `.traffic-one/**` here '
  + '(no .one.json, manifest.json, one-mcp-report.json, runs/, rules/skills copies) and do not write generated '
  + 'AGENTS.md/CLAUDE.md project context into it. Traffic One conventions inherited from a parent directory\'s '
  + 'AGENTS.md do not apply inside this repo. Continue the user\'s task with plain source edits.';

const MATERIALIZED_TITLE = '# Traffic One Local Agent Context';

function denyAuthoringWrite(targetPath: string, root: string): HookResult {
  return deny(skillBlock('session', 'authoring-write-guard', { PATH: targetPath, ROOT: root }, AUTHORING_DENY_FALLBACK));
}

function writtenContent(toolInput: Rec): string {
  const direct = asString(toolInput.content ?? toolInput.new_string ?? toolInput.newContent ?? toolInput.new_str);
  if (direct) return direct;
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
  const editStrings = edits
    .map((edit) => (edit && typeof edit === 'object' ? asString((edit as Rec).new_string ?? (edit as Rec).newString) : ''))
    .filter(Boolean);
  if (editStrings.length > 0) return editStrings.join('\n');
  return patchTextFromToolInput(toolInput);
}

export function authoringWriteGuard(ctx: Ctx): HookResult {
  const raw = obj(ctx.input.raw) || {};
  // parsedToolInput supplies content/patch text on Cursor (no raw.tool_input) so the
  // GENERATED_MARKER content check can see what's being written.
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  const workdir = ctx.input.tool?.workdir || asString(toolInput.workdir ?? toolInput.cwd);
  const pathBase = workdir
    ? (path.isAbsolute(workdir) ? path.resolve(workdir) : path.resolve(ctx.cwd, workdir))
    : ctx.cwd;

  const candidates: string[] = [];
  const filePath = ctx.input.tool?.filePath || asString(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);
  if (filePath) candidates.push(filePath);
  const isApplyPatch = /^apply_patch$/i.test(normalizedToolName(ctx.input.tool?.rawName || toolName));
  if (isApplyPatch) {
    const patchText = patchTextFromToolInput(ctx.input.tool?.patchText, raw.tool_input, raw.toolInput, raw.input, raw, toolInput);
    const parsedPatch = parseApplyPatch(patchText);
    if (!parsedPatch.ok) {
      return deny(`traffic-one — invalid apply_patch payload: ${parsedPatch.error}. No write was made.`);
    }
    candidates.push(...patchOperationPaths(parsedPatch.operations));
  }
  let command = ctx.input.tool?.command || asString(toolInput.command ?? toolInput.cmd);
  if (!/^(Bash|Shell|Terminal|exec_command)$/i.test(String(toolName || ''))) command = '';
  if (command && command.includes('.traffic-one')) {
    if (!isMutatingPreToolUse(toolName, toolInput)) return noop();
    for (const token of command.split(/\s+/)) {
      if (token.includes('.traffic-one')) candidates.push(token.replace(/^["'`]+|["'`,;]+$/g, ''));
    }
  }

  for (const candidate of candidates) {
    if (!candidate || candidate.startsWith('-') || candidate.includes('://') || candidate.includes('$')) continue;
    const abs = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(pathBase, candidate);
    const root = findAuthoringRootContaining(path.dirname(abs));
    if (!root) continue;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (rel === '.traffic-one' || rel.startsWith('.traffic-one/')) {
      return denyAuthoringWrite(abs, root);
    }
    if (rel === 'AGENTS.md' || rel === 'CLAUDE.md') {
      const content = writtenContent(toolInput);
      if (content.includes(GENERATED_MARKER) || content.includes(MATERIALIZED_TITLE)) {
        return denyAuthoringWrite(abs, root);
      }
    }
  }
  return noop();
}
