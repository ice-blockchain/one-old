// src/shared/feature-source-hygiene.ts
// Shell scanners that are NOT on the Write/session-start import graph.
// plan-write loads this module only when the tool is a shell, so the
// statement/tokenizer work stays off every other hook dispatch.

import * as fs from 'fs';
import * as path from 'path';
import { SHELL_NAME, unescapeDoubleQuoted } from './shell-vocabulary';
import {
  inPlaceEditFlag,
  interpreterEvalWrite,
  isCodeGraphIgnorePath,
  isLocalMjsPath,
  stripHeredocBodies,
} from './feature-source';

// Host-agnostic external-temp write detector. Literal roots only — `$TMPDIR`
// and `${TMPDIR}` are not external. `structuredCwd` is a tool_input workdir
// field (never hook ctx.cwd). `mktemp` is not a write primitive. A finished-run
// `mv .traffic-one/runs/<id> /tmp/parked` is excluded so the sidecar gate owns
// live-run directory moves and housekeeping of a finished run stays allowed.
// A dest or structured cwd that is the project root (or under it) is never
// external-temp, even when the project itself lives under `/tmp` or
// `/var/folders` — fixtures on macOS do.
const EXTERNAL_TEMP_ROOTS = [
  '/tmp',
  '/private/tmp',
  '/var/tmp',
  '/var/folders',
  '/private/var/folders',
] as const;

const WRITE_PRIMITIVE_VERBS = new Set(['touch', 'truncate', 'mkdir', 'rm', 'mv', 'cp']);

function tokenizeShellWords(text: string): string[] {
  const tokens: string[] = [];
  const tokenRe = /'([^']*)'|"([^"]*)"|(\S+)/g;
  for (let m = tokenRe.exec(text); m; m = tokenRe.exec(text)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens;
}

function splitSimpleStatements(command: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: "'" | '"' | '' = '';
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      buf += ch;
      if (ch === quote && (quote === "'" || command[i - 1] !== '\\')) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    if (ch === '&' || ch === '|') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      if (command[i + 1] === ch) i += 1;
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function commandVerb(token: string): string {
  const bare = token.replace(/^\\?['"`]+/, '');
  return bare.slice(bare.lastIndexOf('/') + 1);
}

function skipAssignments(words: readonly string[]): string[] {
  let index = 0;
  while (index < words.length && /^[A-Za-z_]\w*=/.test(words[index]!)) index += 1;
  return words.slice(index);
}

function unquotePath(raw: string): string {
  return raw.replace(/^['"]|['"]$/g, '').replace(/[;|&]+$/, '');
}

function normalizeAbsPrefix(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function pathEqualsOrUnder(candidate: string, root: string): boolean {
  const path = normalizeAbsPrefix(candidate);
  const base = normalizeAbsPrefix(root);
  return path === base || path.startsWith(`${base}/`);
}

function projectRootAliases(projectRoot: string): string[] {
  const root = normalizeAbsPrefix(projectRoot);
  if (!root.startsWith('/')) return [];
  const aliases = [root];
  if (root.startsWith('/private/')) aliases.push(root.slice('/private'.length));
  else if (root.startsWith('/var/') || root.startsWith('/tmp')) aliases.push(`/private${root}`);
  return [...new Set(aliases)].sort((a, b) => b.length - a.length);
}

function isUnderProjectRoot(raw: string, projectRoot: unknown): boolean {
  if (typeof projectRoot !== 'string' || !projectRoot.startsWith('/')) return false;
  const text = unquotePath(raw.trim());
  if (!text.startsWith('/')) return false;
  return projectRootAliases(projectRoot).some((alias) => pathEqualsOrUnder(text, alias));
}

function isExternalTempPath(raw: unknown, projectRoot?: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const text = unquotePath(raw.trim());
  if (!text.startsWith('/') || /[$\x60]/.test(text) || text.includes('$(')) return false;
  if (isUnderProjectRoot(text, projectRoot)) return false;
  const normalized = text.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return EXTERNAL_TEMP_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function isRelativeWriteOperand(raw: string): boolean {
  if (!raw || raw === '--' || raw.startsWith('-')) return false;
  const text = unquotePath(raw);
  if (!text || text.startsWith('/') || text.startsWith('$') || /\$\{?TMPDIR/.test(text)) return false;
  return true;
}

function flagValues(words: readonly string[], flags: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const token = words[index]!;
    for (const flag of flags) {
      if (token === flag && words[index + 1] !== undefined) out.push(words[index + 1]!);
      else if (token.startsWith(`${flag}=`)) out.push(token.slice(flag.length + 1));
      else if (
        flag.length === 2
        && token.startsWith(flag)
        && token.length > 2
        && !token.startsWith('--')
        && !/^[a-zA-Z]/.test(token.slice(2, 3))
      ) {
        out.push(token.slice(2));
      }
    }
  }
  return out;
}

function nonFlagOperands(words: readonly string[]): string[] {
  const operands: string[] = [];
  let flagsDone = false;
  for (const token of words) {
    if (!flagsDone && token === '--') { flagsDone = true; continue; }
    if (!flagsDone && token.startsWith('-') && token.length > 1) continue;
    operands.push(token);
  }
  return operands;
}

function isParkedRunMove(operands: readonly string[], projectRoot?: unknown): boolean {
  if (operands.length < 2) return false;
  const dest = operands[operands.length - 1]!;
  if (!isExternalTempPath(dest, projectRoot)) return false;
  return operands.slice(0, -1).some((src) => /(?:^|\/)\.traffic-one\/runs\//.test(src.replace(/\\/g, '/')));
}

function cdDestination(statement: string): string | null {
  const words = skipAssignments(tokenizeShellWords(statement));
  if (commandVerb(words[0] ?? '') !== 'cd') return null;
  const dest = words.slice(1).find((token) => token !== '--' && !token.startsWith('-'));
  return dest ?? '';
}

function applyCd(cwdExternal: boolean, dest: string, projectRoot?: unknown): boolean {
  if (isExternalTempPath(dest, projectRoot)) return true;
  const path = unquotePath(dest.trim());
  if (!path || path.startsWith('/')) return false;
  return cwdExternal;
}

function redirectOrTeeWritesExternalTemp(
  command: string,
  cwdExternal: boolean,
  projectRoot?: unknown,
): boolean {
  const redirectRe = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*(?!&?\d\b)(?!\/dev\/null\b)((?:"[^"]+")|(?:'[^']+')|[^\s;&|<>]+)/g;
  for (let m = redirectRe.exec(command); m; m = redirectRe.exec(command)) {
    const dest = m[1] ?? '';
    if (isExternalTempPath(dest, projectRoot) || (cwdExternal && isRelativeWriteOperand(dest))) return true;
  }
  const teeRe = /\btee\b((?:[\s]+-[a-zA-Z]+)*[\s]+)((?:"[^"]+")|(?:'[^']+')|[^\s;&|]+)/g;
  for (let m = teeRe.exec(command); m; m = teeRe.exec(command)) {
    const dest = m[2] ?? '';
    if (isExternalTempPath(dest, projectRoot) || (cwdExternal && isRelativeWriteOperand(dest))) return true;
  }
  return false;
}

function writePrimitiveWritesExternalTemp(
  verb: string,
  args: readonly string[],
  cwdExternal: boolean,
  projectRoot?: unknown,
): boolean {
  if (!WRITE_PRIMITIVE_VERBS.has(verb)) return false;
  const operands = nonFlagOperands(args);
  if (verb === 'mv' && isParkedRunMove(operands, projectRoot)) return false;
  const targets = (verb === 'cp' || verb === 'mv') ? operands.slice(-1) : operands;
  if (targets.some((operand) => isExternalTempPath(operand, projectRoot))) return true;
  if (!cwdExternal) return false;
  if (verb === 'mkdir' && operands.length === 0) return true;
  return targets.some((operand) => isRelativeWriteOperand(operand));
}

function unzipIsListing(args: readonly string[]): boolean {
  return args.some((token) => token === '--list' || (/^-[^-]*[ltzp]/.test(token) && !token.startsWith('--')));
}

/**
 * QA-trace listing only. `unzipIsListing` keeps `-p` as a listing so
 * `cd /tmp && unzip -p archive.zip` is not an external-temp write (stdout
 * is not a dest). Here `-p` is extract-to-stdout. Listing is `-l` / `-t` /
 * `-z` / `--list` / `--test`.
 */
function unzipIsQaTraceListing(args: readonly string[]): boolean {
  const hasStdoutExtract = args.some((token) =>
    /^-[^-]*p/.test(token) && !token.startsWith('--'));
  if (hasStdoutExtract) return false;
  return args.some((token) =>
    token === '--list'
    || token === '--test'
    || (/^-[^-]*[ltz]/.test(token) && !token.startsWith('--')));
}

function tarExtractMode(args: readonly string[]): 'extract' | 'list' | 'other' {
  let extract = false;
  let list = false;
  for (const token of args) {
    if (token === '--extract' || token === '--get') extract = true;
    else if (token === '--list') list = true;
    else if (/^-[^-]*x/.test(token)) extract = true;
    else if (/^-[^-]*t/.test(token)) list = true;
    else if (!token.startsWith('-') && /^[a-zA-Z]*x[a-zA-Z]*$/.test(token) && token.length <= 6) extract = true;
    else if (!token.startsWith('-') && /^[a-zA-Z]*t[a-zA-Z]*$/.test(token) && token.length <= 6) list = true;
  }
  if (extract) return 'extract';
  if (list) return 'list';
  return 'other';
}

function tarToStdout(args: readonly string[]): boolean {
  return args.some((token) => token === '--to-stdout' || token === '-O' || /^-[^-]*O/.test(token));
}

function extractDestWritesExternalTemp(
  dests: readonly string[],
  cwdExternal: boolean,
  projectRoot?: unknown,
  toStdout = false,
): boolean {
  if (dests.some((dest) => isExternalTempPath(dest, projectRoot))) return true;
  if (toStdout) return false;
  if (!cwdExternal) return false;
  if (dests.length === 0) return true;
  return dests.every((dest) => isRelativeWriteOperand(dest) || dest === '.' || dest === './');
}

function pythonZipfileRest(words: readonly string[]): string[] | null {
  const verb = commandVerb(words[0] ?? '');
  if (verb !== 'python' && verb !== 'python3') return null;
  for (let index = 1; index < words.length - 1; index += 1) {
    if (words[index] === '-m' && words[index + 1] === 'zipfile') return words.slice(index + 2);
  }
  return null;
}

function extractWritesExternalTemp(
  words: readonly string[],
  cwdExternal: boolean,
  projectRoot?: unknown,
): boolean {
  const verb = commandVerb(words[0] ?? '');
  const args = words.slice(1);
  if (verb === 'unzip') {
    if (unzipIsListing(args)) return false;
    return extractDestWritesExternalTemp(flagValues(args, ['-d']), cwdExternal, projectRoot);
  }
  if (verb === 'tar' || verb === 'bsdtar') {
    if (tarExtractMode(args) !== 'extract') return false;
    return extractDestWritesExternalTemp(
      flagValues(args, ['-C', '--directory']),
      cwdExternal,
      projectRoot,
      tarToStdout(args),
    );
  }
  if (verb === 'unar') {
    return extractDestWritesExternalTemp(
      flagValues(args, ['-o', '-output-directory', '--output-directory']),
      cwdExternal,
      projectRoot,
    );
  }
  if (verb === 'ditto') {
    const extract = args.some((token) => token === '-x' || (/^-[^-]/.test(token) && token.includes('x') && !token.startsWith('--')));
    if (!extract) return false;
    const operands = nonFlagOperands(args);
    const dests = operands.length >= 2 ? [operands[operands.length - 1]!] : [];
    return extractDestWritesExternalTemp(dests, cwdExternal, projectRoot);
  }
  const zipfileArgs = pythonZipfileRest(words);
  if (zipfileArgs) {
    const listing = zipfileArgs.some((token) => token === '-l' || token === '--list' || token === '-t' || token === '--test');
    if (listing) return false;
    const extractAt = zipfileArgs.findIndex((token) => token === '-e' || token === '--extract');
    if (extractAt === -1) return false;
    const operands = nonFlagOperands(zipfileArgs.slice(extractAt + 1));
    const dests = operands.length >= 2 ? [operands[1]!] : [];
    return extractDestWritesExternalTemp(dests, cwdExternal, projectRoot);
  }
  return false;
}

export function commandAppearsToWriteExternalTemp(
  command: unknown,
  structuredCwd?: unknown,
  projectRoot?: unknown,
): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  let cwdExternal = isExternalTempPath(structuredCwd, projectRoot);
  for (const statement of splitSimpleStatements(command)) {
    const words = skipAssignments(tokenizeShellWords(statement));
    if (words.length === 0) continue;
    const verb = commandVerb(words[0]!);
    if (redirectOrTeeWritesExternalTemp(statement, cwdExternal, projectRoot)) return true;
    if (writePrimitiveWritesExternalTemp(verb, words.slice(1), cwdExternal, projectRoot)) return true;
    if (extractWritesExternalTemp(words, cwdExternal, projectRoot)) return true;
    const cdDest = cdDestination(statement);
    if (cdDest !== null) cwdExternal = applyCd(cwdExternal, cdDest, projectRoot);
  }
  return false;
}

function pathEndsWithTraceZip(raw: string): boolean {
  const text = unquotePath(raw).replace(/\\/g, '/');
  const value = text.includes('=') && /^--?[A-Za-z]/.test(text)
    ? text.slice(text.indexOf('=') + 1)
    : text;
  return value.toLowerCase().endsWith('.trace.zip');
}

function wordsNameTraceZip(words: readonly string[]): boolean {
  return words.some((word) => pathEndsWithTraceZip(word));
}

function statementIsArchiveExtract(words: readonly string[]): boolean {
  const verb = commandVerb(words[0] ?? '');
  const args = words.slice(1);
  if (verb === 'unzip') return !unzipIsQaTraceListing(args);
  if (verb === 'tar' || verb === 'bsdtar') return tarExtractMode(args) === 'extract';
  if (verb === 'unar') return true;
  if (verb === 'ditto') {
    return args.some((token) => token === '-x'
      || (/^-[^-]/.test(token) && token.includes('x') && !token.startsWith('--')));
  }
  const zipfileArgs = pythonZipfileRest(words);
  if (zipfileArgs) {
    const listing = zipfileArgs.some((token) => (
      token === '-l' || token === '--list' || token === '-t' || token === '--test'
    ));
    if (listing) return false;
    return zipfileArgs.some((token) => token === '-e' || token === '--extract');
  }
  return false;
}

/**
 * True iff a listing-vs-extract command (the same unzip/tar/unar/bsdtar/ditto/
 * `python -m zipfile` set as the external-temp extractor) is an EXTRACT and
 * names a path ending in `.trace.zip` (case-insensitive, any directory).
 * Dest flags do not make a trace extract allow. `unzip -l` / `tar -t` stay false.
 * `unzip -p` is an extract (stdout); `unzipIsListing` still treats `-p` as
 * listing so external-temp does not count stdout as a temp dest.
 */
export function commandAppearsToExtractQaTrace(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  for (const statement of splitSimpleStatements(command)) {
    const words = skipAssignments(tokenizeShellWords(statement));
    if (words.length === 0) continue;
    if (statementIsArchiveExtract(words) && wordsNameTraceZip(words)) return true;
  }
  return false;
}

function redirectOrTeeWritesLocalMjs(command: string): boolean {
  const redirectRe = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*(?!&?\d\b)(?!\/dev\/null\b)((?:"[^"]+")|(?:'[^']+')|[^\s;&|<>]+)/g;
  for (let m = redirectRe.exec(command); m; m = redirectRe.exec(command)) {
    if (isLocalMjsPath(m[1] ?? '')) return true;
  }
  const teeRe = /\btee\b((?:[\s]+-[a-zA-Z]+)*[\s]+)((?:"[^"]+")|(?:'[^']+')|[^\s;&|]+)/g;
  for (let m = teeRe.exec(command); m; m = teeRe.exec(command)) {
    if (isLocalMjsPath(m[2] ?? '')) return true;
  }
  return false;
}

function writePrimitiveWritesLocalMjs(verb: string, args: readonly string[]): boolean {
  if (!WRITE_PRIMITIVE_VERBS.has(verb)) return false;
  return nonFlagOperands(args).some((operand) => isLocalMjsPath(operand));
}

const JS_RUNNER_VERBS = new Set(['node', 'nodejs', 'tsx', 'ts-node', 'bun', 'npx', 'deno']);
const RUNNER_VALUE_FLAGS = new Set([
  '--import', '--require', '-r', '--loader', '--experimental-loader',
  '-e', '--eval', '-p', '--print', '-c',
]);

function runnerExecutesLocalMjs(words: readonly string[]): boolean {
  const raw0 = words[0] ?? '';
  if (isLocalMjsPath(raw0)) return true;
  const verb = commandVerb(raw0);
  if (!JS_RUNNER_VERBS.has(verb)) return false;
  const args = words.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') {
      return args.slice(index + 1).some((candidate) => isLocalMjsPath(candidate));
    }
    if (token.startsWith('-')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        const flag = token.slice(0, eq);
        const value = token.slice(eq + 1);
        if ((flag === '--import' || flag === '--require' || flag === '--loader') && isLocalMjsPath(value)) {
          return true;
        }
        continue;
      }
      if (RUNNER_VALUE_FLAGS.has(token)) {
        const value = args[index + 1];
        if (value !== undefined) {
          if (
            (token === '--import' || token === '--require' || token === '-r' || token === '--loader')
            && isLocalMjsPath(value)
          ) {
            return true;
          }
          index += 1;
        }
        continue;
      }
      continue;
    }
    if (verb === 'npx' && JS_RUNNER_VERBS.has(commandVerb(token))) continue;
    return isLocalMjsPath(token);
  }
  return false;
}

/**
 * Shell write of a `*.local.mjs` (redirect/tee/touch/rm/cp/mv/in-place/eval)
 * or exec of one (`node`/`tsx`/`bun`/`npx`/`node --import tsx`, or `./….local.mjs`).
 */
export function commandAppearsToWriteOrExecLocalMjs(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  for (const statement of splitSimpleStatements(command)) {
    const words = skipAssignments(tokenizeShellWords(statement));
    if (words.length === 0) continue;
    const verb = commandVerb(words[0]!);
    if (redirectOrTeeWritesLocalMjs(statement)) return true;
    if (writePrimitiveWritesLocalMjs(verb, words.slice(1))) return true;
    if (inPlaceEditFlag(statement) && words.some((word) => isLocalMjsPath(word))) return true;
    if (interpreterEvalWrite(statement) && /\.local\.mjs\b/i.test(statement)) return true;
    if (runnerExecutesLocalMjs(words)) return true;
  }
  return false;
}

const RECURSIVE_RM_PROMPT_SEGMENTS = new Set(['dist', '.next']);

// Nested `-c` bodies, appended as sibling text. Copied from sidecar's
// NESTED_SHELL_RE shape so `bash -c 'rm -rf dist'` is visible to the rm
// detector. Wrappers are kept (never emptied): this layer has no
// `.traffic-one` occurrence-read inversion to protect.
const NESTED_SHELL_C_BODY_RE = new RegExp(
  String.raw`\b(?:[^\s;&|]*\/)?${SHELL_NAME}`
  + String.raw`(?:\s+(?:-[a-zA-Z-]+\s+[A-Za-z][\w=.-]*|-[^\s;&|'"]+|\\\n))*?`
  + String.raw`\s+(?:-[a-zA-Z]*c[a-zA-Z]*)\s+(?:'([^']*)'|"((?:\\.|[^"\\])*)")`,
  'g',
);
const MAX_SHELL_NESTING = 4;

function withNestedCBodies(command: string): string {
  let text = command;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_SHELL_NESTING; depth += 1) {
    const bodies: string[] = [];
    for (const match of text.matchAll(NESTED_SHELL_C_BODY_RE)) {
      const single = match[1];
      const doubled = match[2];
      const body = (single !== undefined
        ? single
        : (doubled === undefined ? '' : unescapeDoubleQuoted(doubled))).trim();
      if (body && !seen.has(body)) {
        seen.add(body);
        bodies.push(body);
      }
    }
    if (bodies.length === 0) return text;
    text = `${text}\n${bodies.join('\n')}`;
  }
  return text;
}

/**
 * Text the recursive-rm and codegraph-ignore detectors walk.
 * Non-interpreter heredoc bodies are data (reviewer digest). Interpreter/shell
 * heredocs stay. Nested `bash -c` bodies are appended so the existing verb
 * scan can see them.
 */
function scanPromptGateCommand(command: string): string {
  return withNestedCBodies(stripHeredocBodies(command));
}

function rmHasRecursiveAndForce(args: readonly string[]): boolean {
  let recursive = false;
  let force = false;
  let flagsDone = false;
  for (const token of args) {
    if (!flagsDone && token === '--') { flagsDone = true; continue; }
    if (!flagsDone && token.startsWith('-') && token.length > 1) {
      if (token === '--recursive') { recursive = true; continue; }
      if (token === '--force') { force = true; continue; }
      if (token.startsWith('--')) continue;
      if (/[rR]/.test(token)) recursive = true;
      if (token.includes('f')) force = true;
    }
  }
  return recursive && force;
}

function isRecursiveRmPromptOperand(raw: string): boolean {
  const normalized = unquotePath(raw).replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\/+/, '');
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.includes('node_modules')) return false;
  const joined = segments.join('/');
  if (
    joined === 'supabase/.temp'
    || joined.startsWith('supabase/.temp/')
    || joined.endsWith('/supabase/.temp')
  ) {
    return true;
  }
  return segments.some((segment) => RECURSIVE_RM_PROMPT_SEGMENTS.has(segment));
}

/**
 * True iff a simple `rm` has both recursive and force and names build output
 * that Claude/Cursor prompt on: `dist`, `.next`, or `supabase/.temp`.
 * `node_modules` (including `node_modules/dist`) and `distribution` stay false.
 */
export function commandAppearsToRecursiveRmPromptTarget(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  for (const statement of splitSimpleStatements(scanPromptGateCommand(command))) {
    const words = skipAssignments(tokenizeShellWords(statement));
    if (words.length === 0) continue;
    if (commandVerb(words[0]!) !== 'rm') continue;
    const args = words.slice(1);
    if (!rmHasRecursiveAndForce(args)) continue;
    if (nonFlagOperands(args).some((operand) => isRecursiveRmPromptOperand(operand))) return true;
  }
  return false;
}

function isCodeGraphIgnoreOperand(raw: string, projectRoot?: unknown): boolean {
  if (isCodeGraphIgnorePath(raw)) return true;
  if (typeof projectRoot !== 'string' || !projectRoot.startsWith('/')) return false;
  const text = unquotePath(raw.replace(/\\/g, '/'));
  if (!text.startsWith('/')) return false;
  const root = projectRoot.replace(/\/+$/, '');
  return text === `${root}/.gitnexusignore` || text === `${root}/.graphifyignore`;
}

function codeGraphIgnoreExists(projectRoot: unknown, name: string): boolean {
  if (typeof projectRoot !== 'string' || !projectRoot.startsWith('/')) return false;
  try {
    return fs.existsSync(path.join(projectRoot, name));
  } catch {
    return false;
  }
}

function deletePrimitiveCodeGraphIgnore(
  verb: string,
  args: readonly string[],
  projectRoot?: unknown,
): boolean {
  if (verb !== 'rm' && verb !== 'unlink') return false;
  return nonFlagOperands(args).some((operand) => isCodeGraphIgnoreOperand(operand, projectRoot));
}

function namedCodeGraphIgnore(raw: string, projectRoot?: unknown): string | null {
  if (isCodeGraphIgnorePath(raw)) {
    return unquotePath(raw.replace(/\\/g, '/')).replace(/^\.\/+/, '').replace(/\/+$/, '');
  }
  if (typeof projectRoot === 'string' && projectRoot.startsWith('/')) {
    const text = unquotePath(raw.replace(/\\/g, '/'));
    const root = projectRoot.replace(/\/+$/, '');
    if (text === `${root}/.gitnexusignore`) return '.gitnexusignore';
    if (text === `${root}/.graphifyignore`) return '.graphifyignore';
  }
  return null;
}

function codeGraphIgnoreWriteDests(command: string, projectRoot?: unknown): string[] {
  const dests: string[] = [];
  const add = (raw: string): void => {
    const name = namedCodeGraphIgnore(raw, projectRoot);
    if (name && !dests.includes(name)) dests.push(name);
  };
  const redirectRe = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*(?!&?\d\b)(?!\/dev\/null\b)((?:"[^"]+")|(?:'[^']+')|[^\s;&|<>]+)/g;
  for (let m = redirectRe.exec(command); m; m = redirectRe.exec(command)) add(m[1] ?? '');
  const teeRe = /\btee\b((?:[\s]+-[a-zA-Z]+)*[\s]+)((?:"[^"]+")|(?:'[^']+')|[^\s;&|]+)/g;
  for (let m = teeRe.exec(command); m; m = teeRe.exec(command)) add(m[2] ?? '');
  for (const statement of splitSimpleStatements(command)) {
    const words = skipAssignments(tokenizeShellWords(statement));
    if (words.length === 0) continue;
    const verb = commandVerb(words[0]!);
    if (verb === 'rm' || verb === 'unlink' || !WRITE_PRIMITIVE_VERBS.has(verb)) continue;
    const operands = nonFlagOperands(words.slice(1));
    const targets = (verb === 'cp' || verb === 'mv') ? operands.slice(-1) : operands;
    for (const target of targets) add(target);
  }
  return dests;
}

export function commandAppearsToCreateCodeGraphIgnore(
  command: unknown,
  projectRoot?: unknown,
): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  return codeGraphIgnoreWriteDests(scanPromptGateCommand(command), projectRoot)
    .some((name) => !codeGraphIgnoreExists(projectRoot, name));
}

export function commandAppearsToDeleteCodeGraphIgnore(
  command: unknown,
  projectRoot?: unknown,
): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  for (const statement of splitSimpleStatements(scanPromptGateCommand(command))) {
    const words = skipAssignments(tokenizeShellWords(statement));
    if (words.length === 0) continue;
    const verb = commandVerb(words[0]!);
    if (deletePrimitiveCodeGraphIgnore(verb, words.slice(1), projectRoot)) return true;
    if (interpreterEvalWrite(statement) && /\bunlink(?:Sync)?\b/.test(statement)) {
      if (/\.gitnexusignore\b/.test(statement) || /\.graphifyignore\b/.test(statement)) {
        if (!/\w\/\.(?:gitnexusignore|graphifyignore)\b/.test(statement)) return true;
      }
    }
  }
  return false;
}
