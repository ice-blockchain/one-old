// src/modules/onboarding-gate/stop.ts
// Turn-end backstop: while onboarding is pending and THIS session has a live
// wizard, block the Stop once and re-deliver the setup link. Every in-turn
// surface (bootstrap stdout, deny reasons, systemMessage nudges) is agent-facing
// or collapsed on Claude/Codex — observed live on 1.0.43, a turn ended with the
// user staring at red "Failed to wait" blocks and no link anywhere. Stop is the
// last enforcement point of the turn; after it there is nothing left to ride.
//
// Deviation from the Devin entry (which blocks unconditionally): an ENGAGEMENT
// gate requires a live wizard record. Stop fires at the end of every turn of
// every conversation, and without the gate any Q&A session in an un-onboarded
// directory would be trapped mid-goodbye. The Devin entry keeps its own
// behavior — it is that host's only re-delivery channel.

import { obj } from '../../shared/obj';
import { context, deny, followup, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { computeOnboarding, usePluginQuestionPending } from '../../shared/onboarding-server/flow';
import { isForeignOnboardingThread } from '../../shared/onboarding-server/onboarding-session';
import { onboardingSyncSessionId, onboardingWaitCommand } from '../../shared/onboarding-server/wait-command';
import {
  SETUP_LINK_NUDGE_TTL_MS,
  setupLinkNudgeLabel,
  wizardOpened,
} from '../../shared/onboarding-server/wizard-links';
import { emittedWithin, stampEmitMarker } from '../../shared/once';
import {
  stopSetupLinkPostedReason,
  stopSetupLinksShownReason,
  stopSetupRequiredReason,
} from '../../shared/onboarding-server/claude-setup';
import { assistantPostedLink } from '../../shared/onboarding-server/link-evidence';
import { pluginRoot } from '../../shared/paths';
import { hookSessionIdentity, isSubagentThread } from '../../shared/state';
import { makeSkillBlock } from '../../shared/skill-block';
import { liveWizardLink } from './handler';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}, fallback = ''): string =>
  skillBlock('onboarding-gate', name, vars, fallback);

export function onboardingStopGate(ctx: Ctx): HookResult {
  const raw = obj(ctx.input.raw) || {};
  // Loop guard: Claude/Codex re-fire Stop after a blocking Stop hook with
  // stop_hook_active=true — the second one must pass (one forced continuation
  // per turn, never a livelock).
  if (raw.stop_hook_active === true) return noop();
  const root = resolveProjectRoot(ctx.cwd);
  if (isNonProjectRoot(root)) return noop();
  initializeTrafficOneEnv(root, ctx.host);
  // Subagents never onboard (their SubagentStop is unregistered on Claude/Codex,
  // but Cursor routes this same handler and its child events are unreliable —
  // see the PreToolUse gate's identical guards).
  if (isSubagentThread(raw)) return noop();
  const sessionId = hookSessionIdentity(raw).sessionId;
  if (ctx.host === 'cursor' && sessionId && isForeignOnboardingThread(root, sessionId)) return noop();
  if (pluginUseDeclined(root)) return noop();
  if (computeOnboarding(root).done) return noop();
  // Ask-first pending: the turn MUST end so the user can answer the question in
  // chat — blocking here would fight the ask.
  if (usePluginQuestionPending(root)) return noop();
  // Engagement gate: no live wizard record ⇒ setup was never engaged this
  // session; let the turn end (the PreToolUse/prompt surfaces own first contact).
  const link = liveWizardLink(root, ctx.host);
  if (!link) return noop();

  // OpenCode/Kilo (session.idle forwarded by the wrapper's `event` hook): the
  // wrapper surfaces `systemMessage` as a host toast. One-line, injection-safe
  // prose (the full multi-host block trips the model's injection training on
  // these hosts), TTL-bounded — idle can fire on every turn end — and silent
  // over an open wizard (a toast adds nothing while the user is mid-setup).
  if (ctx.host === 'opencode' || ctx.host === 'kilo') {
    if (wizardOpened(root, link.token, process.env, ctx.host)) return noop();
    if (emittedWithin(root, setupLinkNudgeLabel(link.token), SETUP_LINK_NUDGE_TTL_MS)) return noop();
    stampEmitMarker(root, setupLinkNudgeLabel(link.token));
    return context('', {
      systemMessage: `Traffic One setup required — open: ${link.dashboardUrl}`,
    });
  }

  const waitCommand = onboardingWaitCommand(root, ctx.host, onboardingSyncSessionId(sessionId));
  // Per the Devin precedent, an open wizard does NOT silence the backstop — it
  // swaps the prose: keep the turn on the waiter instead of reposting a link
  // over the user's open setup tab. A link the assistant already posted in the
  // live transcript swaps the prose the same way (delivery evidence — reposting
  // duplicated the link live on 1.0.45): the turn stays on the waiter, no repost.
  const linkAlreadyPosted = !wizardOpened(root, link.token, process.env, ctx.host)
    && assistantPostedLink({ url: link.dashboardUrl, host: ctx.host, raw, sessionId, cwd: root });
  const text = wizardOpened(root, link.token, process.env, ctx.host)
    ? block('stop-setup-links-shown', { WAIT_CMD: waitCommand }, stopSetupLinksShownReason(waitCommand))
    : (linkAlreadyPosted
      ? block('stop-setup-link-posted', { WAIT_CMD: waitCommand }, stopSetupLinkPostedReason(waitCommand))
      : block('stop-setup-required', {
        URL: link.dashboardUrl,
        LOCAL_FALLBACK: link.localFallback,
        WAIT_CMD: waitCommand,
      }, stopSetupRequiredReason(link.dashboardUrl, link.localFallback, waitCommand)));

  if (ctx.host === 'claude' || ctx.host === 'codex') return deny(text);
  // Cursor consumes followup_message from its stop lifecycle events (bounded by
  // the host-side loop_limit: 8): enqueue the same prose as the next turn's
  // instruction. Runs at priority 10 — ahead of agent-model.cursor-stop (40),
  // and mergeResults keeps the FIRST followup, so setup re-delivery wins the
  // slot while onboarding is pending (agent-model emits none in that state).
  if (ctx.host === 'cursor') return followup(text);
  // Remaining hosts do not route a Stop subcommand; keep an unexpected dispatch inert.
  return noop();
}
