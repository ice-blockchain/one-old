// src/shared/tool-classify.ts
// Tool-name + command + state-file classification used by the onboarding/
// post-stack gates. Ported 1:1 from the helpers in
// scripts/hook-runtime/handlers/_helpers.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { LEGACY_STATE_FILE, STATE_FILE } from './config';
import { legacyStatePath, statePath } from './state';

type Rec = Record<string, unknown>;

export function normalizedToolName(toolName: unknown): string {
  const raw = String(toolName || '');
  return raw.includes('.') ? (raw.split('.').pop() as string) : raw;
}

export function isShellToolName(toolName: unknown = ''): boolean {
  return /^(Bash|exec_command)$/i.test(normalizedToolName(toolName));
}

export function isWriteLikeToolName(toolName: unknown = ''): boolean {
  return /^(Write|Edit|MultiEdit|apply_patch)$/i.test(normalizedToolName(toolName));
}

export function commandFromToolInput(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const ti = toolInput as Rec;
  if (typeof ti.command === 'string') return ti.command;
  if (typeof ti.cmd === 'string') return ti.cmd;
  return '';
}

export function isStateFilePath(filePath: unknown): boolean {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const stateFile = STATE_FILE.split(path.sep).join('/');
  return normalized === stateFile
    || normalized.endsWith(`/${stateFile}`)
    || normalized === LEGACY_STATE_FILE
    || normalized.endsWith(`/${LEGACY_STATE_FILE}`);
}

export function hasStateFile(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, STATE_FILE)) || fs.existsSync(path.join(cwd, LEGACY_STATE_FILE));
}

export function existingStateFilePath(cwd: string): string {
  const nextPath = statePath(cwd);
  return fs.existsSync(nextPath) ? nextPath : legacyStatePath(cwd);
}

export function patchTextFromToolInput(toolInput: unknown): string {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  const ti = toolInput as Rec;
  for (const key of ['patch', 'input', 'content', 'text']) {
    if (typeof ti[key] === 'string') return ti[key] as string;
  }
  return '';
}

function patchTouchedFiles(patchText: string): string[] {
  const files: string[] = [];
  for (const line of String(patchText || '').split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) || line.match(/^\*\*\* Move to: (.+)$/);
    if (match) files.push((match[1] as string).trim());
  }
  return files;
}

export function isStateFileOnlyPatch(toolName: unknown, toolInput: unknown): boolean {
  if (!/^apply_patch$/i.test(normalizedToolName(toolName))) return false;
  const files = patchTouchedFiles(patchTextFromToolInput(toolInput));
  return files.length > 0 && files.every((f) => isStateFilePath(f));
}

export function isMutatingPreToolUse(toolName: unknown, toolInput: unknown): boolean {
  const ti = toolInput && typeof toolInput === 'object' ? (toolInput as Rec) : null;
  const name = String(toolName || (ti && (ti.tool_name || ti.toolName)) || '');
  if (isWriteLikeToolName(name)) return true;
  if (ti && ('content' in ti || 'new_string' in ti || 'old_string' in ti || 'edits' in ti)) return true;
  if (!isShellToolName(name)) return false;
  const command = commandFromToolInput(toolInput);
  return /(^|[\s;&|])(mkdir|touch|rm|mv|cp|tee|npm\s+(install|i|add|create)|pnpm\s+(install|add|create)|yarn\s+(install|add|create)|bun\s+(install|add|create)|npx|git\s+(init|add|commit)|sed\s+-i)\b/.test(command)
    || />{1,2}/.test(command);
}

export function isReadOnlyOrientationToolUse(toolName: unknown, toolInput: unknown): boolean {
  const ti = toolInput && typeof toolInput === 'object' ? (toolInput as Rec) : null;
  const name = String(toolName || (ti && (ti.tool_name || ti.toolName)) || '');
  if (!name) return false;
  if (/^(Read|Glob|Grep|LS|NotebookRead)$/i.test(normalizedToolName(name))) return true;
  if (isShellToolName(name) && !isMutatingPreToolUse(name, toolInput)) return true;
  return false;
}
