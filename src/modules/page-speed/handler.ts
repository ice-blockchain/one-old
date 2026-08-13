// src/modules/page-speed/handler.ts
// PostToolUse(shell) advisory: after a production build on a web stack, remind
// the agent to run the Lighthouse mobile gate. Ported 1:1 from
// runPostBuildPageSpeed in scripts/hook-runtime/handlers/post.cjs — including
// the opt-in per-tool token log (no-op unless TRAFFIC_ONE_TOKEN_LOG=1).

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { authSatisfied } from '../../shared/auth';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { hostFlags } from '../../shared/host/capability-flags';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { firstEmitThisSession } from '../../shared/once';
import { retentionAdvisory, sweepTrafficOneRetention } from '../../shared/retention';
import { hookSessionIdentity, isWebState, readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { parsedToolInput } from '../../shared/tool-classify';
import { logToolUse } from '../../shared/token-logger';
import { toolResultText } from '../../shared/tool-result';
import { readVerificationContract } from '../../shared/verification-contract';

const BUILD_COMMAND_RE = /(^|[\s;&|])(pnpm|npm|yarn|bun|turbo|vite)(\s[^;&|]*?)?\s+build(\s|$)/;
const LIGHTHOUSE_COMMAND_RE = /\blighthouse-runner\.(?:cjs|mjs)\b/;

type Rec = Record<string, unknown>;

function jsonObjectCandidates(text: string): string[] {
  const out: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

// A SHAPE, not a list. The runner's failure path is total — every error it can
// hit prints one JSON status line — and this function decides which of those lines
// this hook is willing to see. Enumerating them made it a partial function in
// front of that total contract: `blocked:lighthouse-missing` has been printed and
// dropped here for as long as it has existed, so an agent whose host had no
// Lighthouse binary was told nothing at all, and each status the runner gained
// afterwards inherited the same silence. Matching the prefix instead means a new
// status is surfaced the day it is emitted; the only thing left to keep in step is
// its label below, which a test pins across the two trees.
const RUNNER_STATUS_RE = /^(?:blocked|failed):[a-z][a-z-]*$/;

interface RunnerStatusLine {
  status: string;
  error: string | null;
}

// `blocked:*` says the host stopped the measurement; `failed:*` says the host was
// fine and the project (or the invocation) had nothing auditable. The default is
// for a status this build of the hook has never heard of — it must still read as a
// failed audit, which is why it exists, but no status the runner DECLARES may rest
// here: page-speed.test.ts reads the runner's own list and fails if one does.
function lighthouseStatusLabel(status: string): string {
  switch (status) {
    case 'blocked:sandbox': return 'sandbox blocked Lighthouse';
    case 'blocked:timeout': return 'the Lighthouse runner timed out';
    case 'blocked:usage-limit': return 'usage limit blocked Lighthouse';
    case 'blocked:lighthouse-missing': return 'no Lighthouse binary was available to run';
    case 'blocked:preview-command-missing': return 'the preview server command could not be executed on this host';
    case 'failed:project': return 'the project was not in a state that could be audited';
    case 'failed:unclassified': return 'the Lighthouse runner failed for a reason it could not attribute';
    default: return 'the Lighthouse runner could not produce a result';
  }
}

/**
 * Did the runner report an AUDIT — the other thing it can print?
 *
 * Measured against a real successful run rather than guessed: the runner's summary
 * object carries `buildMode: "production-preview"` alongside `url`, `metrics`,
 * `reports`, `failures` and `withinTolerance`, so either marker identifies it. The
 * raw fallback mirrors the status parser's, for the same reason — a response
 * clipped mid-object has no balanced JSON left to parse, and a truncated SUCCESS
 * must not be mistaken for a run that reported nothing.
 */
function lighthouseSummaryPresent(text: string): boolean {
  for (const candidate of jsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const obj = parsed as Rec;
      if (obj.buildMode === 'production-preview') return true;
      if (typeof obj.url === 'string' && obj.metrics && typeof obj.metrics === 'object') return true;
    } catch {
      // not this object
    }
  }
  return /"buildMode"\s*:\s*"production-preview"|"metrics"\s*:\s*\{/.test(text);
}

function lighthouseRunnerStatus(text: string): RunnerStatusLine | null {
  if (!text) return null;
  const parseCandidate = (candidate: string): RunnerStatusLine | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Rec : null;
      const status = obj && typeof obj.status === 'string' ? obj.status : '';
      if (!RUNNER_STATUS_RE.test(status)) return null;
      return { status, error: obj && typeof obj.error === 'string' ? obj.error : null };
    } catch {
      return null;
    }
  };
  const whole = parseCandidate(text.trim());
  if (whole) return whole;
  const objects = jsonObjectCandidates(text);
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const parsed = parseCandidate(objects[i] as string);
    if (parsed) return parsed;
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = parseCandidate(lines[i] as string);
    if (parsed) return parsed;
  }
  const match = text.match(/"status"\s*:\s*"((?:blocked|failed):[a-z][a-z-]*)"/);
  if (!match) return null;
  const error = text.match(/"error"\s*:\s*"([^"]{1,500})"/);
  return { status: match[1] as string, error: error ? error[1] as string : null };
}

export function postBuildPageSpeed(ctx: Ctx): HookResult {
  if (isNonProjectRoot(ctx.cwd)) return noop();
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  if (isNonProjectRoot(cwd) || pluginUseDeclined(cwd)) return noop();
  if (!authSatisfied()) return noop();
  // The canonical tool input is what a host that keeps none in `raw` (Cursor)
  // leaves on the parsed tool, so pass it: without it every Cursor row in the
  // opt-in token log recorded `inputBytes: 0`.
  logToolUse(
    cwd,
    ctx.input.raw && typeof ctx.input.raw === 'object' ? (ctx.input.raw as Record<string, unknown>) : null,
    parsedToolInput(ctx.input.tool),
  );
  const command = ctx.input.tool?.command ?? '';
  if (LIGHTHOUSE_COMMAND_RE.test(command)) {
    // The runner just wrote another ~1.3 MB report pair into
    // `.traffic-one/reports/lighthouse/`. Retention already caps those at
    // `lighthouseKeepPerRoute`, but its only trigger was SessionStart, so a long
    // build session never swept: observed 10co, six pairs for the single `home`
    // route and a 14.7 MB reports dir inside one run. This is the natural
    // boundary — the files exist, and we are already parsing this command.
    // Best-effort: retention must never turn a page-speed hook into a failure.
    //
    // The sweep's NOTICES are kept rather than dropped, because this branch
    // composes a user-visible banner and retention.ts's own census had recorded
    // the opposite ("the page-speed sweep composes no banner"). They are appended
    // to whichever banner this branch already returns, and no banner is
    // manufactured for them alone: SessionStart reports the same conditions once
    // per session through the same text, so inventing a second surface here would
    // put retention prose in front of a user on every Lighthouse command. What is
    // being fixed is a banner that existed and carried nothing.
    let retentionNotice = '';
    try {
      retentionNotice = retentionAdvisory(sweepTrafficOneRetention(cwd, { dryRun: false }).notices) || '';
    } catch {
      // ignore — a busy or partially-written report dir is swept next time
    }
    const retentionTail = retentionNotice ? `\n${retentionNotice}` : '';
    // Every string the tool result carries, whatever this host calls the field it
    // arrived in. Both halves of that matter here and both were measured: reading
    // only the wrapper keys meant NO structured status had ever surfaced on Cursor,
    // and then naming the containers still missed Cascade and Copilot — where a
    // GREEN audit was reported as an unmeasured one, because a status this hook
    // cannot read is indistinguishable from a runner that printed nothing.
    // `toolResultText` is the shared reader for exactly that question, and it skips
    // the tool INPUT so a runner invocation quoting a route, or a status line,
    // cannot decide the verdict.
    const responded = toolResultText(ctx.input.raw);
    const reported = lighthouseRunnerStatus(responded);
    if (reported) {
      const label = lighthouseStatusLabel(reported.status);
      // Codex's workspace-write sandbox denies binding the 127.0.0.1 preview
      // port (`listen EPERM`, observed 8c-codex). Escalation is routine there —
      // prescribe the exact retry instead of leaving page speed unverified.
      // Stays keyed to the sandbox status alone: escalation buys nothing for a
      // project that has no build, and offering it there sends the reader to a
      // permissions recipe for a `npm run build`.
      const codexEscalation = hostFlags(ctx.host).sandboxNeedsEscalation && reported.status === 'blocked:sandbox'
        ? ' On Codex, rerun the SAME runner command via exec_command with `sandbox_permissions: "require_escalated"` and the persistent prefix `["node", "~/.traffic-one/bin/lighthouse-runner.cjs"]` — the runner must bind a 127.0.0.1 preview port, which the workspace sandbox forbids.'
        : '';
      // Page speed is unverified either way; the repair is not the same. A
      // staging URL is the way around an environment gap and is wrong advice for
      // an unbuilt project, which no URL fixes.
      const repair = reported.status.startsWith('failed:')
        ? ' Treat page speed as unverified and fix the cause in the project before re-running the gate — this was not an environment gap, so an already-running or staging URL does not answer it.'
        : ' Treat page speed as unverified, list concrete page-speed risks, and use a staging/already-running URL if available.';
      return context(
        `[traffic-one] Lighthouse mobile gate reported ${reported.status}: ${reported.error || label}.${repair}${codexEscalation}${retentionTail}`,
        { systemMessage: `traffic-one page-speed ${reported.status}` },
      );
    }
    // The runner has exactly two things it can print: an audit summary, or one
    // JSON status line. Neither observed means no result was observed, and staying
    // silent about that is the fail-OPEN direction — the same silence the runner's
    // total failure path and the prefix match above were built to end, reached by a
    // third route. So report the observation and NOT a cause: this hook genuinely
    // cannot tell a runner killed from outside apart from a response that did not
    // reach it, both are consistent with the evidence, and the one thing that is
    // true under either is that nothing was measured. No `failed:*` repair tail,
    // because neither cause is fixed in the project.
    //
    // `--help` is the one invocation that legitimately prints neither, so it is
    // excluded rather than reported as a missing audit.
    if (!/(?:^|\s)(?:--help|-h)(?:\s|$)/.test(command) && !lighthouseSummaryPresent(responded)) {
      return context(
        '[traffic-one] The Lighthouse mobile gate produced NO RESULT: neither an audit summary nor a '
        + 'status line was observed from that runner call. The runner always prints one of the two, so '
        + 'either it was killed from outside (a host or CI timeout, an interrupt) or its output did not '
        + 'reach this hook intact — this hook cannot tell which, and neither is evidence that the audit '
        + 'passed. Treat page speed as unverified, re-run the gate, and if a re-run is silent too, read '
        + "the runner's own stdout before concluding anything about page speed."
        + retentionTail,
        { systemMessage: 'traffic-one page-speed no-result' },
      );
    }
  }
  if (!BUILD_COMMAND_RE.test(command)) return noop();
  const state = readEffectiveState(cwd);
  if (!isWebState(state)) return noop();
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  const contract = runId ? readVerificationContract(cwd, runId) : null;
  // Lighthouse is a separate, risk-derived performance contract. A normal web
  // build must not manufacture a Lighthouse obligation when the runtime did
  // not compile one for this run.
  if (!contract?.performance.required) return noop();
  // Iterative implement-verify loops run `npm run build` many times; the full
  // advisory injects once per session, later builds get a one-line reminder.
  if (!firstEmitThisSession(cwd, 'pagespeed-advisory', hookSessionIdentity(ctx.input.raw).sessionId)) {
    return context(
      '[traffic-one] The run performance contract still requires Lighthouse evidence — run: node ~/.traffic-one/bin/lighthouse-runner.cjs --route / (the runner ships with the PLUGIN, not the repo).',
      { systemMessage: 'traffic-one page-speed gate pending after build' },
    );
  }
  return context(
    [
      '[traffic-one] A production build just ran for a web stack.',
      'This run has a runtime-compiled performance requirement. Before final delivery, run the Lighthouse mobile gate:',
      '',
      '  node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      '  node ~/.traffic-one/bin/lighthouse-runner.cjs --url https://staging.example.com --skip-preview',
      '',
      'Audit `/` plus the 1-2 heaviest public routes (catalog/listing pages — rerun with `--route <path>`); the home route alone hides heavy-route regressions. A metric flagged `withinTolerance` passed the gate — do NOT iterate on it. A confirmation re-run with no code changes in between may add `--skip-build`. If the local sandbox blocks preview binding, use an already-running or staging URL with `--url ... --skip-preview`. The summary also carries Accessibility/Best-Practices/SEO scores from the same audit — surface a11y warnings to the team.',
      '',
      'If the runner fails, use the reported Lighthouse opportunities to make targeted fixes, then rerun once or twice before reporting the result. The runner ALWAYS ends with one JSON status line: report whichever structured status it printed (`blocked:*` when the environment stopped the measurement, `failed:*` when the project had nothing auditable) with concrete risks; never imply page speed was verified.',
      ...(hostFlags(ctx.host).sandboxNeedsEscalation ? [
        '',
        'Codex: the workspace sandbox denies binding the preview port (`blocked:sandbox`, listen EPERM). Run the runner via exec_command with `sandbox_permissions: "require_escalated"` and the persistent prefix `["node", "~/.traffic-one/bin/lighthouse-runner.cjs"]`, or audit an already-running/staging URL with `--url ... --skip-preview`.',
      ] : []),
    ].join('\n'),
    { systemMessage: 'traffic-one page-speed gate pending after build' },
  );
}
