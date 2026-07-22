// src/test-environment/config/hosts.ts
// Per-host headless command TEMPLATES. The drivers are data-driven: to fix a
// flag, edit here — no driver code change. Tokens expanded at run time:
//   {PROMPT} {PROMPT_FILE} {CWD} {MODEL} {OUTPUT_FORMAT} {DIST}
//
// Only `claude` is marked verified — Codex and Cursor command shapes are best
// guesses pending an empirical check on the maintainer's installs (verified:false).

import type { HostCommandConfig, HostId } from '../core/types';
import { HOST_MODELS, type HostModelKey } from '../../config/model-tiers';

function defaultModels(host: HostModelKey): HostCommandConfig['defaultModelByTier'] {
  return {
    highest: HOST_MODELS[host].tiers.highest[0],
    balanced: HOST_MODELS[host].tiers.balanced[0],
    cheapest: HOST_MODELS[host].tiers.cheapest[0],
  };
}

export const HOST_COMMANDS: Record<HostId, HostCommandConfig> = {
  claude: {
    bin: 'claude',
    promptVia: 'arg',
    // `claude -p "<prompt>"` runs headless. stream-json (requires --verbose) writes
    // events as they happen, so a long run killed by --timeout still leaves a
    // partial transcript (plain json only emits one blob at the very end, lost on
    // kill). bypassPermissions lets the agent act without prompts in the temp project.
    // Exclude user-scoped plugin settings and load this run's freshly built
    // dist directly. This bypasses Claude's version-keyed plugin cache while
    // retaining normal auth, project settings, and local settings.
    runArgs: ['--setting-sources', 'project,local', '--plugin-dir', '{DIST}', '-p', '{PROMPT}', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--model', '{MODEL}'],
    outputFormat: 'stream-json',
    probeArgs: ['--version'],
    installArgs: [],
    currentDistProof: 'session-plugin-dir',
    headlessSubagents: 'unsupported',
    defaultModelByTier: defaultModels('claude'),
    verified: true,
  },

  codex: {
    bin: 'codex',
    promptVia: 'arg',
    // DEFAULTS-TO-VERIFY: confirm `codex exec` accepts a positional prompt, the
    // --json envelope, and the correct sandbox-bypass flag for headless writes.
    // The isolated temp workspace is disposable, so explicitly bypass hook trust;
    // otherwise Codex can withhold the newly installed plugin's hooks there.
    runArgs: ['exec', '--json', '--cd', '{CWD}', '--sandbox', 'danger-full-access', '--dangerously-bypass-hook-trust', '-c', 'plugins."traffic-one@traffic-one-local".enabled=false', '-m', '{MODEL}', '{PROMPT}'],
    outputFormat: 'json',
    probeArgs: ['--version'],
    installArgs: [
      ['plugin', 'marketplace', 'add', '{MARKETPLACE_ROOT}'],
      ['plugin', 'add', 'traffic-one@{MARKETPLACE}'],
    ],
    currentDistProof: 'host-install',
    headlessSubagents: 'unsupported',
    defaultModelByTier: defaultModels('codex'),
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
    // `/add-plugin <dist>` (not scriptable), so this is the sole explicit
    // release-harness exemption. Strict behavior assertions must still pass.
    runArgs: ['-p', '--force', '--output-format', 'text', '--model', '{MODEL}', '{PROMPT}'],
    outputFormat: 'text',
    probeArgs: ['--version'],
    installArgs: [],
    currentDistProof: 'manual-live-pointer',
    headlessSubagents: 'unsupported',
    defaultModelByTier: defaultModels('cursor'),
    // Keep host smoke runs on Cursor's `auto`: the exact per-account selector
    // variants are captured at onboarding and cannot be assumed by headless CI.
    testModel: 'auto',
    verified: false,
  },

  opencode: {
    bin: 'opencode',
    promptVia: 'arg',
    // Matches the same documented headless invocation used by the shipped
    // delegation runner. Plugin loading in a standalone host run is still a
    // maintainer verification item.
    runArgs: ['run', '{PROMPT}', '--dir', '{CWD}', '-m', '{MODEL}', '--format', 'json'],
    outputFormat: 'json',
    probeArgs: ['--version'],
    installArgs: [],
    currentDistProof: 'case-wrapper',
    headlessSubagents: 'unsupported',
    defaultModelByTier: defaultModels('opencode'),
    verified: false,
  },

  kilo: {
    bin: 'kilo',
    promptVia: 'arg',
    // `kilo run` is OpenCode-compatible; --auto is the non-interactive
    // permission mode intended for autonomous/pipeline runs.
    runArgs: ['run', '{PROMPT}', '--dir', '{CWD}', '-m', '{MODEL}', '--format', 'json', '--auto'],
    outputFormat: 'json',
    probeArgs: ['--version'],
    installArgs: [],
    currentDistProof: 'case-wrapper',
    headlessSubagents: 'unsupported',
    defaultModelByTier: defaultModels('kilo'),
    verified: false,
  },

  copilot: {
    bin: 'copilot',
    promptVia: 'arg',
    runArgs: [],
    probeArgs: ['--version'],
    installArgs: [],
    defaultModelByTier: defaultModels('copilot'),
    e2eSupported: false,
    verified: false,
  },

  windsurf: {
    bin: 'windsurf',
    promptVia: 'arg',
    runArgs: [],
    probeArgs: ['--version'],
    installArgs: [],
    defaultModelByTier: defaultModels('windsurf'),
    e2eSupported: false,
    verified: false,
  },
};
