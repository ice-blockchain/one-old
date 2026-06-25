// src/test-environment/config/hosts.ts
// Per-host headless command TEMPLATES. The drivers are data-driven: to fix a
// flag, edit here — no driver code change. Tokens expanded at run time:
//   {PROMPT} {PROMPT_FILE} {CWD} {MODEL} {OUTPUT_FORMAT} {DIST}
//
// Only `claude` is marked verified — Codex and Cursor command shapes are best
// guesses pending an empirical check on the maintainer's installs (verified:false).

import type { HostCommandConfig, HostId } from '../core/types';

export const HOST_COMMANDS: Record<HostId, HostCommandConfig> = {
  claude: {
    bin: 'claude',
    promptVia: 'arg',
    // `claude -p "<prompt>"` runs headless. stream-json (requires --verbose) writes
    // events as they happen, so a long run killed by --timeout still leaves a
    // partial transcript (plain json only emits one blob at the very end, lost on
    // kill). bypassPermissions lets the agent act without prompts in the temp project.
    runArgs: ['-p', '{PROMPT}', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--model', '{MODEL}'],
    outputFormat: 'stream-json',
    probeArgs: ['--version'],
    installArgs: [
      ['plugin', 'marketplace', 'add', '{DIST}'],
      ['plugin', 'install', 'traffic-one@traffic-one'],
    ],
    defaultModelByTier: { highest: 'opus', balanced: 'sonnet', cheapest: 'haiku' },
    verified: true,
  },

  codex: {
    bin: 'codex',
    promptVia: 'arg',
    // DEFAULTS-TO-VERIFY: confirm `codex exec` accepts a positional prompt, the
    // --json envelope, and the correct sandbox-bypass flag for headless writes.
    runArgs: ['exec', '--json', '--cd', '{CWD}', '--sandbox', 'danger-full-access', '-m', '{MODEL}', '{PROMPT}'],
    outputFormat: 'json',
    probeArgs: ['--version'],
    installArgs: [
      ['plugin', 'marketplace', 'add', '{DIST}'],
      ['plugin', 'add', 'traffic-one@traffic-one-local'],
    ],
    defaultModelByTier: { highest: 'gpt-5.5', balanced: 'gpt-5.4', cheapest: 'gpt-5.4-mini' },
    verified: false,
  },

  cursor: {
    bin: 'cursor-agent',
    promptVia: 'arg',
    // Flags match the official headless docs (cursor.com/docs/cli/headless):
    //   cursor-agent -p --force --output-format text "<prompt>"
    // -p = print/non-interactive, --force = apply edits without confirmation,
    // prompt is the LAST positional arg. Auth: export CURSOR_API_KEY (preferred
    // for scripts) or `cursor-agent login` once. STILL verified:false because the
    // open question is whether headless cursor-agent loads the traffic-one plugin
    // (hooks/rules) — Cursor installs as a LIVE dir pointer via the in-editor
    // `/add-plugin <dist>` (not scriptable), so installArgs is empty and
    // build-and-install prints a reminder. A first run confirms plugin loading.
    runArgs: ['-p', '--force', '--output-format', 'text', '--model', '{MODEL}', '{PROMPT}'],
    outputFormat: 'text',
    probeArgs: ['--version'],
    installArgs: [],
    defaultModelByTier: { highest: 'claude-opus-4-8', balanced: 'claude-4.6-sonnet', cheapest: 'composer-2.5' },
    // The tier slugs above are STALE in the plugin (none exist in Cursor's live
    // catalog) — a bug this harness surfaced. Use 'auto' for runs so Cursor picks
    // a valid model and the e2e exercises plugin behavior regardless.
    testModel: 'auto',
    verified: false,
  },
};
