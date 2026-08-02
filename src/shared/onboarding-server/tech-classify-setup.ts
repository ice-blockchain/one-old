// src/shared/onboarding-server/tech-classify-setup.ts
// Verbatim fallbacks + hint formatting for the agent tech-classification
// directive (the `tech-classify-required` T1BLOCK): shown when the deterministic
// artifact tables derive NO stack for an existing repo, so the SESSION AGENT
// must inspect the codebase and submit the tech via the allow-listed
// `--set-tech` runner command. Sibling of claude-setup.ts et al. — the deny
// CONDITIONS live in the gate; this is prose only.

import { BACKEND_IDS, FRONTEND_IDS, MOBILE_FRAMEWORK_IDS } from '../../config/state';
import type { StackDetection } from '../detection';

export const TECH_CLASSIFY_REQUIRED_TOKEN = 'TRAFFIC_ONE_TECH_CLASSIFY_REQUIRED';
export const TECH_RECORDED_TOKEN = 'TRAFFIC_ONE_TECH_RECORDED';
export const TECH_INVALID_TOKEN = 'TRAFFIC_ONE_TECH_INVALID';

export function techClassifyIdLists(): { frontend: string; backend: string; mobile: string } {
  return {
    frontend: [...FRONTEND_IDS].join(', '),
    backend: [...BACKEND_IDS].join(', '),
    mobile: [...MOBILE_FRAMEWORK_IDS].join(', '),
  };
}

// Format the deterministic scanner's PARTIAL evidence as hints for the agent
// (e.g. a websocket lib matched but no stack was derivable).
export function techClassifyHints(detected?: StackDetection | null): string {
  if (!detected) return '(no partial signals)';
  const lines: string[] = [];
  if (detected.realtime === 'light') lines.push('- a websocket library was detected → include --realtime=light');
  if (detected.frontend) lines.push(`- partial frontend signal: ${detected.frontend}`);
  if (detected.backend) lines.push(`- partial backend signal: ${detected.backend}`);
  for (const row of detected.evidence) lines.push(`- ${row}`);
  return lines.length > 0 ? [...new Set(lines)].join('\n') : '(no partial signals)';
}

// Full directive (Claude/Codex/Cursor/Windsurf). {{VARS}} twin lives in the
// onboarding-gate SKILL.md `tech-classify-required` block.
export function techClassifyRequiredReason(setTechTemplate: string, hints: string): string {
  const ids = techClassifyIdLists();
  return [
    'traffic-one — this existing codebase could not be identified deterministically: none of the known stack markers matched, so YOU must classify it before setup can continue.',
    '',
    '1. Inspect the repo yourself — package manifests, lockfiles, entrypoints, framework configs. A few READS are enough; do not modify anything.',
    '2. Submit the tech by running this command with the surfaces you identified appended:',
    setTechTemplate,
    "   Append: `--frontend=<id>` and `--backend=<id>` (both REQUIRED — use `none` when that surface does not exist), plus optional `--mobile=<id>`, `--realtime=light` (when a websocket/realtime layer exists), and `--evidence='<short proof>'` (e.g. --evidence='express + mongoose in package.json').",
    `   frontend ids: ${ids.frontend}`,
    `   backend ids: ${ids.backend}`,
    `   mobile ids: ${ids.mobile}`,
    '   Use `other`/`none` when nothing fits — NEVER invent an id; the command is denied unless every id is from these lists.',
    '',
    'Partial signals already detected:',
    hints,
    '',
    `On success it prints ${TECH_RECORDED_TOKEN} and then the setup wizard's \`Setup link:\` — post that link to the user in chat and run the printed waiter command, exactly as in the normal setup flow. Run the command EXACTLY as printed plus your surface flags — no pipes, redirection, or \`&&\`; the gate allow-lists the precise argv.`,
  ].join('\n');
}

// Injection-safe compact variant for OpenCode/Kilo (their models flag the full
// walkthrough as prompt injection — mirror the gate's minimal factual style).
export function techClassifyRequiredCompactReason(setTechTemplate: string, hints: string): string {
  const ids = techClassifyIdLists();
  return `traffic-one: this repo's stack could not be detected. Inspect the codebase (reads only), then run: ${setTechTemplate} with --frontend=<${ids.frontend}> --backend=<${ids.backend}> appended (both required; optional --mobile, --realtime=light, --evidence='<proof>'). Partial signals: ${hints.replace(/\n/g, ' ')}. It prints ${TECH_RECORDED_TOKEN} then the Setup link.`;
}
