// README.md ↔ code, mechanically.
//
// Nothing tested this file until now, and an independent review of one recently
// changed section found SEVEN false factual claims in it — a host count that
// counted products instead of hosts, a URL parameter documented as the project
// when it is the loopback port, four hooks described as denying when one of them
// carries a comment saying it never denies. Prose cannot be pinned; the claims
// below are the ones that are MECHANICAL — a count, a list, an identifier, a
// command, a version, a URL shape — and every one of them is a claim the reader
// is expected to act on.
//
// The precedent is codex-hook-abi.test.ts, which ties both docs' Codex hook
// count to CODEX_HOOK_EXPECTED_COUNT and is the reason the hook count was the
// only claim in that section the reviewer found to be correct.
//
// Deliberately NOT here: anything about traffic.io's servers (what the dashboard
// does with an API key), which this repository cannot observe.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOST_CAPABILITIES, type TrafficOneHost } from '../src/shared/host/capability-schema';
import { UNCERTIFIED_HOST_OPT_OUT_ENV } from '../src/shared/host/tiers';
import { selfRelativePluginRoot } from '../src/shared/doctor-command';
import { isTrafficOneDoctorCommand, isTrafficOneResetCommand } from '../src/shared/tool-classify';
import { RUNNER_SHIMS, shimSource } from '../src/shared/runner-shims';
import { agentOnboardingUrls } from '../src/config/dashboard';
import { ONE_SETTINGS_VERSION } from '../src/config/one-settings';
import {
  ONE_MCP_CACHE_FILE,
  ONE_MCP_CACHE_SCHEMA_VERSION,
  ONE_MCP_CONFIG_NAME_BY_HOST,
} from '../src/config/one-mcp';
import { OPENCODE_HOST_TARGET_VERSION } from '../src/config/opencode-host';

const REPO_ROOT = path.resolve(__dirname, '..');
const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
// Whitespace-normalized copy, so a paragraph reflow never fails a claim.
const FLAT = README.replace(/\s+/g, ' ');

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function hostsWithTier(tier: 'certified' | 'uncertified'): TrafficOneHost[] {
  return (Object.keys(HOST_CAPABILITIES) as TrafficOneHost[])
    .filter((host) => HOST_CAPABILITIES[host].tier === tier)
    .sort();
}

test('no install command names a marketplace source that does not exist', () => {
  // A `marketplace add` argument is the one thing in this file a reader copies
  // verbatim and runs, and until publication there is no published source to
  // name. The "after publication" section printed `traffic-one/traffic-one`,
  // which is not this repository and is not registered anywhere — the worst of
  // the three possible arguments, because it looks real and fails at the
  // marketplace rather than at the shell.
  //
  // WHEN PUBLICATION HAPPENS this test goes red, deliberately: substituting a
  // real source is exactly the moment to decide whether the surrounding prose
  // still says "not available yet". Replace the placeholder here with the
  // published name rather than deleting the assertion.
  const sources = [...README.matchAll(/(?:plugin marketplace add|\/add-plugin)\s+(\S+)/g)]
    .map((match) => match[1]!);
  assert.ok(
    sources.length >= 5,
    `README no longer prints marketplace install sources (found ${sources.length}) — update this test with them`,
  );
  for (const source of sources) {
    assert.ok(
      source.startsWith('/absolute/path/to/') || source === '<published-marketplace>',
      `README prints an install source that is neither the local build path nor the publication placeholder: ${source}`,
    );
  }
});

test('the supported-host count is the number of hosts, not the number of products', () => {
  // The defect: "all eight supported hosts" counted Copilot's CLI and VS Code
  // surfaces separately. They are one host id, so no per-host claim may say 8.
  const claims = [...FLAT.matchAll(/all (\w+) supported hosts/g)];
  assert.ok(claims.length > 0, 'README no longer states a supported-host count — update this test with it');
  for (const [phrase, word] of claims) {
    const stated = NUMBER_WORDS[String(word).toLowerCase()] ?? Number(word);
    assert.equal(
      stated,
      Object.keys(HOST_CAPABILITIES).length,
      `README: "${phrase}" — HOST_CAPABILITIES has ${Object.keys(HOST_CAPABILITIES).length} hosts`,
    );
  }
});

test('the certified and uncertified host lists match HOST_CAPABILITIES.tier', () => {
  // Each tier bullet enumerates host IDS in backticks; compare the sets, so a
  // host promoted or demoted in the table cannot leave stale prose behind.
  const section = (label: string): string => {
    const match = FLAT.match(new RegExp(`\\*\\*${label}:\\*\\*(.*?)(?=\\*\\*|## )`));
    assert.ok(match, `README: no "${label}:" host-tier bullet found`);
    return match![1] as string;
  };
  for (const tier of ['certified', 'uncertified'] as const) {
    const label = tier === 'certified' ? 'Certified' : 'Uncertified';
    const listed = [...section(label).matchAll(/`([a-z]+)`/g)]
      .map((match) => match[1] as string)
      .filter((token) => token in HOST_CAPABILITIES)
      .sort();
    assert.deepEqual(listed, hostsWithTier(tier), `README ${label} bullet`);
  }
});

test('every TRAFFIC_ONE_* variable the README names is one the code actually reads', () => {
  // A documented env var that no longer exists is unfalsifiable from the
  // reader's side: they set it, nothing happens, and nothing says why.
  const referenced = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|mjs|cjs|json)$/.test(entry.name)) continue;
      for (const match of fs.readFileSync(full, 'utf8').matchAll(/TRAFFIC_ONE_[A-Z0-9_]+/g)) {
        referenced.add(match[0]);
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  const documented = new Set([...README.matchAll(/TRAFFIC_ONE_[A-Z0-9_]+/g)].map((match) => match[0]));
  assert.ok(documented.size > 0, 'README documents no TRAFFIC_ONE_* variable — did the section move?');
  for (const name of documented) {
    assert.ok(referenced.has(name), `README documents ${name}, which no source file reads`);
  }
  // The uncertified-host opt-out is load-bearing: it is the ONLY way past the
  // install refusal, and the README quotes it as copy-pasteable.
  assert.ok(documented.has(UNCERTIFIED_HOST_OPT_OUT_ENV));
  assert.ok(FLAT.includes(`${UNCERTIFIED_HOST_OPT_OUT_ENV}=1`));
});

test('every `npm run <script>` in the README exists in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    engines: { node: string };
  };
  const scripts = new Set([...README.matchAll(/npm run ([a-z][\w:-]*)/g)].map((match) => match[1] as string));
  assert.ok(scripts.size > 0, 'README names no npm script — did the maintenance section move?');
  for (const name of scripts) {
    assert.ok(pkg.scripts[name], `README tells the reader to run "npm run ${name}", which package.json does not define`);
  }
  // "requires Node.js 22 or newer" must track the declared engine range.
  const engineMajor = pkg.engines.node.match(/(\d+)/)?.[1];
  const stated = FLAT.match(/Node\.js (\d+) or newer/)?.[1];
  assert.equal(stated, engineMajor, `README states Node.js ${stated}; package.json engines says ${pkg.engines.node}`);
});

test('every runner script path in the README is a real emitted runner', () => {
  const built = new Set(
    Object.keys(
      // The runner entry map is the source of truth for what lands in
      // dist/scripts/. Read as text: importing src/build/** would pull the
      // whole build pipeline into a docs test.
      Object.fromEntries(
        [...fs.readFileSync(path.join(REPO_ROOT, 'src/build/build-runtime.ts'), 'utf8')
          .matchAll(/'([\w.-]+\.(?:cjs|mjs))':\s*'\.\//g)]
          .map((match) => [match[1] as string, true]),
      ),
    ),
  );
  assert.ok(built.size > 10, 'could not read the runner entry map from src/build/build-runtime.ts');
  const documented = [...README.matchAll(/(?:dist\/)?scripts\/([\w.-]+\.(?:cjs|mjs))/g)]
    .map((match) => match[1] as string);
  assert.ok(documented.length > 0, 'README names no runner script — did the install section move?');
  for (const name of new Set(documented)) {
    assert.ok(built.has(name), `README tells the reader to run scripts/${name}, which the build does not emit`);
  }
  // Shim paths are a DIFFERENT claim: ~/.traffic-one/bin/<x> only exists if
  // RUNNER_SHIMS lists it (and only after an authenticated session writes it).
  const shims = new Set(RUNNER_SHIMS.map((entry) => entry.shim));
  for (const match of README.matchAll(/\.traffic-one\/bin\/([\w.-]+\.cjs)/g)) {
    assert.ok(shims.has(match[1] as string), `README names the shim ${match[1]}, which RUNNER_SHIMS does not write`);
  }
});

// Doctor is the one recovery command the product hands a stuck user, and the
// gate that admits it matches an ABSOLUTE path — the running runtime's own
// `scripts/doctor.cjs`, or a `~/.traffic-one/bin/` shim (doctor-command.ts's
// gateExemptDoctorScriptPaths). The README shipped three relative spellings
// (`node scripts/doctor.cjs`, `node dist/scripts/doctor.cjs`, and the latter
// with `--session <id>`), which `isGateExemptDoctorScript` rejects outright for
// not being absolute: inside a session the documented recovery command was
// blocked by the very gate it exists to diagnose. README.md ships to installs
// verbatim (gen/emit/static.ts), so this was shipped advice, not a note.
//
// Placeholders are substituted the way a reader is told to substitute them
// (`/absolute/path/to/traffic-one/dist` is this repo's generated dist, i.e. the
// plugin root of the running runtime), and `~` is left for the grammar's own
// tilde expansion.
test('every doctor command the README prints is one the gate admits', () => {
  const commands = [...README.matchAll(/node [^\n`]*?doctor\.cjs[^\n`]*/g)].map((match) => match[0]);
  assert.ok(commands.length >= 3, `README no longer prints doctor commands (found ${commands.length})`);
  for (const documented of commands) {
    const command = documented
      .replace('/absolute/path/to/traffic-one/dist', selfRelativePluginRoot())
      // A Codex session id is a UUID (see DOCTOR_ID_PATTERN in doctor-command.ts).
      .replace('<session-id>', '019fbca1-2222-4333-8444-555566667777');
    assert.equal(
      isTrafficOneDoctorCommand('Bash', { command }),
      true,
      `README prints a doctor command the gate denies: ${documented}\n  (resolved to: ${command})`,
    );
  }
});

// The same property for the other recovery command, and it matters more here:
// reset is the escape from a run that has no other escape, so a spelling the
// README prints and the gate denies would leave a wedged project with nothing
// at all. `<id>` stands for a run id, which the grammar bounds to
// DOCTOR_ID_PATTERN (doctor-command.ts) — substituted the way a reader would.
test('every reset command the README prints is one the gate admits', () => {
  const commands = [...README.matchAll(/node [^\n`]*?traffic-one-reset\.cjs[^\n`]*/g)].map((match) => match[0]);
  assert.ok(commands.length >= 1, 'README no longer prints the wedged-run recovery command');
  // The sibling doctor test above substitutes the self-relative plugin root and
  // is immune to what is on the machine; this one is not, because the README's
  // reset spelling is the `~/.traffic-one/bin` shim, whose admission is decided
  // by a byte-comparison against the running template. So HOME is pointed at a
  // fixture holding the reference bytes: the property under test is that the
  // documented SPELLING is admissible, not that this machine's install is
  // current. Without it the test was red on any machine whose shim predated a
  // template edit and vacuously green wherever no shim exists at all.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'one-readme-home-')));
  const previous = process.env.HOME;
  try {
    process.env.HOME = home;
    const bin = path.join(home, '.traffic-one', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'traffic-one-reset.cjs'), shimSource('scripts/traffic-one-reset.cjs'), 'utf8');
    for (const documented of commands) {
      const command = documented
        .replace('/absolute/path/to/traffic-one/dist', selfRelativePluginRoot())
        .replace('<id>', '1785169657252');
      assert.equal(
        isTrafficOneResetCommand('Bash', { command }),
        true,
        `README prints a reset command the gate denies: ${documented}\n  (resolved to: ${command})`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The claim: "at most once per host process, which … on OpenCode and Kilo …
// means once for the life of that wrapper". The throttle key carries the session
// id, so a resident wrapper serving a SECOND session emits a SECOND banner —
// the README described a behaviour the code does not have, on the one host pair
// where the difference is observable.
test('the pre-consent banner throttle the README describes is the throttle the code implements', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'modules', 'session', 'session-start-lib.ts'),
    'utf8',
  );
  const key = /const processKey = `([^`]*)`/.exec(source)?.[1];
  assert.ok(key, 'uncertifiedHostBanner no longer builds a process-scoped throttle key');
  // Per (project, host, SESSION) — so per session, never per wrapper lifetime.
  for (const part of [/cwd/, /host/, /sessionId/]) {
    assert.match(key!, part, `the throttle key no longer includes ${String(part)}`);
  }
  assert.match(source, /const emittedInProcess = new Set/, 'the pre-consent throttle must stay in memory');
  assert.doesNotMatch(FLAT, /life of that wrapper/, 'the throttle is per session, not per wrapper');
  assert.match(FLAT, /throttled per session/);
  // And the reason it cannot be a marker on disk before consent.
  assert.match(FLAT, /may not write anything into the project, not even a marker/);
});

test('the documented onboarding URLs are the URLs the code builds', () => {
  // The defect this pins: `#p=` was documented as the PROJECT for as long as
  // the section existed. It is the loopback port — the same port as the local
  // fallback URL on the line below it — so the two documented templates must
  // come out of one agentOnboardingUrls() call with one port substituted in.
  const port = 51000;
  const token = 'tok';
  const urls = agentOnboardingUrls({}, port, token);
  const documentedDashboard = FLAT.match(/`(https:\/\/traffic\.io\/onboarding\/agent#[^`]+)`/)?.[1];
  const documentedLocal = FLAT.match(/`(http:\/\/127\.0\.0\.1:[^`]+)`/)?.[1];
  assert.ok(documentedDashboard, 'README no longer documents the hosted onboarding URL');
  assert.ok(documentedLocal, 'README no longer documents the loopback onboarding URL');
  const fill = (template: string): string => template
    .replace(/<port>/g, String(port))
    .replace(/<token>/g, token);
  assert.equal(fill(documentedDashboard!), urls.dashboardUrl);
  assert.equal(fill(documentedLocal!), urls.localWizardUrl);
  // …and the placeholder must not name something else (the bug was `<project>`).
  assert.match(documentedDashboard!, /#p=<port>/);
});

test('the versions and schema numbers the README prints match their constants', () => {
  const settings = FLAT.match(/"schemaVersion": (\d+)/)?.[1];
  assert.equal(Number(settings), ONE_SETTINGS_VERSION, 'the one.json example prints a stale schemaVersion');
  const cacheSchema = FLAT.match(/cache envelope is schema v(\d+)/)?.[1];
  assert.equal(Number(cacheSchema), ONE_MCP_CACHE_SCHEMA_VERSION, 'the one-mcp.json cache schema claim is stale');
  assert.ok(FLAT.includes(`~/.traffic-one/${ONE_MCP_CACHE_FILE}`), 'the documented model-cache filename is stale');
  const opencode = FLAT.match(/OpenCode `([\d.]+)`/)?.[1];
  assert.equal(opencode, OPENCODE_HOST_TARGET_VERSION, 'the documented OpenCode target version is stale');
  // The per-host operator row name pattern, checked against every host rather
  // than the one the sentence happens to use.
  const pattern = FLAT.match(/`(traffic_one_[<\w>]+_plugin_ai_model_configuration)`/)?.[1];
  assert.ok(pattern, 'README no longer documents the operator row name');
  for (const host of Object.keys(HOST_CAPABILITIES) as TrafficOneHost[]) {
    const expected = ONE_MCP_CONFIG_NAME_BY_HOST[host];
    assert.equal(
      pattern!.replace('<host>', host === 'claude' ? 'claude_code' : host),
      expected,
      `the documented operator row name does not produce ${expected}`,
    );
  }
});
