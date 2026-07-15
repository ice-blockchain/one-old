// src/modules/page-speed/handler.ts
// PostToolUse(shell) advisory: after a production build on a web stack, remind
// the agent to run the Lighthouse mobile gate. Ported 1:1 from
// runPostBuildPageSpeed in scripts/hook-runtime/handlers/post.cjs — including
// the opt-in per-tool token log (no-op unless TRAFFIC_ONE_TOKEN_LOG=1).

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { authSatisfied } from '../../shared/auth';
import { firstEmitThisSession } from '../../shared/once';
import { hookSessionIdentity, isWebState, readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { logToolUse } from '../../shared/token-logger';

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

function lighthouseBlockedStatus(raw: unknown): { status: 'blocked:sandbox' | 'blocked:usage-limit'; error: string | null } | null {
  const text = collectText(responsePayload(raw)).join('\n');
  if (!text) return null;
  const parseCandidate = (candidate: string): { status: 'blocked:sandbox' | 'blocked:usage-limit'; error: string | null } | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Rec : null;
      const status = obj && typeof obj.status === 'string' ? obj.status : '';
      if (status !== 'blocked:sandbox' && status !== 'blocked:usage-limit') return null;
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
  const match = text.match(/"status"\s*:\s*"(blocked:sandbox|blocked:usage-limit)"/);
  if (!match) return null;
  const error = text.match(/"error"\s*:\s*"([^"]{1,500})"/);
  return { status: match[1] as 'blocked:sandbox' | 'blocked:usage-limit', error: error ? error[1] as string : null };
}

export function postBuildPageSpeed(ctx: Ctx): HookResult {
  if (pluginUseDeclined(ctx.cwd)) return noop();
  if (!authSatisfied()) return noop();
  logToolUse(ctx.cwd, ctx.input.raw && typeof ctx.input.raw === 'object' ? (ctx.input.raw as Record<string, unknown>) : null);
  const command = ctx.input.tool?.command ?? '';
  if (LIGHTHOUSE_COMMAND_RE.test(command)) {
    const blocked = lighthouseBlockedStatus(ctx.input.raw);
    if (blocked) {
      const label = blocked.status === 'blocked:sandbox' ? 'sandbox blocked Lighthouse' : 'usage limit blocked Lighthouse';
      return context(
        `[traffic-one] Lighthouse mobile gate reported ${blocked.status}: ${blocked.error || label}. Treat page speed as unverified, list concrete page-speed risks, and use a staging/already-running URL if available.`,
        { systemMessage: `traffic-one page-speed ${blocked.status}` },
      );
    }
  }
  if (!BUILD_COMMAND_RE.test(command)) return noop();
  if (!isWebState(readEffectiveState(ctx.cwd))) return noop();
  // Iterative implement-verify loops run `npm run build` many times; the full
  // advisory injects once per session, later builds get a one-line reminder.
  if (!firstEmitThisSession(ctx.cwd, 'pagespeed-advisory', hookSessionIdentity(ctx.input.raw).sessionId)) {
    return context(
      '[traffic-one] Lighthouse mobile gate still pending — run: node ~/.traffic-one/bin/lighthouse-runner.cjs --route / (the runner ships with the PLUGIN, not the repo).',
      { systemMessage: 'traffic-one page-speed gate pending after build' },
    );
  }
  return context(
    [
      '[traffic-one] A production build just ran for a web stack.',
      'Before final delivery for generated/changed React or Ionic routes, run the Lighthouse mobile gate:',
      '',
      '  node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      '  node ~/.traffic-one/bin/lighthouse-runner.cjs --url https://staging.example.com --skip-preview',
      '',
      'Audit `/` plus the 1-2 heaviest public routes (catalog/listing pages — rerun with `--route <path>`); the home route alone hides heavy-route regressions. A metric flagged `withinTolerance` passed the gate — do NOT iterate on it. A confirmation re-run with no code changes in between may add `--skip-build`. If the local sandbox blocks preview binding, use an already-running or staging URL with `--url ... --skip-preview`. The summary also carries Accessibility/Best-Practices/SEO scores from the same audit — surface a11y warnings to the team.',
      '',
      'If the runner fails, use the reported Lighthouse opportunities to make targeted fixes, then rerun once or twice before reporting the result. If the environment blocks Lighthouse, report the structured status (`blocked:sandbox` or `blocked:usage-limit`) with concrete risks; never imply page speed was verified.',
    ].join('\n'),
    { systemMessage: 'traffic-one page-speed gate pending after build' },
  );
}
