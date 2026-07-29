// src/modules/page-speed/handler.ts
// PostToolUse(shell) advisory: after a production build on a web stack, remind
// the agent to run the Lighthouse mobile gate. Ported 1:1 from
// runPostBuildPageSpeed in scripts/hook-runtime/handlers/post.cjs — including
// the opt-in per-tool token log (no-op unless TRAFFIC_ONE_TOKEN_LOG=1).

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { authSatisfied } from '../../shared/auth';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { firstEmitThisSession } from '../../shared/once';
import { hookSessionIdentity, isWebState, readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { logToolUse } from '../../shared/token-logger';
import { readVerificationContract } from '../../shared/verification-contract';

const BUILD_COMMAND_RE = /(^|[\s;&|])(pnpm|npm|yarn|bun|turbo|vite)(\s[^;&|]*?)?\s+build(\s|$)/;
const LIGHTHOUSE_COMMAND_RE = /\blighthouse-runner\.(?:cjs|mjs)\b/;

type Rec = Record<string, unknown>;

function responsePayload(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Rec;
  return r.tool_response ?? r.toolResponse ?? r.tool_result ?? r.toolResult ?? null;
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectText(item, depth + 1));
  if (typeof value !== 'object') return [];
  const r = value as Rec;
  const keys = ['stdout', 'stderr', 'output', 'text', 'content', 'message', 'result', 'data'];
  return keys.flatMap((key) => collectText(r[key], depth + 1));
}

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

function lighthouseBlockedStatus(raw: unknown): { status: 'blocked:sandbox' | 'blocked:usage-limit' | 'blocked:timeout'; error: string | null } | null {
  const text = collectText(responsePayload(raw)).join('\n');
  if (!text) return null;
  const parseCandidate = (candidate: string): { status: 'blocked:sandbox' | 'blocked:usage-limit' | 'blocked:timeout'; error: string | null } | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Rec : null;
      const status = obj && typeof obj.status === 'string' ? obj.status : '';
      if (status !== 'blocked:sandbox' && status !== 'blocked:usage-limit' && status !== 'blocked:timeout') return null;
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
  const match = text.match(/"status"\s*:\s*"(blocked:sandbox|blocked:usage-limit|blocked:timeout)"/);
  if (!match) return null;
  const error = text.match(/"error"\s*:\s*"([^"]{1,500})"/);
  return { status: match[1] as 'blocked:sandbox' | 'blocked:usage-limit' | 'blocked:timeout', error: error ? error[1] as string : null };
}

export function postBuildPageSpeed(ctx: Ctx): HookResult {
  if (isNonProjectRoot(ctx.cwd)) return noop();
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  if (isNonProjectRoot(cwd) || pluginUseDeclined(cwd)) return noop();
  if (!authSatisfied()) return noop();
  logToolUse(cwd, ctx.input.raw && typeof ctx.input.raw === 'object' ? (ctx.input.raw as Record<string, unknown>) : null);
  const command = ctx.input.tool?.command ?? '';
  if (LIGHTHOUSE_COMMAND_RE.test(command)) {
    const blocked = lighthouseBlockedStatus(ctx.input.raw);
    if (blocked) {
      const label = blocked.status === 'blocked:sandbox'
        ? 'sandbox blocked Lighthouse'
        : blocked.status === 'blocked:timeout'
          ? 'the Lighthouse runner timed out'
          : 'usage limit blocked Lighthouse';
      // Codex's workspace-write sandbox denies binding the 127.0.0.1 preview
      // port (`listen EPERM`, observed 8c-codex). Escalation is routine there —
      // prescribe the exact retry instead of leaving page speed unverified.
      const codexEscalation = ctx.host === 'codex' && blocked.status === 'blocked:sandbox'
        ? ' On Codex, rerun the SAME runner command via exec_command with `sandbox_permissions: "require_escalated"` and the persistent prefix `["node", "~/.traffic-one/bin/lighthouse-runner.cjs"]` — the runner must bind a 127.0.0.1 preview port, which the workspace sandbox forbids.'
        : '';
      return context(
        `[traffic-one] Lighthouse mobile gate reported ${blocked.status}: ${blocked.error || label}. Treat page speed as unverified, list concrete page-speed risks, and use a staging/already-running URL if available.${codexEscalation}`,
        { systemMessage: `traffic-one page-speed ${blocked.status}` },
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
      'If the runner fails, use the reported Lighthouse opportunities to make targeted fixes, then rerun once or twice before reporting the result. If the environment blocks Lighthouse, report the structured status (`blocked:sandbox`, `blocked:usage-limit`, or `blocked:timeout`) with concrete risks; never imply page speed was verified.',
      ...(ctx.host === 'codex' ? [
        '',
        'Codex: the workspace sandbox denies binding the preview port (`blocked:sandbox`, listen EPERM). Run the runner via exec_command with `sandbox_permissions: "require_escalated"` and the persistent prefix `["node", "~/.traffic-one/bin/lighthouse-runner.cjs"]`, or audit an already-running/staging URL with `--url ... --skip-preview`.',
      ] : []),
    ].join('\n'),
    { systemMessage: 'traffic-one page-speed gate pending after build' },
  );
}
