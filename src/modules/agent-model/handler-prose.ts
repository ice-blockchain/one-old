// src/modules/agent-model/handler-prose.ts
// The skillBlock/block prose closures and the verbatim SKILL.md fallback
// constants shared by every deny builder.

import {  deny } from '../../core/result';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';

const skillBlock = makeSkillBlock(pluginRoot);
export const block = (
  name: string,
  vars: Record<string, string | number | null | undefined> = {},
  fallback = '',
): string => skillBlock('agent-model', name, vars, fallback);
const PLAN_BATCH_GATED_ROLES = new Set(['senior-frontend', 'senior-backend']);
// Verification roles gated on a LIVE Step-0 batch (never on a dead or terminal
// one): reviewing/testing pre-batch state wastes the whole round. Deliberately
// separate from PLAN_BATCH_GATED_ROLES — implementers wait for terminality,
// verifiers only for liveness, with their own at-most-once budget.
const VERIFY_BATCH_GATED_ROLES = new Set(['senior-reviewer', 'senior-tester']);

export const CURSOR_MODELS_CAPTURE_FALLBACK = `Cursor model-capture gate (required before the first team spawn, run {{RUN_ID}}). The spawn is blocked until Traffic One freezes the exact model ids offered by this Cursor build.
Missing captured tiers for this run: {{MISSING_TIERS}}.
Do this once before retrying:
1. List the model ids your \`Task\` tool offers for spawning subagents (the same list Cursor shows when you pick a subagent model).
2. Run \`{{CAPTURE_CMD}}\`, replacing the placeholders with those EXACT ids verbatim (e.g. \`claude-fable-5-thinking-high\`, \`gpt-5.6-terra-medium\`, \`composer-2.5-fast\`, or \`gpt-5.4-mini\`). A valid picker id may or may not include a reasoning suffix; never invent one. Include at least one id per tier the team needs — highest + balanced + cheapest. This internal command writes only your local per-user/project Cursor preferences; do not create \`.traffic-one/cursor-models.json\`.
3. Re-run model-gate, then retry the spawn with the exact role→model value it prints. Project \`.cursor/agents\` contracts remain model-agnostic.
Do not retry with an uncaptured family guess and do not build the project inline because of this gate.`;

// Verbatim mirror of the SKILL.md `spawn-claim-unavailable` block. This gate
// exists precisely for the case where the project's state dir is not answering,
// which is also a state a missing/unreadable SKILL.md correlates with — so it is
// the last gate that can afford to render as `''`.
export const SPAWN_CLAIM_UNAVAILABLE_FALLBACK = `Traffic One spawn gate: the role claim for \`{{ROLE}}\` in run \`{{RUN_ID}}\` could not be recorded, so the spawn was blocked before a child started ({{REASON}}). Nothing is wrong with the run — its ledger still admits claims and the role is free — and this is not a model, team, or plan problem. Traffic One already retried once.

A child spawned without a claim binds no role: it writes as the main agent, is invisible to the duplicate-spawn gate, and cannot be released when the run settles. Blocking the spawn is the recoverable outcome.

Retry the SAME spawn, unchanged, in your next message. A concurrent hook holding the run's claims or ledger lock clears in about two seconds. If the same deny repeats more than twice, another process is wedged on this run's state: run \`node ~/.traffic-one/bin/doctor.cjs --run "{{RUN_ID}}"\` and fix what it reports before spawning again. Do NOT change the role, the model, or the task to work around it, and do NOT build the project inline instead.`;

// Verbatim mirror of the SKILL.md `agent-materialization-missing` block. This
// deny had NO fallback at all, so a missing block rendered it as `''` — a
// refusal with no reason text, on the one gate whose whole job is to say what is
// not on disk yet. `{{CAUSE}}` is empty unless the stamp write was refused.
export const AGENT_MATERIALIZATION_MISSING_FALLBACK = `Traffic One agent spawn gate: project-local rules/skills are not materialized yet.
Do not spawn frontend/backend/reviewer/tester workers until \`.traffic-one/.one.json\` has current \`materializedStack\`, \`materializedAt\`, and \`materializedVersion\`, and \`.traffic-one/manifest.json\`, \`.traffic-one/rules/**\`, \`.traffic-one/skills/**\`, root \`AGENTS.md\`, and root \`CLAUDE.md\` exist.
Run \`node -e "const p=require('node:path'),e=process.env,r=p.resolve(e.TRAFFIC_ONE_PLUGIN_ROOT||e.CURSOR_PLUGIN_ROOT||e.CODEX_PLUGIN_ROOT||e.CLAUDE_PLUGIN_ROOT||process.cwd());process.argv.splice(1,0,'traffic-one-runtime');require(p.join(r,'scripts','hook-runtime.cjs'))" materialize-project\` from the project root, then retry the agent spawn.{{CAUSE}}`;

// The cause clause the deny above could not name. The machine-readable half
// (`denyTarget`, the refused path) already ships; this is the human-readable
// one, and without it an operator sees a deny that repeats on EVERY spawn with
// nothing anywhere saying why. Rendered only when `materializeIfNeeded` reports
// a refused stamp, which has exactly two causes (converge.ts): an unanswered
// consent question, or a symlink planted at the state path. The refusal is
// durable, so the sweep rewrites ~90 files and re-issues this deny forever.
export function materializationStampRefusedCause(statePath: string): string {
  return `\n\nWHY THIS REPEATS: the assets were written, but the materialization stamp write to \`${statePath}\` was REFUSED, so nothing on disk records that this project materialized. The command above will converge the assets again and this same deny will be re-issued on the next spawn, indefinitely. Two things refuse that write: an unanswered Traffic One consent question for this project, and a symlink or foreign path planted at that file. Answer the consent question, or clear whatever occupies that path, then retry the spawn.`;
}

// Verbatim mirrors of the two `agent-reuse-scope-regrant*` SKILL.md blocks.
// Their older sibling `agent-reuse-continue` ships with NO fallback (pinned in
// shared/__tests__/skill-block-coverage.test.ts) and renders `''` when the block
// goes missing — a deny that instructs nothing. These two carry the whole answer
// to "did my scope change take effect?", so an empty render would leave the
// orchestrator to guess, which is the one thing the refused arm exists to
// prevent. `{{VAR}}` here doubles as the fallback's own hole: skillBlock applies
// the vars to the fallback too, so both spellings render identically.
export const AGENT_REUSE_SCOPE_REGRANT_FALLBACK = `Agent-reuse gate: run {{RUN_ID}} already has a LIVE \`{{ROLE}}\` agent — id \`{{AGENT_ID}}\` — so this second spawn was refused. Its \`[t1-bounded-scope]\` marker was NOT discarded: run {{RUN_ID}} has no compiled assignments, so for \`{{ROLE}}\` that marker is the ONLY origin of the bounded contract, and Traffic One republished it. \`{{AGENT_ID}}\` may now write exactly these {{FILE_COUNT}} file(s): {{FILES}}. The scope change is already in effect, so a second agent was never needed for it.
1. {{CONTINUE_CALL}} The message carries ONLY what is NEW: the task spec, the exact file paths above, acceptance criteria, and (for fix cycles) the reviewer/tester findings VERBATIM. The agent keeps everything it already read.
2. Treat the reply exactly like a fresh spawn's final report: the same digest + verdict-token contract, ending with its terminal token and updating \`.traffic-one/digests/{{RUN_ID}}/{{ROLE}}.md\`.
3. Do NOT re-send this spawn to apply the same scope again — it is already published and an identical marker changes nothing. To widen it FURTHER, send one more spawn whose \`[t1-bounded-scope]\` line names the COMPLETE file set you want; each marker REPLACES the scope rather than adding to it. Only if \`{{AGENT_ID}}\` is genuinely unusable — {{CONTINUE_TOOL}} errors ("agent not found"/unavailable), or its replies show context exhaustion — re-spawn \`{{ROLE}}\` with the literal marker \`{{MARKER}}\` and that same scope line.`;

export const AGENT_REUSE_SCOPE_REGRANT_REFUSED_FALLBACK = `Agent-reuse gate: run {{RUN_ID}} already has a LIVE \`{{ROLE}}\` agent — id \`{{AGENT_ID}}\` — so this second spawn was refused, and its \`[t1-bounded-scope]\` marker was refused with it. Traffic One could not republish \`{{ROLE}}\`'s WorkUnitContract, so the widening did NOT happen: \`{{AGENT_ID}}\` still holds the scope it started with, and the {{FILE_COUNT}} file(s) you asked for would be denied on every write — {{FILES}}. Do not continue as though the scope had changed.
1. Re-send this SAME spawn once, unchanged. Publication reads the run's architecture snapshot, its host-capability sidecar and its bootstrap directory, and a concurrent hook holding any of those clears without your intervention.
2. If the same refusal comes back, no scope change can be published for \`{{ROLE}}\` in run {{RUN_ID}} at all. Continue the live agent WITHIN THE SCOPE IT ALREADY HAS instead — {{CONTINUE_CALL}} — and give it only work its current contract covers.
3. Do NOT reach for \`{{MARKER}}\`: replacing the agent destroys its context and publishes no contract either, so it cannot fix this. If the remaining work genuinely needs the wider scope and step 1 did not clear it, stop and report BLOCKED, quoting this message.`;

export function isPlanBatchGatedRole(role: string): boolean {
  return PLAN_BATCH_GATED_ROLES.has(role);
}

export function isVerifyBatchGatedRole(role: string): boolean {
  return VERIFY_BATCH_GATED_ROLES.has(role);
}
