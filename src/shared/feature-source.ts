// src/shared/feature-source.ts
// Feature-source write-ownership helpers used by the plan-write gate:
// which paths count as feature source, which Traffic One role owns a path, and
// how to extract write targets from apply_patch text / shell commands.
// Ported 1:1 from scripts/hook-runtime/handlers/_helpers.cjs.

import * as fs from 'fs';
import * as path from 'path';
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
  HEREDOC_OPERATOR_SOURCE,
  heredocReaderIsInterpreter,
  INTERPRETER_NAME,
  IN_PLACE_EDITORS,
  IN_PLACE_EDITOR_RE,
  NAMED_OUTPUT_TOOL,
  namedOutputDestinations,
  OVERWRITE_TOOL,
  REPLACING_COMPRESSOR,
  SHELL_NAME,
  unescapeDoubleQuoted,
  trafficOnePathLiterals,
  trafficOnePathsNamedOutsideRead,
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
function interpreterEvalWrite(command: string): boolean {
  return interpreterEvalBodies(command).some((body) => (
    EVAL_BODY_WRITE_RE.test(body) || trafficOnePathsNamedOutsideRead(body).length > 0
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
function inPlaceEditFlag(command: string): boolean {
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

// Quoted spans are DATA to the outer shell: `awk '{ if (length > m) … }'`,
// `echo "usage: cmd > out"`, and grep patterns must not read as redirects or
// rm/cp/tee tokens. Observed 5cl-claude: the frontend's own collapse
// self-check (`for f in $(find …); do wc -L "$f"; done` beside an awk
// comparison) was denied as an "implementation write via shell command" — the
// gate blocked exactly the read-only verification the workflow asks for.
// Replace each span with a space to preserve token boundaries; keep the scan
// raw when the command execs a nested shell, whose quoted body is real code.
function stripQuotedSegments(command: string): string {
  if (NESTED_SHELL_EXEC_RE.test(command)) return command;
  return command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' ');
}

export function shellCommandHasWritePrimitive(command: string): boolean {
  const scanned = stripQuotedSegments(command);
  const hasOutputRedirect = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*(?!&?\d\b)(?!\/dev\/null\b)/.test(scanned);
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
 */
function heredocSpans(command: string): HeredocSpan[] {
  const heredocRe = new RegExp(HEREDOC_OPERATOR_SOURCE, 'g');
  const spans: HeredocSpan[] = [];
  let cursor = 0;
  for (let m = heredocRe.exec(command); m; m = heredocRe.exec(command)) {
    if (m.index < cursor) continue; // operator text inside an already-walked body
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
    heredocRe.lastIndex = cursor;
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
function stripHeredocBodies(command: string): string {
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
 */
const VISIBLE_WRITE_TARGET_RE =
  /^(?:\/[^\s]*\/)?(?:\.\/)?\.traffic-one\/(?:(?:runs|digests|reports|fix-cycles)\/.+|deployments\.jsonl)$/;

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
  for (const literal of trafficOnePathLiterals(scanned)) {
    const target = literal.replace(/["'`,;]+$/, '').replace(/\\/g, '/');
    if (VISIBLE_WRITE_TARGET_RE.test(target)) targets.push(target);
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

export function isLocalMjsPath(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !filePath) return false;
  const rel = unquotePath(filePath.replace(/\\/g, '/')).replace(/^\.\/+/, '');
  return rel.toLowerCase().endsWith('.local.mjs');
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
const CODEGRAPH_IGNORE_NAMES = new Set(['.gitnexusignore', '.graphifyignore']);

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

export function isCodeGraphIgnorePath(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !filePath) return false;
  const rel = unquotePath(filePath.replace(/\\/g, '/')).replace(/^\.\/+/, '').replace(/\/+$/, '');
  return CODEGRAPH_IGNORE_NAMES.has(rel);
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

export function applyPatchTargetPaths(patchText: unknown): string[] {
  if (typeof patchText !== 'string' || !patchText.trim()) return [];
  const parsed = parseApplyPatch(patchText);
  return parsed.ok ? patchOperationPaths(parsed.operations) : [];
}
