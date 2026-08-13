// Resolve whether a tool call that starts inside Traffic One's own source/cache
// is still confined to that non-project space. A raw-cwd-only stand-down is
// unsafe: an absolute target or an explicit external workdir can point at a real
// end-user project. Conversely, a child running inside the plugin source must be
// allowed to inspect the source without first creating project run state.

import * as fs from 'fs';
import * as path from 'path';

import type { Ctx } from '../core/types';
import { asString } from '../adapters/coerce';
import { parseApplyPatch, patchOperationPaths, patchTextFromToolInput } from './apply-patch';
import { isNonProjectRoot } from './authoring-root';
import { isPathWithin, resolveProjectRootDetailed, type WorkspaceContainerRegistry } from './hook/paths';
import { dedupeMemberDirectories, enclosingRegisteredMember } from './hook/workspace-members';
import { obj } from './obj';
import { pluginRoot } from './paths';
import { makeSkillBlock } from './skill-block';
import { canonicalToolName, commandFromToolInput, isMutatingPreToolUse, normalizedToolName, parsedToolInput } from './tool-classify';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface ToolScopeTarget {
  path: string;
  directoryHint: boolean;
  source: 'workdir' | 'file-input' | 'patch' | 'command';
  /**
   * How strongly the target states intent to WORK on that path, used only to
   * decide whether it may move the active project root:
   *   'write'            a recognized write operand (cp/mv/touch/tee/redirect …)
   *   'transition'       an explicit directory transition (cd, git -C, --prefix …)
   *   'relative-operand' a literal ./ or ../ operand — fail-closed, since a custom
   *                      or unrecognized writer is indistinguishable from a reader
   *   'operand'          a bare ABSOLUTE path somewhere in the command text; the
   *                      weakest evidence, and the only one a read can produce
   */
  evidence?: 'write' | 'transition' | 'relative-operand' | 'operand';
}

/**
 * Where this call sits relative to a Traffic One WORKSPACE — a container of
 * independent member projects (`mode: 'workspace'`, see
 * hook/workspace-members.ts). Three arms, and the split that earns the third is
 * `member` vs `unresolved`: both mean "the walk met a container", and only one
 * of them names a project a gate may operate on.
 *
 * `none` is the answer for every project that exists today and is produced
 * WITHOUT a syscall — `resolveProjectRootDetailed` hands back the registry the
 * resolution walk already read, and it is null for every non-workspace mode.
 */
export type ToolScopeWorkspace =
  | { readonly kind: 'none' }
  /** Every target belongs to ONE registered member; `projectRoot` is that member. */
  | { readonly kind: 'member'; readonly container: string; readonly member: string }
  /**
   * The call resolved to a container and no single member owns it. The fields
   * are what the refusal renders: `members` is the registry (relative
   * spellings, empty when it could not be enumerated), `why` names the
   * inability, `offending` is the anchor paths that failed, and `touched` is
   * the members the anchors DID span — two or more of which is the split case.
   */
  | {
      readonly kind: 'unresolved';
      readonly container: string;
      readonly members: readonly string[];
      readonly why: string;
      readonly offending: readonly string[];
      readonly touched: readonly string[];
    };

export interface ToolScopeResolution {
  rawCwd: string;
  base: string;
  targets: ToolScopeTarget[];
  externalTargets: ToolScopeTarget[];
  unresolvedWriteTargets: string[];
  projectRoot: string;
  standsDown: boolean;
  workspace: ToolScopeWorkspace;
}

const PATH_FIELDS = [
  'file_path',
  'filePath',
  'path',
  'target',
  'target_path',
  'targetPath',
  'directory',
  'dir',
  'root',
  'projectRoot',
  'project_root',
] as const;

const DIRECTORY_FIELDS = new Set([
  'directory',
  'dir',
  'root',
  'projectRoot',
  'project_root',
]);

const ARRAY_PATH_FIELDS = ['paths', 'files', 'allowedFiles', 'allowed_files'] as const;

// Command text is intentionally not parsed as a complete shell language. We
// only need immutable path evidence before a tool runs. This recognizer finds
// absolute POSIX/Windows paths in plain, quoted, option-assignment, redirect,
// and nested `sh -lc "..."` forms without evaluating expansions.
const COMMAND_ABSOLUTE_PATH_RE = /(?:^|[\s"'`=(:,\[])(\/(?!\/)[^\s"'`;|&<>,)\]}]+|[A-Za-z]:[\\/][^\s"'`;|&<>,)\]}]+)/g;
const COMMAND_RELATIVE_PATH_RE = /(?:^|[\s"'`=(:,\[])(\.{1,2}[\\/][^\s"'`;|&<>,)\]}]+)/g;
const COMMAND_PWD_PATH_RE = /(?:^|[\s"'`=(:,\[])(\$(?:\{PWD\}|PWD(?=[\\/]|$))[^\s"'`;|&<>,)\]}]*)/g;
const DIRECTORY_COMMAND_RE = /(?:^|[\s;&|"'(])(?:cd|pushd|git\s+-C|npm\s+--prefix|pnpm\s+(?:--dir|-C)|yarn\s+--cwd|bun\s+--cwd)(?:\s+|=)(?:--\s+)?["']?([^\s"';&|]+)/g;
const COPY_MOVE_RE = /(?:^|[\s;&|"'(])(?:cp|mv|install|ln|rsync)\s+(?:-[^\s]+\s+)*(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+("[^"]*"|'[^']*'|[^\s;&|]+)/g;
const DIRECT_WRITE_RE = /(?:^|[\s;&|"'(])(touch|mkdir|tee|rm|rmdir|unlink|truncate)\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|><]+))/g;
const WRITE_REDIRECT_RE = /(?:^|[\s])(?:\d*)>>?\s*(?!&)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
const SHELL_WRITE_SIGNAL_RE = /(?:^|[\s;&|"'(])(?:touch|mkdir|tee|rm|rmdir|unlink|truncate|cp|mv|install|ln|rsync)\b|(?:^|[\s])(?:\d*)>>?\s*(?!&)/;
const TRUSTED_PWD_RE = /(^|[^\\])\$(?:\{PWD\}|PWD(?=[\\/]|$))/g;

// ── STAGE 2 OF THE PIPELINE CONTRACT: SCOPE AND ROOT RESOLUTION ──────────────
//
// (The contract for stages 3-6 — tokenization, expansion, extraction and
// judgement — is stated in src/shared/shell-vocabulary.ts. This is the stage
// ABOVE all of them: it decides which project the later stages are asked about,
// so an error here is not a wrong answer, it is a right answer to the wrong
// question, and no later stage can see that it happened.)
//
// THE CONTRACT: a path this stage reports must be one the command could really
// name. When a fragment of command text cannot be resolved to a path, this stage
// reports it as UNRESOLVED — never as a path, and never as nothing.
//
// The recognizers below deliberately do not parse shell. They do have to know
// ONE thing about it, and until round 9 they did not: whether a quote character
// OPENS or CLOSES. `rm -f "$R"/1715091785000/run.json` is one word — the shell
// glues the closing quote to what follows — but the absolute-path recognizer
// accepts any quote as a left delimiter, so it read the residue `/1715…/run.json`
// as an ABSOLUTE path, and project resolution adopted `/1715091785000` as the
// project root. Both judgements then ran against a root that does not exist and
// found nothing: 144B/12f → 137B/11f at gate `noop`, ground-truthed, and the same
// for the `for f in "$R"/*/run.json` spelling. Unquoted `$R/…/run.json` denied
// and `rm -rf "$R"` denied, which is how narrow the escape was and how invisible:
// one token, no diagnostic, in the permitting direction.
//
// A residue after a CLOSING quote is therefore not a path here. It is the tail of
// a word whose head this stage cannot resolve, so the whole word joins
// `unresolvedWriteTargets` when the command signals a write, and the caller
// decides fail-closed with the text in hand.

/** The indices in `text` at which a quote character CLOSES a quoted span. */
function closingQuoteIndices(text: string): Set<number> {
  const closes = new Set<number>();
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote === "'") {
      if (character === "'") { closes.add(index); quote = ''; }
      continue;
    }
    if (character === '\\') { index += 1; continue; }
    if (quote) {
      if (character === quote) { closes.add(index); quote = ''; }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
  }
  return closes;
}

/**
 * The whole shell WORD a matched operand belongs to, when the match began at a
 * closing quote — `"$R"/<id>/run.json`, whose head is the part this stage cannot
 * resolve. Reported unresolved rather than silently dropped.
 */
function wordAround(text: string, matchStart: number): string {
  let from = matchStart;
  while (from > 0 && !/[\s;&|<>()]/.test(text[from - 1]!)) from -= 1;
  let to = matchStart;
  while (to < text.length && !/[\s;&|<>()]/.test(text[to]!)) to += 1;
  return text.slice(from, to);
}

function normalizeCommandCandidate(value: string): string {
  return value
    .replace(/\\ /g, ' ')
    .replace(/^["'`>]+|["'`,;]+$/g, '')
    .replace(/[.:]+$/g, '');
}

function isIgnoredSystemCommandPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/');
  return normalized === '/dev/null'
    || normalized.startsWith('/dev/')
    || normalized.startsWith('/proc/')
    || normalized.startsWith('/sys/')
    || /^(?:\/usr)?\/(?:s?bin|libexec)\/[^/]+$/.test(normalized)
    || /^\/opt\/homebrew\/(?:bin|sbin)\/[^/]+$/.test(normalized);
}

function isDiscardRedirect(candidate: string): boolean {
  return candidate.replace(/\\/g, '/') === '/dev/null';
}

function expandTrustedPwd(candidate: string, base: string): string {
  return candidate.replace(TRUSTED_PWD_RE, (_match, prefix: string) => `${prefix}${base}`);
}

function commandCandidate(value: string, base: string): { value: string; unresolved: boolean } {
  const normalized = normalizeCommandCandidate(value);
  if (!normalized) return { value: '', unresolved: false };
  const expanded = expandTrustedPwd(normalized, base);
  return {
    value: expanded,
    unresolved: expanded.includes('$') || expanded.includes('`'),
  };
}

interface CommandTargetScan {
  targets: ToolScopeTarget[];
  unresolvedWriteTargets: string[];
}

function commandTargets(command: string, base: string): CommandTargetScan {
  if (!command) return { targets: [], unresolvedWriteTargets: [] };
  const unresolvedWriteTargets: string[] = [];
  const writeSignaled = SHELL_WRITE_SIGNAL_RE.test(command);
  const closes = closingQuoteIndices(command);
  // Is this operand match a WORD CONTINUATION rather than an operand of its own?
  // True when the delimiter the recognizer consumed is a closing quote. Records
  // the word for the fail-closed arm and answers true so the caller skips it.
  const continuesWord = (match: RegExpExecArray): boolean => {
    const operand = match[1] || '';
    const delimiter = match.index + match[0].length - operand.length - 1;
    if (delimiter < match.index || !closes.has(delimiter)) return false;
    if (writeSignaled) unresolvedWriteTargets.push(normalizeCommandCandidate(wordAround(command, delimiter)));
    return true;
  };
  const directoryPaths = new Set<string>();
  const directoryTargets: ToolScopeTarget[] = [];
  let directoryMatch: RegExpExecArray | null;
  DIRECTORY_COMMAND_RE.lastIndex = 0;
  while ((directoryMatch = DIRECTORY_COMMAND_RE.exec(command))) {
    const parsed = commandCandidate(directoryMatch[1] || '', base);
    const candidate = parsed.value;
    if (parsed.unresolved) {
      if (writeSignaled) unresolvedWriteTargets.push(normalizeCommandCandidate(directoryMatch[1] || ''));
      continue;
    }
    if (!candidate || candidate.startsWith('-') || candidate.includes('://')) continue;
    const normalized = path.isAbsolute(candidate) ? path.resolve(candidate) : candidate;
    directoryPaths.add(normalized);
    directoryTargets.push({
      path: normalized,
      directoryHint: true,
      source: 'command',
      evidence: 'transition',
    });
  }

  // Keep explicit directory transitions even when they are relative. They are
  // resolved against the raw tool base later, which makes
  // `cd ../external-project && ...` visible before stand-down is decided.
  const targets: ToolScopeTarget[] = [...directoryTargets];
  let match: RegExpExecArray | null;
  // `$PWD` / `${PWD}` is the one shell variable whose value is already
  // authenticated by this invocation's cwd/workdir. Resolve it without reading
  // process.env (which can be stale/spoofed), then feed the literal path through
  // the same project-boundary logic as every other command operand.
  COMMAND_PWD_PATH_RE.lastIndex = 0;
  while ((match = COMMAND_PWD_PATH_RE.exec(command))) {
    const parsed = commandCandidate(match[1] || '', base);
    if (!parsed.value || parsed.unresolved || parsed.value.includes('://')) continue;
    const candidate = path.isAbsolute(parsed.value) ? path.resolve(parsed.value) : parsed.value;
    if (isIgnoredSystemCommandPath(candidate)) continue;
    targets.push({
      path: candidate,
      directoryHint: directoryPaths.has(candidate),
      source: 'command',
      evidence: 'operand',
    });
  }
  COMMAND_ABSOLUTE_PATH_RE.lastIndex = 0;
  while ((match = COMMAND_ABSOLUTE_PATH_RE.exec(command))) {
    if (continuesWord(match)) continue;
    const parsed = commandCandidate(match[1] || '', base);
    const candidate = parsed.value;
    if (!candidate || parsed.unresolved || candidate.includes('://')) continue;
    const absolute = path.resolve(candidate);
    if (isIgnoredSystemCommandPath(absolute)) continue;
    targets.push({
      path: absolute,
      directoryHint: directoryPaths.has(absolute),
      source: 'command',
      evidence: 'operand',
    });
  }
  // Any literal ./ or ../ operand is relevant scope evidence regardless of the
  // executable name. This closes authoring-root escapes through less common
  // writers (rm/sed/install/custom scripts) without attempting shell expansion.
  COMMAND_RELATIVE_PATH_RE.lastIndex = 0;
  while ((match = COMMAND_RELATIVE_PATH_RE.exec(command))) {
    if (continuesWord(match)) continue;
    const parsed = commandCandidate(match[1] || '', base);
    const candidate = parsed.value;
    if (!candidate || parsed.unresolved || candidate.includes('://')) continue;
    targets.push({
      path: candidate,
      directoryHint: directoryPaths.has(candidate),
      source: 'command',
      evidence: 'relative-operand',
    });
  }
  // `cp`/`mv` are the important two-path exception: the first operand can be a
  // generated/read-only asset outside the project while the final operand is
  // the actual write target. Capture that final operand even when it is
  // relative, and append it after generic absolute-path evidence so project
  // resolution prefers the destination.
  let copyMoveMatch: RegExpExecArray | null;
  COPY_MOVE_RE.lastIndex = 0;
  while ((copyMoveMatch = COPY_MOVE_RE.exec(command))) {
    const rawDestination = normalizeCommandCandidate(copyMoveMatch[1] || '');
    const parsed = commandCandidate(rawDestination, base);
    const destination = parsed.value;
    if (parsed.unresolved) {
      if (rawDestination) unresolvedWriteTargets.push(rawDestination);
    } else if (destination && !destination.startsWith('-') && !destination.includes('://')) {
      targets.push({ path: destination, directoryHint: false, source: 'command', evidence: 'write' });
    }
  }
  // Direct shell writers and redirects are the other important relative-path
  // escape. `$PWD` is resolved from the authenticated tool base; every other
  // expansion in a recognized write target remains unverifiable and is
  // returned to the caller for a fail-closed decision.
  let directWriteMatch: RegExpExecArray | null;
  DIRECT_WRITE_RE.lastIndex = 0;
  while ((directWriteMatch = DIRECT_WRITE_RE.exec(command))) {
    const commandName = directWriteMatch[1] || '';
    const rawCandidate = normalizeCommandCandidate(
      directWriteMatch[2] || directWriteMatch[3] || directWriteMatch[4] || '',
    );
    const parsed = commandCandidate(rawCandidate, base);
    const candidate = parsed.value;
    if (parsed.unresolved) {
      if (rawCandidate) unresolvedWriteTargets.push(rawCandidate);
    } else if (candidate && !candidate.startsWith('-') && !candidate.includes('://')) {
      targets.push({
        path: candidate,
        directoryHint: commandName === 'mkdir',
        source: 'command',
        evidence: 'write',
      });
    }
  }
  let redirectMatch: RegExpExecArray | null;
  WRITE_REDIRECT_RE.lastIndex = 0;
  while ((redirectMatch = WRITE_REDIRECT_RE.exec(command))) {
    const rawCandidate = normalizeCommandCandidate(
      redirectMatch[1] || redirectMatch[2] || redirectMatch[3] || '',
    );
    const parsed = commandCandidate(rawCandidate, base);
    const candidate = parsed.value;
    if (parsed.unresolved) {
      if (rawCandidate) unresolvedWriteTargets.push(rawCandidate);
    } else if (
      candidate
      && !candidate.startsWith('&')
      && !candidate.includes('://')
      && !isDiscardRedirect(candidate)
    ) {
      targets.push({ path: candidate, directoryHint: false, source: 'command', evidence: 'write' });
    }
  }
  return {
    targets,
    unresolvedWriteTargets: [...new Set(unresolvedWriteTargets)],
  };
}

function addTarget(
  out: ToolScopeTarget[],
  value: unknown,
  source: ToolScopeTarget['source'],
  directoryHint = false,
): void {
  const target = stringValue(value);
  if (!target || target.startsWith('-') || target.includes('$') || target.includes('://')) return;
  out.push({ path: target, directoryHint, source });
}

function explicitToolTargets(
  ctx: Ctx,
): { base: string; targets: ToolScopeTarget[]; unresolvedWriteTargets: string[] } {
  const raw = obj(ctx.input.raw) || {};
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || obj(raw.input)
    || parsedToolInput(ctx.input.tool) || {};
  const workdir = ctx.input.tool?.workdir
    || stringValue(toolInput.workdir ?? toolInput.working_dir ?? toolInput.workingDir ?? toolInput.cwd);
  const base = workdir
    ? (path.isAbsolute(workdir) ? path.resolve(workdir) : path.resolve(ctx.cwd, workdir))
    : path.resolve(ctx.cwd);
  const targets: ToolScopeTarget[] = [];

  if (workdir) addTarget(targets, workdir, 'workdir', true);
  addTarget(targets, ctx.input.tool?.filePath, 'file-input');
  for (const field of PATH_FIELDS) {
    addTarget(targets, toolInput[field], 'file-input', DIRECTORY_FIELDS.has(field));
  }
  for (const field of ARRAY_PATH_FIELDS) {
    const value = toolInput[field];
    if (!Array.isArray(value)) continue;
    for (const item of value) addTarget(targets, item, 'file-input');
  }

  const rawName = normalizedToolName(ctx.input.tool?.rawName || raw.tool_name || raw.toolName);
  const isApplyPatch = /^apply_patch$/i.test(rawName);
  if (isApplyPatch) {
    const patchText = patchTextFromToolInput(
      ctx.input.tool?.patchText,
      raw.tool_input,
      raw.toolInput,
      raw.input,
      raw,
      toolInput,
    );
    const parsed = parseApplyPatch(patchText);
    if (parsed.ok) {
      for (const target of patchOperationPaths(parsed.operations)) addTarget(targets, target, 'patch');
    }
  }

  // An apply_patch payload is DATA, never shell text: Codex delivers the patch
  // in tool_input.command, and scanning it as a command turns content strings
  // (route paths like "/courses/:slug", `$VAR` in embedded snippets) into
  // phantom write targets outside the workspace (observed 3co: the architect's
  // whole multi-file patch was denied over a semantic route). The parsed patch
  // operations above are the complete, authoritative target set.
  const command = isApplyPatch ? '' : (ctx.input.tool?.command || commandFromToolInput(toolInput));
  const commandScan = commandTargets(command, base);
  targets.push(...commandScan.targets);
  return { base, targets, unresolvedWriteTargets: commandScan.unresolvedWriteTargets };
}

/**
 * May an external target move the ACTIVE PROJECT ROOT away from the raw cwd?
 *
 * Only a call that can CHANGE that target may. Reading, searching, or merely
 * naming a foreign path is not adoption evidence: a hook whose cwd is the plugin
 * source used to adopt any project mentioned in a read-only shell operand, and
 * the onboarding gate then spawned a wizard there and wrote host config files
 * into that unrelated project — stamped with the INSPECTING session's host
 * (observed live: an `ls` of a sibling Cursor project from this repo).
 *
 * Only the WEAKEST evidence is withheld: a bare absolute path that merely appears
 * somewhere in the command text ('operand'). Everything the scanner already
 * treats as intent still re-anchoring exactly as before — an external workdir,
 * an apply_patch operation, a directory transition, a recognized write operand,
 * and any literal `./`/`../` operand (kept fail-closed, because a custom or
 * unrecognized writer is indistinguishable from a reader there).
 *
 * Even a bare absolute operand still re-anchors when the plugin's OWN mutation
 * classifier says the call can write, so `sed -i /abs/path`, package installs,
 * redirects, command substitution and interpreter eval are unaffected.
 *
 * This governs ONLY root selection. `standsDown` still sees every target, so a
 * write into an external project keeps its full enforcement path.
 */
function targetsMayReanchor(ctx: Ctx, externalTargets: readonly ToolScopeTarget[]): boolean {
  const toolClass = ctx.input.tool?.class;
  // A read/search tool names its target in a normal path FIELD rather than in
  // command text, so field-vs-command is not the discriminator here — the tool
  // class is.
  const readOnlyTool = toolClass === 'file-read' || toolClass === 'search';
  const weakestOnly = readOnlyTool || externalTargets.every((target) => (
    target.source === 'command' && target.evidence === 'operand' && !target.directoryHint
  ));
  if (!weakestOnly) return true;
  const raw = obj(ctx.input.raw) || {};
  const toolName = canonicalToolName(ctx.input.tool) || asString(raw.tool_name ?? raw.toolName);
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};
  // Command substitution is deliberately NOT counted here — see the option's own
  // comment. It is evidence that the command might write SOMETHING, never
  // evidence about the foreign path it merely names, and treating it as adoption
  // is what let a read with a subshell in it pull an unrelated project (once
  // `/dev`) into scope and demand onboarding there.
  return isMutatingPreToolUse(toolName, toolInput, { ignoreCommandSubstitution: true });
}

function absoluteTarget(base: string, target: ToolScopeTarget): ToolScopeTarget {
  return {
    ...target,
    path: path.isAbsolute(target.path) ? path.resolve(target.path) : path.resolve(base, target.path),
  };
}

function targetIsNonProject(target: ToolScopeTarget): boolean {
  if (target.directoryHint) return isNonProjectRoot(target.path);
  try {
    if (fs.statSync(target.path).isDirectory()) return isNonProjectRoot(target.path);
  } catch {
    // A not-yet-created file is classified from its owning directory.
  }
  return isNonProjectRoot(path.dirname(target.path));
}

function targetStart(target: ToolScopeTarget): string {
  if (target.directoryHint) return target.path;
  try {
    return fs.statSync(target.path).isDirectory() ? target.path : path.dirname(target.path);
  } catch {
    return path.dirname(target.path);
  }
}

// The default-path answer, shared rather than re-allocated: every project that
// is not a Traffic One workspace gets this exact object.
const NOT_A_WORKSPACE: ToolScopeWorkspace = { kind: 'none' };

/**
 * Which registered member, if any, owns this call — asked ONLY when the
 * resolution walk already established that the resolved root is a container.
 *
 * The anchors are the call's TARGETS, not its cwd, and the difference is
 * load-bearing: an agent working in a monorepo routinely runs with the
 * container as its working directory while every path it touches belongs to one
 * member, and anchoring on the cwd would refuse all of that. The cwd (then the
 * raw cwd) is the FALLBACK anchor, used only when no target lands inside the
 * container at all — a bare `Bash` with no path operands, where the working
 * directory is the only statement of intent the call makes.
 *
 * Targets OUTSIDE the container are dropped rather than counted as unresolved.
 * A `cd member-a && cat /etc/hosts` names a path this workspace has no opinion
 * about; whether that path may be read at all is session/workspace-boundary
 * -guard.ts's question, asked with the whole target list, and answering it a
 * second time here would refuse the call for the wrong reason.
 *
 * This is also the RE-ANCHOR half of the member fence, and it deliberately runs
 * after `targetsMayReanchor` has had its say. That predicate governs ADOPTION —
 * may a foreign path pull the active project away from this cwd — and refuses a
 * read-only tool's target for a reason that does not apply here: moving from a
 * container to a member it registered is not adoption of another project, it is
 * resolution INSIDE the one project tree the walk already chose, and it can only
 * ever move downward.
 */
function workspaceAnchoring(
  container: string,
  registry: WorkspaceContainerRegistry,
  targets: readonly ToolScopeTarget[],
  base: string,
  rawCwd: string,
): ToolScopeWorkspace {
  const members = registry.kind === 'members' ? registry.members : [];
  const inside = [...new Set(
    targets.map((target) => targetStart(target)).filter((dir) => isPathWithin(dir, container)),
  )];
  const fallback = [base, rawCwd].find((dir) => isPathWithin(dir, container));
  const anchors = inside.length > 0 ? inside : (fallback ? [fallback] : []);
  const unresolved = (offending: readonly string[], touched: readonly string[]): ToolScopeWorkspace => ({
    kind: 'unresolved',
    container,
    members,
    // `opaque` (and, defensively, `illegible`) is the arm that carries an
    // inability rather than a list — a registry an agent's Write tool corrupted.
    // It denies like the others and renders differently, because "no member owns
    // this" and "nobody could tell who owns this" are not the same refusal.
    why: registry.kind === 'members' ? '' : registry.why,
    offending: offending.length > 0 ? offending : (anchors.length > 0 ? anchors : [container]),
    touched,
  });
  // An unreadable registry names the CONTAINER as the offending path, where the
  // arms below name the anchors: when nobody could be enumerated, no statement
  // about a subpath is warranted, and the workspace itself is the whole of what
  // is known. (Pinned — mutating this to the anchors survived every other test,
  // because in the common shape the anchor IS the container.)
  if (registry.kind !== 'members') return unresolved([container], []);
  // No `members.length === 0` early exit: with nobody registered the loop below
  // reaches the identical `unresolved(anchors, [])`, and the empty-registry
  // RENDER is chosen by workspaceMemberRefusal off `members` rather than here.
  // An exit was written first and removed once a mutation proved it unkillable.
  const owned: string[] = [];
  const offending: string[] = [];
  for (const anchor of anchors) {
    const member = enclosingRegisteredMember(container, registry, anchor);
    if (member) owned.push(member);
    else offending.push(anchor);
  }
  // BY IDENTITY, not by string, so the counting side answers the same question
  // the matching side does. `enclosingRegisteredMember` is spelling-preserving by
  // contract, so two targets in ONE directory reached under two spellings come
  // back as two strings — and counting those as two members reported "spans 2
  // members" about a call that spans one. See `dedupeMemberDirectories`.
  const touched = dedupeMemberDirectories(owned);
  if (offending.length === 0 && touched.length === 1) {
    return { kind: 'member', container, member: touched[0]! };
  }
  return unresolved(offending, touched);
}

/**
 * Resolve a pre-tool call against both its raw cwd and every explicit path
 * carried by the host. When a hook runs inside the plugin source but points at
 * a real project, the external target becomes the resolution anchor; an
 * unrelated host workspace ceiling is deliberately not applied across that
 * boundary.
 */
export function resolveToolScope(ctx: Ctx): ToolScopeResolution {
  const rawCwd = path.resolve(ctx.cwd);
  const { base, targets: relativeTargets, unresolvedWriteTargets } = explicitToolTargets(ctx);
  const targets = relativeTargets.map((target) => absoluteTarget(base, target));
  const externalTargets = targets.filter((target) => !targetIsNonProject(target));
  const standsDown = isNonProjectRoot(rawCwd)
    && isNonProjectRoot(base)
    && externalTargets.length === 0
    && unresolvedWriteTargets.length === 0;

  // The workspace question is asked ONCE, here, off the registry the resolution
  // walk already read — so a non-workspace project pays one `!== null` test and
  // reaches `NOT_A_WORKSPACE` without opening a file. Both exits below share it
  // rather than restating it, because the two differ only in what they hand the
  // resolver, never in what a container means afterwards.
  const finish = (
    resolved: ReturnType<typeof resolveProjectRootDetailed>,
  ): ToolScopeResolution => {
    // Asked whenever a container was MET, including when the resolver already
    // handed itself down to a member. That second case looks redundant and is
    // not: the resolver redirects on ONE start dir (the file hint, else the
    // cwd), so a call whose hint lands in `api` while a second target lands in
    // `web` would come back as a clean member answer with the span unnoticed.
    // This is the ACTIVE-MEMBER check — every target, not one hint.
    const workspace = resolved.workspaceRegistry
      ? workspaceAnchoring(resolved.workspaceContainer, resolved.workspaceRegistry, targets, base, rawCwd)
      : NOT_A_WORKSPACE;
    return {
      rawCwd,
      base,
      targets,
      externalTargets,
      unresolvedWriteTargets,
      // A refused call reports the CONTAINER, so the root a gate would have
      // operated on is the root the refusal names.
      projectRoot: workspace.kind === 'member'
        ? workspace.member
        : (workspace.kind === 'unresolved' ? workspace.container : resolved.root),
      standsDown,
      workspace,
    };
  };

  const preferred = targetsMayReanchor(ctx, externalTargets)
    ? ([...externalTargets].reverse().find((target) => target.source !== 'command')
      || [...externalTargets].reverse()[0])
    : undefined;
  if (!preferred) {
    // A foreign path we just refused as adoption evidence must not sneak back in
    // through the resolver's file-path hint. The hint stays for the ordinary case
    // (no external target at all), where it is what finds a monorepo sub-package's
    // enclosing workspace root.
    const filePath = externalTargets.length > 0 ? undefined : ctx.input.tool?.filePath;
    return finish(resolveProjectRootDetailed(rawCwd, filePath, { ceiling: ctx.input.workspaceRoot }));
  }

  const start = targetStart(preferred);
  // A normal relative target inside the tool's cwd/workdir must not turn its
  // parent directory (for example `<project>/src`) into a synthetic project
  // root before onboarding state exists. Re-anchor only when the target truly
  // crosses out of the tool base (notably plugin-source cwd -> user project).
  const resolutionCwd = isPathWithin(start, base) ? base : start;
  const workspaceRoot = ctx.input.workspaceRoot && isPathWithin(start, ctx.input.workspaceRoot)
    ? ctx.input.workspaceRoot
    : undefined;
  return finish(resolveProjectRootDetailed(resolutionCwd, preferred.path, { ceiling: workspaceRoot }));
}

/**
 * True only when the raw cwd is a non-project root and every explicit target or
 * workdir remains in non-project space. Any target in a real project disables
 * stand-down so normal auth/model/plan enforcement evaluates that target.
 */

export function resolveToolProjectRoot(ctx: Ctx): string {
  return resolveToolScope(ctx).projectRoot;
}

/**
 * The project root a NON-GATE caller may write runtime state to, or '' when the
 * call resolved to a workspace container.
 *
 * "No gate may operate on a workspace root" is not enforceable by the gates
 * alone: core/dispatch.ts records host capability into `.traffic-one/` from the
 * request path itself, BEFORE the pipeline and therefore before any refusal, so
 * a fence living only in the handlers would still leave a run sidecar minted in
 * the container. That is exactly the state the invariant exists to prevent, and
 * it would then be indistinguishable from a real member's.
 *
 * Returns a root rather than refusing because dispatch has no one to refuse to:
 * it runs before the decision and its observation is a diagnostic, not a
 * verdict. Dropping the record for a call the pipeline is about to deny loses
 * nothing — the deny is itself the stronger evidence that enforcement ran.
 */
export function resolveToolStateRoot(ctx: Ctx): string {
  const scope = resolveToolScope(ctx);
  return scope.workspace.kind === 'unresolved' ? '' : scope.projectRoot;
}

// ── The workspace member fence ───────────────────────────────────────────────
// "No gate may operate on a workspace root." A container is not a project: a
// plan, a compiled architecture, QA evidence, run state and a role claim all
// describe ONE codebase, and at the container level there is no one codebase
// for them to describe. So a gate that finds itself resolved to a registered
// workspace ROOT with no member resolved for the operation refuses, by name,
// instead of quietly operating on the container and minting all of that there.
//
// It lives HERE, next to the resolution it reads, rather than in a handler of
// its own, and that is a cost decision as much as a placement one: a separate
// priority-(-1) handler would have to call `resolveToolScope` a second time —
// a whole extra resolution walk — on every tool call in every project, to
// answer a question that is already sitting on the scope every gate has
// resolved anyway. Each consumer spends two lines instead
// (src/shared/__tests__/tool-scope-fence.test.ts pins that none of them
// forgets), and a non-workspace project spends one comparison.

const skillBlock = makeSkillBlock(pluginRoot);

// Verbatim fallbacks: a missing T1BLOCK must never disable the fence.
const MEMBER_OUTSIDE_FALLBACK = 'traffic-one — blocked: {{PATHS}} is inside the Traffic One workspace {{WORKSPACE}}, '
  + 'and belongs to no member project that workspace has registered. A workspace root is a CONTAINER of independent '
  + 'member projects, never a project itself — it holds no plan, no compiled architecture, no run state and no role '
  + 'claims — so no gate has anything at this level to judge this call against. The members it registered are: '
  + '{{MEMBERS}}. Re-issue this call against exactly one of them: give it a path under that member, and if it is a '
  + 'shell command run it with that member directory as the working directory.';

const MEMBER_SPLIT_FALLBACK = 'traffic-one — blocked: this call spans {{COUNT}} members of the Traffic One workspace '
  + '{{WORKSPACE}} at once — {{TOUCHED}} — through {{PATHS}}. Each member is an independent project with its own plan, '
  + 'run state and role claims, so a call crossing two of them has no single project to be judged against and no '
  + 'single owner to be attributed to; nothing here refuses the work, only the shape of the call. Split it into one '
  + 'call per member and issue them one at a time, starting with {{FIRST}}.';

const MEMBER_EMPTY_FALLBACK = 'traffic-one — blocked: {{WORKSPACE}} is a Traffic One workspace that has registered no '
  + 'member projects at all, so {{PATHS}} sits in a container with no project in it. A workspace root holds no plan, '
  + 'no run state and no role claims — its MEMBERS are the projects — and registering one is a setup step no tool '
  + 'call can perform, so re-issuing this will produce this same refusal. Report it to the user as BLOCKED, naming '
  + '{{WORKSPACE}} and its empty member registry, so they can run setup for the directory they want worked on.';

const MEMBER_REGISTRY_FALLBACK = 'traffic-one — blocked: {{WORKSPACE}} is a Traffic One workspace whose member '
  + 'registry could not be read — {{WHY}} — so {{PATHS}} cannot be attributed to a member and no gate can judge it. '
  + 'Traffic One\'s `.traffic-one/.one.json` is runtime-owned state: editing it by hand is itself denied, so there is '
  + 'nothing here for you to repair. Report this to the user as BLOCKED, quoting {{WORKSPACE}} and {{WHY}} verbatim '
  + 'so they can restore the registry or re-run setup.';

export interface WorkspaceMemberRefusal {
  readonly reason: string;
  readonly denyId: 'workspace-member-unresolved';
  readonly denyTarget: string;
}

/**
 * The named refusal for a call that resolved to a workspace CONTAINER, or null.
 *
 * ONE deny id across four render shapes, which is a deliberate reading of
 * config/deny-ids.ts's naming rule rather than an inheritance of it. The rule
 * splits ids when one site is reached "for genuinely different reasons", and
 * these four are one reason seen from four angles: the call names no member of
 * this workspace. They share a loop (an agent operating at the container
 * instead of in a member), so they share a deny BUDGET bucket correctly, and
 * they stay legible apart in the decision log through `denyTarget` — the
 * offending paths for three shapes, the container itself for the registry
 * one — and through the rendered text, which never repeats across shapes.
 *
 * The one asymmetry worth naming rather than hiding: the registry-unreadable
 * shape's remedy is "report", where the other three end in a call the agent can
 * re-issue. That is the same spread `run-team-not-subagent` carries under one
 * id, and for the same reason — the shapes are angles on one condition, not
 * branches with independent lifetimes.
 *
 * ESCALATABLE (absent from NEVER_ESCALATED_DENY_IDS, the default), and every
 * shape is written to survive that. Nothing here prescribes re-issuing the SAME
 * call: `outside`/`split` prescribe a call against a different path, which
 * changes both `denyTarget` and the rendered reason and therefore starts a new
 * deny-repeat signature rather than filling this one's bucket; `empty` and
 * `registry` prescribe reporting, so three identical draws mean an agent
 * ignoring an explicit instruction twice — exactly when escalation's own
 * "report BLOCKED" is the right thing to add, and it agrees with the prose
 * instead of contradicting it.
 */
export function workspaceMemberRefusal(scope: ToolScopeResolution): WorkspaceMemberRefusal | null {
  const workspace = scope.workspace;
  if (workspace.kind !== 'unresolved') return null;
  const container = workspace.container;
  const relative = (dir: string): string => path.relative(container, dir).split(path.sep).join('/') || dir;
  const paths = workspace.offending.join(', ');
  const vars = { WORKSPACE: container, PATHS: paths };
  const reason = workspace.why
    ? skillBlock('session', 'workspace-member-unresolved-registry',
      { ...vars, WHY: workspace.why }, MEMBER_REGISTRY_FALLBACK)
    : workspace.members.length === 0
      ? skillBlock('session', 'workspace-member-unresolved-empty', vars, MEMBER_EMPTY_FALLBACK)
      : workspace.touched.length > 1
        ? skillBlock('session', 'workspace-member-unresolved-split', {
          ...vars,
          COUNT: workspace.touched.length,
          TOUCHED: workspace.touched.map(relative).join(', '),
          FIRST: relative(workspace.touched[0]!),
        }, MEMBER_SPLIT_FALLBACK)
        : skillBlock('session', 'workspace-member-unresolved-outside',
          { ...vars, MEMBERS: workspace.members.join(', ') }, MEMBER_OUTSIDE_FALLBACK);
  return { reason, denyId: 'workspace-member-unresolved', denyTarget: paths };
}

