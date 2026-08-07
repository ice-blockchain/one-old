// src/shared/tool-classify.ts
// Tool-name + command + state-file classification used by the onboarding/
// post-stack gates. Ported 1:1 from the helpers in
// scripts/hook-runtime/handlers/_helpers.cjs.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isSafeOneMcpModelId, ONE_MCP_MAX_AVAILABLE_MODELS } from '../config/one-mcp';
import { LEGACY_STATE_FILE, STATE_FILE } from '../config/paths';
import { BACKEND_IDS, FRONTEND_IDS, MOBILE_FRAMEWORK_IDS } from '../config/state';
import type { ToolClass, ToolInput } from '../core/types';
import {
  parseApplyPatch,
  patchOperationPaths,
  patchTextFromToolInput as canonicalPatchTextFromToolInput,
} from './apply-patch';
import { onboardingWaitScriptPath } from './onboarding-server/wait-command';
import { modelGateScriptPath } from './model-gate-command';
// The id shape accepted on `--run`/`--session` lives beside the command
// PRINTERS (doctor-command.ts) so what the runtime prints and what this grammar
// admits cannot drift apart; see its header for the charset reasoning.
import { gateExemptDoctorScriptPaths, isDoctorIdArgument } from './doctor-command';
import { legacyStatePath, statePath } from './state';
import { resolveTrafficOneEnv } from './state/traffic-one-paths';

type Rec = Record<string, unknown>;

// Strip a host/server qualifier and keep the bare tool name: Kilo/OpenCode send
// `<server>.<tool>`, Codex sends `apply_patch` bare, Copilot may send
// `mcp__x.Bash`. Consequence, by design and repo-wide: an MCP server can call
// its tool `Bash` and be classified as a shell tool here. That is deliberately
// NOT narrowed — every classifier in this file is used to decide whether to
// GATE something, so treating a suspiciously-named MCP tool as shell means
// scanning its arguments for mutations rather than waving them through, and the
// wrapper hosts genuinely need the last segment. Narrowing it would silently
// un-gate real wrapper tool calls to close a hole that only makes gates
// stricter. The doctor exemption below does not rest on this: a fabricated
// `mcp__x.Bash` still has to produce a `command` that byte-matches the running
// runtime's own doctor path (gateExemptDoctorScriptPaths), and exemption only
// ever yields "no opinion", never an elevated capability.
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

// Synthesize a {command,file_path,content,patchText} input from the adapter-parsed tool, for
// hosts (Cursor) that carry these on the parsed tool rather than in raw.tool_input.
// Returns null when there's nothing to contribute so callers can `|| {}` cleanly.
export function parsedToolInput(tool: ToolInput | undefined): Rec | null {
  if (!tool) return null;
  const ti: Rec = {};
  if (tool.command) ti.command = tool.command;
  if (tool.filePath) ti.file_path = tool.filePath;
  if (tool.content) ti.content = tool.content;
  if (tool.patchText) ti.patchText = tool.patchText;
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

export function patchTextFromToolInput(...sources: readonly unknown[]): string {
  return canonicalPatchTextFromToolInput(...sources);
}

function patchTouchedFiles(patchText: string): string[] {
  const parsed = parseApplyPatch(patchText);
  return parsed.ok ? patchOperationPaths(parsed.operations) : [];
}

export function isStateFileOnlyPatch(toolName: unknown, toolInput: unknown): boolean {
  if (!/^apply_patch$/i.test(normalizedToolName(toolName))) return false;
  const files = patchTouchedFiles(patchTextFromToolInput(toolInput));
  return files.length > 0 && files.every((f) => isStateFilePath(f));
}

/**
 * The same question asked by a caller that is about to EXEMPT the call rather
 * than police it: does this patch do nothing but ADD or UPDATE state files?
 *
 * Separate from isStateFileOnlyPatch rather than a narrowing of it, because that
 * predicate has two callers with OPPOSITE intent (measured from a TypeScript
 * AST, not a grep: 2 non-test call sites). onboarding-gate/handler.ts exempts on
 * it; onboarding/team-mode-approval.ts uses it to SELECT the writes its two
 * team-mode guards inspect. Narrowing it in place would therefore stop the
 * downgrade guard looking at a `*** Move to:` patch whose hunks add
 * `"mode": "main-agent"` — closing a hole at one site by opening one at the
 * other.
 *
 * `delete` and `move` are the shapes excluded, and they are excluded because
 * the exemption's own comment is "the model is allowed to write the canonical
 * state file itself". Deleting it is not writing it: measured on an
 * onboarding-incomplete project, a `*** Delete File: .traffic-one/.one.json`
 * patch came back `noop` from the gate while the identical project denied an
 * ordinary `src/app.ts` write — so the one file the gate exists to protect was
 * the one file an agent could remove. `move` is excluded for the same reason
 * (it is a delete at the source) and because its destination is what makes a
 * two-project patch pass `every` above. Nothing legitimate is lost: an agent
 * repairing a torn state file overwrites it (Write truncates, `*** Update
 * File:` rewrites), and both stay exempt.
 */
export function isStateFileOnlyWritePatch(toolName: unknown, toolInput: unknown): boolean {
  if (!/^apply_patch$/i.test(normalizedToolName(toolName))) return false;
  const parsed = parseApplyPatch(patchTextFromToolInput(toolInput));
  if (!parsed.ok || parsed.operations.length === 0) return false;
  return parsed.operations.every((operation) => (
    (operation.kind === 'add' || operation.kind === 'update') && isStateFilePath(operation.path)
  ));
}

// Mutating-command vocabulary for shell tool calls. Anchored to a line start, a
// shell separator (;, &, |), or a nesting opener (backtick, `(`) so it reads as a
// command, not a substring. Biased toward flagging: a denied read-only command
// during the brief onboarding-incomplete window is harmless, a MISSED write is
// the bypass this guards against. Covers file ops, dependency/package installs,
// build-installs, and working-tree-mutating git subcommands.
//
// The nesting openers are load-bearing, not decoration. While every caller ran
// the blanket `/`|\$\(/` short-circuit below, a writer nested in `$(…)` or
// backticks was caught before these regexes were ever consulted, so their
// anchors were never exercised on that shape. `ignoreCommandSubstitution` turns
// that short-circuit off — and without `(` and a backtick here, `echo "$(rm -f
// x)"` classified as NON-mutating, which is the one direction this file must
// never fail in. `(` also closes a pre-existing miss no caller ever covered:
// the plain subshell `(rm -rf x)`, which carries no substitution at all.
const MUTATING_SHELL_COMMAND = /(^|[\s;&|`(])(mkdir|rmdir|touch|rm|mv|cp|ln|dd|tee|truncate|chmod|chown|chgrp|xargs|npm\s+(install|i|add|create)|pnpm\s+(install|add|create)|yarn\s+(install|add|create)|bun\s+(install|add|create)|npx|pip3?\s+install|cargo\s+(install|add)|go\s+install|gem\s+install|composer\s+(require|install)|make\s+install|git\s+(init|add|commit|rm|mv|checkout|restore|reset|clean|stash|apply|push|merge|rebase)|(sed|perl)\s+-i)\b/;
const MUTATING_FIND_COMMAND = /(^|[\s;&|`(])find\b[^\n;&|]*(?:\s-(?:delete|exec|execdir)\b)/;
// Inline interpreter eval can write files with no visible redirection — e.g.
// `python -c "open('x','w')"`, `node -e "fs.writeFileSync(...)"`. Anchored to the
// eval flag so running a script file (`python build.py`) is not flagged here.
const INTERPRETER_EVAL = /(^|[\s;&|`(])(python3?|node|nodejs|perl|ruby|php)\s+(-c|-e|-r|--eval|--exec)\b/;

export interface MutationClassifyOptions {
  /**
   * Ignore the command-substitution heuristic.
   *
   * `$(…)`/backticks mean "a mutation could be HIDDEN in here", which is the
   * right fail-closed answer for a write gate. It is the wrong answer for
   * choosing the active PROJECT ROOT: substitution says nothing about WHICH
   * path is written, so a read-only command that merely names a foreign path
   * and happens to contain a subshell was adopting that project. Observed
   * live: an inspection session repeatedly had unrelated projects adopted off
   * `RUN=$(ls …)`-shaped reads, and once `/dev` itself off a `/dev/null`
   * operand — each time answered with a full onboarding demand for a project
   * nobody was touching.
   *
   * Safe to narrow HERE only: root selection is not enforcement. Real evidence
   * toward a specific path (`sed -i /abs`, a redirect into it, a write operand,
   * an external workdir, interpreter eval) still re-anchors through the checks
   * below, and `standsDown` still sees every target, so an actual write into a
   * foreign project keeps its full enforcement path.
   */
  ignoreCommandSubstitution?: boolean;
}

export function isMutatingPreToolUse(
  toolName: unknown,
  toolInput: unknown,
  options: MutationClassifyOptions = {},
): boolean {
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
  if (!options.ignoreCommandSubstitution && /`|\$\(/.test(command)) return true;
  return MUTATING_SHELL_COMMAND.test(command) || MUTATING_FIND_COMMAND.test(command) || INTERPRETER_EVAL.test(command);
}

interface ShellWordOptions {
  /**
   * Expand a leading, unquoted `~` (alone or before `/`) to this directory.
   *
   * Off by default: `~` is otherwise in the forbidden set below, because for
   * every OTHER grammar here the expected argv is an absolute path this plugin
   * generated itself, so a tilde can only be a mis-spelling or an attempt to
   * make one path look like another. The doctor grammar opts in because shipped
   * prose hands agents the `~/.traffic-one/bin/doctor.cjs` shim form (see
   * doctor-command.ts) and a gate that rejects the string its own docs print is
   * the bug this exemption exists to fix. Only `~`/`~/…` is expanded — never
   * `~user` (bash's other tilde form), which stays rejected.
   */
  readonly tildeHome?: string;
}

// Parse the deliberately tiny shell grammar emitted by wait-command.ts. Shell
// control characters are rejected outside quotes; `$`/backticks are rejected in
// double quotes because the shell would still expand them. Single-quoted values
// are inert and may contain any project-name character. This is intentionally not
// a general shell parser.
//
// Word splitting is `[ \t]` — POSIX IFS minus the newline the guard below
// already rejects outright — deliberately NOT JS `\s`. `\s` also matches VT,
// FF, NBSP, U+2028 and U+3000, none of which bash/zsh/sh treat as separators:
// they stay part of the word, so `node\u00a0/…/doctor.cjs` is one word naming
// no binary (127) rather than two. A parser that split there would tokenize an
// argv the executor never produces, which is the one way a grammar this file
// uses for allow-listing can disagree with what actually runs.
function cleanShellWords(command: string, options: ShellWordOptions = {}): string[] | null {
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
    if (ch === ' ' || ch === '\t') {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
      continue;
    }
    // Word-initial only, exactly like the shell: `a~/b` is literal there too.
    if (ch === '~' && !started && options.tildeHome) {
      const next = command[i + 1];
      if (next === undefined || next === '/' || next === ' ' || next === '\t') {
        word += options.tildeHome;
        started = true;
        continue;
      }
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

// Resolve two path spellings to one comparable form. realpath collapses
// symlinks and `..`, which matters on macOS where the same directory is
// reachable as both /tmp/x and /private/tmp/x; a nonexistent path degrades to
// path.resolve so a comparison against a missing file is still deterministic
// (and simply never equals an existing one).
function comparablePath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

interface OnboardingRunnerInvocation {
  bootstrap: boolean;
  // The per-project "don't use / reconsider Traffic One" choice commands share
  // the wait runner and its allow-list (same script, leading mode flags — one,
  // or `--use --bootstrap-only` for the yes path's exit-fast first half).
  decline: boolean;
  reconsider: boolean;
  // The agent's manual tech classification for an undetectable existing repo
  // (`--set-tech` + surface flags). Exit-fast like bootstrap/decline.
  setTech: boolean;
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
  const setTech = args[0] === '--set-tech';
  // `--use` records the yes-choice then behaves exactly like the plain waiter,
  // so it keeps the wait-only flags available (unlike the exit-fast modes).
  const use = args[0] === '--use';
  if (bootstrap || decline || reconsider || setTech || use) args.shift();
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
    // Generated wizard commands may carry the parent hook session so the
    // public model sync is shared with SessionStart. The generator normalizes
    // this to the once-marker alphabet and a 96-byte ceiling; enforce that
    // exact bounded shape here so arbitrary command fragments never pass.
    if (/^--sync-session=[A-Za-z0-9._-]{1,96}$/.test(arg)) {
      if (decline || seen.has('sync-session')) return null;
      seen.add('sync-session');
      continue;
    }
    // The agent-classification surface flags: valid only on `--set-tech`, once
    // each, membership-checked against the SAME canonical id vocabularies the
    // state writer enforces — an id outside the sets never reaches the runner.
    if (arg.startsWith('--frontend=')) {
      if (!setTech || seen.has('frontend') || !FRONTEND_IDS.has(arg.slice('--frontend='.length))) return null;
      seen.add('frontend');
      continue;
    }
    if (arg.startsWith('--backend=')) {
      if (!setTech || seen.has('backend') || !BACKEND_IDS.has(arg.slice('--backend='.length))) return null;
      seen.add('backend');
      continue;
    }
    if (arg.startsWith('--mobile=')) {
      if (!setTech || seen.has('mobile') || !MOBILE_FRAMEWORK_IDS.has(arg.slice('--mobile='.length))) return null;
      seen.add('mobile');
      continue;
    }
    if (arg.startsWith('--realtime=')) {
      if (!setTech || seen.has('realtime') || !/^--realtime=(?:none|light)$/.test(arg)) return null;
      seen.add('realtime');
      continue;
    }
    // Short free-text proof; an inert quoted word by construction (like
    // --seed-prompt), bounded so a command cannot smuggle a document.
    if (arg.startsWith('--evidence=')) {
      if (!setTech || seen.has('evidence') || arg.length > '--evidence='.length + 400) return null;
      seen.add('evidence');
      continue;
    }
    if (arg === '--quiet-url') {
      if (bootstrap || decline || reconsider || setTech || seen.has(arg)) return null;
      seen.add(arg);
      continue;
    }
    if (arg === '--timeout-ms' || arg === '--interval-ms') {
      if (bootstrap || decline || reconsider || setTech || seen.has(arg)) return null;
      const value = args.shift() || '';
      if (!/^[1-9]\d*$/.test(value)) return null;
      seen.add(arg);
      continue;
    }
    return null;
  }
  // A classification must state BOTH primary surfaces consciously (explicit
  // `none` allowed); mobile/realtime/evidence are optional refinements.
  if (setTech && (!seen.has('frontend') || !seen.has('backend'))) return null;
  if (envAssignments.size > 0) {
    if (host !== 'opencode') return null;
    const expected = resolveTrafficOneEnv(cwd, 'opencode');
    for (const [name, value] of envAssignments) {
      const expectedValue = name === 'HOME' ? (expected.HOME || '') : (expected.XDG_STATE_HOME || '');
      if (value !== expectedValue) return null;
    }
  }
  return { bootstrap, decline, reconsider, setTech };
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

// The agent's manual tech classification command for an undetectable existing
// repo (`--set-tech --frontend=… --backend=…`). Same exact-argv allow-listing.
export function isOnboardingSetTechCommand(toolName: unknown, toolInput: unknown): boolean {
  return onboardingRunnerInvocation(toolName, toolInput)?.setTech === true;
}

// The trust anchor for `words[1]`. Byte-equality against a path derived from
// the RUNNING runtime (or from HOME) — never from a *_PLUGIN_ROOT env var; see
// gateExemptDoctorScriptPaths() in doctor-command.ts for why. Compared through
// realpath so the same file named two legitimate ways (a symlinked HOME, a
// /tmp vs /private/tmp state dir) is one identity, while a DIFFERENT file that
// merely ends in doctor.cjs is never admitted.
function isGateExemptDoctorScript(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const wanted = comparablePath(candidate);
  return gateExemptDoctorScriptPaths().some((allowed) => comparablePath(allowed) === wanted);
}

type DoctorCommandKind = 'plain' | 'run' | 'bundle' | 'session';

interface DoctorCommandInvocation {
  readonly kind: DoctorCommandKind;
  /** Present on kind === 'run', and on 'bundle' when `--run <id>` pinned it. */
  readonly runId?: string;
  /** Present only when kind === 'session'. */
  readonly session?: string;
}

// The doctor grammar itself — the single place every accepted `node
// <doctorScriptPath> …` argv is enumerated. Every caller (the onboarding gate,
// the fail-closed exemption) goes through isTrafficOneDoctorCommand below,
// which only asks "does SOME accepted form match"; this function is what
// actually enumerates them, so widening what doctor accepts means editing
// exactly this list, once.
//
// `words` is already the output of cleanShellWords (tool-classify.ts's own
// tiny shell-word parser), so by the time this runs: `;`, `&`, `|`, backticks,
// `$`, redirection, globs, and unterminated quotes have ALL already made
// `words` null upstream (cleanShellWords returns null on any of them) — this
// function never has to special-case chaining/substitution/redirection itself,
// it only has to compare a flat, already-detokenized argv against an exact
// shape. Case-sensitive throughout (`--Run`, `--BUNDLE`, `Node` all miss):
// the shipped runner and its flags are lower-case, and loosening case here
// would just admit more strings for the same one binary.
function doctorCommandInvocation(toolName: unknown, toolInput: unknown): DoctorCommandInvocation | null {
  if (!isShellToolName(toolName)) return null;
  const words = cleanShellWords(commandFromToolInput(toolInput).trim(), {
    tildeHome: process.env.HOME || os.homedir(),
  });
  if (!words || words.length < 2) return null;
  // No `npx`/interpreter-flag/wrapper prefix is ever accepted: the first word
  // must be the literal `node`, and the second must resolve to one of the two
  // doctor.cjs paths derived from the running runtime and HOME
  // (gateExemptDoctorScriptPaths) — never a substring match, never a different
  // absolute path that merely ENDS in doctor.cjs, never a path handed in
  // through a *_PLUGIN_ROOT env var. A caller who wants "run doctor with node"
  // has exactly those two spellings, both of which shipped prose prints; a
  // caller who names any other script or interpreter is never this
  // exemption's business.
  if (words[0] !== 'node' || !isGateExemptDoctorScript(words[1] as string)) return null;
  const args = words.slice(2);
  if (args.length === 0) return { kind: 'plain' };
  if (args.length === 1 && args[0] === '--bundle') return { kind: 'bundle' };
  if ((args.length === 2 || (args.length === 3 && args[2] === '--bundle')) && args[0] === '--run') {
    // `--run <id>` and `--run <id> --bundle` (that order only): the runner
    // reads the two flags independently (runners/doctor/lib.ts), the
    // combination is what the operator report prints for a bug report, and it
    // is as read-only as either flag alone.
    const runId = args[1] as string;
    if (!isDoctorIdArgument(runId)) return null;
    return args.length === 3 ? { kind: 'bundle', runId } : { kind: 'run', runId };
  }
  // `--session <id>` is doctor's third shipped flag (runners/doctor/lib.ts) and
  // is read-only in the same way: it selects a Codex transcript to ANALYZE.
  if (args.length === 2 && args[0] === '--session') {
    const session = args[1] as string;
    return isDoctorIdArgument(session) ? { kind: 'session', session } : null;
  }
  // Everything else — extra trailing words after a recognized flag, an
  // unrecognized flag, a flag value that fails DOCTOR_ID_PATTERN, combined or
  // duplicate/reordered flags — is rejected. Biased toward DENY: an
  // undocumented doctor invocation staying gated is a minor recovery
  // inconvenience; a loosened match here is a gate-bypass hole.
  //
  // `--unblock <gateId>` (runners/doctor/unblock.ts) is now a SHIPPED flag and
  // is still absent from this grammar. That omission is PERMANENT, and it is
  // the only one of doctor's flags that is deliberate rather than incidental:
  // every form above is read-only, while `--unblock` mints an operator
  // override that switches a gate off for a run. The exemption's contract —
  // stated three lines below and relied on by hooks/fail-closed.ts — is
  // "this gate has no opinion, because doctor writes nothing anywhere". An
  // override-minting invocation breaks that sentence, and an agent that can
  // mint its own override does not have an escape hatch, it has a bypass:
  // it would deny a gate, emit the command the deny printed, and proceed.
  // The mint additionally refuses a non-interactive stdin, so admitting it
  // here would buy nothing but the hole. The audience for `--unblock` is a
  // human at their own terminal, where no hook fires at all.
  return null;
}

// The bundled read-only doctor is the product's own answer to "the run is
// wedged" — including when the thing that wedged it is a gate. Admit only that
// exact installed runner with no arbitrary argv, so the recovery command cannot
// be trapped by the same gate it diagnoses. Accepts exactly four documented
// forms — the bare command, `--run <id>`, `--session <id>` and `--bundle` — in
// either of two shipped path spellings, via doctorCommandInvocation's bounded

// exact-argv grammar (`--run <id> --bundle` is the one accepted combination).
// Exemption means "this gate has no opinion" (noop), never an elevated
// capability: doctor writes nothing anywhere.
export function isTrafficOneDoctorCommand(toolName: unknown, toolInput: unknown): boolean {
  return doctorCommandInvocation(toolName, toolInput) !== null;
}

interface ModelGateInvocation {
  readonly kind: 'gate' | 'capture';
}

// The model gate is itself a recovery/enforcement command, so recognizing a
// filename substring is unsafe: it can exempt a different script or project
// from an earlier deny. Accept only the exact installed runner and exact argv
// grammar for the active Cursor project.
function modelGateInvocation(
  toolName: unknown,
  toolInput: unknown,
  expectedProjectRoot: string,
): ModelGateInvocation | null {
  if (!isShellToolName(toolName) || !path.isAbsolute(expectedProjectRoot)) return null;
  const words = cleanShellWords(commandFromToolInput(toolInput).trim());
  if (!words || words.length < 4) return null;
  const [runtime, script, projectRoot, host, ...args] = words;
  if (runtime !== 'node'
    || script !== modelGateScriptPath()
    || !projectRoot
    || !path.isAbsolute(projectRoot)
    || comparablePath(projectRoot) !== comparablePath(expectedProjectRoot)
    || host !== '--host=cursor') return null;
  if (args.length === 0) return { kind: 'gate' };
  if (args[0] !== '--capture-models') return null;
  const models = args.slice(1);
  if (models.length === 0
    || models.length > ONE_MCP_MAX_AVAILABLE_MODELS
    || new Set(models).size !== models.length
    || models.some((model) => model.startsWith('--') || !isSafeOneMcpModelId(model, 'cursor'))) return null;
  return { kind: 'capture' };
}

export function isModelGateCommand(
  toolName: unknown,
  toolInput: unknown,
  expectedProjectRoot: string,
): boolean {
  return modelGateInvocation(toolName, toolInput, expectedProjectRoot) !== null;
}

export function isModelCaptureCommand(
  toolName: unknown,
  toolInput: unknown,
  expectedProjectRoot: string,
): boolean {
  return modelGateInvocation(toolName, toolInput, expectedProjectRoot)?.kind === 'capture';
}

// A shell command that pops a URL in the user's browser. Traffic One never opens
// the setup link itself — the agent posts it and the user clicks it — but `open`,
// `xdg-open` and `start` are not in MUTATING_SHELL_COMMAND, so without this they
// classify as read-only orientation and sail through the onboarding gate. That is
// exactly how a run auto-opened the wizard and then told the user the link had
// "already been shared" when no link was ever posted (observed 5cu).
const BROWSER_OPEN_COMMAND = /(^|[\s;&|])(open|xdg-open|cmd(\.exe)?\s+\/c\s+start|start)\s+(-[^\s]+\s+)*['"]?https?:\/\//i;

export function isBrowserOpenCommand(toolName: unknown, toolInput: unknown): boolean {
  if (!isShellToolName(String(toolName || ''))) return false;
  return BROWSER_OPEN_COMMAND.test(commandFromToolInput(toolInput));
}

export function isReadOnlyOrientationToolUse(toolName: unknown, toolInput: unknown): boolean {
  const ti = toolInput && typeof toolInput === 'object' ? (toolInput as Rec) : null;
  const name = String(toolName || (ti && (ti.tool_name || ti.toolName)) || '');
  if (!name) return false;
  if (/^(Read|Glob|Grep|LS|NotebookRead)$/i.test(normalizedToolName(name))) return true;
  if (isShellToolName(name) && !isMutatingPreToolUse(name, toolInput)) return true;
  return false;
}
