// src/shared/uninstall-intent.ts
// Detects an explicit "uninstall Traffic One" request in a chat prompt and builds
// the agent-facing directive that arms the one cleanup command.
//
// The chat message is the ONLY moment a full cleanup is reachable. No host runs a
// plugin uninstall lifecycle hook (Claude Code's hook vocabulary has no such
// event, and Codex removes the bundle without running plugin cleanup) — once the
// bundle is gone, nothing of ours ever executes again. When the user says it in
// chat the plugin is still installed and its hooks still fire, so that is where
// this hooks in.
//
// The detector is deliberately narrow. It arms an irreversible, machine-wide
// action: the API key in ~/.traffic-one/one.json, the managed toolchains, four
// user-level host integrations, and the plugin bundle itself. So it must not fire
// on talk ABOUT uninstalling. Whole-prompt anchors, an explicit
// interrogative/negation reject list, and a length ceiling — the same discipline
// isRuntimeControlPrompt uses. Matching only ARMS a directive; the agent still
// takes one explicit confirmation from the user before running anything.

import * as path from 'path';

import type { HostId } from '../core/types';
import { pluginRoot } from './paths';
import { shellQuote } from './shell-quote';

const MAX_PROMPT_LENGTH = 160;

// Fold diacritics so the Romanian forms ("dezinstalează", "șterge") match the
// same ASCII patterns as everything else.
function normalize(prompt: unknown): string {
  return String(prompt || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
}

// Questions and hypotheticals about uninstalling are NOT requests to uninstall.
// "can/could/would you uninstall …" is a request, so those openers are absent here.
const INTERROGATIVE = /^(?:how|why|what|when|where|which|who|whose|should|shall|is|are|was|were|do|does|did|have|has|if|whether|cum|de ce|ce|cand|care|daca|trebuie)\b/;
const NON_REQUEST = /\b(?:how (?:do|can|to)|don'?t|do not|instead of|rather than|no need|nu (?:sterge|dezinstala|vreau|dezinstalezi)|fara a|fara sa)\b|\bnever\b|\bwithout\b|\bavoid\b/;

const POLITE = '(?:(?:please|just|now|ok|okay|te rog|acum|hai)\\s+)*';
const REQUEST_LEAD = '(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?'
  + '(?:(?:i|we)\\s+(?:want|need|wanna|would like)\\s+(?:to\\s+|you to\\s+)?)?'
  + "(?:let'?s\\s+)?"
  + '(?:(?:vreau|as vrea|vrem|poti|puteti)\\s+(?:sa\\s+)?)?';
const VERB = '(?:uninstall|un-install|uninstal|deinstall|remove|delete|drop|purge|get rid of|scap de'
  + '|dezinstaleaza|dezinstalez|dezinstalezi|dezinstaleze|dezinstalati|sterge|stergi|stergeti'
  + '|scoate|scoti|elimina|elimini)';
const TARGET = '(?:(?:the|this|that|my|your|acest|acel)\\s+)?'
  + '(?:(?:plugin|pluginul|plugin-ul|extensia)\\s+)?'
  + 'traffic[\\s_-]?one';
const TAIL = '(?:\\s+(?:plugin|pluginul|plugin-ul))?'
  + '(?:\\s+(?:completely|entirely|fully|everywhere|for good|complet|de tot|cu totul))?'
  + '(?:\\s+(?:from|off of|off|de pe)\\s+(?:my |this |the )?'
  + '(?:machine|computer|laptop|system|mac|pc|masina|calculator|sistem'
  + '|claude|codex|cursor|opencode|kilo|windsurf|copilot))?'
  + '(?:\\s+(?:please|now|for me|te rog|acum))?';

const UNINSTALL_REQUEST = new RegExp(`^${POLITE}${REQUEST_LEAD}${POLITE}${VERB}\\s+${TARGET}${TAIL}$`);

export function isUninstallTrafficOneIntent(prompt: unknown): boolean {
  const text = normalize(prompt);
  if (!text || text.length > MAX_PROMPT_LENGTH) return false;
  if (INTERROGATIVE.test(text) || NON_REQUEST.test(text)) return false;
  return UNINSTALL_REQUEST.test(text);
}

function uninstallScriptPath(): string {
  return path.join(pluginRoot(), 'scripts', 'traffic-one-uninstall.cjs');
}

export function uninstallCommand(apply: boolean): string {
  return `node ${shellQuote(uninstallScriptPath())} ${apply ? '--yes' : '--dry-run'}`;
}

// Agent-facing directive. It prescribes ONE confirmation, then one command, then
// the restart notice — the restart matters because the host loaded this session's
// hook wiring at startup and does not reload it: after the bundle is removed the
// hook command resolves to a deleted path and errors on every prompt until the
// host restarts.
export function uninstallDirective(host: HostId): string {
  const hostLabel = host === 'claude' ? 'Claude Code'
    : host === 'codex' ? 'Codex'
      : host === 'cursor' ? 'Cursor'
        : host === 'opencode' ? 'OpenCode'
          : host === 'kilo' ? 'Kilo'
            : host === 'windsurf' ? 'Windsurf' : 'the host';
  return [
    'traffic-one — the user appears to be asking to UNINSTALL Traffic One. Handle exactly this, nothing else.',
    '',
    '1. Ask for ONE explicit confirmation before running anything, and state plainly what is removed and that it cannot be undone:',
    '   - `~/.traffic-one` — the saved API key, this machine\'s per-project preferences, the runner shims, and the managed toolchains (OpenCode/GitNexus/graphify, typically over 1 GB; a future install re-downloads them).',
    '   - the user-level host integrations Traffic One installed: the OpenCode and Kilo wrappers, the Windsurf/Cascade hooks and global rule, and the Codex machine-global MCP block.',
    '   - the plugin itself, from every host CLI that has it installed.',
    '   Onboarded project content stays (`.traffic-one/` except generated role files under `.traffic-one/agents/`, AGENTS.md, plan, memory, runs). Generated host Task/subagent files (`.cursor/agents`, `.kilo/agents`, `.github/agents`, `.devin/agents`, leftover `.opencode/agents`, OpenCode `~/.config/opencode/agents/traffic-one-*.md`) are removed when their generated marker matches.',
    '',
    `2. To preview without removing anything: \`${uninstallCommand(false)}\``,
    '',
    '3. Once the user confirms, run exactly this one command and report its output verbatim:',
    `   ${uninstallCommand(true)}`,
    '',
    `4. Then tell the user to RESTART ${hostLabel}. Until they do, this session keeps firing hooks against the removed plugin and will report an error on every prompt and tool call. If the command reports that Cursor has an install, tell the user to remove it from Cursor's plugin UI — Cursor has no uninstall CLI.`,
    '',
    'If the user is instead ASKING about uninstalling — how it works, what it removes, or asking you not to — answer the question and do not run the command.',
  ].join('\n');
}
