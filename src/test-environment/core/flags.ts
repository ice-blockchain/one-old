// src/test-environment/core/flags.ts
// CLI flag parsing for the test-environment harness, split out of run.ts so it
// can be exercised without importing run.ts — that module runs main() on load,
// so importing it would start a real harness run inside the unit suite. The
// split is what lets ci-strict-invocation.test.ts feed the LITERAL argv from
// .github/workflows/**.yml through the same code path the workflow hits.

import type { Category, HostId, RootTestConfig, VerdictHost } from './types';
import { ALL_CATEGORIES, ALL_HOSTS } from '../config/test-config';
import { ALL_CASE_IDS } from '../config/cases';
import { selectedManualCertificationHosts } from '../manual-host-certification';

// Same name and same meaning as UsageError in src/build/sync-hosts.ts: the two
// parsers accept the same host ids and must not disagree about what an
// unrecognized one means.
export class UsageError extends Error {}

export interface Flags {
  hosts?: HostId[];
  categories?: Category[];
  cases?: string[];
  verdictHost?: VerdictHost;
  noBuild?: boolean;
  noInstall?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  auth?: 'on' | 'off';
  dryRun?: boolean;
  e2e?: boolean;
  strict?: boolean;
  runsDir?: string;
  reassert?: string;
  manualCertDir?: string;
}

// An unrecognized value is a usage error, never a silent fall-through to the
// defaults — the rule src/build/sync-hosts.ts already states as "an unknown host
// is a usage error, never a silent fall-through to all hosts".
//
// It filtered instead: `--host=cursr` produced [], applyFlags skips an empty
// list, so the typo quietly ran the DEFAULT host set and reported success —
// certifying hosts nobody asked about while saying nothing about the one they
// did. `--host cursor` (space form, which does not parse — see
// ../README.md) reached the same empty list by a different route, so both are
// rejected here.
function requireKnown<T extends string>(flag: string, raw: string, allowed: readonly T[]): T[] {
  const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new UsageError(`${flag} needs a comma-separated value, e.g. ${flag}=${allowed[0]} (the space-separated form does not parse)`);
  }
  const unknown = values.filter((value) => !(allowed as readonly string[]).includes(value));
  if (unknown.length > 0) {
    throw new UsageError(`unknown ${flag} value${unknown.length > 1 ? 's' : ''} "${unknown.join('", "')}" — expected one of: ${allowed.join(', ')}`);
  }
  return values as T[];
}

export function parseFlags(argv: string[]): Flags {
  const f: Flags = {};
  for (const arg of argv) {
    const [key, rawValue] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, ''];
    const value = rawValue ?? '';
    if (!key) continue;
    switch (key) {
      case '--host': f.hosts = requireKnown('--host', value, ALL_HOSTS); break;
      case '--category': f.categories = requireKnown('--category', value, ALL_CATEGORIES); break;
      case '--case': f.cases = requireKnown('--case', value, ALL_CASE_IDS); break;
      case '--verdict-host': f.verdictHost = (value as VerdictHost); break;
      case '--no-build': f.noBuild = true; break;
      case '--no-install': f.noInstall = true; break;
      case '--concurrency': f.concurrency = Number(value) || 1; break;
      case '--timeout': f.timeoutMs = Number(value) || undefined; break;
      case '--auth': f.auth = value === 'on' ? 'on' : 'off'; break;
      case '--dry-run': f.dryRun = true; break;
      case '--e2e': f.e2e = true; break;
      case '--all': f.e2e = true; break;
      case '--strict': f.strict = true; break;
      case '--runs-dir': case '--artifacts': f.runsDir = value; break;
      case '--reassert': f.reassert = value; break;
      case '--manual-cert-dir': f.manualCertDir = value; break;
      // Same reasoning as an unknown --host value, one level up: a misspelled
      // FLAG (`--hostt=cursor`, or a space-separated value arriving as its own
      // argv entry) was silently dropped and the run proceeded on defaults, so
      // the invocation that reported success was not the one that was asked for.
      default: throw new UsageError(`unknown flag "${key}" — see src/test-environment/README.md for the flag list`);
    }
  }
  return f;
}

export function applyFlags(config: RootTestConfig, f: Flags): RootTestConfig {
  if (f.hosts && f.hosts.length) config.enabledHosts = f.hosts;
  if (f.categories && f.categories.length) config.enabledCategories = f.categories;
  if (f.cases && f.cases.length) config.caseFilter = f.cases;
  if (f.verdictHost) config.verdictHost = f.verdictHost;
  if (f.noBuild) config.build.refreshDist = false;
  if (f.noInstall) config.build.updateHosts = false;
  if (f.concurrency) config.concurrency = f.concurrency;
  if (f.timeoutMs) config.defaultTimeoutMs = f.timeoutMs;
  if (f.auth) config.auth = f.auth;
  if (f.dryRun) config.dryRun = true;
  if (f.e2e) config.includeHostE2E = true;
  if (f.strict) config.strict = true;
  if (f.runsDir) config.runsRoot = f.runsDir;
  if (f.manualCertDir !== undefined) config.manualCertDir = f.manualCertDir;
  return config;
}

// Which hosts this invocation does NOT cover, and why — for the run's own
// output, so the gap does not have to be reconstructed from a YAML comment.
//
// The gap is real and deliberate: the CI job named "Full composition
// (test:env --strict)" passes `--host=claude,codex` because selecting Cursor
// demands a manual certification record that a per-push build can never have
// (see the comment on that step). But a green check named "Full composition"
// reads as full coverage, and the run printed nothing about what it skipped —
// so a release manager could only learn Cursor was unproven by opening the
// workflow file.
//
// Two DIFFERENT exclusions, kept separate because they are not interchangeable:
// a host left out by `--host=` was not asked for, while a selected
// manual-certification host was asked for and still cannot be driven live here.
export function excludedHostNotes(config: RootTestConfig): string[] {
  const notes: string[] = [];
  const deselected = ALL_HOSTS.filter((host) => !config.enabledHosts.includes(host));
  if (deselected.length > 0) {
    notes.push(`not selected for this run: ${deselected.join(', ')}`);
  }
  const manual = selectedManualCertificationHosts(config.enabledHosts);
  if (manual.length > 0) {
    notes.push(
      `selected but never driven automatically (release evidence is a dated manual record): ${manual.join(', ')}`,
    );
  }
  return notes;
}
