// src/shared/feature-source.ts
// Feature-source write-ownership helpers used by the plan-write gate:
// which paths count as feature source, which Traffic One role owns a path, and
// how to extract write targets from apply_patch text / shell commands.
// Ported 1:1 from scripts/hook-runtime/handlers/_helpers.cjs.

import { canonicalizeStateDirSegments, STATE_DIR, STATE_DIR_SEGMENT_SOURCE } from '../config/paths';
import { activeAgentRole, isSubagentSession } from './state';
import type { RunAgentContext } from './state/run-agent';
import { parseApplyPatch, patchOperationPaths } from './apply-patch';
import { SOURCE_EXTS } from './detection/artifacts';
import {
  COMMAND_START,
  COMMAND_WORD_PREFIX,
  compressorKeepsInput,
  DESTRUCTIVE_VERB,
  EVAL_FLAG,
  EVAL_WRITE_MATCH_SOURCE,
  heredocReaderIsInterpreter,
  visibleHeredocSites,
  INTERPRETER_NAME,
  IN_PLACE_EDITORS,
  IN_PLACE_EDITOR_RE,
  NAMED_OUTPUT_TOOL,
  namedOutputDestinations,
  OVERWRITE_TOOL,
  pathIsReadOnlyInText,
  REPLACING_COMPRESSOR,
  SHELL_NAME,
  SHELL_RESERVED_WORDS,
  trafficOnePathLiterals,
  trafficOnePathsNamedOutsideRead,
  TRANSPARENT_COMMAND_PREFIXES,
  VERB_ANCHOR,
  withShellValuesResolved,
} from './shell-vocabulary';

// Paths the architecture gate treats as "feature source" (monorepo + flat layouts).
export const FEATURE_SOURCE_RE =
  /^(apps\/[^/]+\/(src|app)\/|packages\/[^/]+\/src\/|src\/|services\/[^/]+\/src\/)/;

// Build/config/public artifacts that are part of an implementation surface even
// when they are not under src/. In subagent team mode these must be owned by a
// role, not edited directly by the parent/orchestrator.
export const BUILD_ARTIFACT_RE =
  /^(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|turbo\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json|(?:apps|packages|services)\/[^/]+\/(?:package\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json|src\/vite-env\.d\.ts|public\/.+))$/;

const FLAT_FRONTEND_SOURCE_RE =
  /^src\/(?:app\/(?!api\/)|pages\/(?!api\/)|components\/|features\/|hooks\/|i18n\/|locales\/|messages\/|styles\/|assets\/|lib\/(?!(?:db|server|auth)(?:\/|\.))|utils\/|providers\/|contexts\/|layouts\/|routes\/|theme\/|types\/|config\/|App\.[^/]+$|main\.[^/]+$|index\.[^/]+$|entry\.[^/]+$|client\.[^/]+$)/;

const FLAT_BACKEND_SOURCE_RE =
  /^src\/(?:app\/api\/|pages\/api\/|api\/|server\/|services\/|store\/|stores\/|db\/|database\/|prisma\/|supabase\/|middleware\.[cm]?[jt]sx?$|lib\/(?:db|server|auth)(?:\/|\.))/;

export function roleCanWriteFeatureSource(role: unknown, filePath: string): boolean {
  if (role === 'senior-frontend') {
    return /^(apps\/[^/]+\/(src|app)\/|packages\/(ui|i18n|utils)\/src\/)/.test(filePath)
      || FLAT_FRONTEND_SOURCE_RE.test(filePath);
  }
  if (role === 'senior-backend') {
    return /^(packages\/(api-client|ws-client|utils)\/src\/|services\/[^/]+\/src\/|apps\/[^/]+\/src\/(services|store)\/)/.test(filePath)
      || FLAT_BACKEND_SOURCE_RE.test(filePath);
  }
  // The post-build maintenance worker fixes trivial issues anywhere an
  // implementer could write — its scope is bounded by the triage spawn prompt
  // (named files, no exploration), not by the frontend/backend layer split.
  if (role === 'quick-fix') {
    return roleCanWriteFeatureSource('senior-frontend', filePath)
      || roleCanWriteFeatureSource('senior-backend', filePath);
  }
  return false;
}

// Any source-code write is a run-team target in the MAINTENANCE phase, even
// when the repo's layout is not one FEATURE_SOURCE_RE models (Go `internal/`,
// Laravel `app/`, a flat `cmd/` tree, ...). FEATURE_SOURCE_RE encodes the
// prescribed web layouts, which is right for the plan gate on a new project —
// but the maintenance fail-closed contract ("no write without a hash-valid
// assignment or a bounded WorkUnit") was VACUOUS on every backend repo whose
// sources live outside `src/`: the parent could edit `internal/store.go`
// directly and a bounded quick-fix allowlist had nothing to bite on (found by
// the run-sim existing-go maintenance leg). Extension-based on the same set
// mode detection counts as source, so the two ends of the pipeline agree on
// what "code" means; `.traffic-one/**` bookkeeping is never a run-team target.
export function isMaintenanceSourceWritePath(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !filePath) return false;
  const rel = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (rel.startsWith('.traffic-one/') || rel.startsWith('.git/')) return false;
  const ext = rel.slice(rel.lastIndexOf('.'));
  return SOURCE_EXTS.has(ext);
}

// Role ownership check. Prefer the per-agent run claim resolved from the current
// hook session id; fall back to the legacy shared activeAgentRole only for older
// projects that do not have .traffic-one/runs/<runId>/ state yet.
export function subagentMayWriteFeatureSource(
  state: unknown,
  filePath: string,
  agentContext: RunAgentContext | null = null,
): boolean {
  if (agentContext && agentContext.role) {
    return roleCanWriteFeatureSource(agentContext.role, filePath);
  }
  if (!isSubagentSession(state)) return false;
  const role = activeAgentRole(state);
  if (role && roleCanWriteFeatureSource(role, filePath)) return true;
  return roleCanWriteFeatureSource('senior-frontend', filePath)
      || roleCanWriteFeatureSource('senior-backend', filePath);
}

// A bare interpreter token is not a write: `python3 -c "…json.load(open(...))"`
// and `node -e "console.log(...)"` are routine read/inspect commands (the B5
// false-positive). Interpreters count as a write primitive only when file-writing
// vocabulary appears in the EVAL BODY — redirected interpreter output is still
// caught by the redirect check.
//
// The vocabulary names the destructive VERB as a CALLEE, never the module handle.
// Anchoring on a contiguous `fs.` token was a fail-open across the whole write
// fence: in `require('fs').unlinkSync(p)` the text between `fs` and the verb is
// `').`, so `\bfs\.unlink` never matched, and `\bunlink\b` could not match
// `unlinkSync` either — `S` is a word character, so there is no boundary after
// `unlink`. Only a handle bound to a variable (`const fs=require('fs')`) restored
// the anchor. Measured through this file's own exports, 6 of 11 record-erasing
// spellings were invisible, and `truncate` was absent from the vocabulary
// altogether, so BOTH of its spellings failed open — truncating a record to zero
// bytes erases it as effectively as unlinking it. A handle can be spelled without
// limit (`node:fs`, `import('fs')`, `globalThis.require`, a destructured
// `const {unlinkSync}=…`, `fs.promises`), which is why the verb is the half worth
// naming.
//
// The verb set is not a set any more, and that is the round-3 change. It was
// "narrow, not closed", and the two families it advertised as CLASSES — a
// destructive MODE argument and an in-place FLAG — were measured to be spelling
// lists one level up: the mode class was anchored on the literal `open`, so
// php's `fopen`, ruby's `File.new` and perl's 2-arg `open(F, ">P")` were all
// outside it, and the flag class named `sed` and `perl` out of five binaries
// that have the feature. Both gaps were in languages `INTERPRETER_NAMES`
// already lists, which is the tell: a rule that enumerates tokens can only
// forbid what somebody has already been defeated by.
//
// The capability spellings now come from `shell-vocabulary`'s CAPABILITY ×
// FAMILY table, which a generated symmetry property holds complete — a
// capability covered for ruby and not for php is red before anyone tries it.
// What stays HERE is this module's own precision: the exclusions and the
// call-shaped anchors that let it answer on commands naming no artifact.
//
// One family is open and stays open: a verb assembled at runtime
// (`fs['un'+'link'+'Sync']`) has no literal to match.
const EVAL_BODY_WRITE_RE = new RegExp(
  EVAL_WRITE_MATCH_SOURCE
  // `stdout`/`stderr` receivers excluded: `sys.stdout.write(open(p).read())` is
  // `cat` with extra steps and erases nothing (a REDIRECTED stdout is caught by
  // the redirect arm instead). The exclusion was measured, deferred once because
  // plan-write.test.ts's 3co regression row reached the architecture-input
  // validator through this false positive alone, and landed together with the
  // re-rooting of that row onto a command that genuinely writes.
  //
  // `fs.` members and `['"]>{1,2}['"]` are the module-handle and shell-mode
  // shorthands the table does not carry, because they are anchors rather than
  // capabilities.
  + String.raw`|\bfs\.(?:write|append|rm|unlink|rename|mkdir|cp|copy)|['"]>{1,2}['"]`
  // The verb as a callee, receiver unspelled. `[\s\\]*\(` because an UNQUOTED
  // eval body reaches the shell with its call parens escaped
  // (`node -e require\('fs'\).unlinkSync\(p\)`). `link` is deliberately absent:
  // `'a'.link('b')` is a real read false positive and a hard link erases nothing.
  // `mkdir`/`makedirs` stay absent from the bare family so the "mkdir creates no
  // file content" decision below is not quietly reversed for interpreters.
  //
  // `(?:\\?['"\x60]\s*\])?(?:\?\.)?` is what stands between the verb and its call
  // parens when the member is spelled as a STATIC computed access or an optional
  // call: `fs['unlinkSync'](p)`, `fs[\`unlinkSync\`](p)`, `fs.rmSync?.(p)`. The
  // verb literal is right there in the command text in all three; only the
  // punctuation after it moved, and a comment in the test file used to claim
  // (wrongly) that a surviving verb literal was enough. The optional BACKSLASH
  // is not decoration: inside a double-quoted eval body the inner quote arrives
  // escaped (`node -e "fs[\"unlinkSync\"](p)"`), so the shell hands the hook a
  // backslash the naive class could not cross.
  + String.raw`|\b(?:symlink|touch)(?:Sync)?`
  + String.raw`(?:\\?['"\x60]\s*\])?(?:\?\.)?[\s\\]*\(`
  // `writev` splits off from the family for the same reason `stdout.write` does:
  // fds 0/1/2 are the standard streams, `writevSync(1,[buf])` is a print, and any
  // other fd is a variable — which, if it came from a destructive open, the mode
  // arm above has already caught.
  + String.raw`|\bwritev(?:Sync)?(?:\\?['"\x60]\s*\])?[\s\\]*\((?!\s*[012]\s*,)`
  // The same verbs spelled WITHOUT parens, which is idiomatic perl and was an
  // asymmetry inside this very vocabulary: `unlink` had a bare alternative
  // above, `truncate` did not, so `perl -e 'truncate "p", 0'` was invisible
  // while `perl -e "unlink 'p'"` was refused. Restricted to an argument that
  // opens a string/scalar/uppercase filehandle so prose ("truncate the log")
  // stays a read.
  + String.raw`|\b(?:rmtree|symlink)\s+(?:['"$@]|[A-Z])`,
);

// The eval BODIES of a command, so the vocabulary above is searched where the
// code actually is. The old pattern scanned `[\s\S]*` — the entire rest of the
// command — after the eval flag, which is the same free-span mistake
// `inPlaceEditFlag` below records: `node -e "console.log(1)" && rg "unlinkSync("
// src/` is a pure read that a free span reads as a write. The interpreter and its
// flag must also sit in the SAME simple command (as in NESTED_SHELL_EXEC_RE), so
// `node --version && grep -c "unlinkSync(" f` stays a read. The narrower scope
// loses no coverage: text OUTSIDE an eval body is a plain shell command, which
// the redirect/tee/rm/sed arms already scan.
//
// `(?:\\\n|[^\n;|&])*?` is that same one-simple-command scope with the ONE way a
// simple command legally spans lines: a backslash-newline. `node \` + newline +
// `-e "…unlinkSync(p)"` is ordinary multi-line Bash and was invisible, because a
// newline-excluding span cannot reach a flag on the next line. Everything else
// about the bound is unchanged — a bare newline, `;`, `|` and `&` still end it.
const INTERPRETER_EVAL_FLAG_RE = new RegExp(
  String.raw`\b${INTERPRETER_NAME}\b(?:\\\n|[^\n;|&])*?(?:^|\s)${EVAL_FLAG}\b\s*=?\s*`,
  'g',
);

function interpreterEvalBodies(command: string): string[] {
  const bodies: string[] = [];
  INTERPRETER_EVAL_FLAG_RE.lastIndex = 0;
  for (let match = INTERPRETER_EVAL_FLAG_RE.exec(command); match; match = INTERPRETER_EVAL_FLAG_RE.exec(command)) {
    const rest = command.slice(match.index + match[0].length);
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      const quoted = (quote === '"' ? /^"((?:\\.|[^"\\])*)"/ : /^'([^']*)'/).exec(rest);
      bodies.push(quoted ? quoted[1]! : rest.slice(1));
    } else {
      bodies.push(rest); // unquoted or unterminated body: scan the remainder
    }
  }
  // A heredoc is the other way an interpreter is handed code, and it carries no
  // eval flag at all: `python3 - <<'PY' … os.unlink(p) … PY`. Same body, same
  // vocabulary, and it reached the gate as a pure noop until this arm existed.
  for (const span of heredocSpans(command)) {
    if (span.interpreterRead) bodies.push(command.slice(span.bodyStart, span.bodyEnd));
  }
  return bodies;
}

// Two questions, not one, and only the first needs a vocabulary.
//
// `EVAL_BODY_WRITE_RE` answers "is this body a write" about a path this module
// does NOT own — `src/app.ts`, a build artifact — where Traffic One has no
// anchor to hang a judgement on, so a capability vocabulary is the only
// instrument available and its incompleteness is a genuine residual.
//
// THAT RESIDUAL IS NOW MEASURED AT THE GATE RATHER THAN REASONED ABOUT, because
// a disclosure nobody drove is indistinguishable from one that is wrong. In a
// `subagents` fixture where `rm -f src/components/Button.tsx`, `echo x >` onto
// it and `require('fs').unlinkSync` on it all deny with `run-team-shell` (3/3
// positive controls), these reach `noop`:
// `zipfile.ZipFile('src/components/Button.tsx','w')`,
// `Pathname.new('src/components/Button.tsx').delete`,
// `os.close(os.open('src/components/Button.tsx', 1|512|1024))`, and — reasoned,
// not executed, because php is not installed here —
// `new SplFileObject('src/…','w')`. Each of the first three is the same call
// that erases a runtime sidecar when the path is one Traffic One owns, where the
// read-anchored judgement below refuses it without knowing the verb.
//
// The fix is not to widen this alternation by four spellings: that is the shape
// three rounds were defeated at, and the fourth arrives with the next peer. It
// is a separate design question — what anchor `src/**` could have that plays the
// role `.traffic-one` plays here — and it is deliberately NOT answered in the
// round that measured it.
//
// `trafficOnePathsNamedOutsideRead` answers about Traffic One's OWN tree, where
// the anchor exists, and it asks the inverse question: is the path named by
// anything that is not a read? A peer erased an `architecture-input-v1.json`
// with `ruby -e "Pathname.new(p).delete"` and `python3 -c
// "zipfile.ZipFile(p,'w')"` while `File.delete(p)` on the identical path drew
// `architecture-input-shell-unverified` — three spellings of one capability,
// one of them in the vocabulary. The inverse question answers all three without
// knowing any of them, and answers the fourth nobody has written yet.
//
// Case-fold (Phase 2c / 3d): TRAFFIC_ONE_PATH_RE is exact-case `.traffic-one`
// by design — non-state paths stay exact-case (2c residual). The committed
// state file is the exception. Known write verbs already fire
// EVAL_BODY_WRITE_RE without a path, so `open('.Traffic-One/.one.json','w')`
// denies. An unknown verb that ONLY names the folded path
// (`zipfile.ZipFile('.Traffic-One/.one.json','w')`) never reaches that
// alternation and never matches TRAFFIC_ONE_PATH_RE, so the inverse question
// has to see the literal `stateFilePathLiterals` finds. Same
// `pathIsReadOnlyInText` allowlist; `isStateFileWriteTarget` keeps the extra
// literals on the state file itself.
export function interpreterEvalWrite(command: string): boolean {
  return interpreterEvalBodies(command).some((body) => (
    EVAL_BODY_WRITE_RE.test(body)
    || trafficOnePathsNamedOutsideRead(body).length > 0
    || stateFileNamedOutsideRead(body)
  ));
}

// `sed`/`perl` are a write only when an actual in-place flag appears among the
// option tokens that PRECEDE the script/file arguments. The old free-span match
// (`/\bsed\b[\s\S]*-i/`) turned pure reads into writes whenever ANY later text
// merely contained "-i" — observed 8c-codex: `sed -n '1,240p' … known-issues.md`
// (the "-i" inside the filename) denied the tester's read-only orientation, and
// the same pattern inside a heredoc BODY voided the digest carve-out below.
// GNU's postfix form (`sed 's/…/…/' -i file`) is deliberately not chased — the
// canonical `sed -i` spelling stays caught without the filename false positives.
//
// `perl -i` is here because leaving it out was an asymmetry with a false
// justification attached: the comment above the eval vocabulary used to excuse it
// as "a flag, not a verb, which the sed arm does not chase either", and the sed
// arm is this function. `perl -i -pe 's/.*//' <record>` and `perl -pi -e …` erase
// a record as completely as `rm` and were both noop end to end.
//
// perl's option run needs a tighter test than sed's, because perl has options
// that take an ATTACHED argument: `/^-[a-zA-Z]*i/` matches `-MList::Util` (M, L,
// i…) and would refuse `perl -MList::Util -e 'print 1'`, a read. Only the
// bundleable no-argument switches may precede the `i` — which is per-binary, so
// the grammar lives in `IN_PLACE_EDITORS` beside the binary names rather than as
// an `isPerl` branch here. That branch is what made `ruby -i` and
// `awk -i inplace` unreachable: adding a name to a two-name alternation is a
// spelling fix, and this capability has five binaries.
export function inPlaceEditFlag(command: string): boolean {
  IN_PLACE_EDITOR_RE.lastIndex = 0;
  for (let match = IN_PLACE_EDITOR_RE.exec(command); match; match = IN_PLACE_EDITOR_RE.exec(command)) {
    const name = match[0].replace(/^.*[\s;&|('"`/]/, '');
    const editor = IN_PLACE_EDITORS.find((candidate) => candidate.binary === name);
    if (!editor) continue;
    const tokens = command.slice(match.index + match[0].length).split(/\s+/).filter(Boolean);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (!token.startsWith('-') || token === '--') break; // script/file args end the option run
      if (editor.optionsWithArgument?.includes(token)) { index += 1; continue; }
      if (token === '--in-place' || token.startsWith('--in-place=')) return true;
      if (!editor.shortRun.test(token)) continue;
      // gawk's `-i` is `--include`; only the `inplace` extension edits in place.
      if (editor.requiresArgument && tokens[index + 1] !== editor.requiresArgument) continue;
      return true; // -i, -i.bak, -ni, -pi, -Ei…
    }
  }
  return false;
}

// Verbs and tools that destroy or overwrite content, as a plain shell command.
// Split from `shellCommandHasWritePrimitive` because the run-state carve-out
// below must disqualify on exactly the same set: a carve-out that knows about
// fewer primitives than the write check is a carve-out that exempts a write.
//
// The OVERWRITE tools name their destination in a way no generic operand scan
// sees (`dd of=`, `install`/`rsync`'s last operand, `tar -C`), and they must be
// the command rather than an argument — `npm install` is not a write.
//
// The COMPRESSORS were in no verb set at all, which is the same shape of gap
// one layer out: `gzip <file>` deletes the original and leaves `<file>.gz`, so
// it destroys a file as completely as `rm` does, and nothing here had ever been
// defeated by it. `-c`/`-k`/`-l`/`-t` send the result elsewhere or nowhere, and
// the redirect arm judges those.
function destructiveShellVerb(scanned: string): boolean {
  const compressor = new RegExp(
    `${COMMAND_START}${COMMAND_WORD_PREFIX}${REPLACING_COMPRESSOR}\\b([^\\n;|&]*)`,
  ).exec(scanned);
  if (compressor && !compressorKeepsInput((compressor[1] || '').split(/\s+/))) return true;
  const namedOutput = new RegExp(
    `${COMMAND_START}${COMMAND_WORD_PREFIX}(${NAMED_OUTPUT_TOOL})\\b([^\\n;|&]*)`,
  ).exec(scanned);
  if (namedOutput
    && namedOutputDestinations(namedOutput[1] || '', (namedOutput[2] || '').split(/\s+/).filter(Boolean)).length > 0) {
    return true;
  }
  return new RegExp(`${VERB_ANCHOR}${COMMAND_WORD_PREFIX}${DESTRUCTIVE_VERB}\\b`).test(scanned)
    || new RegExp(`${COMMAND_START}${COMMAND_WORD_PREFIX}${OVERWRITE_TOOL}\\b`).test(scanned)
    || new RegExp(`${COMMAND_START}${COMMAND_WORD_PREFIX}dd\\b[^\\n;|&]*\\bof=(?!\\/dev\\/null\\b)`).test(scanned)
    // Only an EXTRACT writes; `tar -c` reads the tree into an archive.
    || new RegExp(`${COMMAND_START}${COMMAND_WORD_PREFIX}tar\\b[^\\n;|&]*\\s-(?:-extract|[a-zA-Z]*x)`).test(scanned);
}

// A nested shell body (`bash -c '…'`, `sh -lc "…"`) IS a command: its quoted
// text must keep participating in the write-primitive scan below. `fish` was
// missing, so `fish -c 'rm <record>'` had its body stripped as data.
const NESTED_SHELL_EXEC_RE = new RegExp(String.raw`\b${SHELL_NAME}\b(?:\\\n|[^\n;|&])*\s-[a-zA-Z]*c\b`);

// Quoted spans are DATA to the outer shell UNLESS they sit in command position
// (`"rm" -rf src`). Blanking every quote made that spelling invisible; unquoting
// the whole text would make `git commit -m "rm -rf src/old"` look destructive.
// Command position is after `^`, `;`, `&&`, `||`, `|`, `$(`, backtick, and after
// a reserved word / assignment / transparent prefix (`env "rm"`). Other quoted
// spans stay blanked. Nested-shell bodies stay raw — their quotes are code.
function stripQuotedSegments(command: string): string {
  if (NESTED_SHELL_EXEC_RE.test(command)) return command;
  return unquoteCommandPositionTokens(command);
}

function unquoteCommandPositionTokens(command: string): string {
  let out = '';
  let index = 0;
  let commandPosition = true;
  const finishToken = (token: string): void => {
    const verb = token.replace(/^\\/, '').slice(token.replace(/^\\/, '').lastIndexOf('/') + 1);
    commandPosition = TRANSPARENT_COMMAND_PREFIXES.has(verb)
      || SHELL_RESERVED_WORDS.has(verb)
      || /^[A-Za-z_]\w*=/.test(token);
  };
  while (index < command.length) {
    const character = command[index]!;
    if (character === ' ' || character === '\t') {
      out += character;
      index += 1;
      continue;
    }
    if (character === ';' || character === '\n') {
      out += character;
      index += 1;
      commandPosition = true;
      continue;
    }
    if (character === '&' && command[index + 1] === '&') {
      out += '&&';
      index += 2;
      commandPosition = true;
      continue;
    }
    if (character === '|' && command[index + 1] === '|') {
      out += '||';
      index += 2;
      commandPosition = true;
      continue;
    }
    if (character === '|') {
      out += '|';
      index += 1;
      commandPosition = true;
      continue;
    }
    if (character === '&') {
      out += character;
      index += 1;
      commandPosition = true;
      continue;
    }
    if (character === '$' && command[index + 1] === '(') {
      out += '$(';
      index += 2;
      commandPosition = true;
      continue;
    }
    if (character === '`') {
      out += '`';
      index += 1;
      commandPosition = true;
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      let inner = '';
      index += 1;
      while (index < command.length) {
        const next = command[index]!;
        if (quote === '"' && next === '\\') {
          inner += command[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (next === quote) { index += 1; break; }
        inner += next;
        index += 1;
      }
      if (commandPosition) {
        out += inner;
        finishToken(inner);
      } else {
        out += ' ';
      }
      continue;
    }
    let token = '';
    while (index < command.length) {
      const next = command[index]!;
      // `$` starts a parameter (`$PKG`, `${FOO}`). Do not treat it as a token
      // break: `$(` is already handled above, and breaking here never advances
      // the index (`rm -rf …/$PKG` spun forever).
      if (/[\s;&|`'"\n]/.test(next)) break;
      token += next;
      index += 1;
    }
    out += token;
    if (commandPosition) finishToken(token);
    else commandPosition = false;
  }
  return out;
}

export function shellCommandHasWritePrimitive(command: string): boolean {
  const scanned = stripQuotedSegments(command);
  const hasOutputRedirect = /(?:^|[\s;&|\w"')}\x60])(?:\d?>{1,2}|&>)\s*(?!&?\d\b)(?!\/dev\/null\b)/.test(scanned);
  return hasOutputRedirect
    || /\btee\b/.test(scanned)
    || /\bcat\b[\s\S]*<</.test(scanned)
    // Interpreter eval bodies live INSIDE quotes — scan the raw command.
    || interpreterEvalWrite(command)
    || inPlaceEditFlag(scanned)
    // mkdir creates no file content and carries no implementation ownership.
    // Treating it as a source write rejects foreground architect scaffolding in
    // Devin Local. Destructive/copying/content primitives remain gated.
    || destructiveShellVerb(scanned)
    || /(?:^|[\s;&|])find\b[\s\S]*\s-delete\b/.test(scanned);
}

export function commandAppearsToWriteFeatureSource(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const mentionsFeaturePath = /(?:^|[\s'"`/])(?:apps\/[^/\s'"`]+\/(?:src|app)(?:\/|(?=$|[\s'"`]))|packages\/[^/\s'"`]+\/src(?:\/|(?=$|[\s'"`]))|src(?:\/|(?=$|[\s'"`]))|services\/[^/\s'"`]+\/src(?:\/|(?=$|[\s'"`])))/.test(command);
  return shellCommandHasWritePrimitive(command) && mentionsFeaturePath;
}

export function commandAppearsToWriteBuildArtifact(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const hasWritePrimitive = shellCommandHasWritePrimitive(command);
  const mentionsBuildArtifact = /(?:^|[\s'"`])(?:(?:apps|packages|services)\/[^/\s'"`]+\/(?:package\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json|src\/vite-env\.d\.ts|public\/[^\s'"`]+)|(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|turbo\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|components\.json))(?:$|[\s'"`])/.test(command);
  return hasWritePrimitive && mentionsBuildArtifact;
}

// Run-state shell writes: reviewer digests and orchestrator fix-cycle notes are
// heredocs whose BODY cites source paths, but whose write TARGET is under
// `.traffic-one/{digests,fix-cycles,runs}/`. Write/Edit are already exempt by
// target path; this restores the same exemption for Bash by anchoring on the
// redirect/tee target instead of the command body. Strict on purpose:
//   - every extracted redirect/tee target must be a run-state path;
//   - any other write primitive class (rm/mv/cp/ln/touch/truncate, find -delete,
//     sed -i, interpreter eval writes) disables the carve-out — a compound
//     command that also mutates feature source stays gated.
// `.traffic-one/plan.md` is intentionally NOT carved out: plan writes must go
// through the Write tool so plan-content validation still runs.
const RUN_STATE_TARGET_RE = /^(?:\.\/)?\.traffic-one\/(?:digests|fix-cycles|runs)\/|\/\.traffic-one\/(?:digests|fix-cycles|runs)\//;

interface HeredocSpan {
  /** First index of the body (the newline that ends the operator line). */
  bodyStart: number;
  /** One past the last body index (the newline before the terminator word). */
  bodyEnd: number;
  /** Was this heredoc fed to an interpreter or a shell, i.e. is it CODE? */
  interpreterRead: boolean;
  /** Did the body run to the end of the command without its terminator? */
  unterminated: boolean;
}

/**
 * Every `<<TERM … TERM` region of a command, with the one distinction the
 * detectors need: whether the READER is an interpreter.
 *
 * Walked once here so `stripHeredocBodies`, `heredocBodies` and the eval-body
 * scan cannot disagree about where a body starts and ends.
 *
 * Sites come from `visibleHeredocSites`: `<<` is found on the mask (quoted /
 * comment / backtick / arithmetic `<<` stay invisible) and the operator is
 * matched on the original at that index so delimiter quotes on `<<'EOF'`
 * stay part of the operator. A visible `<<` that is not an operator (`cat <<`)
 * is not a span — it must not swallow the next command as a "body".
 */
function heredocSpans(command: string): HeredocSpan[] {
  const spans: HeredocSpan[] = [];
  let cursor = 0;
  for (const site of visibleHeredocSites(command)) {
    if (site.index < cursor) continue; // operator text inside an already-walked body
    const m = site.match;
    if (!m) continue;
    const term = m[1] || m[2] || m[3] || '';
    const operatorEnd = m.index + m[0].length;
    const bodyStart = command.indexOf('\n', operatorEnd);
    if (bodyStart === -1) break; // operator with no body at all
    const interpreterRead = heredocReaderIsInterpreter(command, operatorEnd);
    const termRe = new RegExp(`\\n[\\t ]*${term}[\\t ]*(?=\\n|$)`);
    const terminator = termRe.exec(command.slice(bodyStart));
    const bodyEnd = terminator ? bodyStart + terminator.index : command.length;
    spans.push({ bodyStart, bodyEnd, interpreterRead, unterminated: !terminator });
    if (!terminator) break;
    cursor = bodyEnd;
  }
  return spans;
}

// Heredoc BODIES are quoted data, not commands. A reviewer digest whose text
// merely cites `sed -i`, `rm`, or an output redirect must not void the
// run-state carve-out (observed 8c-codex: the digest heredoc was denied because
// a finding mentioned `sed -i`). Remove each `<<TERM … TERM` body before the
// disqualifier/target scans; the redirect that feeds the heredoc target
// (`cat > path <<'EOF'`) precedes the operator, so it survives the strip.
//
// UNLESS an interpreter or a shell is reading it, in which case the body is the
// command and removing it is a fail-open. Stripping unconditionally is why
// `bash <<'SH' … node -e "…unlinkSync(<record>)" … SH` reported a write
// primitive with ZERO write targets — the primitive came from the raw text and
// the target scan ran on the stripped copy — and why `python3 - <<'PY' …
// os.unlink(<record>) … PY` reported no write at all. The reader test is
// PER-HEREDOC, so a digest that quotes `python3 <<'PY'` in its findings stays
// data.
export function stripHeredocBodies(command: string): string {
  let result = '';
  let cursor = 0;
  for (const span of heredocSpans(command)) {
    if (span.interpreterRead) continue;
    result += command.slice(cursor, span.bodyStart);
    cursor = span.unterminated ? command.length : span.bodyEnd;
  }
  return result + command.slice(cursor);
}

/**
 * The inverse of `stripHeredocBodies`: every heredoc body in the command,
 * concatenated, with the surrounding shell text removed.
 *
 * The reviewer is read-only by contract and writes its digest as
 * `cat > .traffic-one/digests/<run>/reviewer.md <<'EOF' … EOF`, so the gate's
 * normal `content` for that write is the empty string — no content-shape check
 * can see the findings it is about to publish. This makes the payload visible
 * to the checks that must read it, WITHOUT promoting it to `content`: shell
 * targets stay `staticCheck: false` and every existing content gate keeps its
 * current (deliberately conservative) blindness.
 */
export function heredocBodies(command: unknown): string {
  if (typeof command !== 'string' || !command.trim()) return '';
  return heredocSpans(command)
    .map((span) => command.slice(span.bodyStart + 1, span.bodyEnd))
    .join('\n');
}

export function shellWriteTargetsStateDir(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const scanned = stripHeredocBodies(command);
  if (interpreterEvalWrite(scanned)) return false;
  if (inPlaceEditFlag(scanned)) return false;
  if (destructiveShellVerb(scanned)) return false;
  if (/(?:^|[\s;&|])find\b[\s\S]*\s-delete\b/.test(scanned)) return false;
  const targets: string[] = [];
  const redirectRe = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*(?!&?\d\b)(?!\/dev\/null\b)((?:"[^"]+")|(?:'[^']+')|[^\s;&|<>]+)/g;
  for (let m = redirectRe.exec(scanned); m; m = redirectRe.exec(scanned)) { if (m[1]) targets.push(m[1]); }
  const teeRe = /\btee\b(?:\s+-[a-zA-Z]+)*\s+((?:"[^"]+")|(?:'[^']+')|[^\s;&|]+)/g;
  for (let m = teeRe.exec(scanned); m; m = teeRe.exec(scanned)) { if (m[1]) targets.push(m[1]); }
  if (targets.length === 0) return false;
  return targets.every((raw) => {
    const target = raw.replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
    return RUN_STATE_TARGET_RE.test(target);
  });
}

/**
 * Redirect/tee whose every destination is the committed state file.
 *
 * Sibling of `shellWriteTargetsStateDir`: a heredoc whose BODY cites `src/`
 * must not be treated as a feature-source shell write just because `.one.json`
 * became a visible target. Interpreter/in-place/destructive primitives disable
 * the carve-out — those still become gate targets and hit the state-file shell
 * deny. This is NOT an allow; it only keeps architect-scope / run-team from
 * judging the state file as product source.
 */
export function shellWriteTargetsStateFile(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const scanned = stripHeredocBodies(command);
  if (interpreterEvalWrite(scanned)) return false;
  if (inPlaceEditFlag(scanned)) return false;
  if (destructiveShellVerb(scanned)) return false;
  if (/(?:^|[\s;&|])find\b[\s\S]*\s-delete\b/.test(scanned)) return false;
  const targets: string[] = [];
  const redirectRe = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*(?!&?\d\b)(?!\/dev\/null\b)((?:"[^"]+")|(?:'[^']+')|[^\s;&|<>]+)/g;
  for (let m = redirectRe.exec(scanned); m; m = redirectRe.exec(scanned)) { if (m[1]) targets.push(m[1]); }
  const teeRe = /\btee\b(?:\s+-[a-zA-Z]+)*\s+((?:"[^"]+")|(?:'[^']+')|[^\s;&|]+)/g;
  for (let m = teeRe.exec(scanned); m; m = teeRe.exec(scanned)) { if (m[1]) targets.push(m[1]); }
  if (targets.length === 0) return false;
  return targets.every((raw) => {
    const target = raw.replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
    return isStateFileWriteTarget(target);
  });
}

/**
 * Exact-ish Traffic One artifact targets named by a mutating shell command.
 * Heredoc bodies are stripped first so prose inside a digest cannot invent
 * extra targets — except when an interpreter or a shell is READING the heredoc,
 * because then the body is the command and stripping it hid the only place the
 * path was written. Both the write question and the target scan run on the same
 * text for that reason: asking one on the raw command and the other on the
 * stripped copy is what produced `prim=true, targets=[]` on a heredoc-fed
 * `unlinkSync`. The caller still applies the normal project-root and role
 * checks; this helper only makes redirect/tee/interpreter/sed/rm/cp paths
 * visible to the same pre-write gate used by Write/Edit/apply_patch.
 */
/**
 * Which Traffic One path literals are per-target WRITE PATHS.
 *
 * THE EXTRACTION IS SHARED AND THIS FILTER IS NOT, which is the honest version
 * of a claim `sidecar-shell.ts` used to make for both. Finding the literals is
 * a fact about text (`trafficOnePathLiterals`, one character class, one place
 * to fix); deciding which of them this function may hand the gate is a fact
 * about what its OUTPUT is for. Its output is a list of paths the gate runs
 * per-target ownership checks on, so a literal that names no file — the
 * `.traffic-one/runs` DIRECTORY, `.traffic-one` itself — belongs to the other
 * judgement, which enumerates what lives under it and names those files
 * instead. A peer measured the divergence and was right that it existed; it is
 * a division of labour rather than a drift, and it is written down here now
 * instead of being implied by a second regex.
 *
 * `fix-cycles/` is included so the orchestrator's verbatim transcription of the
 * reviewer's findings is a visible write target: the finding-satisfiability
 * gate must judge it. It adds no ownership deny — fix-cycle notes match no
 * run-artifact/sidecar contract.
 *
 * `.one.json` is included so a shell redirect/tee/interpreter write of the
 * committed state file is a per-target gate path. Case-fold (Phase 2c): the
 * filter canonicalizes the state-dir segment and also admits `isStateFileWriteTarget`,
 * so `.Traffic-One/.one.json` is visible. It is NOT feature source — readiness
 * and run-team still key on FEATURE_SOURCE_RE / compiled roots, not this list.
 */
const VISIBLE_WRITE_TARGET_RE =
  /^(?:\/[^\s]*\/)?(?:\.\/)?\.traffic-one\/(?:(?:runs|digests|reports|fix-cycles)\/.+|deployments\.jsonl|\.one\.json)$/;

const STATE_FILE_POSIX = `${STATE_DIR}/.one.json`;

/** Project-relative or suffixed `.traffic-one/.one.json`, ASCII-case-folded. */
export function isStateFileWriteTarget(target: string): boolean {
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '');
  const folded = canonicalizeStateDirSegments(normalized);
  return folded === STATE_FILE_POSIX || folded.endsWith(`/${STATE_FILE_POSIX}`);
}

function isVisibleWriteTarget(target: string): boolean {
  const folded = canonicalizeStateDirSegments(target.replace(/\\/g, '/'));
  return VISIBLE_WRITE_TARGET_RE.test(folded) || isStateFileWriteTarget(folded);
}

/**
 * Inverse-question arm for the committed state file under 2c case-fold.
 * `trafficOnePathsNamedOutsideRead` cannot see `.Traffic-One/.one.json`
 * because TRAFFIC_ONE_PATH_RE is exact-case; this asks the same read
 * question of the literals that extractor misses.
 */
function stateFileNamedOutsideRead(text: string): boolean {
  return stateFilePathLiterals(text).some(
    (literal) => isStateFileWriteTarget(literal) && !pathIsReadOnlyInText(text, literal),
  );
}

/**
 * State-file literals the shared extractor misses because TRAFFIC_ONE_PATH_RE
 * is exact-case `.traffic-one`. Walks left for a directory prefix so
 * `/abs/.Traffic-One/.one.json` stays one path. Fed to both the write-target
 * extractor and `interpreterEvalWrite`'s inverse-question arm.
 */
function stateFilePathLiterals(text: string): string[] {
  const re = new RegExp(`${STATE_DIR_SEGMENT_SOURCE}/\\.one\\.json`, 'g');
  const found: string[] = [];
  for (const match of text.matchAll(re)) {
    const end = (match.index ?? 0) + match[0].length;
    let start = match.index ?? 0;
    while (start > 0) {
      const previous = text[start - 1]!;
      if (/[\s'"`,;|&<>()[\]{}=:]/.test(previous)) break;
      start -= 1;
    }
    found.push(text.slice(start, end));
  }
  return found;
}

/**
 * NORMALISED BEFORE EXTRACTION, and the normalisation is shared rather than
 * mirrored. `withShellValuesResolved` is STAGE 4 of the pipeline contract (see
 * shell-vocabulary.ts) — the one value model that resolves bindings and
 * expansions TOGETHER — and it is the layer that answers for
 * `rm -f "${F:-<sidecar>}"`, which erases a named `run.json` (ground-truthed)
 * and which this judgement dropped for a different reason than its sibling did:
 * the extractor yielded `-<sidecar>` and the anchor below rejects a leading `-`.
 * Two judgements discarding the same live path for two unrelated reasons is the
 * signature this lane keeps finding, and the answer is to fix the layer BELOW
 * both of them rather than to teach each one a spelling.
 *
 * Round 8 called `withParameterDefaults` here, which replaced an expansion by
 * its default WORD and therefore lost the name before any binding was read;
 * `F=<sidecar>; rm -f "${F:-nosuch}"` reached this function as `rm -f nosuch`.
 * The text this scan extracts from is now the text the shell would have run.
 */
export function shellTrafficOneWriteTargets(command: unknown): string[] {
  if (typeof command !== 'string' || !command.trim()) return [];
  const scanned = withShellValuesResolved(stripHeredocBodies(command));
  if (!shellCommandHasWritePrimitive(scanned)) return [];
  const targets: string[] = [];
  for (const literal of [...trafficOnePathLiterals(scanned), ...stateFilePathLiterals(scanned)]) {
    const target = literal.replace(/["'`,;]+$/, '').replace(/\\/g, '/');
    if (isVisibleWriteTarget(target)) targets.push(target);
  }
  return [...new Set(targets)];
}

// Test-scope paths are owned by `senior-tester` regardless of which implementer
// assignment covers the surrounding directory (tests are interleaved inside
// frontend/backend scopes — carving them out of every assignment glob would be
// fragile). Covers *.test.*/*.spec.* files plus conventional test directories,
// including the singular `test/` segment for JVM `src/test/` layouts.
// Test files by directory convention or filename convention. The filename arm
// covers dot-infix JS/TS (`.test.` / `.spec.`) AND the side-by-side suffix/
// prefix conventions of Go (`*_test.go` lives NEXT to the source package —
// observed 13c: the tester was denied on services/api/internal/middleware/
// middleware_test.go as backend-owned and dropped the test) and pytest
// (`test_*.py` / `*_test.py`).
export const TEST_SCOPE_RE =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests|test|e2e|cypress|playwright|\.maestro)\/|\.(?:test|spec)\.[^/]+$|_test\.go$|(?:^|\/)test_[^/]+\.py$|_test\.py$/;

export function isTestScopePath(filePath: unknown): boolean {
  const p = String(filePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  return p.length > 0 && TEST_SCOPE_RE.test(p);
}

// Canonical test-runner config/setup files (any directory level): vitest,
// playwright, jest, cypress `.config`/`.setup`/`.workspace` in every JS/TS
// flavour. Deliberately NOT part of TEST_SCOPE_RE: that regex also feeds the
// no-any style exemption, while this predicate exists for the run-team tester
// overlay — the tester owns test INFRA, not just test files (observed 8c
// apps/web/jest.config.js, 11c playwright.config.ts, 12c vitest.setup.ts +
// playwright.config.ts: all correctly-scoped tester writes denied as
// frontend-owned, forcing fix-cycle detours for test wiring). App bundler
// configs (next.config, vite.config) stay implementer-owned.
export const TEST_INFRA_CONFIG_RE =
  /(?:^|\/)(?:vitest|playwright|jest|cypress)\.(?:config|setup|workspace)\.[cm]?[jt]s$/;

export function isTestInfraConfigPath(filePath: unknown): boolean {
  const p = String(filePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  return p.length > 0 && TEST_INFRA_CONFIG_RE.test(p);
}

// A single simple `cp`/`mv` that IMPORTS a read-only file from OUTSIDE the
// project into a project path is a verifiable per-target write, not an opaque
// shell mutation: the plan-write gate re-routes its DEST through the same
// ownership checks as Write/Edit instead of the blanket shell-write deny.
// Observed 10c-codex: a generated OG raster could never be placed — `cp` was
// denied as a shell write and Write/Edit are text-only — so the deliverable
// shipped without its asset. Strict on purpose; return null (= no carve-out,
// normal shell-write handling) unless ALL of:
//   - exactly one simple command: no separators, pipes, redirects, subshells,
//     command substitution, or glob characters;
//   - plain `cp`/`mv` with optional flags;
//   - every SOURCE is an absolute path OUTSIDE the project root (a read-only
//     import — sources inside the project stay on the shell-write deny so
//     in-repo moves cannot dodge per-file gates);
//   - the DEST (resolved against the command's workdir) lands INSIDE the
//     project and never under a dot-directory (`.git/`, `.traffic-one/` keep
//     their own rules).
// Returns the project-relative DEST path.
export function shellAssetImportDest(command: unknown, workdir: unknown, projectRoot: unknown): string | null {
  if (typeof command !== 'string' || !command.trim()) return null;
  if (typeof workdir !== 'string' || !workdir.startsWith('/')) return null;
  if (typeof projectRoot !== 'string' || !projectRoot.startsWith('/')) return null;
  if (/[\n;|&<>`]|\$\(/.test(command)) return null;
  if (/[*?{}[\]~]/.test(command)) return null;
  const tokens: string[] = [];
  const tokenRe = /'([^']*)'|"([^"]*)"|(\S+)/g;
  for (let m = tokenRe.exec(command); m; m = tokenRe.exec(command)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  if (tokens.length < 3) return null;
  const [cmd, ...rest] = tokens;
  if (cmd !== 'cp' && cmd !== 'mv') return null;
  const args: string[] = [];
  let flagsDone = false;
  for (const token of rest) {
    if (!flagsDone && token === '--') { flagsDone = true; continue; }
    if (!flagsDone && token.startsWith('-') && token.length > 1) continue;
    args.push(token);
  }
  if (args.length < 2) return null;
  const root = projectRoot.replace(/\/+$/, '');
  const base = workdir.replace(/\/+$/, '');
  const literalAbsolute = (p: string): string | null => {
    const abs = p.startsWith('/') ? p : `${base}/${p}`;
    // literal paths only: reject `..`/`.` segments and empty segments (`//`);
    // the leading '' from splitting the root slash is expected
    const segments = abs.split('/');
    if (segments[0] !== '' || segments.slice(1).some((s) => s === '' || s === '.' || s === '..')) return null;
    return abs;
  };
  // The root ITSELF is a member of its own project. `abs !== root` made it a
  // non-member, so anything presenting the root as a SOURCE read as an outside
  // read-only import and won the carve-out for a destructive in-repo move:
  // `mv "$ROOT"/src/a.ts dist/b.ts` (this tokenizer ends a token at the closing
  // quote, so the quoted root and `/src/a.ts` arrive as two sources) and the
  // unquoted `mv $ROOT public/x` were both granted, and a granted carve-out
  // judges only the DEST — the destroyed source was answered for by nothing.
  // '' is the root's own relative path and is falsy, so the dest check below
  // keeps rejecting a dest equal to the root exactly as before.
  const relativeToRoot = (abs: string): string | null => (
    abs === root ? '' : abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null
  );
  const dest = args[args.length - 1]!;
  for (const source of args.slice(0, -1)) {
    if (!source.startsWith('/')) return null;
    const abs = literalAbsolute(source);
    if (!abs || relativeToRoot(abs) !== null) return null;
  }
  const destAbs = literalAbsolute(dest);
  if (!destAbs) return null;
  const rel = relativeToRoot(destAbs);
  if (!rel) return null;
  if (rel.split('/').some((segment) => segment.startsWith('.'))) return null;
  return rel;
}

// Deletion twin of shellAssetImportDest. A role that produces a stray file
// outside its allowlist — a tool by-product, a mis-named export — currently
// cannot remove it: `rm` is denied as an unverifiable shell write, the path is
// denied as an allowlist gap, and Write/Edit cannot delete. Observed 6co, the
// frontend created `apps/web/public/icons/favicon.svg.png`, was denied removing
// it, and the PARENT was denied too; the run only escaped through an exact
// `git clean`. Returns the project-relative target of a single, unambiguous
// file deletion so the caller can decide it against the baseline — null (no
// carve-out, normal shell-write handling) unless ALL of:
//   - exactly one simple command: no separators, pipes, redirects, subshells,
//     command substitution, or glob characters;
//   - plain `rm` with at most `-f` (never `-r`/`-R`/`--recursive`: a directory
//     deletion is never "one stray file");
//   - exactly one operand, resolving INSIDE the project root and never under a
//     dot-directory — `.git/` and `.traffic-one/` keep their own rules.
export function shellStrayDeleteTarget(command: unknown, workdir: unknown, projectRoot: unknown): string | null {
  if (typeof command !== 'string' || !command.trim()) return null;
  if (typeof workdir !== 'string' || !workdir.startsWith('/')) return null;
  if (typeof projectRoot !== 'string' || !projectRoot.startsWith('/')) return null;
  if (/[\n;|&<>`]|\$\(/.test(command)) return null;
  if (/[*?{}[\]~]/.test(command)) return null;
  const tokens: string[] = [];
  const tokenRe = /'([^']*)'|"([^"]*)"|(\S+)/g;
  for (let m = tokenRe.exec(command); m; m = tokenRe.exec(command)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  const [cmd, ...rest] = tokens;
  if (cmd !== 'rm') return null;
  const operands: string[] = [];
  let flagsDone = false;
  for (const token of rest) {
    if (!flagsDone && token === '--') { flagsDone = true; continue; }
    if (!flagsDone && token.startsWith('-') && token.length > 1) {
      if (!/^-[f]+$/.test(token) && token !== '--force') return null;
      continue;
    }
    operands.push(token);
  }
  if (operands.length !== 1) return null;
  const root = projectRoot.replace(/\/+$/, '');
  const base = workdir.replace(/\/+$/, '');
  const operand = operands[0]!;
  const abs = operand.startsWith('/') ? operand : `${base}/${operand}`;
  const segments = abs.split('/');
  if (segments[0] !== '' || segments.slice(1).some((s) => s === '' || s === '.' || s === '..')) return null;
  if (abs === root || !abs.startsWith(`${root}/`)) return null;
  const rel = abs.slice(root.length + 1);
  if (rel.split('/').some((segment) => segment.startsWith('.'))) return null;
  return rel;
}


function unquotePath(raw: string): string {
  return raw.replace(/^['"]|['"]$/g, '').replace(/[;|&]+$/, '');
}

const CODEGRAPH_IGNORE_NAMES = new Set(['.gitnexusignore', '.graphifyignore']);

export function isLocalMjsPath(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !filePath) return false;
  const rel = unquotePath(filePath.replace(/\\/g, '/')).replace(/^\.\/+/, '');
  return rel.toLowerCase().endsWith('.local.mjs');
}

export function isCodeGraphIgnorePath(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !filePath) return false;
  const rel = unquotePath(filePath.replace(/\\/g, '/')).replace(/^\.\/+/, '').replace(/\/+$/, '');
  return CODEGRAPH_IGNORE_NAMES.has(rel);
}


export function applyPatchTargetPaths(patchText: unknown): string[] {
  if (typeof patchText !== 'string' || !patchText.trim()) return [];
  const parsed = parseApplyPatch(patchText);
  return parsed.ok ? patchOperationPaths(parsed.operations) : [];
}
