// tests/doctor-callable.test.ts
// The regression whose absence let a "make doctor callable" work item ship with
// doctor uncallable: every documented `traffic-one doctor` invocation, driven
// through the REAL PreToolUse pipeline (every handler core/registry.ts
// discovers, exactly as core/dispatch.ts loads them), against every fixture
// project state on every supported host. A read-only diagnostic the product
// prescribes when a run wedges must be callable from every state a user can be
// stuck in — including pre-consent, where the ask-first fence denies
// unconditionally, and onboarded-but-unbuildable, where the Cursor
// model-policy branches deny long after any per-branch exemption.
//
// It also pins the three properties that make the exemption safe:
//   - NARROW: a near-miss spelling keeps whatever verdict the state gives it;
//   - WRITE-FREE: an undecided (pre-consent) project stays byte-identical
//     across every doctor form, which is the consent write fence's contract;
//   - AGREED WITH THE PROSE: every doctor command string shipped prose prints
//     satisfies the grammar, so the two cannot drift apart again — with one
//     declared exception, `--unblock`, which must keep being REJECTED (see
//     isOverrideInvocation below).

import './replay-corpus/env';

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

import { buildContext } from '../src/core/context';
import { runPipeline } from '../src/core/pipeline';
import { isDeny } from '../src/core/result';
import type { HookInput, HostId } from '../src/core/types';
import {
  doctorBundleCommand,
  doctorCommand,
  doctorScriptPath,
  doctorShimCommand,
  doctorShimPath,
} from '../src/shared/doctor-command';
import { ensureRunnerShims } from '../src/shared/runner-shims';
import { isTrafficOneDoctorCommand } from '../src/shared/tool-classify';
import { cleanupIsolatedHome } from './replay-corpus/env';
import { replayHandlers } from './replay-corpus/handlers';
import {
  cleanupFixtures,
  declinedProject,
  freshProject,
  greenfieldNoPlan,
  onboardedMidRun,
  scaffoldedGreenfield,
  undecidedProject,
} from './replay-corpus/fixtures';

// Two adjustments to the corpus harness's isolation, both narrowing it toward
// the production shape rather than away from it:
//   - XDG_STATE_HOME is dropped so the runner-shim dir resolves to the
//     documented `~/.traffic-one/bin` and the `~`-spelled path shipped prose
//     prints is exercised as itself. HOME stays the isolated temp tree.
//   - HOME is replaced by its realpath, because on macOS os.tmpdir() is the
//     /var symlink to /private/var and the boundary guard's realResolve only
//     follows a symlink for a path that already EXISTS — leaving the two
//     spellings to disagree for a not-yet-created shim. A real user's HOME is
//     already a real path, so this removes a fixture artifact, not a check.
delete process.env.XDG_STATE_HOME;
const HOME = fs.realpathSync(process.env.HOME as string);
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
fs.mkdirSync(path.join(HOME, '.traffic-one', 'bin'), { recursive: true });

// 42 fixture project trees plus the isolated home add up; a run that leaves
// them behind fills a shared temp filesystem for everyone else on the machine.
after(() => {
  cleanupFixtures();
  cleanupIsolatedHome();
});

const HOSTS: HostId[] = ['claude', 'codex', 'cursor', 'opencode', 'copilot', 'windsurf', 'kilo'];
const RUN_ID = '1785169657252';
const SESSION_ID = '019fbca1-2222-4333-8444-555566667777';
const GATE_ID = 'plan-guard';

// Each host's own shell-tool rawName, so the adapter-parsed tool the gates
// classify is the shape that host really sends.
function shellRawName(host: HostId): string {
  if (host === 'codex') return 'exec_command';
  if (host === 'cursor') return 'before-shell-execution';
  if (host === 'windsurf') return 'pre_run_command';
  return 'Bash';
}

function tildeShim(): string | null {
  const shim = doctorShimPath();
  return shim.startsWith(`${HOME}/`) ? `~${shim.slice(HOME.length)}` : null;
}

// Every documented invocation, in both shipped path spellings.
function doctorForms(): Array<[string, string]> {
  const script = doctorScriptPath();
  const shim = doctorShimPath();
  const tilde = tildeShim();
  const forms: Array<[string, string]> = [
    ['plain', `node ${script}`],
    ['--run', `node ${script} --run ${RUN_ID}`],
    ['--session', `node ${script} --session ${SESSION_ID}`],
    ['--bundle', `node ${script} --bundle`],
    ['--run + --bundle', `node ${script} --run ${RUN_ID} --bundle`],
    ['quoted path', `node '${script}'`],
    ['shim plain', `node ${shim}`],
    ['shim --run', `node ${shim} --run ${RUN_ID}`],
    ['shim --session', `node ${shim} --session ${SESSION_ID}`],
    ['shim --bundle', `node ${shim} --bundle`],
  ];
  assert.ok(tilde, 'the shim must live under HOME so the ~ spelling prose prints is testable');
  forms.push(['shim ~', `node ${tilde}`], ['shim ~ --bundle', `node ${tilde} --bundle`]);
  return forms;
}

const STATES: Array<[string, (host: HostId) => string]> = [
  ['undecided', undecidedProject],
  ['declined', declinedProject],
  ['fresh(consented)', freshProject],
  ['greenfieldNoPlan', greenfieldNoPlan],
  ['scaffoldedGreenfield', scaffoldedGreenfield],
  ['onboardedMidRun', onboardedMidRun],
];

// One fixture per (state, host), built once: a fresh mkdtemp tree per case
// would dominate the runtime and prove nothing extra.
const roots = new Map<string, string>();
function fixtureRoot(label: string, make: (host: HostId) => string, host: HostId): string {
  const key = `${label}/${host}`;
  const existing = roots.get(key);
  if (existing) return existing;
  const prev = process.env.TRAFFIC_ONE_HOST;
  process.env.TRAFFIC_ONE_HOST = host;
  try {
    const dir = make(host);
    roots.set(key, dir);
    return dir;
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = prev;
  }
}

async function verdict(host: HostId, cwd: string, command: string): Promise<string> {
  const prev = process.env.TRAFFIC_ONE_HOST;
  process.env.TRAFFIC_ONE_HOST = host;
  try {
    const rawName = shellRawName(host);
    const input: HookInput = {
      event: 'PreToolUse',
      host,
      cwd,
      workspaceRoot: cwd,
      tool: { class: 'shell', rawName, command },
      raw: { tool_name: rawName, tool_input: { command }, session_id: `${host}-main` },
    };
    const result = await runPipeline(replayHandlers(), buildContext(input));
    return isDeny(result) ? `deny ${result.gateId ?? ''}/${result.denyId ?? ''}` : 'allow';
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = prev;
  }
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        out.set(`${path.relative(dir, full)}/`, '');
        walk(full);
      } else {
        out.set(path.relative(dir, full), fs.readFileSync(full).toString('base64'));
      }
    }
  };
  walk(dir);
  return out;
}

test('every documented doctor form is non-deny in every project state on every host', async () => {
  const denials: string[] = [];
  let cases = 0;
  for (const [label, make] of STATES) {
    for (const host of HOSTS) {
      const cwd = fixtureRoot(label, make, host);
      for (const [form, command] of doctorForms()) {
        cases += 1;
        const outcome = await verdict(host, cwd, command);
        if (outcome !== 'allow') denials.push(`${label} | ${host} | ${form} | ${outcome}`);
      }
    }
  }
  assert.equal(cases, STATES.length * HOSTS.length * doctorForms().length);
  assert.deepEqual(denials, [], `doctor must never be denied:\n${denials.join('\n')}`);
});

test('doctor is callable while UNAUTHENTICATED, the other state a user is stuck in', async () => {
  // The priority-0 session.auth gate delegates its deny to onboardingGate()
  // (auth-gate.ts), so the hoist covers it — but the corpus pins
  // TRAFFIC_ONE_AUTH=off, which means no fixture case ever exercises the
  // enforced path. Turn enforcement on with no local key and check both halves.
  const saved = process.env.TRAFFIC_ONE_AUTH;
  delete process.env.TRAFFIC_ONE_AUTH;
  try {
    for (const host of HOSTS) {
      const cwd = fixtureRoot('fresh(consented)', freshProject, host);
      for (const [form, command] of doctorForms()) {
        assert.equal(await verdict(host, cwd, command), 'allow', `${host}: unauthenticated ${form} must still run`);
      }
      assert.match(
        await verdict(host, cwd, 'npm install react'),
        /^deny /,
        `${host}: an ordinary command must still be gated while unauthenticated`,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_AUTH;
    else process.env.TRAFFIC_ONE_AUTH = saved;
  }
});

test('the doctor exemption is narrow: near-miss and ordinary commands keep their gate verdict', async () => {
  const script = doctorScriptPath();
  // Every one of these is a NON-doctor command by the grammar, several of them
  // one byte away from a documented form. In the pre-consent state the
  // ask-first fence denies unconditionally, so each must still be denied
  // there — the exemption is not allowed to have widened the fence.
  const controls: Array<[string, string]> = [
    ['ordinary destructive command', 'rm -rf /'],
    ['doctor followed by a chained rm', `node ${script} ; rm -rf /`],
    ['doctor with a command substitution', `node ${script} $(rm -rf /)`],
    ['doctor under an npx wrapper', `npx ${script}`],
    ['doctor redirected to a file', `node ${script} > /tmp/doctor.json`],
    ['a sibling script in the same dir', `node ${path.join(path.dirname(script), 'doctor-copy.cjs')}`],
    ['a foreign path ending in doctor.cjs', 'node /tmp/evil/scripts/doctor.cjs'],
    ['doctor with a traversal-shaped run id', `node ${script} --run a..-..-..`],
  ];
  for (const [, command] of controls) {
    assert.equal(isTrafficOneDoctorCommand('Bash', { command }), false, `grammar must reject: ${command}`);
  }
  // Pre-consent is where an over-broad match would be invisible: the ask-first
  // fence denies EVERYTHING there, so a control that comes back allowed can
  // only have been let through by the hoisted exemption. (A control carrying a
  // path outside the workspace is denied earlier, by the boundary guard — a
  // different gate, still a deny; asserting the exact gate would only pin
  // priority order, which is not this test's subject.)
  for (const host of HOSTS) {
    const cwd = fixtureRoot('undecided', undecidedProject, host);
    for (const [label, command] of controls) {
      const outcome = await verdict(host, cwd, command);
      assert.ok(outcome.startsWith('deny'), `${host}: ${label} must stay denied pre-consent, got ${outcome}`);
    }
    assert.equal(
      await verdict(host, cwd, 'rm -rf /'),
      'deny onboarding-gate/onboarding-use-plugin-question',
      `${host}: the ask-first consent fence must still be the gate that denies an ordinary command`,
    );
  }
});

test('exempting doctor writes nothing: an undecided project stays byte-identical', async () => {
  for (const host of HOSTS) {
    const cwd = fixtureRoot('undecided', undecidedProject, host);
    const before = snapshot(cwd);
    for (const [, command] of doctorForms()) await verdict(host, cwd, command);
    assert.deepEqual([...snapshot(cwd).entries()], [...before.entries()], `${host}: pre-consent project must not be touched`);
  }
});

// ── shipped prose ↔ grammar agreement ───────────────────────────────────────
// Prose that prints a command the gates reject is the whole defect: an agent
// follows the instruction, gets denied, and concludes the plugin is broken.

// The previous version of this test passed while four shipped spellings were
// denied, for three structural reasons — each fixed below by a rule rather
// than by a longer list:
//   - it read a hardcoded two-file list, so README.md was never scanned;
//   - it required a literal `node ` prefix, which made the ONE defect of this
//     class then live (run-diagnostic-report.ts printing `doctor --run <id>
//     --bundle`, no interpreter, no path) invisible BY CONSTRUCTION: the thing
//     that made the command unrunnable was also what excluded it from the scan;
//   - its `found >= 5` floor was met by a single file, so dropping a file from
//     the list — or a file losing all its invocations — could not fail it.

const REPO_ROOT = path.resolve(__dirname, '..');

function walkFiles(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, keep, out);
    else if (entry.isFile() && keep(full)) out.push(full);
  }
  return out;
}

// Every source of prose that ships to a user or an agent. Discovered by
// walking, not listed: a new skill's SKILL.md is scanned the day it lands.
function proseFiles(): string[] {
  return [
    path.join(REPO_ROOT, 'README.md'),
    ...walkFiles(path.join(REPO_ROOT, 'src', 'gen', 'static'), (f) => f.endsWith('.md')),
    ...walkFiles(path.join(REPO_ROOT, 'src', 'modules', 'skills', 'skills-catalog'), (f) => f.endsWith('.md')),
  ];
}

// …plus the command strings the runners BUILD, which is where the missing
// interpreter actually shipped. Read out of the parsed source's string and
// template literals, so a mention in a comment or an identifier named
// `doctorBundleCommand` is not mistaken for a printed command.
function runnerSourceFiles(): string[] {
  return walkFiles(
    path.join(REPO_ROOT, 'src', 'runners'),
    (f) => f.endsWith('.ts') && !f.includes(`${path.sep}__tests__${path.sep}`),
  );
}

interface Snippet {
  readonly source: string;
  readonly line: number;
  readonly text: string;
}

// Markdown: every line of a fenced block and every inline code span. Prose
// outside a code span is not a command and never was.
function markdownSnippets(rel: string, text: string): Snippet[] {
  const out: Snippet[] = [];
  let fenced = false;
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      out.push({ source: rel, line, text: raw.trim() });
      return;
    }
    for (const span of raw.matchAll(/`([^`\n]+)`/g)) out.push({ source: rel, line, text: (span[1] as string).trim() });
  });
  return out;
}

function tsLiteralSnippets(rel: string, text: string): Snippet[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const out: Snippet[] = [];
  const emit = (node: ts.Node, value: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    for (const chunk of value.split('\n')) out.push({ source: rel, line, text: chunk.trim() });
  };
  const visit = (node: ts.Node): void => {
    // A template is reassembled whole, with each `${…}` standing in as a
    // grammar-valid run id: the printed command is the concatenation, so
    // judging the fragments separately would split `node <path> --run ${id}`
    // into two harmless-looking pieces. Recursion continues into the
    // substitution EXPRESSIONS (they can hold literals of their own), not
    // into the template's own head/middle/tail.
    if (ts.isTemplateExpression(node)) {
      emit(node, node.head.text + node.templateSpans.map((span) => RUN_ID + span.literal.text).join(''));
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    if (ts.isStringLiteralLike(node)) {
      emit(node, node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

// A token that NAMES the doctor runner: `doctor`, `doctor.cjs`, or either
// behind a path. Deliberately not `\bdoctor\b`, which also matches the skill
// name `traffic-one-doctor` and the word in a sentence.
const DOCTOR_PROGRAM = /(?:^|\/)doctor(?:\.cjs)?$/;
// Words that can precede the program without changing what is being run.
const INTERPRETER = /^(?:node|nodejs|npx|bunx|bun|deno|sudo|env|command|exec)$/;

// Is this snippet an INVOCATION of doctor — something a reader is meant to
// type — as opposed to a path reference, a sentence, or sample output?
//
// Matched by shape, so a missing `node` is a FAILURE rather than an exclusion.
// Two rules, both structural:
//   - doctor must be in PROGRAM position (first word, or first after an
//     interpreter). `node …/opencode-host.cjs doctor` runs opencode-host with
//     a `doctor` subcommand — a different program, not this grammar's business;
//     `traffic-one doctor — summary: ACTION_NEEDED` is sample OUTPUT.
//   - a LONE word is a reference, not a command: `` `doctor` `` reads as the
//     tool's name mid-sentence and `` `~/.traffic-one/bin/doctor.cjs` `` as a
//     path. Both are still checked, by the shim-existence test below rather
//     than by the grammar. Anything with an interpreter or an argument is a
//     command: `doctor --run <id> --bundle` is caught here.
function unquote(word: string): string {
  return /^(['"]).*\1$/.test(word) ? word.slice(1, -1) : word;
}

// A word after which a new command begins: a sentence's colon ("run this:"),
// a shell separator, a prompt marker. Needed because the defect this test
// missed was printed INSIDE a sentence — `Attach machine-readable state to a
// bug report: doctor --run <id> --bundle` — where the command does not start
// at word 0.
const COMMAND_START = /[:;|&$>]$|^[$>]$/;

interface Invocation {
  /** The program word, unquoted. */
  readonly program: string;
  /** The command as printed, from its own start to end of line. */
  readonly command: string;
}

// The doctor invocation in this snippet, or null if there is none. Matched by
// SHAPE, so a command missing its interpreter is a FAILURE rather than an
// exclusion — the property the previous `node ` prefix could not express.
//
// Three structural rules decide it, in order:
//   1. some word must NAME the doctor runner (`doctor`, `doctor.cjs`, either
//      behind a path) — not `\bdoctor\b`, which also matches the skill name
//      `traffic-one-doctor` and the word in a sentence;
//   2. it must be that command's PROGRAM — first word after the nearest
//      command start, or second when the first is an interpreter. `node
//      …/opencode-host.cjs doctor --cwd …` runs opencode-host with a `doctor`
//      subcommand, and `traffic-one doctor — summary: ACTION_NEEDED` is sample
//      OUTPUT; neither is this grammar's business;
//   3. it must be USED, not merely named: an interpreter in front or a flag
//      behind. A lone word is a reference — `` `doctor` `` reads as the tool's
//      name mid-sentence, `` `~/.traffic-one/bin/doctor.cjs` `` as a path.
//      Those are still checked, by the shim-existence test below.
function doctorInvocation(text: string): Invocation | null {
  const words = text.split(/\s+/).filter(Boolean);
  for (let index = 0; index < words.length; index += 1) {
    const program = unquote(words[index] as string);
    if (!DOCTOR_PROGRAM.test(program)) continue;
    const previous = index > 0 ? unquote(words[index - 1] as string) : null;
    const interpreted = previous !== null && INTERPRETER.test(previous);
    const start = interpreted ? index - 1 : index;
    // Anything between the command's start and the program means the program
    // is something else and doctor is one of its arguments.
    if (start > 0 && !COMMAND_START.test(words[start - 1] as string)) continue;
    const rest = words.slice(index + 1);
    if (!interpreted && !rest.some((word) => word.startsWith('-'))) continue;
    return { program, command: words.slice(start).join(' ') };
  }
  return null;
}

function substitutePlaceholders(command: string): string {
  // The plugin root README spells as a placeholder, and SKILL.md as
  // `<plugin-root>`, is doctorScriptPath()'s own root on the reader's machine.
  const pluginRoot = path.dirname(path.dirname(doctorScriptPath()));
  return command
    .replace('/absolute/path/to/traffic-one/dist', pluginRoot)
    .replace('<plugin-root>', pluginRoot)
    .replace(/<session-id>|<sessionid>/g, SESSION_ID)
    .replace(/<run-id>|<id>/g, RUN_ID)
    .replace(/<gate-id>|<gateid>/g, GATE_ID);
}

function proseInvocations(): Array<Snippet & Invocation> {
  const found: Array<Snippet & Invocation> = [];
  const add = (snippets: readonly Snippet[]): void => {
    for (const snippet of snippets) {
      const invocation = doctorInvocation(snippet.text);
      if (invocation) {
        found.push({ ...snippet, ...invocation, command: substitutePlaceholders(invocation.command) });
      }
    }
  };
  for (const file of proseFiles()) {
    const rel = path.relative(REPO_ROOT, file);
    add(markdownSnippets(rel, fs.readFileSync(file, 'utf8')));
  }
  for (const file of runnerSourceFiles()) {
    const rel = path.relative(REPO_ROOT, file);
    add(tsLiteralSnippets(rel, fs.readFileSync(file, 'utf8')));
  }
  return found;
}

// Each file that must keep printing invocations, and how many at minimum. A
// count floor summed across files is what let a whole file go quiet; these are
// per file, so a file dropping to zero fails BY NAME. New prose is covered
// without editing this list — every discovered file's invocations are checked.
const PROSE_INVOCATION_FLOOR: ReadonlyArray<readonly [string, number]> = [
  // Emitted as dist/AGENTS.md and dist/CLAUDE.md: loaded on EVERY host, every
  // session. The single highest-traffic doctor instruction in the product.
  ['src/gen/static/plugin-instructions.md', 1],
  ['src/modules/skills/skills-catalog/traffic-one-doctor/SKILL.md', 5],
  ['README.md', 4],
];

// No shipped prose may name doctor by anything other than an absolute path or
// the `~` shim: the grammar compares argv[1] against absolute paths derived
// from the running runtime and HOME, so a relative spelling — or a bare
// `doctor`, which is on no PATH this plugin ever sets — is rejected before any
// comparison is made. Kept as an exact-set comparison rather than a plain
// "must be empty" so the failure names the offending line, and so a future
// exception has to be written down rather than absorbed by a count.
const KNOWN_UNRUNNABLE_PATHS: readonly string[] = [];

// ── the one invocation that must NOT satisfy the grammar ────────────────────
// `doctor --unblock <gate-id>` mints an operator override. It is the only
// doctor form that writes, and it is deliberately absent from the gate-exempt
// grammar (shared/tool-classify.ts) — an agent able to mint its own override
// has a bypass, not an escape hatch. Its audience is a human at their own
// terminal, where no hook fires at all.
//
// So the invariant this file pins is NOT "no prose prints a rejected command";
// it is "no prose prints a rejected command BY ACCIDENT". Left unstated, the
// grammar assertion below would fail the day the override was documented, with
// a message ("print an absolute path instead") whose advice does not apply and
// whose obvious fix — widen the grammar — is the single most dangerous change
// available in this design. Naming the exception here turns that trap into a
// checked property in the OPPOSITE direction: an override invocation in prose
// must still name a runnable path (a human has to be able to type it), and the
// grammar must still REJECT it. Whichever half a future edit breaks, a named
// assertion breaks with it.
function isOverrideInvocation(command: string): boolean {
  return /(?:^|\s)--unblock(?:\s|$)/.test(command);
}

test('every doctor invocation printed by shipped prose satisfies the gate grammar', () => {
  const all = proseInvocations();
  // The override is excluded from every assertion below and gets its own test,
  // including from the floor: the floor exists to prove the RUNNABLE
  // instructions did not silently vanish, and a command nobody may run must
  // not be able to prop that count up.
  const invocations = all.filter((entry) => !isOverrideInvocation(entry.command));

  for (const [rel, floor] of PROSE_INVOCATION_FLOOR) {
    const count = invocations.filter((entry) => entry.source === rel).length;
    assert.ok(
      count >= floor,
      `${rel} printed ${count} doctor invocation(s), expected at least ${floor} — either the instruction was `
      + 'removed (then update PROSE_INVOCATION_FLOOR in the same commit) or the scanner stopped seeing that file',
    );
  }

  const unrunnable = invocations
    .filter((entry) => !path.isAbsolute(entry.program) && !entry.program.startsWith('~/'))
    .map((entry) => `${entry.source}:${entry.line} :: ${entry.command}`);
  assert.deepEqual(
    [...unrunnable].sort(),
    [...KNOWN_UNRUNNABLE_PATHS].sort(),
    'shipped prose names doctor by something the gate cannot resolve — a path relative to a cwd it never '
    + 'sees, or a bare `doctor` that is on no PATH. Print an absolute path (doctorCommand()) or the ~ shim '
    + '(doctorShimCommand()) instead',
  );

  const denied: string[] = [];
  for (const entry of invocations) {
    if (unrunnable.includes(`${entry.source}:${entry.line} :: ${entry.command}`)) continue;
    assert.ok(
      !entry.command.includes('<'),
      `${entry.source}:${entry.line}: unsubstituted placeholder in "${entry.command}"`,
    );
    if (!isTrafficOneDoctorCommand('Bash', { command: entry.command })) {
      denied.push(`${entry.source}:${entry.line}  ${entry.command}`);
    }
  }
  assert.deepEqual(denied, [], `shipped prose prints doctor commands the gate grammar rejects:\n${denied.join('\n')}`);
});

test('the operator override is documented, runnable by a human, and rejected by the gate grammar', () => {
  const overrides = proseInvocations().filter((entry) => isOverrideInvocation(entry.command));
  // A floor, like every other prose instruction: if the override stops being
  // documented, the deny hint that prints this command is telling users about a
  // flag no shipped page explains.
  assert.ok(
    overrides.length >= 1,
    'no shipped prose documents `--unblock`; the deny hint prints that command, so something must explain it',
  );
  for (const entry of overrides) {
    const where = `${entry.source}:${entry.line}`;
    // Half one: a human must be able to type it. Same rule as every other
    // printed invocation — the override is exempt from the GRAMMAR, never from
    // being a real, resolvable command.
    assert.ok(
      path.isAbsolute(entry.program) || entry.program.startsWith('~/'),
      `${where}: the override command must name doctor by an absolute path or the ~ shim, got "${entry.program}"`,
    );
    assert.ok(!entry.command.includes('<'), `${where}: unsubstituted placeholder in "${entry.command}"`);
    // Half two, the security half: the gates must keep refusing it.
    assert.equal(
      isTrafficOneDoctorCommand('Bash', { command: entry.command }),
      false,
      `${where}: \`${entry.command}\` is gate-EXEMPT. An agent can now mint its own operator override, which is a `
      + 'bypass, not an escape hatch — revert whatever admitted --unblock to doctorCommandInvocation()',
    );
  }
});

// The other half of the same property: what the RUNTIME prints, proven by
// calling the printers rather than by reading their source. run-diagnostic-
// report.ts printed `doctor --run <id> --bundle` — no interpreter, no path,
// and `doctor` is not on PATH anywhere — at the exact moment a run is wedged.
test('every doctor command the runtime prints satisfies the gate grammar', () => {
  const printed: Array<[string, string]> = [
    ['doctorCommand()', doctorCommand()],
    ['doctorShimCommand()', doctorShimCommand()],
    ['doctorBundleCommand(runId)', doctorBundleCommand(RUN_ID)],
    ['doctorBundleCommand(null)', doctorBundleCommand(null)],
    // An id the grammar would reject must degrade to a runnable command, not
    // interpolate itself into an unrunnable one.
    ['doctorBundleCommand(unsafe)', doctorBundleCommand('not a safe id')],
  ];
  for (const [label, command] of printed) {
    assert.equal(isTrafficOneDoctorCommand('Bash', { command }), true, `${label} printed a denied command: ${command}`);
    assert.ok(doctorInvocation(command), `${label} did not print an invocation-shaped command: ${command}`);
  }
});

// B1's invariant, first half: a shim path hardcoded in prose must EXIST at
// that literal location once ensureRunnerShims() has run. `~/.traffic-one/bin`
// is spelled literally for ten different shims — the doctor was simply the one
// whose absence was also a gate denial. (The gate half, across every
// HOME/XDG_STATE_HOME/TRAFFIC_ONE_TOOLCHAIN_ROOT combination, is asserted in
// src/shared/__tests__/doctor-command.test.ts.)
test('every ~/.traffic-one/bin shim prose hardcodes exists after ensureRunnerShims()', () => {
  const literals = new Set<string>();
  for (const file of [...proseFiles(), ...runnerSourceFiles(), ...walkFiles(path.join(REPO_ROOT, 'src', 'modules'), (f) => f.endsWith('.md'))]) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/~\/\.traffic-one\/bin\/[A-Za-z0-9._-]+/g)) {
      literals.add(match[0] as string);
    }
  }
  assert.ok(literals.size >= 10, `expected the shim literals to still be documented, found ${literals.size}`);

  ensureRunnerShims();
  const missing = [...literals]
    .map((literal) => path.join(HOME, literal.slice('~/'.length)))
    .filter((file) => !fs.existsSync(file));
  assert.deepEqual(
    missing,
    [],
    `prose hardcodes ${missing.length} shim path(s) that ensureRunnerShims() does not create:\n${missing.join('\n')}`,
  );
});

test('every flag combination shipped prose describes is accepted on the documented path', () => {
  const tilde = tildeShim() as string;
  for (const args of ['', ` --session ${SESSION_ID}`, ` --run ${RUN_ID}`, ' --bundle', ` --run ${RUN_ID} --bundle`]) {
    assert.equal(
      isTrafficOneDoctorCommand('Bash', { command: `node ${tilde}${args}` }),
      true,
      `prose describes appending "${args.trim() || '(nothing)'}" to the shim command`,
    );
  }
});

test('the doctor grammar is anchored on the running runtime, not on the environment', () => {
  // The one property BLOCKER 2 turned on: a *_PLUGIN_ROOT override cannot
  // decide what is gate-exempt. Proven here at the pipeline level rather than
  // in isolation, because this is the layer a stale override actually hurt.
  const forged = fs.mkdtempSync(path.join(os.tmpdir(), 't1-forged-root-'));
  const saved = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  try {
    fs.mkdirSync(path.join(forged, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(forged, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(forged, 'scripts', 'doctor.cjs'), 'ARBITRARY\n');
    fs.writeFileSync(path.join(forged, 'scripts', 'hook-runtime.cjs'), '');
    fs.writeFileSync(path.join(forged, 'rules', 'core.md'), '# forged\n');
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = forged;
    assert.equal(
      isTrafficOneDoctorCommand('Bash', { command: `node ${path.join(forged, 'scripts', 'doctor.cjs')}` }),
      false,
      'a forged plugin root must never be gate-exempt',
    );
    assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${doctorShimPath()}` }), true, 'the HOME shim stays exempt');
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT;
    else process.env.TRAFFIC_ONE_PLUGIN_ROOT = saved;
    fs.rmSync(forged, { recursive: true, force: true });
  }
});
