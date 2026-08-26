// src/core/result.ts
// Builders + merge for the canonical HookResult (now carrying optional
// systemMessage / promptRequest). Handlers never assemble host-shaped output.

import { pluginRoot } from '../shared/paths';

import type { HookResult, ResultMeta } from './types';

export const noop = (): HookResult => ({ kind: 'noop' });

// An empty `context` is a NOOP, and unlike an empty `deny` it gets no
// substituted notice. That asymmetry is deliberate, and it is safe for a reason
// that lives elsewhere rather than here.
//
// A deny that renders empty still REFUSED, so the agent is owed an explanation
// and something has to say so. A context that renders empty is the absence of
// advice: injecting "Traffic One could not load a directive" into every turn of
// a broken install would put a notice in front of the user on paths where
// nothing was blocked and nothing is owed, and there is no addressee obliged to
// act on it. So the hole was closed at the SOURCE instead. Six sites used to
// build a `context()` from a block with no fallback and vanish silently on a
// torn install (agent-model/choice-reply.ts, agent-model/model-denies.ts ×2,
// session/prompt-submit.ts, and the two maintenance directives in
// session/triage-directive.ts, which return a string that becomes session
// context upstream); all six now resolve through the generated fallback table,
// and shared/__tests__/skill-block-coverage.test.ts asserts — for all 179 call
// sites, denies and contexts alike — that no rendered block can come back
// empty. A guard here would have nothing left to fire on.
export function context(text: string, meta: ResultMeta = {}): HookResult {
  const hasText = Boolean(text && text.trim());
  if (!hasText
    && meta.systemMessage === undefined
    && meta.promptRequest === undefined
    && meta.followupMessage === undefined
    && meta.updatedToolInput === undefined) {
    return { kind: 'noop' };
  }
  return { kind: 'context', context: text || '', ...meta };
}

/**
 * Queue a continuation from Cursor's stop/subagentStop lifecycle events.
 * Adapters intentionally keep this internal metadata inert everywhere else.
 */
export function followup(message: string): HookResult {
  return message && message.trim()
    ? context('', { followupMessage: message })
    : noop();
}

// What a refusal says when its own wording could not be loaded.
//
// A gate's `reason` is normally assembled by shared/skill-block.ts, which reads
// a named `T1BLOCK` out of `modules/<id>/skill/SKILL.md`, then consults the
// GENERATED fallback table beside it (shared/skill-fallbacks.generated.ts, the
// same bodies compiled into the runtime and reached without pluginRoot()), then
// the call site's own argument. Since that table landed, an installation whose
// plugin root has no skill trees — a torn install, a partial rsync, a plugin
// sync mid-way through replacing a version-keyed cache dir — still renders the
// shipped paragraph, so this notice no longer stands in for an unreadable FILE.
//
// What it still covers is prose that exists NOWHERE: a block name no SKILL.md
// declares, whose call site passes no fallback either. That population is
// asserted to be empty, from a parse, by
// shared/__tests__/skill-block-coverage.test.ts ('every block a call site can
// render resolves to prose with no filesystem read'), and this is the guard
// that keeps the failure legible if it ever stops being empty.
//
// The denyId is INTERPOLATED, and that is load-bearing rather than decorative.
// shared/state/deny-repeat.ts signs a refusal as `denyTarget` plus the WHOLE
// rendered reason and escalates at DENY_REPEAT_ESCALATE_AT (3) — so one CONSTANT
// notice across all 28 sites would collapse them into a single bucket and start
// telling an agent that is hitting three DIFFERENT broken gates to stop
// retrying. With the id in the text each gate keeps its own count.
//
// The plugin root IS named, and the doctor COMMAND is not — which is not an
// inconsistency, the two components fail differently.
//
// The root is what makes the notice actionable by the human who has to repair
// the install: a missing skill block without a location sends them looking
// through as many plugin caches as they have hosts, and the version-keyed
// cache dir this most often fires from is not a path anyone can guess. It is
// interpolated as `pluginRoot()` VERBATIM, with nothing appended inside the
// string, because
// shared/state/deny-repeat.ts's withoutInstallLocation folds a refusal's signing
// key by splitting on exactly that value — a derived spelling (posix-normalised,
// trailing separator, relative) would slip through the fold and re-open the
// defect it exists for: the deny-repeat loop splits into one key per install
// location and escalation arrives on the fifth identical refusal instead of the
// third.
//
// Doctor stays in PROSE with no command line. The gate grammar admits only the
// absolute spellings doctor-command.ts prints (gateExemptDoctorScriptPaths) and
// denies a relative one, so the choice is between `doctorCommand()` and no
// command at all — and `doctorCommand()` resolves
// `<pluginRoot>/scripts/doctor.cjs`, a SIBLING of the very skill trees this
// notice fires because they are missing. A partial tree that lost
// `modules/**/skill/SKILL.md` may equally have lost `scripts/doctor.cjs`, and
// printing a path to a file that is not there is the one thing a message about
// a broken install must not do. Naming the DIRECTORY makes no such promise.
// Same shape as kilo-entry.ts's prose-only "Run Traffic One doctor, then
// restart …".
export function lastResortDenyReason(denyId?: string): string {
  const gate = denyId ? `\`${denyId}\`` : 'the gate that refused it';
  return `Traffic One refused this action, and the explanation for it could not be loaded: ${gate} reads its wording from a \`skill/SKILL.md\` block that is missing from the Traffic One install at \`${pluginRoot()}\`, so the reason rendered empty. The refusal itself is unaffected — the gate decided on its own evidence, so re-issuing the same action will be refused again with this same message. Do not retry it and do not work around it. Run Traffic One doctor. The gate will state its real reason once that file is readable.`;
}

const LAST_RESORT_USER_REASON = 'Retry the same action after setup finishes.';

// `opts.denyId` should be a literal from config/deny-ids.ts (see DenyId) — pass
// it as a declared constant, never build it from `reason`. Omitting it is not
// a type error (many call sites still need one added; see the completeness
// test in tests/), but the pipeline will only synthesize an anonymous
// fallback, not a real identity, so leaving it off a NEW call site is a bug.
//
// BOUND, stated rather than implied: the substitution covers the WHOLLY-empty
// reason only. Gates routinely compose a reason from a block PLUS clauses built
// in TS (`${block('x', …)} ${suffix}`, or a violation list joined with other
// text), and a block that goes missing inside an otherwise non-empty reason
// leaves a HOLE the notice never sees. Widening it — sniffing for a suspiciously
// short reason, say — would be a guess, and the honest fix for those sites is
// the fallback argument the assembler already takes.
export function deny(reason: string, opts: { context?: string } & ResultMeta = {}): HookResult {
  const { context: extraContext, ...meta } = opts;
  const emptyReason = !(reason && reason.trim());
  return {
    kind: 'deny',
    reason: emptyReason ? lastResortDenyReason(meta.denyId) : reason,
    // Last-resort substitution is agent-facing. When the caller did not
    // already split channels, the user side gets a calm retry — not the
    // torn-block essay.
    ...(emptyReason && meta.userReason === undefined ? { userReason: LAST_RESORT_USER_REASON } : {}),
    ...(extraContext && extraContext.trim() ? { context: extraContext } : {}),
    ...meta,
  };
}

export function isDeny(result: HookResult): result is Extract<HookResult, { kind: 'deny' }> {
  return result.kind === 'deny';
}

// A Cursor user APPROVE/REJECT prompt (the only hook-driven user prompt Cursor supports — via
// `permission:"ask"` on beforeShellExecution). Reuses the `deny` kind so merge/short-circuit
// semantics are unchanged (an unanswered ask blocks, like a deny); the Cursor adapter maps
// `askUser` → `permission:"ask"` on PreToolUse. On Claude/Codex it serializes as a plain deny —
// inert, because the only command it gates is Cursor-only.
//
// It carries a declared id like every other exit: leaving it off did not make
// it identity-free, it made the pipeline mint `unattributed-handler:<gateId>`
// for it, so the ONE surface meant to say "a fallback fired" started reporting
// a routine, expected approval prompt. `user-approval-request` (see
// config/deny-ids.ts) names the prompt class; `gateId` still says which gate
// asked; and `askUser: true` remains the discriminator for a consumer holding
// the result rather than a log record.
//
// A deny budget MUST SKIP these records — an approval prompt is not a refusal
// and the human answering it is already the rate limit. Set here rather than
// at the call site because there is nothing per-site to choose: any askUser IS
// this cause.
//
// It builds the literal itself instead of calling deny(), and that stays
// deliberate now that deny() substitutes lastResortDenyReason for an empty
// reason: this `reason` is the QUESTION Cursor renders inside its approve/reject
// modal, so a "this install is incomplete" notice in that slot would be actively
// wrong. Same exception, and the same reason, as the suffixes core/pipeline.ts's
// stampDeny already withholds from an askUser.
export function askUser(question: string, agentMessage: string): HookResult {
  return { kind: 'deny', reason: question, askUser: true, agentMessage, denyId: 'user-approval-request' };
}

// Merge results: the first deny wins (short-circuit). Otherwise concatenate
// context strings and keep the first systemMessage / promptRequest /
// followupMessage / updatedToolInput seen.
export function mergeResults(results: readonly HookResult[]): HookResult {
  for (const result of results) {
    if (isDeny(result)) return result;
  }
  const contexts: string[] = [];
  let systemMessage: string | undefined;
  let promptRequest: unknown;
  let followupMessage: string | undefined;
  let updatedToolInput: Record<string, unknown> | undefined;
  for (const result of results) {
    if (result.kind !== 'context') continue;
    if (result.context && result.context.trim()) contexts.push(result.context);
    if (systemMessage === undefined && result.systemMessage !== undefined) systemMessage = result.systemMessage;
    if (promptRequest === undefined && result.promptRequest !== undefined) promptRequest = result.promptRequest;
    if (followupMessage === undefined && result.followupMessage !== undefined) followupMessage = result.followupMessage;
    if (updatedToolInput === undefined && result.updatedToolInput !== undefined) updatedToolInput = result.updatedToolInput;
  }
  if (contexts.length === 0
    && systemMessage === undefined
    && promptRequest === undefined
    && followupMessage === undefined
    && updatedToolInput === undefined) {
    return { kind: 'noop' };
  }
  return {
    kind: 'context',
    context: contexts.join('\n\n'),
    ...(systemMessage !== undefined ? { systemMessage } : {}),
    ...(promptRequest !== undefined ? { promptRequest } : {}),
    ...(followupMessage !== undefined ? { followupMessage } : {}),
    ...(updatedToolInput !== undefined ? { updatedToolInput } : {}),
  };
}
