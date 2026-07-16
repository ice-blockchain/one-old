// src/shared/tool-classify.ts
// Tool-name + command + state-file classification used by the onboarding/
// post-stack gates. Ported 1:1 from the helpers in
// scripts/hook-runtime/handlers/_helpers.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { LEGACY_STATE_FILE, STATE_FILE } from '../config/paths';
import type { ToolClass, ToolInput } from '../core/types';
import { onboardingWaitScriptPath } from './onboarding-server/wait-command';
import { legacyStatePath, statePath } from './state';
import { resolveTrafficOneEnv } from './state/traffic-one-paths';

type Rec = Record<string, unknown>;

export function normalizedToolName(toolName: unknown): string {
  const raw = String(toolName || '');
  return raw.includes('.') ? (raw.split('.').pop() as string) : raw;
}

export function isShellToolName(toolName: unknown = ''): boolean {
  return /^(Bash|exec_command)$/i.test(normalizedToolName(toolName));
}

// Names the classifiers above recognize. rawName is already one of these on
// Claude/Codex; Cursor's rawName is a host SUBCOMMAND (before-shell-execution,
// before-read-file, after-file-edit) that matches none of them.
const KNOWN_TOOL_NAME = /^(Bash|exec_command|Write|Edit|MultiEdit|apply_patch|Read|Glob|Grep|LS|NotebookRead|NotebookEdit)$/i;

function nameForClass(cls: ToolClass): string {
  switch (cls) {
    case 'shell': return 'Bash';
    case 'file-read': return 'Read';
    case 'file-edit': return 'Edit';
    case 'file-write': return 'Write';
    case 'search': return 'Grep';
    case 'spawn-agent': return 'Task';
    default: return '';
  }
}

function canonicalKnownToolName(rawName: string): string {
  const normalized = normalizedToolName(rawName);
  if (KNOWN_TOOL_NAME.test(normalized)) return rawName;
  switch (normalized.toLowerCase()) {
    case 'bash':
      return 'Bash';
    case 'write':
      return 'Write';
    case 'edit':
      return 'Edit';
    case 'patch':
      return 'apply_patch';
    case 'read':
      return 'Read';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'list':
      return 'LS';
    case 'task':
      return 'Task';
    default:
      return '';
  }
}

// A host-agnostic tool name the classifiers understand. The adapter-parsed
// ToolInput is canonical on every host — but Cursor sets rawName to a coarse
// subcommand, so when rawName isn't a recognized tool name, map the canonical
// CLASS to a representative one. Keeps Claude/Codex (already-canonical rawName)
// byte-identical while making Cursor's gate checks actually classify.
export function canonicalToolName(tool: ToolInput | undefined): string {
  if (!tool) return '';
  const known = canonicalKnownToolName(tool.rawName || '');
  if (known) return known;
  return nameForClass(tool.class) || tool.rawName || '';
}

// Synthesize a {command,file_path,content} input from the adapter-parsed tool, for
// hosts (Cursor) that carry these on the parsed tool rather than in raw.tool_input.
// Returns null when there's nothing to contribute so callers can `|| {}` cleanly.
export function parsedToolInput(tool: ToolInput | undefined): Rec | null {
  if (!tool) return null;
  const ti: Rec = {};
  if (tool.command) ti.command = tool.command;
  if (tool.filePath) ti.file_path = tool.filePath;
  if (tool.content) ti.content = tool.content;
  return Object.keys(ti).length > 0 ? ti : null;
}

export function isWriteLikeToolName(toolName: unknown = ''): boolean {
  return /^(Write|Edit|MultiEdit|apply_patch)$/i.test(normalizedToolName(toolName));
}

export function commandFromToolInput(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const ti = toolInput as Rec;
  if (typeof ti.command === 'string') return ti.command;
  if (typeof ti.cmd === 'string') return ti.cmd;
  // Windsurf/Devin `pre_run_command` payloads carry the command as `command_line`
  // (`tool_info.command_line`); without this, run-command classifiers (e.g.
  // isOnboardingWaitCommand) got an empty string on Windsurf and the onboarding
  // gate wrongly DENIED the wait command — re-minting the wizard server and
  // staling the link the agent had already shown.
  if (typeof ti.command_line === 'string') return ti.command_line;
  if (typeof ti.commandLine === 'string') return ti.commandLine;
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

export function patchTouchedFiles(patchText: string): string[] {
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

// Mutating-command vocabulary for shell tool calls. Anchored to a line start or a
// shell separator (;, &, |) so it reads as a command, not a substring. Biased
// toward flagging: a denied read-only command during the brief onboarding-
// incomplete window is harmless, a MISSED write is the bypass this guards against.
// Covers file ops, dependency/package installs, build-installs, and working-tree-
// mutating git subcommands.
const MUTATING_SHELL_COMMAND = /(^|[\s;&|])(mkdir|rmdir|touch|rm|mv|cp|ln|dd|tee|truncate|chmod|chown|chgrp|xargs|npm\s+(install|i|add|create)|pnpm\s+(install|add|create)|yarn\s+(install|add|create)|bun\s+(install|add|create)|npx|pip3?\s+install|cargo\s+(install|add)|go\s+install|gem\s+install|composer\s+(require|install)|make\s+install|git\s+(init|add|commit|rm|mv|checkout|restore|reset|clean|stash|apply|push|merge|rebase)|(sed|perl)\s+-i)\b/;
const MUTATING_FIND_COMMAND = /(^|[\s;&|])find\b[^\n;&|]*(?:\s-(?:delete|exec|execdir)\b)/;
// Inline interpreter eval can write files with no visible redirection — e.g.
// `python -c "open('x','w')"`, `node -e "fs.writeFileSync(...)"`. Anchored to the
// eval flag so running a script file (`python build.py`) is not flagged here.
const INTERPRETER_EVAL = /(^|[\s;&|])(python3?|node|nodejs|perl|ruby|php)\s+(-c|-e|-r|--eval|--exec)\b/;

export function isMutatingPreToolUse(toolName: unknown, toolInput: unknown): boolean {
  const ti = toolInput && typeof toolInput === 'object' ? (toolInput as Rec) : null;
  const name = String(toolName || (ti && (ti.tool_name || ti.toolName)) || '');
  if (isWriteLikeToolName(name)) return true;
  if (ti && ('content' in ti || 'new_string' in ti || 'old_string' in ti || 'edits' in ti)) return true;
  if (!isShellToolName(name)) return false;
  const command = commandFromToolInput(toolInput);
  // Output redirection (truncate `>` or append `>>`) is an unconditional write —
  // but fd-to-fd (`2>&1`) and discard (`2>/dev/null`) redirects are routine on
  // read-only orientation commands (`ls -la … 2>/dev/null`) and are not writes.
  if (/(?:^|[\s;&|\w])(?:>{1,2}|&>)\s*(?!&?\d(?:\b|$))(?!\/dev\/null(?:\b|$))/.test(command)) return true;
  // Command substitution can hide a mutating command from the top-level regex.
  if (/`|\$\(/.test(command)) return true;
  return MUTATING_SHELL_COMMAND.test(command) || MUTATING_FIND_COMMAND.test(command) || INTERPRETER_EVAL.test(command);
}

// Parse the deliberately tiny shell grammar emitted by wait-command.ts. Shell
// control characters are rejected outside quotes; `$`/backticks are rejected in
// double quotes because the shell would still expand them. Single-quoted values
// are inert and may contain any project-name character. This is intentionally not
// a general shell parser.
function cleanShellWords(command: string): string[] | null {
  if (!command || /[\r\n]/.test(command)) return null;
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: 'single' | 'double' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote === 'single') {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === 'double') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\') {
        i += 1;
        if (i >= command.length) return null;
        const escaped = command[i] as string;
        if (escaped !== '"' && escaped !== '\\') return null;
        word += escaped;
      } else {
        if (ch === '$' || ch === '`') return null;
        word += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
      continue;
    }
    if (ch === "'") {
      quote = 'single';
      started = true;
      continue;
    }
    if (ch === '"') {
      quote = 'double';
      started = true;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      if (i >= command.length) return null;
      word += command[i] as string;
      started = true;
      continue;
    }
    if (/[;&|`$<>(){}#*?\[\]~]/.test(ch)) return null;
    word += ch;
    started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

interface OnboardingRunnerInvocation {
  bootstrap: boolean;
  // The per-project "don't use / reconsider Traffic One" choice commands share
  // the wait runner and its allow-list (same script, leading mode flags — one,
  // or `--use --bootstrap-only` for the yes path's exit-fast first half).
  decline: boolean;
  reconsider: boolean;
}

function onboardingRunnerInvocation(toolName: unknown, toolInput: unknown): OnboardingRunnerInvocation | null {
  if (!isShellToolName(toolName)) return null;
  const words = cleanShellWords(commandFromToolInput(toolInput).trim());
  if (!words) return null;
  const envAssignments = new Map<string, string>();
  while (/^(?:HOME|XDG_STATE_HOME)=/.test(words[0] || '')) {
    const assignment = words.shift() as string;
    const equals = assignment.indexOf('=');
    const name = assignment.slice(0, equals);
    if (envAssignments.has(name)) return null;
    envAssignments.set(name, assignment.slice(equals + 1));
  }
  if (words[0] !== 'node' || words[1] !== onboardingWaitScriptPath()) return null;

  const args = words.slice(2);
  let bootstrap = args[0] === '--bootstrap-only';
  const decline = args[0] === '--decline';
  const reconsider = args[0] === '--reconsider';
  // `--use` records the yes-choice then behaves exactly like the plain waiter,
  // so it keeps the wait-only flags available (unlike the exit-fast modes).
  const use = args[0] === '--use';
  if (bootstrap || decline || reconsider || use) args.shift();
  // `--use --bootstrap-only` is the ask-first yes path's fast first half —
  // record the choice, print the setup link, exit. Grammar-wise it is a
  // bootstrap invocation (exit-fast, so the wait-only flags stay rejected).
  if (use && args[0] === '--bootstrap-only') {
    bootstrap = true;
    args.shift();
  }
  const cwd = args.shift() || '';
  if (!cwd || !path.isAbsolute(cwd)) return null;

  const seen = new Set<string>();
  let host = '';
  while (args.length > 0) {
    const arg = args.shift() as string;
    if (/^--host=(?:claude|codex|cursor|opencode|copilot|windsurf|kilo)$/.test(arg)) {
      if (seen.has('host')) return null;
      seen.add('host');
      host = arg.slice('--host='.length);
      continue;
    }
    // The ask-first yes commands carry the user's original request so the runner
    // can seed `originalPrompt` AFTER recording the yes (nothing is written
    // pre-decision). The value is an inert quoted word by construction; it is
    // only meaningful (and only accepted) on a `--use` invocation.
    if (arg.startsWith('--seed-prompt=')) {
      if (!use || seen.has('seed-prompt')) return null;
      seen.add('seed-prompt');
      continue;
    }
    if (arg === '--quiet-url') {
      if (bootstrap || decline || reconsider || seen.has(arg)) return null;
      seen.add(arg);
      continue;
    }
    if (arg === '--timeout-ms' || arg === '--interval-ms') {
      if (bootstrap || decline || reconsider || seen.has(arg)) return null;
      const value = args.shift() || '';
      if (!/^[1-9]\d*$/.test(value)) return null;
      seen.add(arg);
      continue;
    }
    return null;
  }
  if (envAssignments.size > 0) {
    if (host !== 'opencode') return null;
    const expected = resolveTrafficOneEnv(cwd, 'opencode');
    for (const [name, value] of envAssignments) {
      const expectedValue = name === 'HOME' ? (expected.HOME || '') : (expected.XDG_STATE_HOME || '');
      if (value !== expectedValue) return null;
    }
  }
  return { bootstrap, decline, reconsider };
}

// The blocking "wait for setup" command is allow-listed only when it invokes
// this installed plugin's exact shipped runner with the known argv grammar.
// A filename substring or an arbitrary Node script is never sufficient.
export function isOnboardingWaitCommand(toolName: unknown, toolInput: unknown): boolean {
  return onboardingRunnerInvocation(toolName, toolInput) !== null;
}

export function isOnboardingBootstrapCommand(toolName: unknown, toolInput: unknown): boolean {
  return onboardingRunnerInvocation(toolName, toolInput)?.bootstrap === true;
}

// The pre-spawn model-gate command (node …/model-gate.cjs <cwd>) the Cursor orchestrator runs
// after capturing models, before spawning. Same clean-node-invocation allow-list shape as the
// wait command — recognized so the beforeShellExecution model-gate handler can intercept it.
export function isModelGateCommand(toolName: unknown, toolInput: unknown): boolean {
  if (!isShellToolName(toolName)) return false;
  const command = commandFromToolInput(toolInput).trim();
  if (!command || command.includes('\n')) return false;
  if (/[;&|`$<>(){}]/.test(command)) return false;
  return /(^|\s)node(\s|$)/.test(command) && command.includes('model-gate.cjs');
}

export function isModelCaptureCommand(toolName: unknown, toolInput: unknown): boolean {
  if (!isModelGateCommand(toolName, toolInput)) return false;
  return /(?:^|\s)--capture-models(?:\s|$)/.test(commandFromToolInput(toolInput));
}

export function isReadOnlyOrientationToolUse(toolName: unknown, toolInput: unknown): boolean {
  const ti = toolInput && typeof toolInput === 'object' ? (toolInput as Rec) : null;
  const name = String(toolName || (ti && (ti.tool_name || ti.toolName)) || '');
  if (!name) return false;
  if (/^(Read|Glob|Grep|LS|NotebookRead)$/i.test(normalizedToolName(name))) return true;
  if (isShellToolName(name) && !isMutatingPreToolUse(name, toolInput)) return true;
  return false;
}
