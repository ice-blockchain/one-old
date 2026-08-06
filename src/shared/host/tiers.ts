// src/shared/host/tiers.ts
// The product-facing host-tier decision (HOST_CAPABILITIES[host].tier) and the
// two places it surfaces: an uncertified host's install (refuse, opt-out) and
// an already-installed uncertified host's SessionStart banner (visible,
// non-blocking). Both read the SAME capability record — no parallel list of
// "which hosts are uncertified" lives here.

import { HOST_CAPABILITIES, type TrafficOneHost } from './capability-schema';

// TRAFFIC_ONE_* boolean-flag convention already used for
// TRAFFIC_ONE_ONBOARDING_NO_SPAWN / TRAFFIC_ONE_RUNTIME_PROBE_OFF: '1' opts
// in, anything else (including unset) leaves the install refusal active.
export const UNCERTIFIED_HOST_OPT_OUT_ENV = 'TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST';

const HOST_LABELS: Record<TrafficOneHost, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  kilo: 'Kilo',
  copilot: 'Copilot',
  windsurf: 'Windsurf',
};

function contractFor(host: string): (typeof HOST_CAPABILITIES)[TrafficOneHost] | null {
  return HOST_CAPABILITIES[host as TrafficOneHost] ?? null;
}

/** The name a user recognizes, for a host id. Unknown ids pass through. */
export function hostLabel(host: string): string {
  return HOST_LABELS[host as TrafficOneHost] ?? host;
}

// Derived, never a second list: the banner has to tell the reader which hosts
// DO carry the guarantee, and hardcoding "Claude Code, Codex and Cursor" in
// prose is a claim that silently goes stale the day a tier changes.
function certifiedHostNames(): string {
  const names = Object.values(HOST_CAPABILITIES)
    .filter((contract) => contract.tier === 'certified')
    .map((contract) => hostLabel(contract.host));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Fail CLOSED on a host with no capability record. "Uncertified" means "Traffic
// One has no release evidence that its enforcement keeps working here", and a
// host string this module has never heard of is the strongest possible case of
// that — a typo in TRAFFIC_ONE_HOST, or a host added to the adapters without a
// row in HOST_CAPABILITIES. Reading the absence of a record as `certified` gave
// exactly that host a silent free pass through both surfaces below.
export function isUncertifiedHost(host: string): boolean {
  return contractFor(host)?.tier !== 'certified';
}

export function uncertifiedHostOptOutSet(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[UNCERTIFIED_HOST_OPT_OUT_ENV] === '1';
}

// The named refusal message for an install surface we control (today: the
// opencode/kilo/windsurf wrapper installers — see their `installWrapper()`).
// Returns null when the host is certified or the opt-out is already set — i.e.
// "installation may proceed."
export function uncertifiedHostInstallRefusal(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isUncertifiedHost(host) || uncertifiedHostOptOutSet(env)) return null;
  const label = HOST_LABELS[host as TrafficOneHost] ?? host;
  return [
    `Refusing to install Traffic One for ${label}: ${label} is not a certified host.`,
    'Traffic One cannot enforce its guarantees there — its enforcement contract '
      + 'is backed only by a manual, dated certification record, not an automated '
      + 'live run (unlike the certified hosts: Claude Code, Codex, Cursor).',
    `To install anyway, re-run with the opt-out set: ${UNCERTIFIED_HOST_OPT_OUT_ENV}=1`,
  ].join('\n');
}

// Non-blocking SessionStart banner for an uncertified host that is already
// installed and running. Returns null for a certified host.
//
// Deliberately claims NOTHING about what the user agreed to. The previous
// wording told every reader they had "already accepted that risk — either via
// TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST=1, or because <host> has no install step
// Traffic One can gate", which is false for the whole second branch: a Copilot
// user is never asked anything (Copilot installs through its own
// `copilot plugin install`), so telling them they accepted a risk is telling
// them something that did not happen. It also printed the host's internal
// `enforcementPoints` identifiers (`pre_write_code`, `PreToolUse`, …), which
// name nothing a user can act on. What is left is only what is true right now:
// the checks are running, this notice blocks nothing, the release harness does
// not re-verify this host, and here is the concrete consequence.
export function uncertifiedHostSessionBanner(host: string): string | null {
  if (!isUncertifiedHost(host)) return null;
  const label = hostLabel(host);
  return [
    `traffic-one [${label} is not a certified host]`,
    "Traffic One's checks are running here, and this notice blocks nothing.",
    `Before each release, Traffic One re-tests its checks against real host `
      + `behaviour on ${certifiedHostNames()} only. ${label} is not in that set, `
      + `so Traffic One cannot promise its checks still work after a ${label} `
      + 'update.',
    'What that means for you: a file write, a model choice or an agent spawn '
      + 'Traffic One would normally stop BEFORE it happens may instead be caught '
      + `late, or not at all. On ${label}, review changes yourself, and prefer a `
      + 'certified host for work where those checks matter.',
  ].join('\n');
}
