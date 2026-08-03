// src/test-environment/core/lint-corpus/index.ts
// The false-positive corpus runner. Feeds every fixture through every BLOCKING
// write-time gate the plugin exposes — planStaticViolations, the structural
// hot path (against a REAL compiled contract), analyzeI18nSourceText at the
// severity the real gates apply, collapse detection, tailwind evidence, and
// the forbidden-library install matcher — and reports:
//
//   falsePositives   known-good idiomatic code that any gate would block
//                    (strict fixtures also fail on advisory findings)
//   missedDetections known-bad fixtures whose owning gate did not fire —
//                    the corpus can never be satisfied by disabling gates
//
// Advisory findings on good fixtures are reported, never failed (unless the
// fixture opts into strictness by default — see fixtures.ts).
//
// Everything here is deterministic and pure-node: contracts are compiled with
// the real compiler into disposable temp projects, no host CLI, no spend.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  compileArchitecture,
  uiAstLintLayer,
  type ArchitectureInputV1,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import { capabilityProfileForProject } from '../../../shared/capabilities';
import type { CapabilityProfileV1 } from '../../../shared/capabilities';
import { collapsedLineNumber } from '../../../shared/collapsed-source';
import { isTestScopePath } from '../../../shared/feature-source';
import {
  analyzeI18nSourceText,
  validateI18nCatalogs,
} from '../../../shared/i18n-enforcement';
import {
  tailwindToolchainPresent,
  tailwindUtilityEvidence,
} from '../../../shared/tailwind-evidence';
import {
  analyzeStructureText,
  analyzeStructureTextAgainstContract,
} from '../../../modules/plan-guard/react-structure';
import { planStaticViolations } from '../../../modules/plan-guard/plan-static';
import {
  INSTALL_RE,
  forbiddenForStack,
} from '../../../modules/plan-guard/forbidden';

import {
  COMMAND_FIXTURES,
  FILE_FIXTURES,
  enIntermediateParityFixture,
  kbCatalogParityFixture,
  reactAppShellFixture,
  reactBrokenRouteFixture,
  roCatalogSeed,
  roPluralCatalogFixture,
  shadcnVendorPrimitiveFixture,
  sourceCatalogSeed,
  type CorpusFileFixture,
  type CorpusGateId,
  type CorpusProfileId,
} from './fixtures';

export interface CorpusGateResult {
  gate: CorpusGateId;
  blocking: string[];
  advisory: string[];
}

export interface CorpusFixtureResult {
  id: string;
  file: string;
  guards: string;
  expectBlock: CorpusGateId | null;
  gates: CorpusGateResult[];
}

export interface CorpusReport {
  fixtures: CorpusFixtureResult[];
  falsePositives: string[];
  missedDetections: string[];
}

// The same semantic architecture every run-sim web shape declares — compiled
// with the REAL compiler so route/module outputs are runtime truth, never
// hand-maintained path literals.
const ARCHITECTURE_INPUT: ArchitectureInputV1 = {
  schemaVersion: 1,
  routes: [
    { id: 'home-route', path: '/', moduleId: 'home' },
    { id: 'courses-route', path: '/courses', moduleId: 'courses' },
  ],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' },
    { id: 'home', name: 'Home', kind: 'page' },
    { id: 'courses', name: 'Courses', kind: 'page' },
    { id: 'course-card', name: 'Course Card', kind: 'component' },
  ],
  i18n: {
    sourceLocale: 'en',
    locales: ['en', 'ro'],
    literalBrands: ['Traffic One'],
  },
};

const REACT_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { framework: 'none' },
};

const VUE_STATE = {
  mode: 'new-project',
  stack: 'custom-frontend',
  frontend: 'vue',
  backend: 'none',
  mobile: { framework: 'none' },
};

const GENERIC_STATE = {
  mode: 'new-project',
  stack: 'custom-frontend',
  frontend: 'other',
  backend: 'none',
  mobile: { framework: 'none' },
};

// Web state for the install matcher: the default full-stack selection.
const INSTALL_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { enabled: false, framework: 'none' },
};

const COPY_FINDING_IDS = new Set(['STRUCT_HARDCODED_COPY', 'STRUCT_I18N_REACT_TRANS']);

interface CorpusEnv {
  reactRoot: string;
  vueRoot: string;
  bareRoot: string;
  reactContract: CompiledArchitectureV1;
  vueContract: CompiledArchitectureV1;
  genericProfile: CapabilityProfileV1;
}

function contractFor(env: CorpusEnv, profile: CorpusProfileId): CompiledArchitectureV1 | null {
  if (profile === 'react') return env.reactContract;
  if (profile === 'vue') return env.vueContract;
  return null;
}

function profileFor(env: CorpusEnv, profile: CorpusProfileId): CapabilityProfileV1 {
  return contractFor(env, profile)?.profile ?? env.genericProfile;
}

function projectRootFor(env: CorpusEnv, fixture: CorpusFileFixture): string {
  if (fixture.bareProject) return env.bareRoot;
  return fixture.profile === 'vue' ? env.vueRoot : env.reactRoot;
}

function describe(finding: { id: string; file: string; line?: number; message: string }): string {
  return `${finding.id} (${finding.file}${finding.line ? `:${finding.line}` : ''}): ${finding.message}`;
}

function evaluateFileFixture(env: CorpusEnv, fixture: CorpusFileFixture): CorpusFixtureResult {
  const profile = profileFor(env, fixture.profile);
  const contract = contractFor(env, fixture.profile);
  const gates: CorpusGateResult[] = [];

  // planStaticViolations: every violation is a write-time deny.
  gates.push({
    gate: 'plan-static',
    blocking: planStaticViolations(
      fixture.file,
      fixture.content,
      false,
      (name, fallback) => `${name}: ${fallback}`,
    ),
    advisory: [],
  });

  // The structural hot path, against the real compiled contract where one
  // exists (mirrors plan-readiness: readCompiledArchitecture → contract-aware
  // analysis). Error severity blocks — at write time for the hot ids, at the
  // completion scan for everything else — so the corpus treats every
  // error-severity structural finding as blocking.
  const structural = contract
    ? analyzeStructureTextAgainstContract(fixture.file, fixture.content, contract, {})
    : analyzeStructureText(fixture.file, fixture.content, profile, []);
  gates.push({
    gate: 'structure',
    blocking: structural.filter((finding) => finding.severity === 'error').map(describe),
    advisory: structural.filter((finding) => finding.severity !== 'error').map(describe),
  });

  // i18n at the severity the real gates apply: copy/Trans findings demote to
  // advisory where the compiled eslint config carries a real AST i18n rule
  // (uiAstLintLayer) and on test-scope paths (the completion scan skips them
  // and the write path never blocks copy); everything else blocks.
  const i18n = analyzeI18nSourceText(
    fixture.file,
    fixture.content,
    profile,
    contract?.i18n,
  );
  const copyDemoted = uiAstLintLayer(profile) !== null || isTestScopePath(fixture.file);
  const i18nBlocking: string[] = [];
  const i18nAdvisory: string[] = [];
  for (const finding of i18n.findings) {
    (COPY_FINDING_IDS.has(finding.id) && copyDemoted ? i18nAdvisory : i18nBlocking)
      .push(describe(finding));
  }
  gates.push({ gate: 'i18n', blocking: i18nBlocking, advisory: i18nAdvisory });

  // Catalog DATA validation (STRUCT_I18N_CATALOG): when the fixture IS a
  // compiled catalog file, mirror the exact call plan-readiness makes for a
  // changed catalog — its namespaces only, `requireAllCatalogs: false`, the
  // proposed content injected, parity judged against the other locales already
  // on disk. Same write-time split as plan-readiness: cross-locale parity
  // classes accumulate as ledger warnings (13cl: a role cannot write two
  // locale files atomically), so they are advisory here; single-file classes
  // (unparseable, empty catalog, empty values) block.
  const changedCatalog = contract?.i18n?.catalogs.find(
    (candidate) => candidate.path === fixture.file,
  );
  if (contract?.i18n && changedCatalog) {
    const catalogFindings = validateI18nCatalogs(projectRootFor(env, fixture), contract.i18n, {
      namespaces: changedCatalog.namespaces,
      requireAllCatalogs: false,
      contentOverrides: { [fixture.file]: fixture.content },
    });
    gates.push({
      gate: 'catalog',
      blocking: catalogFindings.filter((finding) => !finding.crossLocaleParity).map(describe),
      advisory: catalogFindings.filter((finding) => finding.crossLocaleParity).map(describe),
    });
  }

  // Collapse detection (pre-install semantics: no formatter is reachable, so a
  // collapsed line denies outright).
  const collapsedLine = collapsedLineNumber(fixture.file, fixture.content);
  gates.push({
    gate: 'collapse',
    blocking: collapsedLine === null
      ? []
      : [`STRUCT_COLLAPSED_LINE (${fixture.file}:${collapsedLine}): packed one-line source`],
    advisory: [],
  });

  // Tailwind evidence: three-plus distinct utilities with no reachable
  // toolchain render unstyled — the blocking condition from stylingFindings.
  // A dense file WITH the toolchain records advisory evidence so the corpus
  // can prove the pass came from the toolchain, not from an undercount.
  const tailwindBlocking: string[] = [];
  const tailwindAdvisory: string[] = [];
  if (/\.(?:tsx|jsx|vue|svelte)$/i.test(fixture.file)) {
    const utilities = tailwindUtilityEvidence(fixture.content);
    if (utilities.count >= 3) {
      if (tailwindToolchainPresent(projectRootFor(env, fixture), fixture.file)) {
        tailwindAdvisory.push(
          `deliberate Tailwind styling: ${utilities.count} distinct utilities (${utilities.sample.join(', ')}) with the toolchain present`,
        );
      } else {
        tailwindBlocking.push(
          `STRUCT_TAILWIND_NO_TOOLCHAIN (${fixture.file}): ${utilities.count} distinct utilities (${utilities.sample.join(', ')}) with no toolchain`,
        );
      }
    }
  }
  gates.push({ gate: 'tailwind', blocking: tailwindBlocking, advisory: tailwindAdvisory });

  return {
    id: fixture.id,
    file: fixture.file,
    guards: fixture.guards,
    expectBlock: fixture.expectBlock ?? null,
    gates,
  };
}

function evaluateCommandFixture(
  env: CorpusEnv,
  fixture: { id: string; guards: string; command: string; expectBlock?: 'forbidden-install' },
): CorpusFixtureResult {
  const blocking: string[] = [];
  if (INSTALL_RE.test(fixture.command)) {
    const hits = forbiddenForStack(INSTALL_STATE, false, env.reactContract.profile.uiSystem)
      .filter(([pattern]) => new RegExp(pattern).test(fixture.command));
    for (const [pattern, tip] of hits) blocking.push(`${pattern}: ${tip}`);
  }
  return {
    id: fixture.id,
    file: fixture.command,
    guards: fixture.guards,
    expectBlock: fixture.expectBlock ?? null,
    gates: [{ gate: 'forbidden-install', blocking, advisory: [] }],
  };
}

function verdicts(
  results: readonly CorpusFixtureResult[],
  advisoryOkIds: ReadonlySet<string>,
): Pick<CorpusReport, 'falsePositives' | 'missedDetections'> {
  const falsePositives: string[] = [];
  const missedDetections: string[] = [];
  for (const result of results) {
    if (result.expectBlock) {
      const expected = result.gates.find((gate) => gate.gate === result.expectBlock);
      if (!expected || expected.blocking.length === 0) {
        missedDetections.push(
          `${result.id}: expected gate \`${result.expectBlock}\` produced no blocking finding — ${result.guards}`,
        );
      }
      continue;
    }
    for (const gate of result.gates) {
      for (const message of gate.blocking) {
        falsePositives.push(`${result.id} [${gate.gate}]: ${message}`);
      }
      if (!advisoryOkIds.has(result.id)) {
        for (const message of gate.advisory) {
          falsePositives.push(`${result.id} [${gate.gate}] (advisory on a strict fixture): ${message}`);
        }
      }
    }
  }
  return { falsePositives, missedDetections };
}

export function runLintCorpus(): CorpusReport {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-lint-corpus-'));
  try {
    const reactRoot = path.join(root, 'react');
    const vueRoot = path.join(root, 'vue');
    const bareRoot = path.join(root, 'bare');
    for (const dir of [reactRoot, vueRoot, bareRoot]) fs.mkdirSync(dir, { recursive: true });

    // Compile BEFORE seeding any manifest so profile detection sees the same
    // empty greenfield tree the real PLAN_READY transaction compiles against.
    const env: CorpusEnv = {
      reactRoot,
      vueRoot,
      bareRoot,
      reactContract: compileArchitecture(reactRoot, 'R', REACT_STATE, ARCHITECTURE_INPUT),
      vueContract: compileArchitecture(vueRoot, 'R', VUE_STATE, ARCHITECTURE_INPUT),
      genericProfile: capabilityProfileForProject(bareRoot, GENERIC_STATE),
    };
    // The react project HAS its pinned styling toolchain (the bare project has
    // none — that is what the tailwind known-bad runs against).
    fs.writeFileSync(
      path.join(reactRoot, 'package.json'),
      `${JSON.stringify({
        name: 'lint-corpus-react',
        private: true,
        devDependencies: { tailwindcss: '^4.0.0' },
      }, null, 2)}\n`,
    );
    // Catalog parity needs both sides: the source-locale catalog lives on disk
    // (same canonical key set the catalog fixtures are built from) while the
    // fixture under judgement is injected via contentOverrides. The ro sibling
    // is seeded too so the intermediate-parity fixture (an en write adding a
    // key ro lacks) judges against a real counterpart, exactly as live.
    for (const seed of [sourceCatalogSeed(env.reactContract), roCatalogSeed(env.reactContract)]) {
      fs.mkdirSync(path.dirname(path.join(reactRoot, seed.path)), { recursive: true });
      fs.writeFileSync(path.join(reactRoot, seed.path), seed.content);
    }

    const fileFixtures: CorpusFileFixture[] = [
      ...FILE_FIXTURES,
      reactAppShellFixture(env.reactContract),
      reactBrokenRouteFixture(env.reactContract),
      roPluralCatalogFixture(env.reactContract),
      kbCatalogParityFixture(env.reactContract),
      enIntermediateParityFixture(env.reactContract),
      shadcnVendorPrimitiveFixture(env.reactContract),
    ];
    const advisoryOkIds = new Set(
      fileFixtures.filter((fixture) => fixture.advisoryOk).map((fixture) => fixture.id),
    );
    const results = [
      ...fileFixtures.map((fixture) => evaluateFileFixture(env, fixture)),
      ...COMMAND_FIXTURES.map((fixture) => evaluateCommandFixture(env, fixture)),
    ];
    return { fixtures: results, ...verdicts(results, advisoryOkIds) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Every gate family must keep at least one known-bad fixture. */
export function corpusGateFamiliesWithKnownBad(): Set<CorpusGateId> {
  const families = new Set<CorpusGateId>();
  for (const fixture of FILE_FIXTURES) if (fixture.expectBlock) families.add(fixture.expectBlock);
  for (const fixture of COMMAND_FIXTURES) if (fixture.expectBlock) families.add(fixture.expectBlock);
  families.add('structure'); // reactBrokenRouteFixture, contract-derived
  families.add('catalog'); // kbCatalogParityFixture, contract-derived
  return families;
}
