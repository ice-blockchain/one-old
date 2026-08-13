// src/modules/plan-guard/plan-readiness/index.ts
// The plan-readiness orchestrator: planReadinessViolations walks every gate
// in order. Helpers live in the sibling modules; digest completion gates in
// completion.ts. Deny PROSE comes from skill/SKILL.md via skillBlock.

import * as fs from 'fs';
import * as path from 'path';
import { readRegularFile } from '../../../shared/bounded-read';
import {
  buildRuntimeAssignments,
  capabilityProfileForRun,
  compileArchitectureForRun,
  ensureScaffoldContent,
  persistCompiledArchitecture,
  publishRuntimeAssignments,
  readCompiledArchitecture,
  uiAstLintLayer,
  validateArchitectureInput,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import { profileHasWebUi } from '../../../shared/capabilities';
import { collapsedLineNumber } from '../../../shared/collapsed-source';
import { supersedeSkippedDelegationFallback } from '../../../shared/maintenance/fallback';
import { isKnownStack } from '../../../shared/config';
import { isPluginAuthoringRoot } from '../../../shared/authoring-root';
import { detectMode } from '../../../shared/detection';
import {  stateRequiresNewProjectMonorepo } from '../../../shared/hook/paths';
import { hasMaterializedProjectAssets } from '../../../shared/materialize';
import { canonicalHost } from '../../../shared/model-tiers';
import { hostFlags } from '../../../shared/host/capability-flags';
import { openCodeDelegationActive } from '../../../shared/performance';
import { OPENCODE_PLAN_MIN_UNITS } from '../../../shared/opencode-roles';
import {
  preserveOpenCodeDelegateBlockForWrite,
  restorePlanOpenCodeDelegateBlock,
} from '../../../shared/opencode-plan/preserve';
import { obj } from '../../../shared/obj';
import {
  activateRunV2RollbackBarrier,
  writeRunSettlement,
} from '../../../shared/run-settlement';
import {
  canPublishRunPolicyBootstraps,
  ensureRunPolicyBootstraps,
  readRunModelPolicy,
} from '../../../shared/run-model-policy';
import { readActiveRunBootstrap } from '../../../shared/run-bootstrap-policy';
import {  matchesScope } from '../../../shared/scope';
import {
  analyzeI18nSourceText,
  detectExistingI18nContract,
  I18N_CATALOG_RE,
  I18N_SOURCE_RE,
  projectDeclaresI18nRuntime,
  validateI18nCatalogs,
} from '../../../shared/i18n-enforcement';
import {
  isNewProjectMode,
  isMaterialized,
  isNativeState,
  legacyStatePath,
  readRunAssignmentsResilient,
  resolveRunAgentContext,
  runLedgerClaimAdmission,
  stackFingerprint,
  statePath,
} from '../../../shared/state';
import { appendQualityFindings } from '../../../shared/state/quality-findings';
import { seedI18nCatalogKeys } from '../../../shared/i18n-seed';
import {
  buildVerificationContract,
  publishVerificationContract,
} from '../../../shared/verification-contract';
import { readVerificationPlanIntent } from '../../../shared/verification-plan-intent';
import {
  analyzeStructureText,
  analyzeStructureTextAgainstContract,
  invalidateStructureCache,
} from '../react-structure';

import {
  ARCHITECTURE_INPUT_RE,
  ARCHITECT_DIGEST_RE,
  ASSIGNMENTS_FILE_RE,
  PLAN_FILE_RE,
  RESET_RECORD_RE,
  type Block,
  type Rec,
  boundedScanTruncated,
  exists,
  recordScanIncomplete,
} from './context';
import {
  noImplementerRoleFallback,
  noImplementerRoleSummary,
  structureFindingSummary,
} from './checks';
import {
  ADR_OR_DOC_RE,
  ROOT_MONOREPO_FLAT_RE,
  ROOT_VITE_RE,
  hasOpenCodeDelegateMarker,
  missingOpenCodeDelegateBlock,
  missingProjectMemoryBaseline,
  openCodeQueuePolicyErrors,
  opencodeQueueBlocks,
  packageJsonMatchesWorkspaceRoot,
  planOnDiskHasOpenCodeDelegateMarker,
  planOnDiskMissingOpenCodeBlock,
  planOnDiskOpenCodeQueuePolicyErrors,
} from './architect';
import {
  architectMayWrite,
  architectureInputErrors,
  artifactContract,
  assignmentScopesForRole,
  assignmentWriterRole,
  digestClaimsVerdict,
  roleContract,
  runtimeOwnedRunSidecar,
  usesMainAgentTeam,
} from './contracts';
import { digestCompletionGates } from './completion';
import {
  contractSelfConflictFallback,
  contractSelfConflictSummary,
  contractSelfConflicts,
} from './satisfiability';

interface ReadinessArgs {
  filePath: string;          // project-relative target path
  content: string;           // write content (Write.content / Edit.new_string)
  // The bytes THIS write authors (Write content, Edit new_string, patch added
  // lines) as opposed to `content`, which for Edit/apply_patch is the whole
  // reconstructed post-write file. The existing-mode collapse scoping keys on
  // it: pre-existing collapse in the reconstructed file must not deny an
  // unrelated maintenance edit. Absent → fall back to judging `content`.
  addedContent?: string;
  // False when the target was inferred from a shell command whose write payload
  // cannot be reconstructed (e.g. `node -e` naming the file). Content-shape
  // gates then judge the on-disk artifact instead of an empty pseudo-payload.
  contentVerified?: boolean;
  // Heredoc payload behind a shell-derived target. Unverified shell text: only
  // gates that explicitly opt in may read it, and it never becomes `content`.
  shellBody?: string;
  projectRoot: string;       // resolved project root for the target
  state: Rec;                // readEffectiveState(projectRoot)
  writingFeatureSource: boolean;
  host?: string;
  rawData?: unknown;
  block: Block;
}

// The only write-time structural/i18n finding ids that still DENY: compiled-
// contract violations no tool can auto-fix, scope gaps, catalog data
// validation (single-file classes only — cross-locale parity findings carry
// `crossLocaleParity` and accumulate instead; see the split below), and
// collapse (an unconditional deny: write it formatted, see below).
// Every other finding accumulates into the run-scoped quality ledger and is
// batched into one document at the completion digest.
const HOT_WRITE_BLOCKING_IDS = new Set<string>([
  'STRUCT_ROUTE_MODULE_MISMATCH',
  'STRUCT_ASSIGNMENT_ALLOWLIST_GAP',
  'STRUCT_I18N_CATALOG',
  'STRUCT_COLLAPSED_LINE',
]);

// Readiness violations for a single write/edit. Empty array == nothing to block.
export function planReadinessViolations(args: ReadinessArgs): string[] {
  const { filePath, content, projectRoot, state, writingFeatureSource, rawData, block, host } = args;
  const contentVerified = args.contentVerified !== false;
  const violations: string[] = [];
  const currentHost = canonicalHost(host);
  const currentRunId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  const writerRole = assignmentWriterRole(projectRoot, state, rawData, host);

  const requiresMonorepoScaffold = stateRequiresNewProjectMonorepo(state);
  const architectureInputTarget = ARCHITECTURE_INPUT_RE.exec(filePath);

  if (ASSIGNMENTS_FILE_RE.test(filePath)) {
    violations.push(block('runtime-assignments-owner-gate',
      'Runtime contract gate: `.traffic-one/runs/<runId>/assignments.json` is generated atomically from CompiledArchitectureV1 and VerificationContractV2. Agents and the parent may not create, edit, widen, or replace it; change ArchitectureInputV1 and re-run PLAN_READY compilation instead.'));
  }

  // The reset record. A SEPARATE gate from the sidecar one below, and separate
  // for two measured reasons rather than for tidiness.
  //
  // It is not a run sidecar and must not be described as one: it sits above every
  // run id on purpose, the sidecar predicate cannot match it, and the sidecar
  // prose prescribes remedies (change ArchitectureInputV1, invoke the owning
  // transition) that this file has no equivalent of. And until this gate existed
  // it had NO fence of its own at all — every refusal on the path came from
  // `strayRunIdInText` reading the filename `.resets.json` as a fabricated run
  // id, which refused the write with instructions to write under
  // `.traffic-one/runs/<currentRunId>/` instead. Measured at this gate, that
  // accident left 7 of 27 erasure channels PERMITTED with a run pointer in place
  // and all 27 permitted without one, because the run-id guard stands down when
  // `currentRunId` is empty. Nothing here reads `currentRunId`: the record is
  // project-level, its `count` prices the next reset whatever run is live, and a
  // fence conditional on a pointer is a fence an actor can open by damaging the
  // pointer.
  //
  // Fires for every channel that reaches a target — Write/Edit/apply_patch
  // directly, and the shell shapes plan-write/reset-record-shell.ts reads out of
  // the command text, which include the ones that name no file.
  if (RESET_RECORD_RE.test(filePath)) {
    violations.push(block('reset-record-owner-gate',
      `Reset record gate: \`.traffic-one/runs/.resets.json\` is the project's record of every reset — how many have happened, and what each successor run inherited because of them. Traffic One's own recovery command is its only writer, and no agent, child or parent may create, edit, delete, truncate, move, replace or repair it through any channel. There is no correct run directory to write it under, so this refusal has no "write it somewhere else" remedy: it is not a run artifact and does not live inside a run. Erasing it USED to do two things — make the next reset free again, and drop the terminal model exhaustion a reset at or past the widening threshold handed the current run, which is what stops a role whose model is exhausted from respawning without the user's enable/retry answer. Both of those facts are now MIRRORED into the successor run's own \`runs/<runId>/run.json\` by the same reset that records them, and both readers take the record UNION that mirror with the user's enable/retry discharge ahead of both, so erasing THIS FILE ALONE moves neither decision: measured after a real \`rm\` through a spelling this fence does not see, the next reset is still priced at the height the ladder had reached and the inherited exhaustion still stands, and the user's answer still clears it in place. That is not the same claim as "erasing the record no longer pays", and it is deliberately not that claim — the mirror is a second copy inside the same project, so a command that takes the whole \`runs/\` directory takes both of them, and what the successor's \`run.json\` has instead of immunity is a fence of its own (\`runtime-sidecar-owner-gate\`) which was measured answering the three spellings below exactly as this fence answers them — the second copy is not better hidden, it is a different file, and being a different file is the whole of what it buys. READING it is allowed: \`cat\`, \`head\`, \`tail\`, \`grep\`, \`jq\`, \`wc\`, \`sed -n\` and an interpreter read of the path are all permitted. A command that names the record with any other verb is refused, because a file with no legitimate agent write has nothing to tell an unrecognised one apart from; so is a command that destroys a directory containing it (\`rm -rf .traffic-one/runs\`, \`git clean -fdx\`). A shell line that hides the path from static reading stood here as a five-member list — assembled by \`cd\`, a variable, \`$(…)\`, \`eval\`, or joined inside interpreter code — and the round that taught this fence to read the shell the way its sibling does falsified three of the five, so what follows is what was re-measured rather than what was inherited. REFUSED now, in all three project states: \`cd .traffic-one/runs && rm -f .resets.json\` and its \`;\` spelling, \`R=.traffic-one/runs; rm -rf "$R"\`, and an interpreter join that leaves any fragment spelling \`.traffic-one\` or this file's own name (\`'.traffic-one/' + 'runs/.resets.json'\`). STILL UNSEEN, which is a breach this gate cannot see rather than a route it permits, each one measured erasing this file in real bash at no refusal: what a substitution PRINTS (\`rm -rf "$(cat where)"\`); a \`$( … )\` body or a literal \`eval\` in the two states where no run directory exists for a sibling fence to answer first (\`rm -rf "$(echo .traffic-one/runs)"\` and \`eval "rm -rf .traffic-one/runs"\` are refused while a run directory is live and were measured NOT REFUSED once it is gone, which is when this file is the only thing left below \`runs/\`); and a join that splits both names through the middle (\`'.tra' + 'ffic-one/runs/.res' + 'ets.json'\`). That is what has been MEASURED to be unseen, in the states it was measured in, and not a proof that nothing else is. WHAT THOSE THREE NOW BUY is the other half of the same measurement, and it is the mirror above rather than any refusal that changed it: aimed at this file alone, they buy nothing — both decisions read the same before and after the erasure. Aimed at the whole \`runs/\` directory they still take both copies at no refusal, and the printed-substitution spelling was measured doing exactly that; aimed at either file alone they take one copy and the other still answers. So the unseen list above is unchanged, only the payoff of its narrowest use has moved, and a tree-wide erasure is recorded here as a known breach rather than implied to be closed. If the record itself is genuinely in the way, that is an operator decision made outside the agent, not a write to re-issue.`));
  }

  if (runtimeOwnedRunSidecar(filePath) && !ASSIGNMENTS_FILE_RE.test(filePath)) {
    violations.push(block('runtime-sidecar-owner-gate',
      `Runtime sidecar gate: \`${filePath}\` is generated and atomically published by Traffic One runtime. Agents, children, and the parent may read it but may not create, edit, delete, widen, replace, or repair it. Write/Edit/apply_patch are refused outright. Shell is refused through two rules with OPPOSITE polarities, and the difference between them is the whole design. (1) THE READ RULE, asked of EVERY simple command of every shell line — not of a list of binaries — and asked wherever the path is spelled: at top level, inside a \`bash -c\`/\`sh -lc\`/\`fish -c\` body, inside a heredoc a shell or interpreter reads as code, and inside an interpreter eval body under \`-e\`/\`-p\`/\`-r\`/\`--eval\`/\`eval\`. Wherever the command text spells this path, EVERY CALL IN THE STATEMENT THAT SPELLS IT must be a recognised read, every open mode must be a read mode, and a path named in shell position rather than inside a call must be named by a verb that only reads. Everything else is refused, so a destructive spelling nobody has written down yet is refused for NOT BEING A READ rather than permitted for not being recognised: \`zipfile.ZipFile(p,'w')\`, \`File.open(p, File::WRONLY|File::TRUNC)\`, \`Pathname.new(p).delete\`, \`path(p)->spew_utf8("")\`, \`os.renames(p, …)\`, a verb assembled at runtime (\`fs['un'+'link'+'Sync']\`), and equally \`awk 'BEGIN{print "" > p}'\`, \`curl -o p\`, \`openssl enc -out p\`, \`ex -sc '%d|x' p\` and an alias-escaped \`rm\` — none of which appears in any verb list this gate keeps. THE UNIT IS THE STATEMENT, NOT A PATH THROUGH IT, so a destruction BESIDE the occurrence is the same case as one above it: \`list(map(lambda f: ZipFile(f,'w'), [p]))\`, \`[ZipFile(f,'w') for f in glob.glob(p)]\`, \`[q.unlink() for q in Path(<runs dir>).glob('*/run.json')]\`, \`Dir.glob(p).each { |f| Pathname.new(f).delete }\`, \`ZipFile(str(p),'w')\`, \`os.unlink(os.path.abspath(p))\` and \`console.log(unlinkSync(p))\` are all refused, and a separator quoted to end the statement early (\`ZipFile('; cat x'[0:0] + p,'w')\`) does not shorten it. A MODE THAT IS NOT A RECOGNISED READ is refused for the same reason, including one bound to a variable (\`m='w'; open(p,m)\`), computed, or written as numeric flags (\`os.open(p, 1|512|1024)\`); \`'r'\`, \`'rb'\`, \`'r:UTF-8'\`, perl's \`'<'\`, \`O_RDONLY\`, \`{read:true}\` and no mode at all are reads. An INTERPOLATED path is refused through the directory its literal part names, so a template literal or f-string over \`…/runs/<var>/run.json\` and \`rm -rf .traffic-one/runs/$OLD_RUN\` are both refused even where the same deletion with the id spelled out is permitted housekeeping — spell the id if you mean a finished run; a path whose FIRST segment is interpolated is judged on what the REST of the literal spells, not on the part that is unreadable: \`rm -rf "$(pwd)/dist"\`, \`rm -f "$f"\`, \`rm -rf "$TMPDIR/scratch"\`, \`mv "$src" dist/out.js\` and \`cp assets/logo.svg "$dest"\` name no \`.traffic-one\` path at all and are not refused, while \`rm -rf "$PWD/.traffic-one/runs"\` and \`rm -rf "$ROOT/.traffic-one/runs"\` spell this tree in full under whatever root the variable holds and are refused, as are — ONE MEASURED SPELLING AT A TIME rather than a class asserted complete — the braced \`"\${PWD}/…"\`, the \`"$(pwd)/…"\` one, one with a \`./\` in the middle, the unquoted \`$PWD/…\`, and each of those written with the closing quote after the VARIABLE instead of after the path (\`"$PWD"/.traffic-one/runs\`). THIS SENTENCE USED TO READ "in any of its spellings", naming the braced and \`$(pwd)\` forms as instances of a totality, and while it said so the quote-after-the-variable group was measured at NO REFUSAL, erasing every file under the runs tree including the reset ledger; it is a list of what was measured now for exactly that reason — including when that root would have turned out to be some other project's, which this gate cannot resolve and will not guess about. A CLOSING QUOTE FOLLOWED BY MORE PATH IS ONE WORD, as it is to the shell: \`R=.traffic-one/runs; rm -f "$R"/<id>/run.json\` is the sidecar and is refused, in that spelling, in the braced \`"\${R}"\` spelling, and through a loop over \`"$R"/*/run.json\`. The head may be BOUND IN THE COMMAND or supplied by the SHELL, and until round 10 only the first was: \`"$PWD"/.traffic-one/runs\`, the \`"\${PWD}"\`, \`"$(pwd)"\` and \`"$OLDPWD"\` versions of it, and \`".traffic-one"/runs/../runs\` each erased the whole runs tree at no refusal, because the word was SPLIT at the closing quote and the residue was then judged alone — \`/.traffic-one/runs\`, an absolute path resolving outside the project and naming nothing there. Every stage answered its own question correctly and the composition was wrong, which is why the unit is the shell WORD and both rules above assemble it the same way: a word from which any stage removed or failed to resolve a piece carries that fact into the judgement, and the remainder is not read as a path of its own. It used not to be — the remainder after the quote was read as an ABSOLUTE path, \`/<id>\` was adopted as the project root, and both rules above then ran against a directory that does not exist and found nothing, which is the worst shape a refusal can fail in: silent, permitting, and identical for every command whose path a variable holds. GLOB METACHARACTERS ARE NOT LITERAL EITHER, and they name whatever they match: \`rm -rf .traffic-one/run?\`, \`.traffic-one/[r]uns\`, \`.traffic-one/[a-z]uns\`, \`.traffic-one/[!x]uns\`, \`.traffic-one/ru*\`, \`.traffic*/runs\`, \`.traffic-one/runs/1715*\` and \`.traffic-one/runs/*/run.jso?\` are all refused, because Traffic One is handed the pattern and never the expansion. A pattern that CANNOT match this tree is not refused — \`rm -rf .traffic-one/c?che\` cleans the cache, \`rm -rf *\` does not reach a dotfile at all, and \`rm -rf .traffic-one/runs/<a finished run's prefix>*\` is the same housekeeping the id spelled out would be. A WORD IS ASSEMBLED BEFORE IT IS JUDGED, so shell-level quoting does not hide it: \`.traffic-'one'/runs\`, \`".traffic-one"/runs\`, \`.traffic-one/'runs'\` and the ANSI-C \`$'.traffic-one/run\\x73'\` are the same path and are refused as one. Quotes are removed only where removing them cannot change how the line splits, so \`grep "foo;bar" ${filePath}\` keeps its pattern and stays a read. A CHARACTER THAT DOES NOT DENOTE ITSELF MAKES THE WHOLE LITERAL UNREADABLE, and that is asked as an allowlist rather than as a list of metacharacters: a literal counts as the path it spells only when every character in it is one a shell hands through a word unchanged, and anything else — an expansion, a backtick, a BACKSLASH ESCAPE, a brace, a glob, a quote that survived assembly, a tilde at the head of the word — leaves it unresolved, in which case its longest complete directory prefix and what the \`.traffic-one\` remainder spells decide it. An unquoted backslash is resolved the way a shell resolves it, so \`rm -rf .traffic\\-one/runs\` is refused, as are \`run\\s\`, \`\\runs\`, \`.\\traffic-one/runs\` and the same escape inside a partly quoted word — five spellings that name exactly this tree to bash and erased it at no refusal until round 10; \`\\\` before a newline is a line continuation and disappears, while a backslash inside single quotes stays, because there it is data. \`\\find . -name run.json -delete\` is refused too, that escape having hidden the VERB rather than the path, and \`find . -name \\*.json -delete\` is refused because a \`-name\` pattern this gate cannot read may match anything rather than nothing. Asking it in this direction is the point: a metacharacter nobody here has written down leaves a literal unresolved on the day it arrives instead of the day someone destroys a run with it. An unreadable literal that does not spell this tree is not refused (\`rm -rf ~/Downloads/tmp\`, \`rm -rf "$TMPDIR/scratch"\`). A PARAMETER EXPANSION IS JUDGED ON THE VALUE IT CAN PRODUCE, and the bindings in the command are part of that value: names and expansions are resolved TOGETHER, so \`runs=.traffic-one/runs; rm -rf "\${runs:-nosuch}"\` is refused on what \`runs\` holds and not permitted on the default word that never applies. Every operator that can yield this tree is covered — the defaults \`:-\`/\`-\`/\`:=\`/\`=\`, the alternates \`:+\`/\`+\`, the error forms \`:?\`/\`?\` (whose WORD is a message, but whose VALUE still deletes when the name is set), indirection \`\${!n}\`, substrings \`\${v:off}\`/\`\${v:off:len}\`, suffix and prefix removal \`\${v%pat}\`/\`\${v%%pat}\`/\`\${v#pat}\`/\`\${v##pat}\`, replacement \`\${v/pat/rep}\`/\`\${v//pat/rep}\`, and a default nested inside a default. What an operator does NOT produce is not invented: \`\${#R}\` is a LENGTH and never a path, \`\${R##*/.}\` over \`zz/.traffic-one/runs\` leaves \`traffic-one/runs\`, which is a different directory, and \`rm -rf "\${RUNS:?.traffic-one/runs}"\` with \`RUNS\` unset exits rather than deleting — all three permitted, all three ground-truthed as no-ops. Two rounds of history, because both were fail-open and both were structural: until round 8 only \`:=\` was refused and \`:-\` was not, its \`-\` being swallowed as a flag; round 8 then fixed defaults and bindings as two sequential textual rewrites, the first of which replaced the expansion with its default word and destroyed the name the second needed, which cost nine more whole-tree erasures at no refusal. One value model is the reason this list can be stated at all. An ESCAPED QUOTE inside a double-quoted \`-c\` body is unescaped before the body is judged, so a \`bash -c\` whose body wraps this path in backslash-escaped quotes is refused; the body used to arrive with those backslashes still attached, one character too long to match anything, and erased every sidecar at depth 1. THE VERB IS THE FIRST REAL COMMAND WORD, so shell grammar does not change any of the above: \`if\`/\`then\`/\`for\`/\`while\`/\`case\`/\`do\`/\`!\`, a leading \`VAR=value\`, and the transparent prefixes \`env\`/\`nohup\`/\`sudo\`/\`command\`/\`timeout\` are skipped to reach it; a SUBSHELL \`( … )\`, a brace group \`{ …; }\` and a command substitution \`$( … )\` are re-entered as command lists and their own contents judged; and \`for f in <paths>; do … done\` is judged with the binding RESOLVED, so a body that reads \`"$f"\` is permitted and one that deletes it is refused. (2) THE UNNAMED-DESTRUCTION RULE, for a command that names no runtime path, where there is no occurrence to judge a position of and a verb set is the only instrument available: \`rm -rf\` on the run directory or the project root, a \`find\` sweep whose action is not a recognised READ (\`-delete\`, or an \`-exec\`/\`-execdir\`/\`xargs\` action that is anything other than a reading verb — \`rm\`, \`shred\`, \`truncate\`, \`gzip\`, \`sed -i\`, \`cp\`, \`tee\`, and equally a WRAPPER whose body writes, \`-exec sh -c '…rm…' _ {}\`, because a \`-c\` body is re-entered as a command list rather than matched against a list of wrapper names; \`-exec cat {}\`, \`-exec grep -l x {}\`, \`-exec sort {}\` and \`-exec sh -c 'cat "$1"' _ {}\` are reads and stay permitted — the action's VERB is asked FIRST and its flags mean whatever that verb makes them mean, because an eval flag is an eval flag only on an INTERPRETER: \`-exec jq -r\`, \`-exec grep -E\`, \`-exec grep -e\`, \`-exec grep -c\`, \`-exec wc -c\`, \`-exec head -c\`, \`-exec tail -c\`, \`-exec sort -r\`, \`xargs jq -r\` and \`xargs grep -c\` are ordinary read sweeps and are permitted, while \`-exec sh -c\` and \`-exec python3 -c\` are re-entered as code; asking the flag before the verb refused all ten of those reads for one round, and the \`-exec grep -l x {}\` recorded here as permitted survived that round only because \`l\` happens not to be in the flag class), \`dd of=\`, \`install\`, \`rsync\`, \`tar -x -C\`, a replacing compressor, a named output (\`sort -o\`, \`unzip -d\`, \`patch\`), and any git spelling whose purpose is to override git's own refusal to clobber a locally modified tracked file: \`clean -f\`, \`checkout\`, \`checkout -f\`, \`restore\`, \`switch --discard-changes\`, \`reset --hard\`, \`rm\`, \`mv\`, \`stash\`, \`checkout-index -f\`, \`read-tree -u\`, \`sparse-checkout set\`, \`submodule update --force\`, and the \`--abort\` of \`merge\`/\`rebase\`/\`cherry-pick\`/\`revert\`/\`am\`. An ordinary \`git merge\`, \`rebase\`, \`cherry-pick\`, \`revert\` or \`pull\` is NOT refused, because git itself stops rather than overwrite a modified tracked file. This rule is fail-OPEN by construction — a verb nobody wrote down is admitted — which is why rule (1) exists and why it is the one that carries the unknown spellings. Reading is what stays permitted, and is the list that is maintained: \`cat\`, \`head\`, \`tail\`, \`grep\`, \`rg\`, \`jq\`, \`wc\`, \`ls\`, \`stat\`, \`diff\`, \`cmp\`, \`sed -n\`, \`awk\` with no output redirect in its program — a COMPARISON is not one, so \`awk 'length($0) > 10 {print}'\` reads while \`awk '{print > "out"}'\` does not — \`sort\` with no \`-o\`, \`gzip -c\`, \`git log\`/\`git diff -- <path>\`/\`git show\`, a \`find\` sweep whose action does not write, \`readFileSync\`, \`open(p)\` and \`open(p,'r')\`, \`File.read\`, \`Path(p).read_text()\`, \`Pathname.new(p).read\`, \`file_get_contents\`, \`Deno.readTextFileSync\`, perl's \`open(my $fh, '<', p)\`, stat fields and byte/text conversions over what was already read (\`os.stat(p).st_size\`, \`statSync(p).mtimeMs\`, \`open(p,'rb').read().decode()\`), path arithmetic (\`os.path.join\`, \`basename\`), and printing the path. WHAT THIS COSTS, because a fail-closed rule refuses reads it does not recognise and the refusals are real: a verb that reads this path without being on that list is refused anyway — \`cp ${filePath} backup.json\`, \`dd if=${filePath}\`, and \`echo "see ${filePath}"\` or \`printf\` of the path, which write nothing at all — \`tar -cf backup.tgz <runs dir>\` was listed here too and is measurably NOT refused, because creating an archive reads the tree and only \`-x\` writes it; a \`find\` action that hands the file to an INTERPRETER rather than to a verb (\`-exec python3 -c '<code>' {}\`) is refused whatever the code does, because the operand arrives as \`sys.argv[1]\` and there is nothing left to judge — spell the read as \`-exec cat {}\`; READING this path into an OUTPUT is refused whatever the reading verb is and wherever the output goes (\`cat ${filePath} > out.txt\`, \`jq . ${filePath} > pretty.json\`, \`awk '{print}' ${filePath} > summary.txt\`, \`cat ${filePath} | tee out.txt\`, \`cat ${filePath} | jq . > pretty.json\`), because the command as a whole writes and this path stands inside it — measured, all five, with no in-command remedy: read it in one command and write the result in the next; an interpolated ROOT that this gate cannot resolve is refused when the rest of the literal spells this tree (\`rm -rf "$ELSEWHERE/.traffic-one/runs"\`, \`rm -rf "dist/$X/.traffic-one/runs"\`), even when the root would have turned out to be somewhere else entirely; and an incomplete \`for NAME in <paths>\` with no \`do … done\` to bind into is refused because an unresolved binding is judged on nothing — including the GLOB spelling (\`for f in .traffic-one/runs/*/run.json\`), which this paragraph recorded as an unseen residue until globs became readable and which is now the same cost as the literal one; the path spelled OUTSIDE an interpreter body and read through it (\`python3 -c 'print(open(sys.argv[1]).read())' ${filePath}\`, \`os.environ["RF"]\`) is refused because the occurrence sits in shell position under the verb \`python3\` — spell the path inside the body, or read it with \`cat\`; a single statement that reads this path AND calls something that is not a read, even about an unrelated path, is refused as one unit — use two commands; and \`os.removedirs(<run dir>)\` is refused although it would raise on a non-empty directory; METADATA on a sidecar is refused although it moves no content — \`chmod 644 ${filePath}\` and \`touch -r package.json ${filePath}\`, both ground-truthed as no-ops on the bytes — because a mode of \`000\` breaks the next publish as surely as a truncation and a \`touch\` of a MISSING sidecar fabricates one the runtime never wrote, so leave it alone and let the runtime rewrite it; and two CONVENIENCES around a run directory fall under the same operand-role limit that refuses \`cp -r <runs dir> <backup>\` — \`ln -s <run dir> latest-run\`, whose write is at the symlink and whose read is the run, and \`mkdir -p <run dir>/debug\`, which is idempotent on a directory that already exists. The symlink is the one of those two whose refusal is load-bearing rather than cheap, and it was measured: once the link exists, \`rm -f latest-run/run.json\`, \`truncate -s 0 latest-run/run.json\` and \`find -L latest-run -name run.json -delete\` are all \`noop\` and all destroy the sidecar, because a path through the link spells no \`.traffic-one\` literal for either rule to judge. Permitting the link would buy a laundering route for every command after it, so it stays refused; name the run directory itself when you want to reach it. A LITERAL THIS GATE CANNOT READ IS PRICED AT ITS READABLE PREFIX, so a name carrying a character the allowlist declines is refused inside \`.traffic-one\` even where it names nothing — a backslash-escaped space (\`rm -rf .traffic-one/my\\ cache\`), a semicolon or a parenthesis inside a quoted name — while a QUOTED space is data and is not (\`rm -rf ".traffic-one/my cache"\` is permitted), and no such name outside \`.traffic-one\` is refused at all. A NAME IS SPLIT WHERE BASH SPLITS IT — on a SPACE, a TAB or a NEWLINE — and every other character JavaScript calls whitespace is DATA here for the same reason it is data to bash: the no-break space a browser paste leaves behind, a macOS Option-Space, the rest of the Unicode space block, and \`\\v\`, \`\\f\` and \`\\r\`, each ground-truthed with the word unquoted in operand position against a real bash, which forms ONE word from all of them. THIS CLAUSE USED TO READ "as is a non-ASCII name", promised beside the quoted-space one, and while it said so \`rm -rf .traffic-one/runs<U+00A0>x\` and its quoted spelling were both refused in every project state, against a ground truth of nothing moved, because a splitting class spelled as JavaScript's \`\\s\` cut the word at the no-break space and the remainder read as the runs ROOT — so the deny the developer read named the gate that owns \`assignments.json\`, which their command had nothing to do with. Both spellings are permitted now, and so are the other Unicode space characters measured beside them. The promise is the CLASS rather than that one character, and one member of the class is a KNOWN COST rather than a fix: \`\\v\`, \`\\f\` and \`\\r\` are data to bash but are not characters the allowlist above accepts as denoting themselves, so a \`.traffic-one\` name carrying one is priced at its readable prefix and refused in all three project states — by the rule this sentence opens with, rather than by an accident of a regex. FOUR REFUSALS THIS PARAGRAPH NEVER DISCLOSED ARE GONE, each ground-truthed as touching nothing: \`xattr -l ${filePath}\` LISTS extended attributes and is a read, where \`-w\`/\`-d\`/\`-c\` still refuse; \`exec 3< ${filePath}; cat <&3\` is a read through a file descriptor, where \`3<>\` opens for writing too and still refuses; \`lsof +D <runs dir>\` asks who holds a sidecar open, which is the first thing to ask when a publish looks stuck; and \`rsync -an <runs dir> <backup>\` is a DRY RUN that writes nothing by construction, while the real copy stays refused. An alias-escaped verb resolves to the verb it escapes in both directions, so \`\\cat ${filePath}\` reads and \`\\rm -rf <runs dir>\` does not. A refused dry run is the worst false refusal a fence over this tree can produce: it is the command reached for in order to destroy nothing — WHICH IS WHY BOTH OF THOSE SENTENCES ARE RECORDED HERE AS HAVING SHIPPED WHILE THE DRY RUN WAS STILL REFUSED. "GONE" was measured at THIS fence and at no other: the reset record's fence reads the same command text for its own file, it had no dry-run test at all, and it refused \`rsync -an\`, \`rsync -a -n\` and \`rsync -a --dry-run\` with \`reset-record-owner-gate\` in every project state named at the end of this paragraph, against a ground truth of nothing moved — so the sentence was true of the reader it was taken from and false of the product, because a refusal survives from ANY fence that can produce one and a permission has to be measured at all of them. All three spellings are permitted at both fences now, measured in all three states, while \`rsync -a --delete <backup> <runs dir>\` — which erases the reset record in real bash — is refused in all three. FINISHED-RUN HOUSEKEEPING IS ASYMMETRIC, which was true and undisclosed: deleting a finished run's DIRECTORY by its real id (\`rm -rf .traffic-one/runs/<finished id>\`) is permitted, while deleting one FILE inside that same directory (\`rm -f .traffic-one/runs/<finished id>/run.json\`) is refused — the directory question is answered by the run-rotation exemption and the file question by per-file ownership, and they do not meet. The exemption also needs the id to be a real one: an id of the shape the runtime mints (13 digits) that names no directory on disk, and any id that is not of that shape, are both refused as a run-id mismatch rather than treated as housekeeping. Remove the directory, or leave the run alone. WHAT REMAINS UNSEEN, which are breaches this gate cannot see rather than routes it permits — and this is what has been MEASURED to be unseen, not a proof that nothing else is, a distinction this paragraph used to get wrong by claiming the list "is the whole of it" while four escapes were open: a PATH for which no complete \`.traffic-one\` literal survives in the command text AND whose assembly is an INTERPRETER's rather than the shell's — concatenated inside code (\`'.traffic' + '-one/…'\`), computed (\`chr(46)\`), decoded (base64, hex), or produced as the OUTPUT of a substitution rather than spelled in it (\`rm -rf "$(cat where)"\`, \`CMD=$(cat where); eval "$CMD"\` — the body of a \`$( … )\` is judged, so \`rm -rf "$(echo <runs dir>)"\` is refused, but what a body PRINTS cannot be) — because each spelling is judged where it appears and following a value needs an interpreter rather than a position. FIVE entries stood in this list that measurement then found REFUSED, and they are named because a residue list that over-claims teaches the wrong lesson as surely as one that under-claims: a path joined over split segments (\`os.path.join('.traffic-one','runs',…)\`), one hidden behind \`cd\` (\`cd .traffic-one/runs && rm -rf run-1\`, its \`;\` and subshell spellings), one hidden behind a literal \`eval\` (\`eval "rm -rf <runs dir>"\`), and one BOUND TO A NAME in an INTERPRETER and destroyed through the name (\`p=str('…/run.json'); zipfile.ZipFile(p,'w')\`) are all refused. The fifth is the TILDE, which stood here as unseen with a note that the \`$HOME\` spelling of the same path IS refused — an inconsistency written down as a distinction, since \`~\` and \`$HOME\` denote one root. All four spellings are refused now (a bare \`~\` head, an unquoted \`$HOME\` one, a quoted one, and one with the closing quote after the variable), on the fail-closed ground this paragraph already gives for a root it cannot resolve, and the price is stated there: refusing another project's runs tree costs a rewording, permitting this one's costs the run. \`~+\` and \`~-\` were never HOME-relative to begin with — they are \`$PWD\` and \`$OLDPWD\` — so \`rm -rf ~+/.traffic-one/runs\` names THIS project under any HOME whatsoever, and it erased the whole runs tree at no refusal until round 10. A SHELL binding is resolved too — the \`for\` binding and an assignment, scalar or array — so a name bound to this tree and then deleted through \`"$d"\`, through a braced reference, or through an array subscript is refused, as is a name built from another name (\`d=.traffic-one; e="$d/runs"; rm -rf "$e"\`), where until round 8 an ARRAY assignment was read as an expression grouping and destroyed the tree unseen; a BODY that never appears in the command text (arriving through a pipe instead of being spelled on the command line); and a PROJECT SCRIPT that does it (\`npm run reset:state\`), whose bytes are in package.json. \`-c\` NESTING IS NOT IN THAT LIST and used to be: "more than four levels" was recorded here and did not survive measurement — and neither did the figure that replaced it, which read "a deletion is refused and a read is permitted at every depth from 0 to 12, in both quoting alternations". That was narrower than it sounded and part of it was measured on a MALFORMED command: a driver that escapes the quotes of a double-quoted body but not its BACKSLASHES emits, from depth 3, a literal backslash and an early end of string, which is a different command and is what made a deep nest first look permitted and then look unseen. The figure has now been wrong three times and the driver was the cause every time, so it is stated PER SPELLING, from 63 commands each built, PRINTED, then run against a real bash over a real sidecar tree before any gate was asked. The three spellings are the double-quoted nest with quotes AND backslashes escaped (220 bytes at depth 6), the single-quoted nest whose body must re-quote itself as \`'"'"'\` (1538 bytes at depth 6, because each level roughly triples), and the mixed nest an agent actually types — single-quoted while the body holds no \`'\`, double-quoted once it does (158 bytes at depth 6). A DELETION IS REFUSED AT EVERY DEPTH FROM 0 TO 6 IN ALL THREE, measured twice over: 21 whole-tree deletions, each of which erased the tree completely when run (144B/12f to 0B/0f), and 21 deletions of a single named sidecar, each of which erased that file. The two arms answer different questions and both are worth having — a whole-tree delete is refused by the sibling gate that owns \`assignments.json\` and reaches it first, so only the single-file arm shows THIS gate's refusal surviving all six layers. A READ is permitted at every depth from 0 to 6 in the double-quoted and mixed spellings; in the \`'"'"'\` spelling it is permitted at depths 0 and 1 and REFUSED from depth 2 up, because a \`-c\` body capture ends at the first \`'\` and a re-quoted body is not one token. That is five refused reads, a cost in this paragraph's sense rather than a breach, and it is the only nesting cost measured. The double-quoted spelling was unseen from depth 2 up until round 8 closed five ground-truthed erasures, and the depth-5 and depth-6 READS are what hold the residual wrapper's body emptied — without it they are refused. A statement holding more than two hundred calls is NOT in that list — it is unresolved, and unresolved is refused. EVERY FIGURE ABOVE WAS MEASURED IN ONE PROJECT STATE, AND UNTIL NOW NONE OF THEM SAID SO: a project with a LIVE run directory, \`.traffic-one/runs/<runId>/\` holding real sidecars. The runtime passes through two others — a FINISHED run, its pointer set and its directory gone while an older run's directory is still on disk, and POST-RESET, \`runs/\` holding the reset record and nothing else — and what changes there is not this gate's own answer to a named sidecar, which is the same in all three, but WHICH FENCE ANSWERS AT ALL: a whole-tree spelling like \`rm -rf .traffic-one/runs\` is refused in the live state by the sibling that owns \`assignments.json\` and reaches it first, and in the other two by the reset record's fence, which is a different gate with different prose and, until the round that wrote this sentence, a quote-blind reader of its own. Two claims above are true only in the live state and are named rather than reworded, because their shape is the lesson: \`rm -rf "$(echo <runs dir>)"\` and \`eval "rm -rf <runs dir>"\` are refused with a run directory present and were measured NOT REFUSED in both of the other states, where each erases the whole tree including the reset record — which is exactly the state in which that record is the only thing left to destroy, and it is that record's own paragraph that names the routes to it that stay unseen. Of everything else stated above, what was re-priced across the three states did not move, and what was not carries the state it was taken in, which is the live one. A coverage figure with no project state in it is not a figure, and the escape that was found by asking for one had been live for as long as this paragraph had been priced without it. If you want \`git stash\` here, name the paths you actually mean — \`git stash push -m wip src\` is permitted. Otherwise change the semantic ArchitectureInputV1 or invoke the owning runtime transition instead.`,
      { TARGET: filePath }));
  }

  const childArtifact = artifactContract(filePath, currentRunId);
  if (obj(state.team)?.mode === 'subagents' && childArtifact) {
    const bootstrap = writerRole === childArtifact.role
      ? readActiveRunBootstrap(projectRoot, childArtifact.runId, childArtifact.role)
      : null;
    const scope = bootstrap
      ? {
          include: bootstrap.workUnit.allowlist,
          exclude: bootstrap.workUnit.allowlistExclude,
        }
      : null;
    if (childArtifact.runId !== currentRunId
      || !bootstrap
      || !bootstrap.workUnit.outputs.includes(filePath)
      || !scope
      || !matchesScope(filePath, scope)) {
      // Name WHY the role is unresolved. `Active role is unresolved` alone sent
      // orchestrators into respawn loops chasing a spawn-ordering race, when the
      // real cause was a closed run ledger that no respawn could fix.
      //
      // Three-valued, because the boolean this used to ask cannot distinguish a
      // closed ledger from one it could not READ: `runLedgerAdmitsClaims` answers
      // `true` for both an active run and a truncated `run.json`, so an illegible
      // ledger produced NO note at all — the deny then said only "Active role is
      // `unresolved`", which is the bare wording this note exists to replace. The
      // `closed` arm is left exactly as it was, including its answer for an empty
      // `currentRunId` (`runLedgerClaimAdmission` reports `closed` for a blank id,
      // as the boolean did), so only the previously-silent case moves.
      const admission = runLedgerClaimAdmission(projectRoot, currentRunId);
      const unresolvedNote = writerRole
        ? ''
        : admission === 'closed'
          ? ` The run ledger for \`${currentRunId}\` is settled, so NO child can bind a role in it — respawning cannot fix this; the run must be replaced.`
          : admission === 'unknown'
            ? ` The run ledger for \`${currentRunId}\` (\`.traffic-one/runs/${currentRunId}/run.json\`) cannot be read or parsed, so NO child can bind a role in it and neither resuming nor settling the run will work — every one of those returns \`ledger-corrupt\`. Respawning cannot fix this and no agent may repair that file; ask the user to restore it from version control or delete it, then mint a fresh run.`
            : '';
      violations.push(block('run-artifact-work-unit-gate',
        `Run artifact gate: \`${filePath}\` may be written only by the parent-bound \`${childArtifact.role}\` child whose current, hash-valid WorkUnitContract names this exact output. Active role is \`${writerRole || 'unresolved'}\`; no digest, QA report, or deployment claim may self-authorize or borrow another run's bootstrap.${unresolvedNote}`,
        {
          TARGET: filePath,
          ROLE: writerRole || 'unresolved',
          EXPECTED_ROLE: childArtifact.role,
        }));
    }
  }

  if (writerRole === 'senior-architect'
    && filePath
    && !ASSIGNMENTS_FILE_RE.test(filePath)
    && !architectMayWrite(projectRoot, filePath, currentRunId)) {
    violations.push(block('architect-planning-allowlist-gate',
      `Architect scope gate: \`senior-architect\` may write only the semantic plan/project-memory files, NEW ADRs under \`.traffic-one/decisions/<name>.md\` (existing ones are append-only across runs — use the \`${currentRunId || '<runId>'}-\` prefix to rewrite your own), \`.traffic-one/runs/${currentRunId || '<runId>'}/architecture-input-v1.json\`, and its architect digest. \`${filePath}\` is runtime- or implementer-owned. Do not scaffold packages, workspace/config/source files, barrels, Tailwind assets, tests, or assignments; emit semantic ArchitectureInputV1 and let runtime compile the work units.`,
      { TARGET: filePath }));
  }

  if (architectureInputTarget) {
    if (writerRole && writerRole !== 'senior-architect') {
      violations.push(block('architecture-input-owner-gate',
        `Architecture input gate: only the parent-bound \`senior-architect\` planning role may write ArchitectureInputV1; active role is \`${writerRole}\`. Retrying the write, or making it through shell instead, draws the same refusal — the owner is decided by the run's role claim, not by the tool. Record the semantic change you wanted (routes, modules including component placement, exact UI primitive identifiers, i18n locale/exact-brand intent, or a narrow exception request) in your own digest instead, and let the orchestrator route it to \`senior-architect\`, who owns this artifact and re-runs PLAN_READY compilation from it.`,
        { ROLE: writerRole }));
    }
    if (contentVerified) {
      const errors = architectureInputErrors(content);
      if (errors.length > 0) {
        violations.push(block('architecture-input-gate',
          `Architecture input gate: ArchitectureInputV1 may contain only semantic routes, modules (including component placement), exact UI primitive identifiers, i18n locale/exact-brand intent, and narrow exception requests. Runtime owns profiles, roots, roles, limits, output paths, and the baseline. Fix: ${errors.join('; ')}.`,
          { ERRORS: errors.join('; ') }));
      }
    } else {
      // Shell-inferred target: the payload is not reconstructable, so judge the
      // artifact already on disk. A valid on-disk file means this is almost
      // certainly a read/diagnostic (observed 3co: the architect running the
      // plugin's own validateArchitectureInput via `node -e` was denied with a
      // message blaming a file that was valid the whole time). Only a missing
      // or invalid on-disk artifact keeps the deny — and says what is actually
      // wrong instead of accusing the file when the COMMAND is the unknown.
      const diskErrors = ((): string[] => {
        try {
          // BOUNDED (shared/bounded-read.ts). `filePath` here came out of a
          // SHELL COMMAND the agent wrote, so the path this opens is chosen by
          // the party being gated — the one population where an unbounded open
          // is not a hazard but a mechanism. A non-regular object joins the
          // arm an unreadable artifact already took.
          const text = readRegularFile(path.join(projectRoot, filePath));
          if (text === null) return ['architecture input file is not a regular file'];
          return architectureInputErrors(text);
        } catch {
          return ['architecture input file does not exist on disk yet'];
        }
      })();
      if (diskErrors.length > 0) {
        violations.push(block('architecture-input-shell-unverified',
          `Architecture input gate: this shell command references \`${filePath}\` but its write payload cannot be reconstructed for validation, and the current on-disk file is not valid ArchitectureInputV1 (${diskErrors.join('; ')}). Read-only checks pass once the on-disk file is valid; to (re)write it, use the role-scoped Write/Edit tools with the complete semantic JSON instead of shell eval.`,
          { TARGET: filePath, ERRORS: diskErrors.join('; ') }));
      }
    }
  }

  if (requiresMonorepoScaffold && filePath === 'package.json' && !packageJsonMatchesWorkspaceRoot(projectRoot, content)) {
    violations.push(block('monorepo-package-json',
      'New-project monorepo gate: stack=default / React-Vite new projects must start with the Traffic One Turborepo root package.json: `private: true`, `packageManager: pnpm@...`, and a workspace declaration (`pnpm-workspace.yaml` or package.json `workspaces`) for `apps/*` and `packages/*`. Read `rules/modes/new-project.md` and scaffold the monorepo before feature code.'));
  }

  if (requiresMonorepoScaffold && ROOT_VITE_RE.test(filePath)) {
    violations.push(block('monorepo-root-vite',
      'New-project monorepo gate: root Vite app files are not allowed for this stack. Use `apps/web/` for the React app and create the required `packages/*` workspaces first; see `rules/modes/new-project.md`.'));
  }

  if (requiresMonorepoScaffold && ROOT_MONOREPO_FLAT_RE.test(filePath)) {
    violations.push(block('monorepo-root-flat-scaffold',
      'New-project monorepo gate: root-level TypeScript config files (`tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, etc.) are not allowed for this stack. Complete the architect phase and scaffold the Turborepo workspace (`pnpm-workspace.yaml`, `apps/web/`, `packages/*`, `tsconfig.base.json`) instead of creating a flat root Vite layout.'));
  }

  // Hot structural path: analyze only the touched file against the immutable
  // compiled contract and current work-unit allowlist. Numeric limits remain
  // warnings; robust responsibility/route/assignment findings deny immediately.
  if (
    (writingFeatureSource || writerRole === 'senior-frontend')
    && (
      /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|php)$/i.test(filePath)
      || I18N_SOURCE_RE.test(filePath)
      || I18N_CATALOG_RE.test(filePath)
    )
  ) {
    const profile = capabilityProfileForRun(projectRoot, state);
    if (profileHasWebUi(profile) || profile.surfaces.includes('native-ui')) {
      invalidateStructureCache(path.join(projectRoot, filePath));
      const architecture = currentRunId
        ? readCompiledArchitecture(projectRoot, currentRunId)
        : null;
      const scopedArchitecture = architecture && writerRole
        ? roleContract(architecture, writerRole)
        : architecture;
      const scopes = architecture && writerRole
        ? assignmentScopesForRole(projectRoot, currentRunId, writerRole)
        : [];
      const allowlist = scopes.flatMap((scope) => scope.include);
      const structuralFindings = profileHasWebUi(profile)
        ? (scopedArchitecture
          ? analyzeStructureTextAgainstContract(
              filePath,
              content,
              scopedArchitecture,
              writerRole ? { allowlist } : {},
            )
          : analyzeStructureText(filePath, content, profile, []))
        : [];
      const enforceI18n = isNewProjectMode(state)
        || projectDeclaresI18nRuntime(projectRoot, architecture || undefined);
      const i18n = architecture?.i18n || (enforceI18n ? detectExistingI18nContract(projectRoot) : undefined);
      const sourceI18n = enforceI18n && I18N_SOURCE_RE.test(filePath)
        ? analyzeI18nSourceText(filePath, content, profile, i18n)
        : null;
      const sourceI18nFindings = sourceI18n?.findings || [];
      // Deterministic catalog seeding: a missing key that a `<Trans ns
      // i18nKey>fallback</Trans> in THIS change references is auto-fixed, not
      // denied — the fallback is the declared source copy, so runtime seeds it
      // into the source locale and a marked TODO into the other locales before
      // any validator can trip over it. Empty-value/extra-key parity findings
      // are untouched: they carry no in-change fallback to seed from.
      if (contentVerified && i18n && sourceI18n?.references.some((reference) => reference.fallback)) {
        seedI18nCatalogKeys(projectRoot, i18n, sourceI18n.references);
      }
      const changedCatalog = i18n?.catalogs.find((catalog) => catalog.path === filePath);
      const catalogI18nFindings = enforceI18n && changedCatalog
        ? validateI18nCatalogs(projectRoot, i18n!, {
            namespaces: changedCatalog.namespaces,
            requireAllCatalogs: false,
            contentOverrides: { [filePath]: content },
          })
        : [];
      // Write-time demotion, mirroring the completion-scan severity in
      // react-structure/contract.ts: where the compiled eslint config carries
      // a real AST i18n rule, the lexical copy findings advise instead of
      // deny — the project's own `lint` run owns the blocking verdict there.
      // Catalog/runtime findings are data validation and always block.
      const lexicalCopyDemoted = uiAstLintLayer(profile) !== null;
      const i18nFindings = [...sourceI18nFindings, ...catalogI18nFindings]
        .map((finding) => ({
          ...finding,
          severity: lexicalCopyDemoted
            && (finding.id === 'STRUCT_HARDCODED_COPY' || finding.id === 'STRUCT_I18N_REACT_TRANS')
            ? 'warning' as const
            : 'error' as const,
        }));
      const allFindings = [...structuralFindings, ...i18nFindings];
      // Write-time blocking set: intent-level violations only — compiled-
      // contract breaks (a route pointing away from its module), scope
      // (allowlist gaps), catalog DATA validation, and collapse the formatter
      // could not fix. Everything else — entrypoint conventions, copy/Trans
      // findings, advisory route notes — accumulates into the run-scoped
      // quality ledger and is delivered ONCE, batched, at the completion
      // digest (observed 13co: 16 per-write denies, each atomically rejecting
      // a whole multi-file patch, for findings that were all fixable in one
      // batched pass).
      // STRUCT_I18N_CATALOG splits by scope: parity is a property of the
      // namespace's locale PAIR, and a role cannot write two files atomically,
      // so every legitimate intermediate state costs a deny (observed 13cl: ~8
      // denies including a perfect oscillation on one key — "en has extra key"
      // → the counterpart write itself denied → "en is missing key"). The
      // cross-locale parity classes therefore accumulate into the quality
      // ledger as warnings; the single-file classes (unparseable JSON, empty
      // catalog, empty values) stay immediate denies, and the completion scan
      // keeps full-parity blocking exactly as before.
      const isCrossLocaleParity = (finding: { id: string; crossLocaleParity?: boolean }): boolean => (
        finding.crossLocaleParity === true
      );
      // Existing-codebase demotion: STRUCT_ROUTE_MODULE_MISMATCH enforces the
      // compiled routing architecture, and a repo Traffic One did not create
      // keeps its own routing conventions — a maintenance edit adding a route
      // the plan never mentioned must not be hard-denied. It accumulates into
      // the quality ledger as a warning instead. STRUCT_COLLAPSED_LINE demotes
      // too UNLESS the collapse is in the bytes this write authors: the
      // analyzer judges the reconstructed whole file, so a legacy wide line
      // would otherwise deny every unrelated edit to that file forever
      // (verified repro: a ~115-char pre-existing JSX row denied a one-token
      // Edit on a different line, identically on every retry). The other
      // blocking ids stay: allowlist gaps are ownership and catalog classes
      // are data validation.
      const existingCodebase = !isNewProjectMode(state);
      const writeAuthorsCollapse = existingCodebase
        && collapsedLineNumber(
          filePath,
          args.addedContent !== undefined ? args.addedContent : content,
        ) !== null;
      const demotedOnExisting = (finding: { id: string; file?: string }): boolean => {
        if (!existingCodebase) return false;
        if (finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH') return true;
        // Catalog validation draws the SAME line collapse draws, for the same
        // reason: the namespace validator reads every locale registered for the
        // namespace, so one pre-existing empty value in the user's `de.json`
        // denied every write to `en.json` — a defect this run did not author and
        // cannot be asked to fix inside a single atomic write. The catalog being
        // WRITTEN stays blocking, because those are bytes this run authors.
        if (finding.id === 'STRUCT_I18N_CATALOG') return finding.file !== filePath;
        return finding.id === 'STRUCT_COLLAPSED_LINE' && !writeAuthorsCollapse;
      };
      let blocking = allFindings.filter((finding) => (
        finding.severity === 'error'
        && HOT_WRITE_BLOCKING_IDS.has(finding.id)
        && !isCrossLocaleParity(finding)
        && !demotedOnExisting(finding)
      ));
      // `STRUCT_COLLAPSED_LINE` is NOT waved through when a formatter could fix
      // it. That branch (v1.0.44) computed the formatted text, used it only as a
      // predicate, and threw it away — so the ORIGINAL collapsed content still
      // landed on disk, and the deferred repair it pointed at is calibrated 3.5x
      // looser (completion scans raw >500 chars; this gate masks and thresholds
      // at 140/80), leaving that whole band collapsed forever. Observed 15co:
      // `pnpm format:check` stayed red for an entire run; 14co: 25 unformatted
      // source files at the tester.
      //
      // The argument that settles it is determinism, not the dropped string:
      // `resolveProjectPrettier` walks for `node_modules/.bin/prettier`, so the
      // SAME byte-identical write was denied before install and allowed after. A
      // gate whose verdict depends on install state is not a gate — every other
      // HOT_WRITE_BLOCKING_ID is a pure function of path + content. Substituting
      // the formatted text instead is not available either: `updatedToolInput` is
      // Claude-only and Codex cannot rewrite tool input, which would make this
      // host-conditional enforcement.
      //
      // This reverses part of v1.0.44's "auto-fix over deny" direction, and that
      // direction stays right for BATCHED quality findings (13co: 16 per-write
      // denies for one pass of fixes). It is wrong for collapse, where the deny
      // is one write, one file, and one directly actionable instruction.
      if (blocking.length > 0) {
        // Carry each finding's own message. Reporting only `ID (file:line)`
        // withheld the one fact that resolves the deny — which route/module is
        // wrong and what the compiled contract expects instead — so the writer
        // guessed: observed 2cu, three of four routes were correct and only the
        // catch-all failed, but the frontend read the generic prose as "routes
        // are forbidden here", reported BLOCKED twice, and burned a re-plan.
        const summary = structureFindingSummary(blocking);
        violations.push(block('frontend-structure-hot-gate',
          `Structural/i18n gate: ${summary}. Entrypoints may only bootstrap the app; route pages must be separate compiled modules. React child copy uses <Trans ns="…" i18nKey="…">fallback</Trans>; t() is reserved for string props, metadata, and imperative APIs.`,
          { FINDINGS: summary }));
      } else if (currentRunId) {
        // The write proceeds: bank the non-blocking findings (per role, deduped)
        // instead of interrupting. The completion digest consolidates them into
        // one fix-cycle document, and the completion structure scan still holds
        // the bar — batching changes the delivery, never the standard.
        const accumulated = allFindings
          .filter((finding) => !HOT_WRITE_BLOCKING_IDS.has(finding.id)
            || isCrossLocaleParity(finding)
            || demotedOnExisting(finding))
          .map((finding) => (isCrossLocaleParity(finding) || demotedOnExisting(finding)
            ? { ...finding, severity: 'warning' as const }
            : finding));
        appendQualityFindings(projectRoot, currentRunId, writerRole || 'main-agent', accumulated);
      }
    }
  }

  const architectDigest = ARCHITECT_DIGEST_RE.exec(filePath);
  if (architectDigest && digestClaimsVerdict(content, 'PLAN_READY')) {
    const runId = architectDigest[2] || '';
    const missingMemory = missingProjectMemoryBaseline(projectRoot, state);
    if (missingMemory.length > 0) {
      violations.push(block('architect-memory-baseline-gate',
        `Architect completion gate: do not write \`PLAN_READY\` until the required .traffic-one project-memory baseline exists with real content. Missing or incomplete: ${missingMemory.join(', ')}. Write the missing memory files yourself (do not delegate .traffic-one/* to OpenCode), then update \`.traffic-one/digests/<runId>/architect.md\` and only then emit \`PLAN_READY\`.`,
        { MISSING: missingMemory.join(', ') }));
    }
    // Runtime touchpoint for the preserved-queue auto-fix (see the plan gate
    // below): a plan rewrite was allowed to land without the block because a
    // previously-accepted queue survives — re-append it here, on disk, before
    // judging PLAN_READY. Deny only when nothing is recoverable.
    if (isNewProjectMode(state) && openCodeDelegationActive(state, host) && planOnDiskMissingOpenCodeBlock(projectRoot) && opencodeQueueBlocks(host)
      && !restorePlanOpenCodeDelegateBlock(projectRoot, runId)) {
      violations.push(block('architect-opencode-queue-gate',
        `Architect completion gate: OpenCode is enabled but \`.traffic-one/plan.md\` is missing at least ${OPENCODE_PLAN_MIN_UNITS} runnable machine-readable delegation units. Include \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` with 3–6 bounded units (\`- id: <stable-unit-id> | role: … | files: … | task: …\`) before emitting \`PLAN_READY\`. The orchestrator runs \`opencode_delegate_from_plan\` from that block BEFORE spawning implementers.`));
    }
    if (isNewProjectMode(state) && hostFlags(currentHost).opencodeSelfHosted && planOnDiskHasOpenCodeDelegateMarker(projectRoot)) {
      violations.push(block('architect-opencode-self-delegation-gate',
        'Architect completion gate: this run is already hosted by OpenCode/Kilo, so `.traffic-one/plan.md` must not include an OpenCode delegation queue or `opencode-delegate` marker. Remove the self-delegation block before emitting `PLAN_READY`; implementer work runs directly on the current host.'));
    }
    const modelPolicy = readRunModelPolicy(projectRoot, runId);
    const subagentMode = obj(state.team)?.mode === 'subagents';
    if (subagentMode && !modelPolicy) {
      violations.push(block('bootstrap-publication-gate',
        'Bootstrap gate: immutable parent model-policy.json is missing or corrupt. No architecture assignments or implementation bootstrap may be published until parent preflight creates it.',
        { ERROR: 'model policy missing' }));
    }
    // Zero-implementer stop, BEFORE compilation. A profile with neither
    // implementer cannot build anything, and the architecture compiler THROWS on
    // the first route/app-shell/page/component module for a no-UI profile — so
    // without this the honest cause surfaces as `architecture-contract-gate`
    // blaming the architect's semantic input for a defect that lives in
    // `.one.json`, and the architect re-plans forever against a contract it can
    // never satisfy. Denying here also keeps the 2cl invariant: the
    // `violations.length === 0` guard below means no capability snapshot,
    // baseline, verification contract, assignment set, or child envelope is
    // minted for a run that can never produce code.
    const noImplementer = noImplementerRoleSummary(projectRoot, state);
    if (noImplementer) {
      violations.push(block('capability-no-implementer-gate',
        noImplementerRoleFallback(noImplementer, runId || '<runId>'),
        { PROFILE: noImplementer, RUN_ID: runId || '<runId>' }));
    }
    const inputExists = Boolean(runId) && exists(projectRoot, `.traffic-one/runs/${runId}/architecture-input-v1.json`);
    if (violations.length === 0 && (isNewProjectMode(state) || inputExists)) {
      try {
        // Compile in memory only: nothing may reach disk until every
        // completion check has passed. A persisted architecture-v1.json next
        // to a DENIED digest invalidates the live architect's bootstrap
        // envelope and revokes its tools mid-flight (observed 2cl).
        const compiled = compileArchitectureForRun(projectRoot, runId, state, { persist: false });
        const verification = buildVerificationContract(
          projectRoot,
          runId,
          state,
          compiled,
          {
            ...readVerificationPlanIntent(projectRoot),
            boundedScanTruncated: boundedScanTruncated(projectRoot, runId),
          },
        );
        if (!verification.scanComplete) {
          recordScanIncomplete(projectRoot, runId,
            block('verification-contract-scan-gate',
              `Verification contract gate: STRUCT_SCAN_INCOMPLETE (${verification.scanReason || 'unknown reason'}). Runtime could not derive the complete diff from the immutable baseline. \`PLAN_READY\` proceeds and the contract published below carries the truncation: \`uiImpact\` is pinned to the truncated-scan floor, so this run owes the browser evidence that floor requires. It cannot be CERTIFIED in this state, though — settlement re-derives the source identity from the same baseline and rejects the QA report as \`scan-incomplete\` whenever THAT scan is still truncated, no matter what evidence the tester gathers (it is the live re-derivation that decides, not the \`scanComplete\` field frozen into this contract; they agree only while the cause below is unfixed). Clear the cause named above (resolve the Git worktree, drop the symlink, narrow the generated/output roots the walk is counting) so the diff recompiles complete before the run reaches QA.`,
              { ERROR: verification.scanReason || 'scan incomplete' }));
        }
        // The accept path runs whether or not the diff was complete. Refusing
        // here was the last unremediable stop in the run's whole opening move —
        // the truncation causes are a framework cache, a vendored tree, a
        // symlink the architect did not plant — and it bought nothing the
        // contract does not now carry itself: the pinned impact makes a
        // truncated run STRICTER than a complete one, and the partial diff can
        // only NARROW `changedPaths`, which is the authorization union, never
        // widen it. The guard is the same one the outer block already applies,
        // restated because the branch above may not add to it.
        if (violations.length === 0) {
          const candidateAssignments = buildRuntimeAssignments(
            compiled,
            verification.contractHash,
          );
          // Satisfiability is a compiler invariant: every output the compiled
          // contract demands must be writable under the compiled contract's own
          // blocking write gates. A contract that fails this sweep would spawn
          // implementers into a guaranteed deadlock (12co/13co class: the
          // mandatory file is hard-denied and only a replan — which the fix
          // cycle cannot perform — could ever fix it). Deny PLAN_READY here,
          // naming both sides, while the architect can still change the input.
          const selfConflicts = contractSelfConflicts(compiled, candidateAssignments, {
            isNative: isNativeState(state),
            enforceI18n: isNewProjectMode(state)
              || projectDeclaresI18nRuntime(projectRoot, compiled),
            existingMode: !isNewProjectMode(state),
          });
          // Full queue checks: metadata (stable ids, depends edges, parseable
          // files, unit-kind heuristics) AND the file-vs-assignment scope
          // cross-check. The compiled allowlist is born in THIS call, so the
          // scope check runs against `candidateAssignments` and its deny
          // prints the REAL in-scope file lists — the architect never has to
          // guess compiled paths (the 2cl failure mode that once forced this
          // check to be deferred). Deferring it to Step-0 delegation silently
          // wasted the whole batch instead: observed 5cl-claude, 0/3 units
          // delegable because every unit invented conventional Next paths
          // (components/course-card.tsx, …) that the compiled scope never
          // contained, and the run lost the entire OpenCode economy with no
          // signal to the architect.
          const queuePolicyErrors = openCodeDelegationActive(state, host)
            && !planOnDiskMissingOpenCodeBlock(projectRoot)
            ? planOnDiskOpenCodeQueuePolicyErrors(projectRoot, {
              assignments: candidateAssignments.assignments,
            })
            : [];
          if (selfConflicts.length > 0) {
            const summary = contractSelfConflictSummary(selfConflicts);
            violations.push(block('contract-self-conflict',
              contractSelfConflictFallback(summary),
              { CONFLICTS: summary }));
          } else if (queuePolicyErrors.length > 0) {
            violations.push(block('architect-opencode-queue-policy-gate',
              `Architect completion gate: OpenCode queue metadata is unsafe: ${queuePolicyErrors.join('; ')}. Fix the queue block in \`.traffic-one/plan.md\` (stable unique ids, parseable \`files:\`, explicit \`depends:\` edges for overlaps) and re-emit \`PLAN_READY\`. Scope errors above list the owning role's real compiled in-scope files — retarget each unit's \`files:\` to those exact paths, or declare the module in ArchitectureInputV1 so runtime compiles the output you need.`,
              { ERRORS: queuePolicyErrors.join('; ') }));
          } else if (modelPolicy && !canPublishRunPolicyBootstraps(
            projectRoot,
            modelPolicy,
            state,
            {
              architecture: compiled,
              verification,
              assignments: candidateAssignments,
            },
          )) {
            violations.push(block('bootstrap-publication-gate',
              'Bootstrap gate: canonical role/rule/skill materials or a candidate WorkUnitContract could not be resolved before publication. No assignments or child envelope were published; repair the parent policy/materialization and retry PLAN_READY.',
              { ERROR: 'bootstrap preflight failed' }));
          } else {
            // This atomic legacy projection MUST precede verification-v2.json.
            // If the process dies on the next instruction, runtime 1.0.19 sees
            // blocked while the current runtime recovers canonical `active`.
            const rollbackBarrier = activateRunV2RollbackBarrier(projectRoot, runId);
            if (!rollbackBarrier) {
              violations.push(block('architecture-contract-gate',
                `Architecture contract gate: the runtime could not atomically activate the V2 rollback barrier for run \`${runId}\`. No V2 verification contract or implementation bootstrap was published.`,
                { ERROR: 'V2 rollback barrier activation failed' }));
            } else {
              // Accept path: persist the compiled architecture first — the
              // verification/assignments sidecars published below reference
              // its contractHash, and ensureRunPolicyBootstraps re-reads it
              // from disk at the end of this same call.
              persistCompiledArchitecture(projectRoot, compiled);
              // Seed canonical content for scaffold files whose body is runtime
              // knowledge (.prettierignore skip list, .env.example VITE_SITE_URL
              // contract) — only when missing/blank, never over agent content.
              // On greenfield runs the same call also materializes the compliant
              // module skeletons the satisfiability sweep above just certified,
              // with their catalog keys seeded into every declared locale —
              // implementers EDIT compliant code instead of authoring de novo.
              ensureScaffoldContent(projectRoot, compiled.scaffoldOutputs || [], compiled.profile, {
                compiled,
                newProject: isNewProjectMode(state),
              });
              // The publish is fenced (fsjson.ts: an unanswered consent
              // question, a planted symlink, a path that escapes the state
              // dir), and its refusal used to be dropped — so the accept path
              // went on to publish assignments, settle the run `active` and
              // hand implementers a bootstrap that all reference a contract
              // hash no file on disk carries. Every sidecar below depends on
              // this one landing, so a refusal ends the accept path here.
              const publishedVerification = publishVerificationContract(projectRoot, verification);
              if (!publishedVerification) {
                violations.push(block('architecture-contract-gate',
                  `Architecture contract gate: the V2 rollback barrier is active, but the runtime could not persist \`.traffic-one/runs/${runId}/verification-v2.json\`. No assignments, settlement or implementation bootstrap was published; the run remains fail-closed.`,
                  { ERROR: 'V2 verification contract publication was refused' }));
              } else {
                const assignments = publishRuntimeAssignments(
                  projectRoot,
                  compiled,
                  verification.contractHash,
                );
                // A SKIPPED delegation's pending-fallback pin is superseded by
                // the freshly compiled contracts — without this the bounded
                // 2-file hashes veto every envelope this same accept path is
                // about to publish (see supersedeSkippedDelegationFallback).
                supersedeSkippedDelegationFallback(projectRoot, runId, compiled.contractHash);
                const settlement = writeRunSettlement(projectRoot, runId, {
                  status: 'active',
                  incompleteChecks: ['verification-not-started'],
                });
                if (!settlement) {
                  violations.push(block('architecture-contract-gate',
                    `Architecture contract gate: the V2 rollback barrier is active, but the canonical run settlement could not be published for run \`${runId}\`. The run remains fail-closed and no implementer may spawn.`,
                    { ERROR: 'canonical V2 settlement publication failed' }));
                } else if (modelPolicy) {
                  if (!ensureRunPolicyBootstraps(projectRoot, modelPolicy, state)) {
                    violations.push(block('bootstrap-publication-gate',
                      `Bootstrap gate: the parent could not atomically publish role/rule/skill and work-unit envelopes against architecture=${compiled.contractHash}, verification=${verification.contractHash}, and assignments=${assignments.assignmentsHash}. No implementer may spawn until the immutable envelopes are published.`,
                      { ERROR: 'bootstrap publication failed' }));
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(block('architecture-contract-gate',
          `Architecture contract gate: do not emit \`PLAN_READY\` until \`.traffic-one/runs/${runId || '<runId>'}/architecture-input-v1.json\` is valid and runtime compilation succeeds. ${message}. The architect may change only semantic routes/modules/component placement/uiPrimitives/i18n/exceptions; runtime owns roots, roles, outputs, baseline, and hashes.`,
          { ERROR: message }));
      }
    }
  }

  digestCompletionGates({
    projectRoot, state, filePath, content, shellBody: args.shellBody, currentRunId, violations, block,
  });

  // Auto-fix over deny (13cl replan: two identical 'block missing' denies 30s
  // apart — the architect rewrites prose and cannot reconstruct machine
  // metadata from memory). A plan write carrying NO delegate marker while a
  // previously-accepted queue exists for the current run is preserved: the
  // write proceeds and runtime re-appends the prior block at the next
  // touchpoint (PLAN_READY gate / --from-plan). A write that DOES carry the
  // marker is the architect authoring the block, so an incomplete one still
  // denies with the concrete fix; a first-ever write with nothing recoverable
  // denies too.
  if (PLAN_FILE_RE.test(filePath) && isNewProjectMode(state) && openCodeDelegationActive(state, host) && missingOpenCodeDelegateBlock(content) && opencodeQueueBlocks(host)
    && (hasOpenCodeDelegateMarker(content) || !preserveOpenCodeDelegateBlockForWrite(projectRoot, currentRunId))) {
    violations.push(block('plan-opencode-queue-gate',
      `Plan gate: OpenCode is enabled — \`.traffic-one/plan.md\` must include the machine-readable \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` block with at least ${OPENCODE_PLAN_MIN_UNITS} runnable bounded units (\`- id: <stable-unit-id> | role: frontend|backend|tester|docs | files: … | task: …\`). Prose-only or incomplete OpenCode lists are ignored by \`opencode_delegate_from_plan\`. A rewrite may omit the block only after a queue was accepted for the current run — runtime then preserves and re-appends it. Concrete example of a runnable unit row:\n\`<!-- opencode-delegate:start -->\`\n\`- id: seed-demo-data | role: backend | files: supabase/seed.sql | task: Seed the demo rows the plan data section describes\`\n\`<!-- opencode-delegate:end -->\``));
  }

  if (PLAN_FILE_RE.test(filePath) && isNewProjectMode(state) && hostFlags(currentHost).opencodeSelfHosted && hasOpenCodeDelegateMarker(content)) {
    violations.push(block('plan-opencode-self-delegation-gate',
      'Plan gate: this run is already hosted by OpenCode/Kilo, so `.traffic-one/plan.md` must not include an OpenCode delegation queue or `opencode-delegate` marker. Remove the self-delegation block; implementer work runs directly on the current host.'));
  }

  if (PLAN_FILE_RE.test(filePath) && openCodeDelegationActive(state, host) && !missingOpenCodeDelegateBlock(content)) {
    const policyErrors = openCodeQueuePolicyErrors(content);
    if (policyErrors.length > 0) {
      violations.push(block('plan-opencode-queue-policy-gate',
        `Plan gate: OpenCode queue metadata is unsafe: ${policyErrors.join('; ')}. Add stable unique ids, exact files allowlists, and depends edges for overlapping areas.`,
        { ERRORS: policyErrors.join('; ') }));
    }
  }

  const validStateStack = Boolean(state.stack && isKnownStack(state.stack));
  const stateMissing = !fs.existsSync(statePath(projectRoot)) && !fs.existsSync(legacyStatePath(projectRoot));
  const memoryPresent = fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'))
    || fs.existsSync(path.join(projectRoot, '.traffic-one', 'stack.md'));
  const detectedModeForState = state.mode || (stateMissing ? detectMode(projectRoot) : null);

  if (writingFeatureSource && !validStateStack && (detectedModeForState === 'new-project' || memoryPresent)) {
    violations.push(block('state-gate',
      'State gate: root .traffic-one/.one.json is missing or incomplete. Write the Traffic One state file with mode, stack, backend, realtime, confirmed, onboardingComplete, and confirmedAt before writing feature source. The .traffic-one/ folder is project memory, not the stack-selection state file.'));
  }

  const hasMaterializedAssets = hasMaterializedProjectAssets(projectRoot, state);
  const featureContextMaterialized = isPluginAuthoringRoot(projectRoot)
    || !state.onboardingComplete
    || (isMaterialized(state) && hasMaterializedAssets);

  if (writingFeatureSource && !featureContextMaterialized) {
    violations.push(block('materialization-gate',
      `Materialization gate: stack context for ${stackFingerprint(state)} has not been materialized on disk yet. Run \`node -e "const p=require('node:path'),e=process.env,r=p.resolve(e.TRAFFIC_ONE_PLUGIN_ROOT||e.CURSOR_PLUGIN_ROOT||e.CODEX_PLUGIN_ROOT||e.CLAUDE_PLUGIN_ROOT||process.cwd());process.argv.splice(1,0,'traffic-one-runtime');require(p.join(r,'scripts','hook-runtime.cjs'))" materialize-project\` from the project root and verify \`.traffic-one/rules/**\`, \`.traffic-one/skills/**\`, \`.traffic-one/manifest.json\`, root \`AGENTS.md\`, and root \`CLAUDE.md\` exist before writing feature source.`,
      { FINGERPRINT: stackFingerprint(state) }));
  }

  const isNewProject = isNewProjectMode(state);
  const planMissing = !fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'));
  const writingPlan = PLAN_FILE_RE.test(filePath);
  const writingDoc = ADR_OR_DOC_RE.test(filePath);
  if (isNewProject && planMissing && writingFeatureSource && !writingPlan && !writingDoc
  ) {
    if (usesMainAgentTeam(state)) {
      violations.push(block('plan-main-agent-gate',
        'Plan gate: .traffic-one/plan.md is missing on a new project in Low/main-agent mode. Do NOT call `run_subagent`, `Task`, `spawn_agent`, `task`, or another subagent tool. You are the architect in this thread: write `.traffic-one/plan.md` and required `.traffic-one/` project memory before root config, workspace scaffold, or feature-source writes; then resume the same ordered phases. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'));
    } else if (writerRole === 'senior-architect') {
      // Never tell the architect to "run the senior-architect subagent" (B8) —
      // it IS that subagent. Tell it to write the plan itself.
      violations.push(block('plan-architect-self-gate',
        'Plan gate: .traffic-one/plan.md is missing on this new project. You ARE the `senior-architect` for this run — write `.traffic-one/plan.md`, project memory, and semantic ArchitectureInputV1; do not spawn another architect and do not scaffold implementation files.'));
    } else {
      violations.push(block('plan-gate',
        'Plan gate: .traffic-one/plan.md is missing on a new project. Run the `senior-architect` subagent (or the `senior-eng-orchestrator` skill) to produce the plan before writing feature source files. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'));
    }
  }

  return violations;
}

export {
  architectPhaseIncompleteReasons,
  isArchitectPhaseComplete,
} from './contracts';
