// The seal on `RoleContractOutcome`, tested as a COMPILER property.
//
// Round 1's guarantee was prose: "`unwritable` carries no `written` field, so the
// old swallow cannot recompile". True as worded, and not enough — the defect it
// describes (returning the DELETION sweep count as a write count) is spellable on
// the two variants that DO carry `written`:
//
//     return { kind: 'complete', written: cleanupGeneratedAgents(dir), removed: 0 };
//
// which is round 1's own bug, one severity down, and compiles fine against an
// unsealed union. So the type now carries a branded property keyed on a
// non-exported `unique symbol`, and the claim under test is not about one field:
// NO module other than role-contracts.ts can spell a value of this type at all.
// The only ways in are `writeRoleContracts` and `roleContractsSwept`, and both
// put a sweep count in `removed`.
//
// Two independent enforcements, because each fails in a way the other does not:
//
//   1. THE `@ts-expect-error` ROWS below ride `npx tsc --noEmit` (tsconfig
//      includes `src/**/*.ts`). If the seal is removed, the forged literals
//      compile, the directives become unused, and TS2578 fails the typecheck —
//      i.e. deleting the guard breaks the build rather than quietly passing.
//      They do NOT protect against the ROWS being deleted, which is what (2) is
//      for. They also cost nothing at run time; the file is a test so the
//      declarations are never evaluated by anything that matters.
//   2. A REAL COMPILATION inside the suite, of source built here, asserting that
//      a forged literal produces a diagnostic and the legitimate constructors do
//      not. That one is positive evidence — it FAILS if the seal stops biting,
//      and it cannot be satisfied by an absent fixture, which is the failure mode
//      standing rule 7 is about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { roleContractsSwept, roleContractsWritten, writeRoleContracts, type RoleContractOutcome } from '../role-contracts';

// ── 1. the directives the typecheck enforces ─────────────────────────────────
//
// Each row is the swallow it forbids, at the severity it forbids it at. `void`
// keeps them from being unused bindings without executing anything.

// @ts-expect-error — the seal: 'complete' cannot be forged, so a sweep count
// cannot be re-labelled a write count the way round 1's defect did.
const forgedComplete: RoleContractOutcome = { kind: 'complete', written: 3, removed: 0 };
// @ts-expect-error — the seal: nor at 'partial', which round 1's no-`written`
// argument did not cover.
const forgedPartial: RoleContractOutcome = { kind: 'partial', written: 3, removed: 0, failures: [] };
// @ts-expect-error — the seal: nor by widening the refused variant with a count.
const forgedUnwritable: RoleContractOutcome = {
  kind: 'unwritable',
  removed: 0,
  failure: { path: '/x', errno: 'EEXIST' },
};
void forgedComplete;
void forgedPartial;
void forgedUnwritable;

// The claim about `unwritable` itself, still worth pinning separately: the
// variant has no `written` to read, so the narrowed access does not exist.
test('the refused variant has no write count to report, and reads as zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-role-seal-'));
  try {
    const blocked = path.join(dir, 'agents');
    fs.writeFileSync(blocked, 'a file, not a directory\n', 'utf8');
    const outcome = writeRoleContracts(blocked, 4, [{ path: path.join(blocked, 'x.md'), content: 'x' }]);
    assert.equal(outcome.kind, 'unwritable');
    if (outcome.kind === 'unwritable') {
      // @ts-expect-error — no `written` on this variant, which is what stops a
      // caller from folding a refusal into a success total.
      void outcome.written;
      assert.equal(outcome.removed, 4, 'the sweep that did run is reported, as a removal');
    }
    assert.equal(roleContractsWritten(outcome), 0, 'and the accessor answers zero rather than the sweep count');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the sweep constructor can only put its count in removed', () => {
  const swept = roleContractsSwept(7);
  assert.equal(swept.kind, 'complete');
  assert.equal(roleContractsWritten(swept), 0, 'nothing was written and nothing may be claimed');
  assert.equal(swept.kind === 'complete' ? swept.removed : -1, 7);
});

// ── 2. the same claim, compiled ──────────────────────────────────────────────

const ROLE_CONTRACTS_MODULE = path.resolve(__dirname, '..', 'role-contracts.ts');
const MODULE_DIR = path.dirname(ROLE_CONTRACTS_MODULE);

/**
 * The two modules role-contracts.ts imports that are not node builtins, stubbed
 * at their real resolved paths.
 *
 * WHY stub at all: role-contracts.ts's own text is the thing under test, but
 * pulling its real imports pulls the shared tree behind them. Measured on this
 * machine, all three shapes answering the identical question:
 *
 *   one program per probe, real imports        58.2s for four probes (242 files)
 *   one program for four probes, real imports  17.9s               (242 files)
 *   one program, imports stubbed                3.4s               ( 70 files)
 *
 * and the lib alone is 2.0s of that, so the stubbed program is within ~1.4s of
 * the floor. This repo already made the same trade once, in the other direction:
 * tests/refusal-contract.test.ts REJECTED `createProgram` (~34s) for a parse-only
 * scan of equal power. A parse cannot decide assignability, so the program stays
 * — but it stays cheap.
 *
 * The stub cannot silently rot: a THIRD import added to role-contracts.ts
 * resolves to the real file, the program grows, and the source-file bound
 * asserted below fails and names it.
 */
const STUBS: Record<string, string> = {
  [path.resolve(MODULE_DIR, '..', 'fs-text.ts')]:
    'export declare function writeTextIfChanged(file: string, content: string): boolean;\n',
  [path.resolve(MODULE_DIR, '..', 'state', 'state-write-log.ts')]:
    'export declare function errnoOf(error: unknown): string | null;\n',
};

interface ProbeCompilation {
  /** Diagnostics for each probe, keyed by its label. */
  readonly probes: Map<string, readonly string[]>;
  /** Diagnostics against role-contracts.ts itself. */
  readonly module: string[];
  readonly sourceFiles: number;
}

/**
 * Compile every probe against the REAL text of role-contracts.ts, in one
 * in-memory program, and report the diagnostics per probe.
 *
 * Nothing is written to disk: the probes and the stubs are served from a map by a
 * wrapped compiler host, which is also why this needs no scratch directory and no
 * cleanup. `strict` matches tsconfig.json — a seal that only bit under a stricter
 * posture than the repo compiles with would be no seal.
 */
function compileProbes(probes: Record<string, string>): ProbeCompilation {
  const sources = new Map<string, string>(Object.entries(STUBS));
  sources.set(ROLE_CONTRACTS_MODULE, fs.readFileSync(ROLE_CONTRACTS_MODULE, 'utf8'));
  const labels = new Map<string, string>();
  for (const [label, body] of Object.entries(probes)) {
    // Inside the real directory, so `./role-contracts` resolves to the file
    // above; never created on disk, so a crashed run leaves nothing behind.
    const file = path.join(MODULE_DIR, `__seal-probe-${label}.ts`);
    sources.set(file, `import { roleContractsSwept, writeRoleContracts, type RoleContractOutcome } from './role-contracts';\n${body}\n`);
    labels.set(file, label);
  }

  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    esModuleInterop: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const realGetSourceFile = host.getSourceFile.bind(host);
  const realReadFile = host.readFile.bind(host);
  const realFileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate): ts.SourceFile | undefined => {
    const text = sources.get(path.resolve(fileName));
    return text === undefined
      ? realGetSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  host.readFile = (fileName): string | undefined => sources.get(path.resolve(fileName)) ?? realReadFile(fileName);
  host.fileExists = (fileName): boolean => sources.has(path.resolve(fileName)) || realFileExists(fileName);

  const program = ts.createProgram([...labels.keys()], options, host);
  const out = new Map<string, string[]>();
  for (const label of labels.values()) out.set(label, []);
  const moduleErrors: string[] = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const file = diagnostic.file ? path.resolve(diagnostic.file.fileName) : '';
    const text = `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
    const label = labels.get(file);
    if (label) out.get(label)?.push(text);
    else if (file === ROLE_CONTRACTS_MODULE) moduleErrors.push(text);
  }
  return { probes: out, module: moduleErrors, sourceFiles: program.getSourceFiles().length };
}

test('the outcome type is unconstructible outside its own module, and the constructors still type', () => {
  const compiled = compileProbes({
    control: [
      'export const a: RoleContractOutcome = roleContractsSwept(3);',
      "export const b: RoleContractOutcome = writeRoleContracts('/x', 0, []);",
    ].join('\n'),
    complete: "export const forged: RoleContractOutcome = { kind: 'complete', written: 3, removed: 0 };",
    partial: "export const forged: RoleContractOutcome = { kind: 'partial', written: 3, removed: 0, failures: [] };",
    unwritable: "export const forged: RoleContractOutcome = { kind: 'unwritable', removed: 0, failure: { path: '/x', errno: 'EEXIST' } };",
  });

  // THE HARNESS, checked before its verdicts are read. Each of these is a way
  // this test could report "the seal holds" while measuring nothing:
  //
  //   - the module under test failing to typecheck at all would widen the type
  //     and could make any literal assignable. The only diagnostics tolerated
  //     are the node builtins, which `types: []` deliberately does not resolve
  //     (measured: exactly TS2307 for 'fs' and for 'path', and nothing else);
  //   - a program that grew past ~90 files means a new import resolved to the
  //     real shared tree instead of a stub, and the 3.4s measurement above is no
  //     longer what anyone is paying;
  //   - the legitimate constructors failing to compile would make every
  //     rejection below pass for the wrong reason.
  assert.deepEqual(
    compiled.module.filter((error) => !/TS2307.*'(fs|path)'/.test(error)),
    [],
    `role-contracts.ts itself did not typecheck, so the probes below prove nothing: ${compiled.module.join(' | ')}`,
  );
  assert.ok(compiled.sourceFiles <= 90,
    `the probe program compiled ${compiled.sourceFiles} files — role-contracts.ts has gained an import that is not `
    + 'stubbed in STUBS, and this test now pulls the shared module graph');
  assert.deepEqual(compiled.probes.get('control'), [],
    'the two legitimate constructors must compile clean — otherwise this harness proves nothing');

  for (const label of ['complete', 'partial', 'unwritable'] as const) {
    const errors = compiled.probes.get(label) ?? [];
    assert.ok(errors.length > 0,
      `a hand-built '${label}' outcome compiled — the seal is gone, and a new host writer can report its `
      + 'deletion sweep as a write count again');
    assert.ok(errors.some((error) => /ROLE_CONTRACT_SEAL/.test(error)),
      `the '${label}' rejection must be the SEAL rather than an unrelated error, or this test would keep passing `
      + `for a type that merely changed shape: ${errors.join(' | ')}`);
  }
});
