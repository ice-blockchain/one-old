// src/shared/tool-classify.ts
// Tool-name + command + state-file classification used by the onboarding/
// post-stack gates. Ported 1:1 from the helpers in
// scripts/hook-runtime/handlers/_helpers.cjs.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isSafeOneMcpModelId, ONE_MCP_MAX_AVAILABLE_MODELS } from '../config/one-mcp';
import { canonicalizeStateDirSegments, LEGACY_STATE_FILE, STATE_FILE } from '../config/paths';
import { BACKEND_IDS, FRONTEND_IDS, MOBILE_FRAMEWORK_IDS } from '../config/state';
import type { ToolClass, ToolInput } from '../core/types';
import {
  parseApplyPatch,
  patchOperationPaths,
  patchTextFromToolInput as canonicalPatchTextFromToolInput,
} from './apply-patch';
import { openRegularFd } from './bounded-read';
import { onboardingWaitScriptPath } from './onboarding-server/wait-command';
import { modelGateScriptPath } from './model-gate-command';
// The id shape accepted on `--run`/`--session` lives beside the command
// PRINTERS (doctor-command.ts) so what the runtime prints and what this grammar
// admits cannot drift apart; see its header for the charset reasoning.
import { gateExemptDoctorScriptPaths, isDoctorIdArgument } from './doctor-command';
import { gateExemptResetScriptPaths } from './reset-command';
import { gateExemptWorkspaceScriptPaths } from './workspace-command';
import { gateExemptSecurityCheckScriptPaths, securityCheckRunnerRel } from './security-check-command';
// The shim GENERATOR, imported for the exemption's identity check (see
// isGeneratedShim): the bytes a candidate must equal are derived, never
// described. One-directional and cycle-free — runner-shims.ts imports only
// node-floor and toolchain-paths, and this module already reaches it through
// reset-command's documentedBinDir().
import { shimSource } from './runner-shims';
// A member SELECTOR is judged by the two authorities that already own the two
// spellings it may take, plus one character class. See isMemberSelectorArgument
// for what the two authorities measurably fail to exclude on their own.
import { memberPathVerdict } from './hook/workspace-members';
import { isSafeRunId } from './qa-report/schema';
import { legacyStatePath, statePath } from './state';
import { resolveTrafficOneEnv } from './state/traffic-one-paths';
import {
  COMMAND_START,
  COMMAND_WORD_PREFIX,
  DESTRUCTIVE_VERB,
  EVAL_FLAG,
  findWriteAction,
  HEREDOC_INTERPRETER_RE,
  IN_PLACE_EDITORS,
  IN_PLACE_EDITOR_RE,
  OVERWRITE_TOOL,
  SHELL_NAME,
  shellStatementHead,
  shellWordsOf,
  VERB_ANCHOR,
} from './shell-vocabulary';

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

/**
 * Shell-ness for a GATE EXEMPTION, which is the opposite question to the one
 * above and therefore wants the opposite bias.
 *
 * `isShellToolName` reads the last dot-segment on purpose: for a gate, calling
 * a suspiciously-named MCP tool "shell" means scanning its arguments instead of
 * waving them through, so the loose reading is the strict answer. Run the same
 * predicate backwards — to decide whether to STOP judging — and the looseness
 * inverts with it. Measured: `mcp__evil.Bash` with a top-level `command` field
 * cleared the fail-closed recovery boundary on the Cursor MCP surface, and for
 * a real MCP tool that field is not what executes, so every OTHER argument in
 * the call rode along unjudged. The byte-match that protects the sibling row
 * does not reach this: the string being matched is not the string the server
 * runs.
 *
 * So an exemption requires the name to be UNQUALIFIED. Measured before
 * narrowing, across every adapter fixture and the replay corpus: the only
 * qualified shell-classified name anywhere in the tree is `mcp.Bash` in this
 * module's own test, asserting the broad reading above. Every real host sends
 * the bare name — Claude/Codex `Bash`/`exec_command`, Copilot `bash`, Kilo and
 * OpenCode `bash` — and Cursor's shell arrives on the `before-shell-execution`
 * subcommand, which carries no tool name at all. Nothing legitimate qualifies
 * one, so nothing legitimate breaks.
 *
 * Case-insensitive, like its sibling: Copilot's lower-case `bash` is a real
 * host spelling, and case is not what an attacker needs here.
 */
export function isExemptShellToolName(toolName: unknown = ''): boolean {
  const raw = String(toolName || '');
  return !raw.includes('.') && /^(Bash|exec_command)$/i.test(raw);
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
  return /^(Write|Edit|MultiEdit|apply_patch|NotebookEdit|create|str_replace_editor)$/i.test(
    normalizedToolName(toolName),
  );
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
  const folded = canonicalizeStateDirSegments(normalized);
  const stateFile = STATE_FILE.split(path.sep).join('/');
  return folded === stateFile
    || folded.endsWith(`/${stateFile}`)
    || folded === LEGACY_STATE_FILE
    || folded.endsWith(`/${LEGACY_STATE_FILE}`);
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

/**
 * How deep a `--project=` selector may reach. A member path is a directory
 * inside the container, and the registry's own reader accepts any depth; the
 * bound exists because this is a bounded exact-argv grammar and every other
 * value in it carries one. Four is the depth at which a monorepo has stopped
 * being one (`apps/web`, `services/go/api`, `packages/ui/core`).
 */
const MEMBER_SELECTOR_MAX_SEGMENTS = 4;

/**
 * A value `--project=` may carry: a member's minted ID, or the relative PATH of
 * the member it names.
 *
 * Both spellings are admitted because both are things a person legitimately
 * has in hand. The id is what the registry records and what a run record joins
 * on (`web-3f2a1c` for the second `web` in a workspace); the path is what the
 * person typed when they nominated the directory (`apps/web`) and the only
 * spelling available before the member is registered at all — which is the
 * case this flag exists to serve. Resolution between the two is the runner's
 * job (memberBySelector, id first); this only decides what argv is ADMITTED.
 *
 * THREE authorities, and the third is a character class typed right here —
 * which an earlier draft of this comment claimed was unnecessary. It was wrong,
 * and the measurement is the reason it changed: `isSafeRunId` is a
 * FILESYSTEM-SAFETY predicate (no slash, no backslash, not `.` or `..`, no
 * control characters, ≤128) and `memberPathVerdict` is a PATH-SHAPE predicate
 * (relative, normalized, not a glob, not a vendor directory). Executed together
 * over a 46-row table they admitted 22 rows, and the admitted set included
 * `-api`, `--api`, `~`, `$HOME`, backticks, `a;b`, `a|b`, `a&b`, `a>b`, a
 * literal space, and `\u202e` — the right-to-left override. Two of those matter
 * here even though none of them can reach a shell (this value becomes a path
 * component and a JSON string, never argv): a selector starting with `-` is a
 * NEAR-COLLISION with a flag, the exact spelling class this grammar refuses
 * deliberately everywhere else, and a bidi override lands in the registry and
 * is then echoed back inside a refusal message, where reordering the visible
 * text is the whole attack.
 *
 * So each segment must also be `[A-Za-z0-9_][A-Za-z0-9._-]*`. The other two
 * authorities stay, and stay FIRST in the source order, because they are the
 * ones that tighten on their own when the registry's rules tighten; this class
 * only removes spellings, never adds one.
 *
 * The escape hatch for a directory this class refuses — a unicode name, a
 * leading dot — is not an escape hatch at all, it is the ordinary path: run
 * setup INSIDE that member. `--project=` is a convenience for naming a member
 * from its container, not the only way to reach one.
 *
 * Nothing here relies on `cleanShellWords` having been strict: `*`, `?`, `[`,
 * `~`, `$` and the rest are rejected upstream OUTSIDE quotes, but single quotes
 * make them inert and they arrive as ordinary characters — so `--project='*'`
 * reaches this predicate as the literal `*` and is refused on the merits.
 */
const MEMBER_SELECTOR_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function isMemberSelectorArgument(value: string): boolean {
  const segments = value.split('/');
  return segments.length <= MEMBER_SELECTOR_MAX_SEGMENTS
    && segments.every((segment) => isSafeRunId(segment) && MEMBER_SELECTOR_SEGMENT_RE.test(segment))
    && memberPathVerdict(value).ok;
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
  // `--set-tech --force`: the submission CORRECTS a stack already on record
  // instead of only filling an empty one. Without it a probe's guess is
  // permanent, because every writer refuses to overwrite a committed stack.
  force: boolean;
  // `--set-tech --project=<memberId>`: the classification is about ONE MEMBER
  // of the workspace at the positional cwd, not about the cwd itself. Empty
  // when absent, which is the single-project shorthand and stays the default —
  // every existing `--set-tech` command means exactly what it always meant.
  project: string;
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
  let force = false;
  let project = '';
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
    // WHICH project this classification is about, inside a workspace. Valid
    // only on `--set-tech`, once, and bounded by the two member authorities
    // (isMemberSelectorArgument). It selects a target; it never widens what a
    // submission may SAY, which stays the surface flags below.
    if (arg.startsWith('--project=')) {
      const selector = arg.slice('--project='.length);
      if (!setTech || seen.has('project') || !isMemberSelectorArgument(selector)) return null;
      seen.add('project');
      project = selector;
      continue;
    }
    // Correcting a stack already on record. Valid only on `--set-tech`, and
    // still membership-checked through the same surface flags — `--force`
    // widens WHEN a submission applies, never WHAT it may say.
    if (arg === '--force') {
      if (!setTech || seen.has(arg)) return null;
      seen.add(arg);
      force = true;
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
  return { bootstrap, decline, reconsider, setTech, force, project };
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

// The member a `--set-tech` submission is ABOUT, or '' for the un-prefixed
// single-project shorthand. Exported so a caller reads the selector the grammar
// admitted rather than re-scanning the command text for it.
export function onboardingSetTechMemberSelector(toolName: unknown, toolInput: unknown): string {
  const invocation = onboardingRunnerInvocation(toolName, toolInput);
  return invocation?.setTech ? invocation.project : '';
}

// ── IS THE FILE AT THIS ANCHOR OUR GENERATED SHIM FOR `rel`? ────────────────
//
// BYTE-EQUALITY AGAINST THE GENERATOR — `runner-shims.ts`'s `shimSource(rel)`,
// the same function `ensureRunnerShims()` writes the shims from. That makes this
// an identity check rather than a description of one: a file equal to the
// generator's output IS the shim (it forwards to the real runner and carries no
// payload), and a forgery indistinguishable from the genuine article is the
// genuine article. Its trust root is the plugin tree — not a directory an agent
// can write — which is the same root the self-relative anchor already rests on:
// forge that and the process is already running forged code.
//
// This replaced a SHAPE test that was documented as identity and was not one.
// The shape was two public constants — the `GENERATED BY traffic-one` marker
// line (quoted verbatim in this repo's own AGENTS.md) and `const REL =
// "<rel>";` — so it refused an unmarked planted file and an adversary who had
// not read the source, and nothing more. The hole it exists to close is an agent
// planting a stub at the anchor path, and such an agent can write two known
// lines above its payload for free.
//
// The reference is DERIVED, never snapshotted: `shimSource` is pure string
// construction over `rel` and NODE_FLOOR_MAJOR, evaluated on every call, so a
// version bump that changes the emitted bytes moves the writer and this
// comparison in the same commit and a shim written by the running plugin still
// matches. A shim left behind by a DIFFERENT plugin version whose template
// differed is refused — and that is not a wedge: `ensureRunnerShims()` runs from
// SessionStart in the same process that answers this question, so the bytes on
// disk are the bytes this function derives unless that write failed, and the
// self-relative in-plugin runner stays exempt either way.
//
// Deriving the reference cannot fail on an unreadable plugin tree: it reads no
// file. If the module holding it could not be loaded, this module could not have
// been either and no classification happens at all. The `catch` below is there
// for completeness of the contract, and it refuses — an expected-bytes value we
// could not compute must never become a reason to admit a file.
//
// WHY NOT THE ALTERNATIVES, having looked:
//
//  - BYTE-EQUALITY AGAINST A SIBLING SHIM. Every shim in a directory comes from
//    the same generator in one pass and differs from its siblings in one line,
//    so a sibling looks like a reference copy. Implemented and REJECTED, and it
//    stays rejected: the reference sits in the same attacker-writable directory
//    as the candidate, so the adversary writes its payload twice (once per
//    `rel`) and passes. It converts "add two lines" into "write two files",
//    buys an availability risk on a machine whose shim directory is incomplete,
//    and makes the reset exemption depend on doctor.cjs's bytes.
//  - DROPPING CONTENT ENTIRELY, by exempting only the in-plugin self-relative
//    runner. Rejected on the merits: the `~/.traffic-one/bin` spelling is the
//    one ~60 places of shipped prose print and the one whose path survives a
//    plugin bump (which is why host command approvals are stored against it).
//    Refusing it would gate the command the gate's own deny prose prescribes —
//    the round-3 failure this exemption was rebuilt to avoid.
//
// A symlink at the anchor is judged by the bytes it resolves to, like any other
// path: a link to an attacker's file is refused because that file is not the
// generator's output, and a link to a genuine copy is admitted because it is.
//
// The absence clause below is untouched and stays untouched: a pre-consent
// machine has no shim at the anchor, and admitting a command that cannot
// execute anything is what keeps "you must run this" from composing with "this
// is denied until a consented run writes a file".
function isGeneratedShim(candidate: string, rel: string): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(shimSource(rel), 'utf8');
  } catch {
    return false;
  }
  let fd: number;
  try {
    // BOUNDED, because this runs on PreToolUse for EVERY Bash command. The bare
    // `openSync(candidate, 'r')` this replaces blocked before the `fstat` two
    // lines down could classify anything: a FIFO at the anchor SIGKILLed the
    // classifier at 8 008 ms against a 291 ms control (DRIVEN by the round-3
    // peer). The anchor is `$HOME/.traffic-one/bin/…`, so this is machine-owned
    // rather than project-controlled — which lowers the arrival probability and
    // changes nothing about the outcome, since the hook simply never returns.
    fd = openRegularFd(candidate);
  } catch (error) {
    // ABSENT IS ADMITTED, and this distinction is load-bearing rather than
    // pedantic. There is nothing at this path to forge, and admitting it lets
    // through a command that cannot do anything: node exits with a module-not-
    // found error. Denying it instead broke the case this exemption exists for
    // — MEASURED on the replay corpus, where two pre-consent control cases went
    // from allowed to denied. A user who has not yet answered the consent
    // question has no shims written, and the deny prose of the very gate
    // stopping them prescribes this command. "You must run doctor" plus "doctor
    // is denied until something writes a file only a consented run writes" is
    // the wedge, rebuilt inside the recovery.
    //
    // Anything OTHER than absence is refused: a file that exists but cannot be
    // read is not one we can vouch for, and node could still execute it. That
    // now includes the shapes the bounded open declines — a FIFO or a device at
    // the anchor is something rather than nothing, and it is refused.
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
  try {
    // Size first, from the FD rather than the path, so a candidate larger than
    // the shim is refused without reading it and the bytes compared are the
    // bytes of the file that was opened.
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size !== expected.length) return false;
    const actual = Buffer.alloc(expected.length);
    let read = 0;
    while (read < expected.length) {
      const chunk = fs.readSync(fd, actual, read, expected.length - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
    return read === expected.length && actual.equals(expected);
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The trust anchor for `words[1]`, and it is two questions, not one.
 *
 * PATH: byte-equality against the narrowed anchor set (doctor-command.ts's
 * gateExemptShimDirs — see its header for the three environment variables that
 * used to move this set and what was measured before dropping the relocatable
 * anchor). Compared through realpath so the same file named two legitimate ways
 * (a symlinked HOME, a /tmp vs /private/tmp state dir) is one identity, while a
 * DIFFERENT file that merely ends in the same basename is never admitted.
 *
 * IDENTITY: and then whether the file sitting there IS one of our generated
 * shims for this runner — byte-equality against `shimSource(rel)`, the
 * generator that writes them. The path half alone admitted anything an agent
 * could get written to one of the anchors — a stub at
 * `$HOME/.traffic-one/bin/traffic-one-reset.cjs` — and `node <that file>` then
 * runs unjudged at a boundary reached precisely because nothing is judging. An
 * earlier draft of this half tested only the SHAPE (two public literals, free
 * to an adversary who reads the source) while claiming identity;
 * `isGeneratedShim` above carries the full accounting of what the comparison
 * does and does not buy, and of the alternatives that are worth less than they
 * look.
 *
 * The self-relative anchor is exempt from the content test by construction: it
 * is not a shim but the runner itself, inside the tree the currently-executing
 * code was loaded from, so if it is forged the process is already running forged
 * code and there is nothing left to protect. That is the same trust root the
 * generator comparison inherits, which is why the comparison is worth making.
 */
function isGateExemptScript(candidate: string, allowed: readonly string[], rel: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const wanted = comparablePath(candidate);
  const [own, ...shims] = allowed as readonly [string, ...string[]];
  if (comparablePath(own) === wanted) return true;
  return shims.some((entry) => comparablePath(entry) === wanted) && isGeneratedShim(candidate, rel);
}

function isGateExemptDoctorScript(candidate: string): boolean {
  return isGateExemptScript(candidate, gateExemptDoctorScriptPaths(), 'scripts/doctor.cjs');
}

function isGateExemptSecurityCheckScript(candidate: string): boolean {
  return isGateExemptScript(candidate, gateExemptSecurityCheckScriptPaths(), securityCheckRunnerRel());
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
  // The narrower predicate, for the same reason as the reset row below: this is
  // an exemption, so a qualified MCP name must not satisfy it.
  if (!isExemptShellToolName(toolName)) return null;
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
  //
  // The grammar's silence is not the deny. namesDoctorUnblock below (and
  // doctorUnblockAgentMintDenial) is what refuses the mint on PreToolUse,
  // including expect/script/pty/bash -c wrappers. Do not fold `--unblock`
  // into this exemption to "catch" those — that would waive every other gate.
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

// `--unblock` as a flag token. Fail-closed on quoting (`"--unblock"`,
// `'--unblock'`, `--unblock=gate`) so a python/pty argv literal still matches;
// `--unblocked` and `X--unblock` do not.
const DOCTOR_UNBLOCK_FLAG = /(?:^|[\s'"=`])--unblock(?:[\s'"=`]|$)/;

function commandNamesDoctorRunner(command: string): boolean {
  if (!command) return false;
  const posix = command.replace(/\\/g, '/');
  // Basename of every shipped runner and shim. A foreign `/tmp/evil/doctor.cjs
  // --unblock` is a mint attempt too — this is a deny, not an exemption.
  if (/(?:^|[/\s'"\\])doctor\.cjs\b/i.test(posix)) return true;
  for (const admitted of gateExemptDoctorScriptPaths()) {
    if (admitted && command.includes(admitted)) return true;
    const posixAdmitted = admitted.replace(/\\/g, '/');
    if (posixAdmitted && posix.includes(posixAdmitted)) return true;
  }
  // Documented `~/.traffic-one/bin/doctor.cjs` spelling, and the bare `doctor`
  // shim token (`echo doctor --unblock` names the runner; `echo --unblock` does
  // not). `documentation --unblock` must not trip the token.
  if (posix.includes('~/.traffic-one/bin/doctor')) return true;
  if (/(?:^|[\s'"=/`])doctor(?:[\s'"`]|$)/.test(command)) return true;
  return false;
}

/**
 * Fail-closed predicate for an agent-issued `doctor --unblock`.
 *
 * If the command text names a doctor runner (admitted path, `doctor.cjs`, or
 * the `doctor` shim token) AND contains `--unblock`, this is true — including
 * when wrapped by `expect`, `script`, `python`/`pty`, `bash -c`, `sh -c`, or
 * `eval`. No AST. False positives that name the runner (`echo doctor
 * --unblock`) are accepted; `echo --unblock` without the runner is not.
 *
 * Permanent sibling of isTrafficOneDoctorCommand, never a widening of it.
 */
export function namesDoctorUnblock(command: string): boolean {
  if (!command || !DOCTOR_UNBLOCK_FLAG.test(command)) return false;
  return commandNamesDoctorRunner(command);
}

/**
 * The reset grammar: `node <resetScriptPath> --run-id <id>`, and NOTHING else.
 *
 * The tightest grammar in this file, deliberately. Doctor's has four accepted
 * forms because doctor is read-only and each form only selects what it reads;
 * this runner MUTATES — it repoints `currentRunId` at a fresh planned run and
 * releases the retired run's claims — so every degree of freedom it does not
 * need is a degree of freedom an attacker gets for nothing. There is exactly
 * one accepted argv shape, of exactly four words, with no optional flag, no
 * flag ordering to get wrong, and no second spelling of the same request.
 *
 * `words` is already cleanShellWords output, so `;`, `&`, `|`, backticks, `$`,
 * redirection, globs and unterminated quotes have all made it null upstream —
 * this only has to compare a flat argv against one exact shape. Case-sensitive
 * throughout, like the doctor grammar: the shipped runner and its flag are
 * lower-case, and loosening case admits more strings for the same one binary.
 *
 * The id is judged by isDoctorIdArgument, the SAME authority doctor's `--run`
 * uses, because it is the same question ("an opaque run id as it may appear on
 * an argv a gate exempts") and a second copy of it could only drift. Anchored
 * on alnum at both ends, so no `-`-prefixed flag can ever parse as an id.
 *
 * Admitting the command is not authorizing the reset. The runner re-derives
 * every precondition itself under the project state lock — the id must BE the
 * project's `currentRunId` and its ledger must legibly read terminal `failed` —
 * so the widest thing this grammar can buy a caller is the right to be refused
 * by the runner. See runners/traffic-one-reset/index.ts.
 */
function resetCommandInvocation(toolName: unknown, toolInput: unknown): { readonly runId: string } | null {
  if (!isExemptShellToolName(toolName)) return null;
  const words = cleanShellWords(commandFromToolInput(toolInput).trim(), {
    tildeHome: process.env.HOME || os.homedir(),
  });
  if (!words || words.length !== 4) return null;
  if (words[0] !== 'node'
    || !isGateExemptScript(words[1] as string, gateExemptResetScriptPaths(), 'scripts/traffic-one-reset.cjs')) return null;
  if (words[2] !== '--run-id') return null;
  const runId = words[3] as string;
  return isDoctorIdArgument(runId) ? { runId } : null;
}

// The one sanctioned recovery edge out of a `failed` run, and the second (and
// only other) row of the fail-closed recovery allowlist. Exemption means "this
// gate has no opinion" (noop), never an elevated capability.
export function isTrafficOneResetCommand(toolName: unknown, toolInput: unknown): boolean {
  return resetCommandInvocation(toolName, toolInput) !== null;
}

/**
 * The workspace-convert grammar: `node <workspaceScript> --convert-to-container`
 * or the same with `--yes`. Two exact argv shapes, nothing else.
 *
 * Tight like reset: the runner MUTATES identity (and with `--yes` archives plan
 * and runs), so optional flags stay out of the gate. `--cwd` / `--json` are
 * CLI-only. Exemption means no opinion, never an elevated capability.
 */
function workspaceCommandInvocation(toolName: unknown, toolInput: unknown): 'plain' | 'yes' | null {
  if (!isExemptShellToolName(toolName)) return null;
  const words = cleanShellWords(commandFromToolInput(toolInput).trim(), {
    tildeHome: process.env.HOME || os.homedir(),
  });
  if (!words || (words.length !== 3 && words.length !== 4)) return null;
  if (words[0] !== 'node'
    || !isGateExemptScript(words[1] as string, gateExemptWorkspaceScriptPaths(), 'scripts/traffic-one-workspace.cjs')) {
    return null;
  }
  if (words[2] !== '--convert-to-container') return null;
  if (words.length === 3) return 'plain';
  return words[3] === '--yes' ? 'yes' : null;
}

export function isTrafficOneWorkspaceCommand(toolName: unknown, toolInput: unknown): boolean {
  return workspaceCommandInvocation(toolName, toolInput) !== null;
}

const SECURITY_CHECK_FLAG_WITH_VALUE = new Set(['--report-dir', '--cwd']);
const SECURITY_CHECK_FLAG_SOLO = new Set([
  '--strict', '--stamp', '--no-stamp', '--help', '-h',
]);

/**
 * The security-check grammar: `node <security-check-runner.cjs>` plus only
 * that runner's documented flags.
 *
 * Same identity stack as doctor/reset (`isGateExemptScript` + generated-shim
 * byte-equality). Exemption here means "this is not the state-file shell
 * deny" — never a fail-closed recovery row, and never a widening of doctor
 * or reset. The deploy remediation is `--strict --stamp`; `--stamp` is what
 * writes `.one.json` via `writeState` and typically does not name that file
 * in argv, so the predicate must still admit the command if a detector would
 * classify `node <shim> --stamp` as a state-file writer.
 *
 * `words` is cleanShellWords output: chaining, substitution and redirection
 * have already made it null. Case-sensitive flags, like the sibling grammars.
 */
function securityCheckCommandInvocation(toolName: unknown, toolInput: unknown): boolean {
  if (!isExemptShellToolName(toolName)) return false;
  const words = cleanShellWords(commandFromToolInput(toolInput).trim(), {
    tildeHome: process.env.HOME || os.homedir(),
  });
  if (!words || words.length < 2) return false;
  if (words[0] !== 'node' || !isGateExemptSecurityCheckScript(words[1] as string)) return false;
  const args = words.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string;
    if (SECURITY_CHECK_FLAG_SOLO.has(flag)) continue;
    if (SECURITY_CHECK_FLAG_WITH_VALUE.has(flag)) {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) return false;
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

export function isTrafficOneSecurityCheckCommand(toolName: unknown, toolInput: unknown): boolean {
  return securityCheckCommandInvocation(toolName, toolInput);
}

// The run id the grammar admitted, or '' — exported so a caller reads the value
// the grammar parsed instead of re-scanning the command text for it.
export function trafficOneResetRunId(toolName: unknown, toolInput: unknown): string {
  return resetCommandInvocation(toolName, toolInput)?.runId || '';
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

// ── Onboarding orientation shell (allowlist; unknown → not read-only) ────────
//
// isMutatingPreToolUse is a DENYLIST used by re-anchor, authoring-guard, and
// several onboarding-gate mutating walks. It deliberately leaves `python
// analyze.py` unflagged so a read-only investigation of a foreign project does
// not re-anchor onto it. That same denylist misses `"rm"`, `\rm`, `/bin/rm`,
// `bash -c`, `eval`, `sh x.sh`, interpreter eval/heredoc, in-place editors,
// glued redirects, rsync/patch/install, `curl -o`, and most git verbs.
//
// This predicate is the opposite bias, used ONLY by isReadOnlyOrientationToolUse
// for the shell half: a command-position verb that is not a known orientation
// read is mutating. Do not call it from tool-scope / authoring-guard / other
// isMutatingPreToolUse consumers.

const NESTED_SHELL_EXEC_RE = new RegExp(
  String.raw`\b${SHELL_NAME}\b(?:\\\n|[^\n;|&])*\s-[a-zA-Z]*c\b`,
);
const EVAL_FLAG_RE = new RegExp(`^${EVAL_FLAG}$`);
const DESTRUCTIVE_VERB_RE = new RegExp(`^${DESTRUCTIVE_VERB}$`);
const OVERWRITE_TOOL_RE = new RegExp(`^${OVERWRITE_TOOL}$`);
const SHELL_BINARY_RE = new RegExp(`^${SHELL_NAME}$`);
const COMMAND_WORD_PREFIX_RE = new RegExp(`^${COMMAND_WORD_PREFIX}`);
const ONBOARDING_WRITE_REDIRECT_RE =
  /(?:^|[\s;&|\w"')}\x60])(?:>{1,2}|&>)\s*(?!&?\d(?:\b|$))(?!\/dev\/null(?:\b|$))/;
const ONBOARDING_DESTRUCTIVE_RE = new RegExp(
  `${VERB_ANCHOR}${COMMAND_WORD_PREFIX}${DESTRUCTIVE_VERB}\\b`,
);
const ONBOARDING_OVERWRITE_RE = new RegExp(
  `${COMMAND_START}${COMMAND_WORD_PREFIX}${OVERWRITE_TOOL}\\b`,
);
const ONBOARDING_INTERPRETER_RE = /^(?:python(?:\d+(?:\.\d+)*)?|node(?:js)?|ts-node|tsx|deno|bun|perl|ruby|php)$/;
const ONBOARDING_CURL_WRITE_RE = /^(?:-[a-zA-Z]*[oOT]|--output(?:-dir)?|--remote-name(?:-all)?)$/;

/** Inspection verbs an onboarding agent may run. Unknown command-position verbs fail closed. */
const ONBOARDING_READ_VERBS: ReadonlySet<string> = new Set([
  'pwd', 'echo', 'printf', 'which', 'type', 'whence', 'printenv',
  'whoami', 'id', 'uname', 'hostname', 'arch', 'nproc', 'getconf',
  'ps', 'date', 'cd',
  'cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'wc', 'jq', 'yq',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ls', 'stat', 'file', 'du',
  'cmp', 'diff', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum',
  'uniq', 'cut', 'tr', 'column', 'xxd', 'od', 'strings', 'realpath',
  'readlink', 'dirname', 'basename', 'test', '[', '[[', 'true', 'false',
  'lsof',
]);

const ONBOARDING_GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'grep', 'ls-files', 'ls-tree',
  'rev-parse', 'describe', 'version', 'help', 'shortlog', 'name-rev',
  'cat-file', 'rev-list', 'for-each-ref', 'symbolic-ref', 'check-ignore',
  'check-attr', 'whatchanged', 'annotate',
]);

const GIT_GLOBAL_WITH_ARGUMENT = new Set([
  '-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path',
]);

function onboardingCommandVerb(word: string): string {
  return word.replace(/^['"`]+/, '').replace(/['"`]+$/, '').replace(COMMAND_WORD_PREFIX_RE, '');
}

function argsHaveEvalFlag(args: readonly string[]): boolean {
  return args.some((arg) => EVAL_FLAG_RE.test(arg) || /^(?:--eval|--exec|--print)=/.test(arg));
}

function onboardingInPlaceEdit(verb: string, args: readonly string[]): boolean {
  const editor = IN_PLACE_EDITORS.find((candidate) => candidate.binary === verb);
  if (!editor) return false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('-') || token === '--') break;
    if (editor.optionsWithArgument?.includes(token)) { index += 1; continue; }
    if (token === '--in-place' || token.startsWith('--in-place=')) return true;
    if (!editor.shortRun.test(token)) continue;
    if (editor.requiresArgument && args[index + 1] !== editor.requiresArgument) continue;
    return true;
  }
  return false;
}

function gitSubcommandIsOnboardingRead(args: readonly string[]): boolean {
  let cursor = 0;
  while (cursor < args.length) {
    const token = args[cursor]!;
    if (GIT_GLOBAL_WITH_ARGUMENT.has(token)) { cursor += 2; continue; }
    if (token.startsWith('-')) { cursor += 1; continue; }
    break;
  }
  const subcommand = args[cursor] ?? '';
  return ONBOARDING_GIT_READ_SUBCOMMANDS.has(subcommand);
}

function commandHasOnboardingWriteRedirect(command: string): boolean {
  let quote: "'" | '"' | '`' | '' = '';
  let scanned = '';
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (quote === '"' && character === '\\') { index += 1; continue; }
      if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      scanned += ' ';
      continue;
    }
    scanned += character;
  }
  return ONBOARDING_WRITE_REDIRECT_RE.test(scanned);
}

function matchingClose(command: string, open: number, closer: string): number {
  if (closer === '`') {
    for (let index = open + 1; index < command.length; index += 1) {
      if (command[index] === '\\') { index += 1; continue; }
      if (command[index] === '`') return index;
    }
    return -1;
  }
  let depth = 0;
  let quote: "'" | '"' | '' = '';
  for (let index = open; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (quote === '"' && character === '\\') { index += 1; continue; }
      if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '(') { depth += 1; continue; }
    if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

function onboardingSimpleCommands(command: string): string[] | null {
  const pieces: string[] = [];
  let current = '';
  let quote: "'" | '"' | '' = '';
  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed) pieces.push(trimmed);
    current = '';
  };
  const liftSubstitution = (body: string): boolean => {
    const inner = onboardingSimpleCommands(body);
    if (inner === null) return false;
    pieces.push(...inner);
    return true;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    const next = command[index + 1];
    if (quote === "'") {
      current += character;
      if (character === "'") quote = '';
      continue;
    }
    if (quote === '"' && character === '\\') {
      current += character;
      current += next ?? '';
      index += 1;
      continue;
    }
    // Live in double quotes as well as unquoted. Single-quoted `$(…)` / backticks
    // / `<(…)` stay data. Unmatched substitution is fail-closed (null), not
    // "verb is echo". `<(…)` is lifted the same way as `$()`; `>(…)` is left
    // for the write-redirect check.
    if (character === '`') {
      const close = matchingClose(command, index, '`');
      if (close === -1) return null;
      if (!liftSubstitution(command.slice(index + 1, close))) return null;
      current += '`';
      index = close;
      continue;
    }
    if (character === '$' && next === '(' && command[index + 2] !== '(') {
      const close = matchingClose(command, index + 1, ')');
      if (close === -1) return null;
      if (!liftSubstitution(command.slice(index + 2, close))) return null;
      current += '$';
      index = close;
      continue;
    }
    if (character === '<' && next === '(') {
      const close = matchingClose(command, index + 1, ')');
      if (close === -1) return null;
      if (!liftSubstitution(command.slice(index + 2, close))) return null;
      current += '<';
      index = close;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '\n' || character === ';') { flush(); continue; }
    if (character === '&' && next === '&') { flush(); index += 1; continue; }
    if (character === '&') {
      // `2>&1` / `&>file` keep the operator; a background `&` splits like `;` / `|`.
      if (next === '>' || current.endsWith('>')) {
        current += character;
        continue;
      }
      flush();
      continue;
    }
    if (character === '|' && next === '|') { flush(); index += 1; continue; }
    if (character === '|') { flush(); continue; }
    current += character;
  }
  flush();
  return pieces;
}

function simpleCommandIsOnboardingRead(statement: string): boolean {
  if (!statement) return true;
  if (commandHasOnboardingWriteRedirect(statement)) return false;
  if (HEREDOC_INTERPRETER_RE.test(statement)) return false;
  const words = shellWordsOf(statement);
  if (words.length === 0) return true;
  const head = shellStatementHead(words);
  if (head.redirectionOnly) return !commandHasOnboardingWriteRedirect(statement);
  const verb = onboardingCommandVerb(head.verb);
  const args = head.args;
  if (!verb) return false;

  const verbLine = `${verb}${args.length ? ` ${args.join(' ')}` : ''}`;
  if (ONBOARDING_DESTRUCTIVE_RE.test(verbLine) || DESTRUCTIVE_VERB_RE.test(verb)) return false;
  if (ONBOARDING_OVERWRITE_RE.test(verbLine) || OVERWRITE_TOOL_RE.test(verb)) return false;
  if (verb === 'eval' || verb === 'source' || verb === '.') return false;
  if (SHELL_BINARY_RE.test(verb) || NESTED_SHELL_EXEC_RE.test(verbLine)) return false;
  if (verb === 'dd' || verb === 'tee' || verb === 'patch' || verb === 'xargs') return false;
  IN_PLACE_EDITOR_RE.lastIndex = 0;
  if (IN_PLACE_EDITOR_RE.test(verb) && onboardingInPlaceEdit(verb, args)) return false;
  if (onboardingInPlaceEdit(verb, args)) return false;
  if (verb === 'curl' && args.some((arg) => ONBOARDING_CURL_WRITE_RE.test(arg))) return false;
  if (verb === 'find') return !findWriteAction(statement);
  if (verb === 'git') return gitSubcommandIsOnboardingRead(args);
  if (verb === 'sed' || verb === 'gsed' || verb === 'awk' || verb === 'gawk') {
    return !onboardingInPlaceEdit(verb, args);
  }
  if (ONBOARDING_INTERPRETER_RE.test(verb)) {
    if (argsHaveEvalFlag(args)) return false;
    if (/<<-?/.test(statement)) return false;
    return true;
  }
  return ONBOARDING_READ_VERBS.has(verb);
}

/**
 * Allowlist of onboarding orientation shell. Unknown command-position verbs
 * are not read-only. Inverse of isOnboardingMutatingShell.
 */
export function isOnboardingReadOnlyShell(command: string): boolean {
  if (!command.trim()) return false;
  if (commandHasOnboardingWriteRedirect(command)) return false;
  const statements = onboardingSimpleCommands(command);
  if (!statements) return false;
  return statements.every((statement) => simpleCommandIsOnboardingRead(statement));
}

/** Fail-closed inverse: a command-position verb that is not a known orientation read. */
export function isOnboardingMutatingShell(command: string): boolean {
  return !isOnboardingReadOnlyShell(command);
}

export function isReadOnlyOrientationToolUse(toolName: unknown, toolInput: unknown): boolean {
  const ti = toolInput && typeof toolInput === 'object' ? (toolInput as Rec) : null;
  const name = String(toolName || (ti && (ti.tool_name || ti.toolName)) || '');
  if (!name) return false;
  if (/^(Read|Glob|Grep|LS|NotebookRead)$/i.test(normalizedToolName(name))) return true;
  if (isShellToolName(name) && isOnboardingReadOnlyShell(commandFromToolInput(toolInput))) return true;
  return false;
}
