import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  captureArchitectureBaseline,
  compileArchitecture,
  type ArchitectureInputV1,
} from '../architecture-contract';
import {
  buildVerificationContract,
  changedPathsFromBaseline,
  compileVerificationContract,
  DEFAULT_LIGHTHOUSE_THRESHOLDS,
  currentVerificationSourceHash,
  deriveUiImpact,
  plannedUiImpactFloor,
  requiredChecks,
  uiImpactWithPlannedFloor,
  type UiImpact,
} from '../verification-contract';
import { rank } from '../verification-contract/impact';
import { capabilityProfileForProject } from '../capabilities';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-verification-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function setupReact(cwd: string): void {
  for (const dir of ['apps/web/src/pages', 'apps/web/src/features', 'apps/web/src/lib', 'apps/web/src/components']) {
    fs.mkdirSync(path.join(cwd, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    dependencies: { react: '19.0.0', vite: '7.0.0' },
  }));
}

const REACT = {
  mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'none', mobile: { framework: 'none' },
};

const EXISTING_REACT = {
  ...REACT,
  mode: 'existing-codebase',
};

// Changed-hunk evidence needs a git baseline: without one every markup path is
// classified conservatively `visual` with a reason, which cannot distinguish a
// template edit from a handler-only one.
function commit(cwd: string): void {
  execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
  execFileSync('git', [
    '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'base',
  ], { cwd, stdio: 'ignore' });
}

test('backend/API projects derive uiImpact none and never require a browser', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'internal'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.test/api\n');
    const architecture = compileArchitecture(cwd, 'R', {
      mode: 'new-project', stack: 'custom-backend', frontend: 'none', backend: 'go', mobile: { framework: 'none' },
    }, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'health-service', name: 'Health Service', kind: 'service' }],
    });
    const contract = compileVerificationContract(cwd, 'R', {}, architecture, { changedPaths: ['internal/health.go'] });
    assert.equal(contract.uiImpact, 'none');
    assert.equal(contract.browserRequired, false);
    assert.deepEqual(contract.requiredScreenshotWidths, []);
  });
});

test('web impact is mechanically classified and agents can raise but never lower it', () => {
  withProject((cwd) => {
    setupReact(cwd);
    const profile = capabilityProfileForProject(cwd, REACT);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/lib/mapper.ts'), 'export const map = (x: string) => x;\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/features/routes.ts'), 'export const routes = [];\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Home.tsx'), 'export const Home = () => <main />;\n');
    assert.equal(deriveUiImpact(cwd, profile, ['apps/web/src/lib/mapper.ts']).impact, 'nonvisual');
    assert.equal(deriveUiImpact(cwd, profile, ['apps/web/src/features/routes.ts']).impact, 'behavioral');
    assert.equal(deriveUiImpact(cwd, profile, ['apps/web/src/pages/Home.tsx']).impact, 'visual');

    const input: ArchitectureInputV1 = {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    };
    const architecture = compileArchitecture(cwd, 'R', EXISTING_REACT, input);
    const raised = compileVerificationContract(cwd, 'R', EXISTING_REACT, architecture, {
      changedPaths: ['apps/web/src/lib/Mapping.ts'],
      agentRaisedImpact: 'behavioral',
    });
    assert.equal(raised.uiImpact, 'behavioral');
    const cannotLower = compileVerificationContract(cwd, 'R2', EXISTING_REACT, {
      ...architecture,
      runId: 'R2',
      contractHash: architecture.contractHash,
    }, {
      changedPaths: ['apps/web/src/pages/Home.tsx'],
      agentRaisedImpact: 'none',
    });
    assert.equal(cannotLower.uiImpact, 'visual');
  });
});

// The impact contract is TWO-SIDED, and each direction is a live failure mode
// that a fix for the other one alone reintroduces:
//
//   the planned floor is a LOWER BOUND that no scan outcome may reduce, and the
//   scan's own IGNORANCE is not evidence that may raise it.
//
// Under-escalation ships unverified UI: a run that plans three pages and then
// publishes "no UI impact" — because the diff scan failed, exceeded its file
// bound, or simply ran before implementation exists — has nothing left asking for
// a browser. Over-escalation makes runs unsettleable: `deriveUiImpact` answered
// `behavioral` for ANY changed JS/TS file it did not recognize, so a service-only
// plan writing its own compiled `tests/<module>.test.ts` demanded
// `playwright-local` from a machine that may own no Chromium (measured: 664 of
// this repo's 867 tracked JS/TS paths were `behavioral` on extension alone).
//
// Fixing only the second invites `uiImpact = floor`, which closes it and opens the
// first, because an unplanned stylesheet or `.tsx` edit could then never escalate
// the run that made it. Hence one property, both directions: a maximum, never an
// assignment, and the scan side has to earn every raise.
test('the planned floor is a lower bound and the scan raises only on evidence', () => {
  const SCAN_OUTCOMES: Array<[string, Record<string, unknown>]> = [
    ['scan saw nothing', { changedPaths: [] }],
    ['scan failed', { changedPaths: [], scanComplete: false, scanReason: 'git baseline diff could not be completed' }],
    ['scan saw only a mapper', { changedPaths: ['apps/web/src/lib/mapper.ts'] }],
    ['scan saw only tester outputs', { changedPaths: ['tests/home.test.ts', 'vitest.config.ts'] }],
  ];

  // Direction 1: whatever the scan does or fails to do, the contract stays at
  // what the PLAN already committed to.
  for (const [label, input, floor] of [
    ['page plan', {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' as const },
        { id: 'home', name: 'Home', kind: 'page' as const },
      ],
    }, 'visual'],
    ['feature plan', {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'contact', name: 'Contact', kind: 'feature' as const }],
    }, 'behavioral'],
  ] as Array<[string, ArchitectureInputV1, UiImpact]>) {
    withProject((cwd) => {
      setupReact(cwd);
      const architecture = compileArchitecture(cwd, 'R', EXISTING_REACT, input);
      assert.equal(
        plannedUiImpactFloor(cwd, architecture),
        floor,
        `fixture guard: ${label} must declare a ${floor} floor`,
      );
      for (const [outcome, options] of SCAN_OUTCOMES) {
        const contract = buildVerificationContract(cwd, 'R', EXISTING_REACT, architecture, options);
        assert.equal(contract.uiImpact, floor, `${label} / ${outcome} must not fall below its planned floor`);
        assert.equal(contract.browserRequired, true, `${label} / ${outcome} still owes browser evidence`);
        assert.deepEqual(contract.requiredChecks, requiredChecks(floor));
      }
    });
  }

  // Direction 2: on a plan that declares no UI, an unrecognized changed path is
  // not a reason to demand a browser. Every entry here reached the deleted
  // `else if (/\.(?:tsx?|jsx?|mjs|cjs)$/) -> behavioral` arm, including the unit
  // test the plan itself compiles.
  withProject((cwd) => {
    setupReact(cwd);
    const architecture = compileArchitecture(cwd, 'R', EXISTING_REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'sync-service', name: 'Sync Service', kind: 'service' }],
    });
    assert.equal(plannedUiImpactFloor(cwd, architecture), 'nonvisual', 'fixture guard: a service plan declares no UI');
    assert.ok(
      architecture.allowedOutputs.includes('tests/sync-service.test.ts'),
      'fixture guard: the plan owes exactly the unit test that used to escalate it',
    );
    const unrecognized = [
      'tests/sync-service.test.ts',
      'server/index.ts',
      'src/services/payments.ts',
      'src/middleware/rate-limit.ts',
      'apps/api/src/server.ts',
      'packages/shared/src/money.ts',
      'scripts/backfill.mjs',
      'scripts/legacy.cjs',
      'apps/web/src/api-client.js',
    ];
    const profile = capabilityProfileForProject(cwd, EXISTING_REACT);
    for (const file of unrecognized) {
      assert.equal(
        deriveUiImpact(cwd, profile, [file]).impact,
        'nonvisual',
        `${file} is unrecognized, and non-recognition is not evidence of UI impact`,
      );
    }
    const contract = buildVerificationContract(cwd, 'R', EXISTING_REACT, architecture, { changedPaths: unrecognized });
    assert.equal(contract.uiImpact, 'nonvisual');
    assert.equal(contract.browserRequired, false);
    assert.deepEqual(contract.requiredChecks, ['stack-build', 'stack-format', 'stack-test']);
    assert.deepEqual(contract.requiredScreenshotWidths, []);

    // And the same nonvisual plan still escalates on real evidence, which is what
    // stops the floor from being applied as an assignment rather than a maximum.
    // `checkout.ts` carries its evidence in CONTENT, not in the path: `lib/` was
    // the quietest directory the deleted nonvisual list had.
    fs.writeFileSync(
      path.join(cwd, 'apps/web/src/lib/checkout.ts'),
      'export const go = () => navigate("/pay");\n',
    );
    for (const [file, expected] of [
      ['apps/web/src/styles/globals.css', 'visual'],
      ['apps/web/src/features/routes.ts', 'behavioral'],
      ['apps/web/src/lib/checkout.ts', 'behavioral'],
    ] as Array<[string, UiImpact]>) {
      const raised = buildVerificationContract(cwd, 'R', EXISTING_REACT, architecture, { changedPaths: [file] });
      assert.equal(raised.uiImpact, expected, `${file} is evidence and must still raise a nonvisual plan`);
      assert.equal(raised.browserRequired, true);
    }
  });

  // The mount point is the one path the deleted fallback classified on real
  // evidence: on vue/svelte/angular/generic-web it is `main.ts`, which no markup
  // or style pattern can see. It keys on the profile's own declaration.
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { vue: '3.5.0' } }));
    fs.writeFileSync(path.join(cwd, 'src/App.vue'), '<template><div /></template>\n');
    fs.writeFileSync(path.join(cwd, 'src/main.ts'), 'import App from "./App.vue";\n');
    const state = {
      mode: 'existing-codebase', stack: 'custom-frontend', frontend: 'vue', backend: 'none', mobile: { framework: 'none' },
    };
    const profile = capabilityProfileForProject(cwd, state);
    assert.deepEqual(profile.entrypoints, ['src/main.ts', 'src/main.js'], 'fixture guard: a non-markup mount point');
    assert.equal(
      deriveUiImpact(cwd, profile, ['src/main.ts']).impact,
      'behavioral',
      'the declared web mount point is browser-facing on evidence, not on extension',
    );
    // A sibling of the same shape and extension, one directory away from the
    // declaration, is not the mount point and buys no browser.
    assert.equal(
      deriveUiImpact(cwd, profile, ['src/setup/main.ts']).impact,
      'nonvisual',
      'only the declared entrypoint path is the entrypoint',
    );
  });

  // `generic-web` names its app ROOT among its entrypoints, so the arm is
  // extension-guarded: a committed build artifact that happens to sit at that
  // exact path is not the project's mount module.
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { htmx: '2.0.0' } }));
    fs.writeFileSync(path.join(cwd, 'app/index.js'), 'export {};\n');
    const profile = capabilityProfileForProject(cwd, {
      mode: 'existing-codebase', stack: 'custom-frontend', frontend: 'other', backend: 'none', mobile: { framework: 'none' },
    });
    assert.ok(profile.entrypoints.includes('app'), 'fixture guard: a directory-shaped entrypoint declaration');
    assert.equal(
      deriveUiImpact(cwd, profile, ['app']).impact,
      'nonvisual',
      'a directory-shaped entrypoint declaration must not make its namesake the mount module',
    );
  });

  // Total over the impact lattice: the composition is a maximum of both inputs,
  // for every scan answer, including ones no corpus produces.
  withProject((cwd) => {
    setupReact(cwd);
    for (const input of [
      {
        schemaVersion: 1,
        routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
        modules: [{ id: 'home', name: 'Home', kind: 'page' as const }],
      },
      { schemaVersion: 1, routes: [], modules: [{ id: 'sync', name: 'Sync', kind: 'service' as const }] },
    ] as ArchitectureInputV1[]) {
      const architecture = compileArchitecture(cwd, 'R', EXISTING_REACT, input);
      const floor = plannedUiImpactFloor(cwd, architecture);
      for (const scanned of ['none', 'nonvisual', 'behavioral', 'visual', 'native-ui'] as UiImpact[]) {
        const settled = uiImpactWithPlannedFloor(cwd, architecture, scanned);
        assert.ok(rank(settled) >= rank(floor), `${scanned} lowered the ${floor} floor to ${settled}`);
        assert.ok(rank(settled) >= rank(scanned), `the ${floor} floor lowered a ${scanned} scan to ${settled}`);
      }
    }
  });
});

// The mirror hole the same deletion opened. MARKUP_RE is a list of extensions
// that MEAN markup, so it recognizes React, Vue, Svelte and Astro and cannot
// recognize Angular at all — Angular's canonical component is `hero.component.ts`
// (naming.ts pins `.component.ts` for every Angular module kind) and it carries
// its template inline. Measured on the tree before this arm: `hero.component.ts`
// derived `nonvisual` while the same bytes as `hero.component.tsx` derived
// `visual`, so a first-class framework's UI shipped with nothing asking for a
// browser. The evidence is the framework's own component API, never the
// extension, which is why the service beside it still falls through.
test('a component declaration is evidence in any file the framework writes it in', () => {
  const ANGULAR = {
    mode: 'existing-codebase', stack: 'custom-frontend', frontend: 'angular', backend: 'none', mobile: { framework: 'none' },
  };

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'src/app'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'server/src/main/java/billing'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { '@angular/core': '19.0.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'angular.json'), '{}\n');
    fs.writeFileSync(path.join(cwd, 'src/main.ts'), 'export {};\n');
    const component = [
      "import { Component } from '@angular/core';",
      '',
      '@Component({',
      "  selector: 'app-hero',",
      '  template: \'<h1 class="hero">{{ title }}</h1>\',',
      '})',
      'export class HeroComponent {',
      "  title = 'Welcome';",
      "  greet(): string { return 'hi'; }",
      '}',
      '',
    ].join('\n');
    // Same file extension, same decorator syntax, same Angular import, no UI.
    const service = [
      "import { Injectable } from '@angular/core';",
      '',
      "@Injectable({ providedIn: 'root' })",
      'export class BillingService {',
      "  charge(id: string) { return fetch('/api/charge/' + id); }",
      '}',
      '',
    ].join('\n');
    // Spring's stereotype is spelled `@Component` too — and, named, spelled with
    // the parenthesis this predicate looks for. A Java service beside an Angular
    // app is an ordinary pairing, which is what the module-extension guard is for.
    const bean = [
      'package billing;',
      'import org.springframework.stereotype.Component;',
      '@Component("billingBean")',
      'public class BillingBean {',
      '  public String charge(String id) { return id; }',
      '}',
      '',
    ].join('\n');
    for (const rel of ['src/app/hero.component.ts', 'src/app/hero.component.tsx']) {
      fs.writeFileSync(path.join(cwd, rel), component);
    }
    fs.writeFileSync(path.join(cwd, 'src/app/billing.service.ts'), service);
    fs.writeFileSync(path.join(cwd, 'server/src/main/java/billing/BillingBean.java'), bean);
    commit(cwd);
    const profile = capabilityProfileForProject(cwd, ANGULAR);
    assert.equal(profile.profileId, 'angular', 'fixture guard: the framework whose components are plain .ts');
    const baseline = captureArchitectureBaseline(cwd, profile);
    assert.equal(baseline.kind, 'git-head', 'fixture guard: hunk evidence needs a git baseline');

    // Byte-identical content one letter of extension apart must classify
    // identically, and it is the CHANGED HUNK that picks the class — the same
    // discrimination `.vue` and `.tsx` already get, not a flat answer.
    for (const [label, edited, expected] of [
      ['handler-only', component.replace("return 'hi';", "return 'hello there';"), 'behavioral'],
      [
        'template',
        component.replace('<h1 class="hero">{{ title }}</h1>', '<h2 class="hero">{{ title }}</h2><p>tagline</p>'),
        'visual',
      ],
    ] as Array<[string, string, UiImpact]>) {
      for (const rel of ['src/app/hero.component.ts', 'src/app/hero.component.tsx']) {
        fs.writeFileSync(path.join(cwd, rel), edited);
        assert.equal(
          deriveUiImpact(cwd, profile, [rel], baseline).impact,
          expected,
          `${rel}: a ${label} edit in an Angular component`,
        );
        fs.writeFileSync(path.join(cwd, rel), component);
      }
    }

    for (const [rel, edited] of [
      ['src/app/billing.service.ts', service.replace("'/api/charge/'", "'/api/charges/'")],
      ['server/src/main/java/billing/BillingBean.java', bean.replace('return id;', 'return id.trim();')],
    ]) {
      fs.writeFileSync(path.join(cwd, rel!), edited!);
      assert.equal(
        deriveUiImpact(cwd, profile, [rel!], baseline).impact,
        'nonvisual',
        `${rel}: declares no component and must buy no browser`,
      );
    }
  });

  // Lit and vanilla custom elements reach here as `generic-web`, so the arm
  // cannot be gated on `profile.framework === 'angular'` without leaving the
  // whole web-components ecosystem exactly where Angular was.
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'src/api'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { lit: '3.2.0', vite: '7.0.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'index.html'), '<div id="app"></div>\n');
    fs.writeFileSync(path.join(cwd, 'src/main.ts'), 'export {};\n');
    const lit = [
      "import { LitElement, html } from 'lit';",
      "import { customElement } from 'lit/decorators.js';",
      '',
      "@customElement('hero-banner')",
      'export class HeroBanner extends LitElement {',
      '  render() { return html`<h1 class="hero">Welcome</h1>`; }',
      '}',
      '',
    ].join('\n');
    const vanilla = [
      'class LegacyHero extends HTMLElement {',
      '  connectedCallback() { this.innerHTML = \'<h1 class="hero">Welcome</h1>\'; }',
      '}',
      "customElements.define('legacy-hero', LegacyHero);",
      '',
    ].join('\n');
    const api = 'export const charge = (id: string) => fetch(`/api/charge/${id}`);\n';
    fs.writeFileSync(path.join(cwd, 'src/hero.ts'), lit);
    fs.writeFileSync(path.join(cwd, 'src/legacy-hero.js'), vanilla);
    fs.writeFileSync(path.join(cwd, 'src/api/billing.ts'), api);
    commit(cwd);
    const profile = capabilityProfileForProject(cwd, {
      mode: 'existing-codebase', stack: 'custom-frontend', frontend: 'other', backend: 'none', mobile: { framework: 'none' },
    });
    assert.equal(profile.profileId, 'generic-web', 'fixture guard: web components have no framework profile of their own');
    const baseline = captureArchitectureBaseline(cwd, profile);

    for (const [rel, edited] of [
      ['src/hero.ts', lit.replace('<h1 class="hero">Welcome</h1>', '<h1 class="hero">Welcome back</h1>')],
      ['src/legacy-hero.js', vanilla.replace('<h1 class="hero">Welcome</h1>', '<h1 class="hero">Welcome back</h1>')],
    ]) {
      fs.writeFileSync(path.join(cwd, rel!), edited!);
      assert.equal(
        deriveUiImpact(cwd, profile, [rel!], baseline).impact,
        'visual',
        `${rel}: a registered custom element is browser-observable UI`,
      );
    }
    fs.writeFileSync(path.join(cwd, 'src/api/billing.ts'), api.replace('/api/charge/', '/api/charges/'));
    assert.equal(
      deriveUiImpact(cwd, profile, ['src/api/billing.ts'], baseline).impact,
      'nonvisual',
      'the module beside them registers no element and stays unrecognized',
    );
  });
});

// The same extension guard, applied to the two arms that never had it. Measured
// on this 24-row polyglot corpus before it: 21 of the 42 browser-requiring paths
// could not be observed in a browser AT ALL — Go's `router.go`/`handler.go`,
// Rails' mandated `*_controller.rb`, Spring's `*Controller.java`, ASP.NET's
// `*Controller.cs`, `internal/routes`/`internal/store`/`internal/state` packages,
// FastAPI's `router = APIRouter()`, a `router_audit` migration, a gateway
// `routes.yaml`, a `router-smoke.sh` and `docs/architecture/router.md`. Direction
// of harm is cost and settleability rather than unverified UI, but the frequency
// is near-total: those two file names are conventions, not choices.
//
// Each row is asserted TWICE, and the second assertion is what makes the first
// non-vacuous: the identical bytes at a JS/TS path still classify `behavioral`,
// so the fixture provably carries the evidence the arm looks for and the file's
// language is the only thing that changed the answer.
test('a router by any other name: behavior spelling only counts in a file a browser loads', () => {
  const ROWS: Array<[string, string, string]> = [
    ['internal/api/router.go', 'chi: the canonical Go HTTP file name, and `router` is its variable', [
      'package api',
      '',
      'import "github.com/go-chi/chi/v5"',
      '',
      'func New() http.Handler {',
      '\trouter := chi.NewRouter()',
      '\trouter.Get("/healthz", healthz)',
      '\treturn router',
      '}',
    ].join('\n')],
    ['internal/api/handler.go', 'the handler layer every Go service has', [
      'package api',
      '',
      'func healthz(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }',
    ].join('\n')],
    ['internal/routes/health.go', 'a Go PACKAGE named routes is not a UI layer', [
      'package routes',
      '',
      'func Health() http.HandlerFunc { return nil }',
    ].join('\n')],
    ['internal/state/machine.go', 'a Go state package', [
      'package state',
      '',
      'type Phase string',
    ].join('\n')],
    ['app/api/deps.py', 'FastAPI spells its own router `router = APIRouter()`', [
      'from fastapi import APIRouter',
      '',
      'router = APIRouter(prefix="/v1")',
    ].join('\n')],
    ['app/controllers/invoices_controller.rb', 'Rails MANDATES this file name', [
      'class InvoicesController < ApplicationController',
      '  def index; @invoices = Invoice.all; end',
      'end',
    ].join('\n')],
    ['server/src/main/java/acme/InvoiceController.java', 'Spring MVC convention', [
      'package acme;',
      '',
      '@RestController',
      'public class InvoiceController {',
      '  @GetMapping("/v1/invoices") public String index() { return "[]"; }',
      '}',
    ].join('\n')],
    ['dotnet/Controllers/InvoicesController.cs', 'ASP.NET Core convention', [
      'namespace Acme.Controllers;',
      '',
      'public class InvoicesController : ControllerBase',
      '{',
      '    public IActionResult Index() => Ok();',
      '}',
    ].join('\n')],
    ['crates/api/src/state.rs', 'axum shared state', [
      '#[derive(Clone)]',
      'pub struct AppState { pub pool: sqlx::PgPool }',
    ].join('\n')],
    ['db/migrations/002_router_audit.sql', 'a table named after the router', [
      'create table router_audit (id bigserial primary key, router text not null);',
    ].join('\n')],
    ['docs/architecture/router.md', 'PROSE about the router; a browser cannot load markdown', [
      '# Router',
      '',
      'The router mounts /v1 and delegates to each handler.',
    ].join('\n')],
  ];

  withProject((cwd) => {
    setupReact(cwd);
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.test/svc\n');
    const profile = capabilityProfileForProject(cwd, EXISTING_REACT);
    assert.equal(profile.profileId, 'vite-react', 'fixture guard: a project WITH a web surface, so the loop runs');
    for (const [rel, why, body] of ROWS) {
      for (const candidate of [rel, `${rel.replace(/\.[^./]+$/, '')}.ts`]) {
        fs.mkdirSync(path.join(cwd, path.dirname(candidate)), { recursive: true });
        fs.writeFileSync(path.join(cwd, candidate), `${body}\n`);
      }
      assert.equal(
        deriveUiImpact(cwd, profile, [rel]).impact,
        'nonvisual',
        `${rel}: ${why} — a name is not evidence in a language no browser runs`,
      );
      assert.equal(
        deriveUiImpact(cwd, profile, [`${rel.replace(/\.[^./]+$/, '')}.ts`]).impact,
        'behavioral',
        `fixture guard: the same bytes at a JS/TS path must still be recognized, or ${rel} proves nothing`,
      );
    }

    // The web surface keeps every one of them, which is what stops the bound
    // from being a blanket lowering. Each row below is claimed by exactly one of
    // the two bounded arms and by no earlier one: plain `.ts`/`.js`, no markup
    // extension, no style path.
    for (const [rel, body, expected] of [
      ['apps/web/src/router/index.ts', "export const router = createBrowserRouter([]);", 'behavioral'],
      ['apps/web/src/stores/cart.ts', 'export const cart = { items: [] };', 'behavioral'],
      ['apps/web/src/lib/checkout.ts', "export const pay = () => navigate('/pay');", 'behavioral'],
      ['apps/web/src/routes/guard.ts', 'export const guard = () => true;', 'behavioral'],
      ['apps/web/src/lib/handler.ts', 'export const handler = () => 1;', 'behavioral'],
    ] as Array<[string, string, UiImpact]>) {
      fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), `${body}\n`);
      assert.equal(
        deriveUiImpact(cwd, profile, [rel]).impact,
        expected,
        `${rel}: a browser-loadable module keeps both arms`,
      );
    }

    // And the markup extensions the bound could plausibly have been covering are
    // all answered ABOVE it, so control never reaches the behavior arms for one.
    // Verified rather than assumed: this is the direction that ships unverified UI.
    for (const rel of [
      'laravel/app/Http/Controllers/InvoiceController.php',
      'laravel/resources/views/invoices/index.blade.php',
      'rails/app/views/invoices/index.html.erb',
      'symfony/templates/home.html.twig',
      'web/templates/card.hbs',
      'public/index.html',
      'apps/web/src/marketing.astro',
      'apps/web/src/Widget.vue',
      'apps/web/src/Panel.svelte',
    ]) {
      fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), '<main class="hero">Invoices</main>\n');
      assert.equal(
        deriveUiImpact(cwd, profile, [rel]).impact,
        'visual',
        `${rel}: a browser-observable template must not be lowered by a bound on the arms below it`,
      );
    }
  });
});

// The class that bound EXPOSED rather than created. `.mdx` and `.pug` were
// browser-requiring only while their bytes happened to hold `onClick`/`navigate`,
// and their siblings `.htm`, `.haml`, `.njk`, `.liquid` and `.gohtml` were
// `nonvisual` and always had been: two of seven, decided by which token a
// template happened to contain, is not coverage of anything. So the class is
// answered where the evidence is the extension MEANING markup, and every fixture
// below is deliberately token-free — no `onClick`, no `navigate`, no `className`
// — so neither deleted arm could have claimed one.
//
// Each row is asserted TWICE and the second assertion is what makes the first
// non-vacuous, mirroring the polyglot test above but in the opposite direction:
// the SAME bytes at an extension that names a templating ENGINE rather than
// markup must stay `nonvisual`, so the extension is provably the only thing
// answering. That is also the line the vocabulary draws — `.tmpl`, `.tpl`, `.j2`
// and `.mustache` render Helm values, an Ansible nginx.conf and a codegen'd
// model class at least as often as a page, and `.md` is documentation.
test('a template is browser-observable by extension, not by the token it happens to hold', () => {
  const ANGLE_BRACKET = '<main><h1>Invoices</h1></main>\n';
  const ANGLE_BRACKET_EDIT = '<main><h1>Invoices</h1><p>Totals</p></main>\n';
  const INDENTED = 'main\n  h1 Invoices\n';
  const INDENTED_EDIT = 'main\n  h1 Invoices\n  p Totals\n';

  const ROWS: Array<[string, string, string, UiImpact, string]> = [
    // Angle-bracket templates: `visualProjection` can see the structural edit, so
    // they discriminate exactly as the `.html` beside them does.
    ['public/legacy/home.htm', ANGLE_BRACKET, ANGLE_BRACKET_EDIT, 'visual', 'the other spelling of .html'],
    ['site/_includes/base.njk', '<main>{{ content }}</main>\n', '<main>{{ content }}<footer>{{ y }}</footer></main>\n', 'visual', 'Nunjucks/Eleventy'],
    ['sections/hero.liquid', '<section>{{ s.title }}</section>\n', '<section>{{ s.title }}<p>{{ s.sub }}</p></section>\n', 'visual', 'Shopify/Jekyll Liquid'],
    ['web/templates/invoice.gohtml', '<main>{{ .Total }}</main>\n', '<main>{{ .Total }}<span>{{ .Tax }}</span></main>\n', 'visual', "Go's html/template"],
    ['app/components/nav.marko', '<nav><a href="/">Home</a></nav>\n', '<nav><a href="/">Home</a><a href="/pay">Pay</a></nav>\n', 'visual', 'Marko, a detected frontend'],
    ['app/components/hero.gjs', '<template><h1>Hi</h1></template>\n', '<template><h1>Hi</h1><p>There</p></template>\n', 'visual', 'Ember template-tag JS'],
    ['app/components/hero.gts', '<template><h1>Hi</h1></template>\n', '<template><h1>Hi</h1><p>There</p></template>\n', 'visual', 'Ember template-tag TS'],
    ['web/views/invoice.jsp', ANGLE_BRACKET, ANGLE_BRACKET_EDIT, 'visual', 'JSP, for the java backend'],
    ['web/views/invoice.jspx', ANGLE_BRACKET, ANGLE_BRACKET_EDIT, 'visual', 'JSP in XML syntax'],
    ['web/views/profile.xhtml', ANGLE_BRACKET, ANGLE_BRACKET_EDIT, 'visual', 'JSF Facelets'],
    // Indentation-based templates carry no angle brackets, so the tag walk alone
    // sees nothing on either side. These four used to settle for `behavioral`
    // here, declared rather than hidden; `visualProjection` now reads lines as
    // well as tags for them, so they reach `visual` like every row above. The
    // test below this one is what proves the raise did not cost the
    // discrimination — a comment-only or handler-only edit is still `behavioral`.
    ['app/views/wrapper.pug', 'doctype html\nbody\n  h1 Invoices\n', 'doctype html\nbody\n  h1 Invoices\n  p Totals\n', 'visual', 'Pug'],
    ['app/views/legacy.jade', 'body\n  h1 Invoices\n', 'body\n  h1 Invoices\n  p Totals\n', 'visual', "Pug's former spelling"],
    ['app/views/invoices/show.html.haml', '%main\n  %h1 Invoices\n', '%main\n  %h1 Invoices\n  %p Totals\n', 'visual', "Rails' HAML"],
    ['app/views/invoices/edit.html.slim', INDENTED, INDENTED_EDIT, 'visual', "Rails' Slim, beside .erb and .haml"],
  ];

  // `.tmpl`/`.tpl`/`.j2`/`.mustache`/`.md` take the same bytes as the row above
  // them and must NOT be recognized. Their bodies are the angle-bracket fixture
  // on purpose: if the vocabulary ever answered on content, these would move.
  const DECLINED = ['deploy/home.tmpl', 'charts/app/home.tpl', 'deploy/home.j2', 'codegen/home.mustache', 'docs/home.md'];
  const MDX = 'content/blog/ship.mdx';
  const MDX_BASE = '# Ship\n\nIntro copy.\n\n<Counter start={1} />\n\n- one\n  - two\n';

  withProject((cwd) => {
    setupReact(cwd);
    for (const [rel, before] of [...ROWS.map(([rel, before]) => [rel, before] as const), [MDX, MDX_BASE] as const]) {
      fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), before);
    }
    for (const rel of DECLINED) {
      fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), ANGLE_BRACKET);
    }
    commit(cwd);
    const profile = capabilityProfileForProject(cwd, EXISTING_REACT);
    assert.equal(profile.profileId, 'vite-react', 'fixture guard: a project WITH a web surface, so the loop runs');
    const baseline = captureArchitectureBaseline(cwd, profile);
    assert.equal(baseline.kind, 'git-head', 'fixture guard: hunk evidence needs a git baseline');

    for (const [rel, before, edited, expected, why] of ROWS) {
      assert.doesNotMatch(
        edited,
        /onClick|navigate|className|\brouter\b/,
        `fixture guard: ${rel} must hold none of the tokens the deleted arms read, or it proves nothing`,
      );
      fs.writeFileSync(path.join(cwd, rel), edited);
      assert.equal(
        deriveUiImpact(cwd, profile, [rel], baseline).impact,
        expected,
        `${rel}: ${why} — a template edit is browser-observable`,
      );
      fs.writeFileSync(path.join(cwd, rel), before);
    }

    for (const rel of DECLINED) {
      fs.writeFileSync(path.join(cwd, rel), ANGLE_BRACKET_EDIT);
      assert.equal(
        deriveUiImpact(cwd, profile, [rel], baseline).impact,
        'nonvisual',
        `${rel}: an extension that names a templating engine is not evidence of markup, whatever the bytes say`,
      );
      fs.writeFileSync(path.join(cwd, rel), ANGLE_BRACKET);
    }

    // `.mdx` is the one row a path cannot settle: the same extension is a
    // compiled page component in Next, Astro, Gatsby and Remix AND how a docs
    // site writes prose. It is read as markup because the other failure is
    // shipping an interactive page with nothing asking for a browser, and the
    // cost of being wrong is bounded by the same discrimination every markup
    // extension gets — a prose-only hunk is `behavioral`, not a screenshot sweep.
    //
    // The third row is what keeps that bound standing now that the projection
    // also reads indentation. A Markdown list IS indentation-structured, so a
    // content probe would call every nested bullet a node and make each docs
    // edit a screenshot sweep. The parser is reached by an extension WHITELIST
    // that `.mdx` is not on, so the bullet stays prose.
    for (const [label, edited, expected] of [
      ['a prose-only edit', MDX_BASE.replace('Intro copy.', 'Intro copy, revised.'), 'behavioral'],
      ['a nested list item added', MDX_BASE.replace('  - two\n', '  - two\n  - three\n'), 'behavioral'],
      ['a component added', MDX_BASE.replace('/>\n', '/>\n<Chart series={[]} />\n'), 'visual'],
    ] as Array<[string, string, UiImpact]>) {
      fs.writeFileSync(path.join(cwd, MDX), edited);
      assert.equal(
        deriveUiImpact(cwd, profile, [MDX], baseline).impact,
        expected,
        `${MDX}: ${label} in an MDX page`,
      );
      fs.writeFileSync(path.join(cwd, MDX), MDX_BASE);
    }
  });
});

// The asymmetry that made the raise above worth its own lane sits INSIDE one
// framework. Rails ships three view languages; `visualProjection` walked angle
// brackets, so `.erb` bought the screenshot sweep and the `.haml` or `.slim`
// beside it — same app, same page, same edit — produced an identical empty
// projection on both sides and settled for `behavioral`. Whether a visual
// regression was ever looked at depended on which view language the team picked,
// and the miss direction was under-escalation.
test('the three Rails view languages answer the same structural edit the same way', () => {
  const PAGE: Array<[string, string, string]> = [
    ['app/views/invoices/index.html.erb', '<main>\n  <h1>Invoices</h1>\n</main>\n', '<main>\n  <h1>Invoices</h1>\n  <p>Totals</p>\n</main>\n'],
    ['app/views/invoices/index.html.haml', '%main\n  %h1 Invoices\n', '%main\n  %h1 Invoices\n  %p Totals\n'],
    ['app/views/invoices/index.html.slim', 'main\n  h1 Invoices\n', 'main\n  h1 Invoices\n  p Totals\n'],
  ];
  withProject((cwd) => {
    setupReact(cwd);
    for (const [rel, before] of PAGE) {
      fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), before);
    }
    commit(cwd);
    const profile = capabilityProfileForProject(cwd, EXISTING_REACT);
    const baseline = captureArchitectureBaseline(cwd, profile);
    assert.equal(baseline.kind, 'git-head', 'fixture guard: hunk evidence needs a git baseline');
    for (const [rel, before, edited] of PAGE) {
      fs.writeFileSync(path.join(cwd, rel), edited);
      assert.equal(
        deriveUiImpact(cwd, profile, [rel], baseline).impact,
        'visual',
        `${rel}: the same paragraph added to the same page must not depend on the view language`,
      );
      fs.writeFileSync(path.join(cwd, rel), before);
    }
  });
});

// Reading lines instead of tags is only half the fix, and the other half is what
// bounds its cost: a projection that called EVERY line structural would buy a
// three-viewport sweep for a typo in a comment. So the line pass discriminates
// on the same two rules the tag walk already used — event-handler attributes are
// stripped out of the node, and a line the browser never paints carries no part
// at all — and each language below is composed from ONE list of lines with a
// single member swapped or inserted, so the EDIT is provably the only difference
// between the row that raises and the rows that do not.
//
// Rendered TEXT is deliberately NOT excluded: `%h1 Invoices` is part of the
// projection exactly as `<h1>Invoices</h1>`'s text is in the `.erb` next door, so
// retitling a heading is `visual` in both. Excluding it would have closed the
// asymmetry above and reopened it one edit shape to the left.
test('an indentation template still discriminates prose and handlers from structure', () => {
  interface Language {
    rel: string;
    root: string;
    silent: string;
    silentEdit: string;
    heading: string;
    added: string;
    handler: string;
    handlerEdit: string;
  }
  const LANGUAGES: Language[] = [
    {
      rel: 'app/views/wrapper.pug',
      root: 'main',
      silent: '//- keep this',
      silentEdit: '//- keep this instead',
      heading: 'h1 Invoices',
      added: 'p Totals',
      handler: 'button(v-on:click="save(1)") Go',
      handlerEdit: 'button(v-on:click="save(1, 2)") Go',
    },
    {
      rel: 'app/views/legacy.jade',
      root: 'body',
      silent: '//- keep this',
      silentEdit: '//- keep this instead',
      heading: 'h1 Invoices',
      added: 'p Totals',
      handler: 'button(v-on:click="save(1)") Go',
      handlerEdit: 'button(v-on:click="save(1, 2)") Go',
    },
    {
      // HAML's `-#` is the silent comment; `/` renders an HTML comment, which the
      // line pass also drops — invisible is invisible.
      rel: 'app/views/invoices/show.html.haml',
      root: '%main',
      silent: '-# keep this',
      silentEdit: '-# keep this instead',
      heading: '%h1 Invoices',
      added: '%p Totals',
      handler: '%button(v-on:click="save(1)") Go',
      handlerEdit: '%button(v-on:click="save(1, 2)") Go',
    },
    {
      // Slim spells the silent comment `/` and brackets its attributes.
      rel: 'app/views/invoices/edit.html.slim',
      root: 'main',
      silent: '/ keep this',
      silentEdit: '/ keep this instead',
      heading: 'h1 Invoices',
      added: 'p Totals',
      handler: 'button[v-on:click="save(1)"] Go',
      handlerEdit: 'button[v-on:click="save(1, 2)"] Go',
    },
    {
      // Marko is the row the vocabulary owed a second look: it accepts an
      // HTML-like syntax AND a concise indented one, and only the first was ever
      // visible to the tag walk. `--` opens its text, `//` is its comment.
      rel: 'app/components/counter.marko',
      root: 'div.container',
      silent: '// keep this',
      silentEdit: '// keep this instead',
      heading: 'h1 -- Invoices',
      added: 'p -- Totals',
      handler: 'button(v-on:click="save(1)") -- Go',
      handlerEdit: 'button(v-on:click="save(1, 2)") -- Go',
    },
  ];

  const compose = (language: Language, lines: string[]): string => (
    `${language.root}\n${lines.map((line) => `  ${line}`).join('\n')}\n`
  );

  withProject((cwd) => {
    setupReact(cwd);
    for (const language of LANGUAGES) {
      fs.mkdirSync(path.join(cwd, path.dirname(language.rel)), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, language.rel),
        compose(language, [language.silent, language.heading, language.handler]),
      );
    }
    commit(cwd);
    const profile = capabilityProfileForProject(cwd, EXISTING_REACT);
    const baseline = captureArchitectureBaseline(cwd, profile);
    assert.equal(baseline.kind, 'git-head', 'fixture guard: hunk evidence needs a git baseline');

    for (const language of LANGUAGES) {
      const base = compose(language, [language.silent, language.heading, language.handler]);
      const rows: Array<[string, string, UiImpact]> = [
        ['a node added', compose(language, [language.silent, language.heading, language.added, language.handler]), 'visual'],
        ['a node re-nested', compose(language, [language.silent, language.heading, `  ${language.handler}`]), 'visual'],
        ['the heading retitled', compose(language, [language.silent, language.heading.replace('Invoices', 'Revenue'), language.handler]), 'visual'],
        ['a comment reworded', compose(language, [language.silentEdit, language.heading, language.handler]), 'behavioral'],
        ['a handler rewritten', compose(language, [language.silent, language.heading, language.handlerEdit]), 'behavioral'],
      ];
      for (const [label, edited, expected] of rows) {
        assert.doesNotMatch(
          edited,
          /onClick|navigate|className|\brouter\b/,
          `fixture guard: ${language.rel} must hold none of the tokens the deleted arms read, or it proves nothing`,
        );
        assert.notEqual(edited, base, `fixture guard: ${language.rel} "${label}" must actually edit the file`);
        fs.writeFileSync(path.join(cwd, language.rel), edited);
        assert.equal(
          deriveUiImpact(cwd, profile, [language.rel], baseline).impact,
          expected,
          `${language.rel}: ${label}`,
        );
        fs.writeFileSync(path.join(cwd, language.rel), base);
      }
    }

    // Marko's concise mode carries the component's JavaScript in a top-level
    // brace block, and its body is script rather than markup. Without the skip
    // every state tweak in a Marko component would buy a screenshot sweep, which
    // is not what the `.tsx` beside it pays for the same edit.
    const marko = 'app/components/stateful.marko';
    const MARKO_JS = [
      'class {',
      '  onCreate() {',
      '    this.state = { count: COUNT };',
      '  }',
      '}',
      'div.counter',
      '  h1 -- Invoices',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(cwd, marko), MARKO_JS.replace('COUNT', '0'));
    // Handlers are stripped from the NODE, never from the whole line, and this
    // is the row that holds them there: `@support =` inside rendered copy is
    // handler-SHAPED, so a line-wide strip would delete it from both sides and
    // read a real copy change as no change at all — the silent direction.
    const prose = 'app/views/contact.pug';
    const PROSE_BASE = 'main\n  p Email @support = COPY\n';
    fs.writeFileSync(path.join(cwd, prose), PROSE_BASE.replace('COPY', 'fastest'));
    // All five accept inline HTML, and those lines stay the tag walk's, which
    // knows how to take a handler out of a tag. Claiming them for the line pass
    // would hand it an unparsed `<button …>` it has no node pattern for, so the
    // whole tag would land in the text and a handler-only edit would read as
    // structural — in Pug with Alpine, the commonest way to write one.
    const inline = 'app/views/alpine.pug';
    const INLINE_BASE = 'main\n  <button @click="save(ARGS)">Go</button>\n';
    fs.writeFileSync(path.join(cwd, inline), INLINE_BASE.replace('ARGS', '1'));
    commit(cwd);
    const withMarko = captureArchitectureBaseline(cwd, profile);
    assert.equal(withMarko.kind, 'git-head', 'fixture guard: the second baseline must carry hunk bodies too');
    for (const [label, edited, expected] of [
      ['a state literal changed', MARKO_JS.replace('COUNT', '1'), 'behavioral'],
      ['a node added below the block', `${MARKO_JS.replace('COUNT', '0').trimEnd()}\n  p -- Totals\n`, 'visual'],
    ] as Array<[string, string, UiImpact]>) {
      fs.writeFileSync(path.join(cwd, marko), edited);
      assert.equal(
        deriveUiImpact(cwd, profile, [marko], withMarko).impact,
        expected,
        `${marko}: ${label}`,
      );
    }

    fs.writeFileSync(path.join(cwd, prose), PROSE_BASE.replace('COPY', 'slowest'));
    assert.equal(
      deriveUiImpact(cwd, profile, [prose], withMarko).impact,
      'visual',
      `${prose}: rendered copy that merely LOOKS like a handler is still rendered copy`,
    );

    fs.writeFileSync(path.join(cwd, inline), INLINE_BASE.replace('ARGS', '1, 2'));
    assert.equal(
      deriveUiImpact(cwd, profile, [inline], withMarko).impact,
      'behavioral',
      `${inline}: an inline-HTML line is the tag walk's, so its handler is still stripped`,
    );
  });
});

// Svelte 5 runes are compiler KEYWORDS, not functions: they cannot be imported,
// assigned or passed, and the compiler accepts them in exactly three file types,
// refusing them anywhere else with `rune_outside_svelte` ("the %rune% rune is
// only available inside .svelte and .svelte.js/ts files"). `.svelte` is already
// MARKUP_RE's, which left the module extensions — the place a SvelteKit app puts
// shared client state — classified `nonvisual` through all three of the lanes
// that narrowed this file. So `$state(` in the code projection of a
// `.svelte.js`/`.svelte.ts` module is a declaration in the same sense as
// `defineComponent(`, and the extension is the bound BECAUSE a rune elsewhere is
// not a rune: AngularJS spells its ui-router service `$state` too.
test('a Svelte rune is a declaration, and only where the compiler allows one', () => {
  const SVELTE = {
    mode: 'existing-codebase', stack: 'custom-frontend', frontend: 'svelte', backend: 'none', mobile: { framework: 'none' },
  };
  const ROWS: Array<[string, string, string, UiImpact, string]> = [
    [
      'src/lib/cart.svelte.ts',
      'export const cart = { items: 0 };\n',
      'let items = $state(0);\nexport const cart = { get items() { return items; } };\n',
      'behavioral',
      '$state declares client state',
    ],
    [
      'src/lib/prefs.svelte.js',
      'export const prefs = {};\n',
      'let dense = $state(false);\nexport const wide = $derived.by(() => !dense);\n',
      'behavioral',
      '$derived.by is a rune member, and .svelte.js is a rune module too',
    ],
    [
      'src/lib/timer.svelte.ts',
      'export const tick = 0;\n',
      'let tick = $state(0);\nexport const bump = () => { $effect.pre(() => { tick += 1; }); };\n',
      'behavioral',
      '$effect.pre is a rune member',
    ],
    [
      'src/lib/box.svelte.ts',
      'export const box = {};\n',
      'export const box = $state.raw({ open: false });\n',
      'behavioral',
      '$state.raw is a rune member',
    ],
    // The three ways this must NOT answer, each removing exactly one leg of the
    // evidence while keeping the other two.
    [
      'src/lib/quiet.svelte.ts',
      'export const parse = (s: string) => s.trim();\n',
      'export const parse = (s: string) => s.trimEnd();\n',
      'nonvisual',
      'a rune-legal extension declaring no rune is not evidence',
    ],
    [
      'src/lib/notes.ts',
      'export const notes: number[] = [];\n',
      'const count = $state(0);\nexport const notes = [count];\n',
      'nonvisual',
      'the same bytes one extension away are a compile error, not client state',
    ],
    [
      'src/lib/ng-legacy.ts',
      'export const go = () => undefined;\n',
      "export const go = ($state: { go(p: string): void }) => $state.go('/pay');\n",
      'nonvisual',
      "AngularJS' own $state service is why the bound is the extension",
    ],
    [
      'src/lib/prose.svelte.ts',
      'export const HINT = "";\n',
      '// Port this to $state(0) when the store goes.\nexport const HINT = "call $state(0) here";\n',
      'nonvisual',
      'a rune named in a comment and a string is not a declaration',
    ],
    // Placement. The arm is a disjunct of the BEHAVIOR branch, not of MARKUP_RE's
    // changed-hunk block, and this row is the difference: in that block
    // `changedCodeIsVisual` matches the word `width` and buys a three-viewport
    // sweep for a module that has no template at all.
    [
      'src/lib/viewport.svelte.ts',
      'export const viewport = {};\n',
      'let width = $state(0);\nexport const viewport = { get width() { return width; } };\n',
      'behavioral',
      'a state module declares no markup, so it never reaches visual on its own',
    ],
    // And the arms ABOVE it still answer first: adding a disjunct to the last arm
    // cannot shadow one that would have said `visual`. The vehicle used to be the
    // path NAME — `lib/theme/…` was claimed by the visual arm at the top of the
    // chain — and it is a declared custom element now, because that name arm is
    // gone: a rune module under `theme/` is a state module like any other and no
    // longer buys a screenshot sweep for its spelling. Same shadowing claim, on
    // evidence from inside the file.
    [
      'src/lib/theme/scale.svelte.ts',
      'export const scale = 1;\n',
      "let width = $state(0);\ncustomElements.define('x-scale', class extends HTMLElement {});\n",
      'visual',
      'a declared custom element is claimed by the component arm above the rune arm',
    ],
  ];

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'src/lib/theme'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { svelte: '5.0.0', vite: '7.0.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'index.html'), '<div id="app"></div>\n');
    fs.writeFileSync(path.join(cwd, 'src/App.svelte'), '<main><h1>Hi</h1></main>\n');
    for (const [rel, before] of ROWS) {
      fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), before);
    }
    commit(cwd);
    const profile = capabilityProfileForProject(cwd, SVELTE);
    assert.equal(profile.profileId, 'svelte', 'fixture guard: a first-class Svelte profile');
    const baseline = captureArchitectureBaseline(cwd, profile);
    assert.equal(baseline.kind, 'git-head', 'fixture guard: hunk evidence needs a git baseline');

    for (const [rel, before, edited, expected, why] of ROWS) {
      assert.ok(
        !profile.entrypoints.includes(rel),
        `fixture guard: ${rel} must not be a declared entrypoint, or the entrypoint arm answers instead`,
      );
      fs.writeFileSync(path.join(cwd, rel), edited);
      assert.equal(
        deriveUiImpact(cwd, profile, [rel], baseline).impact,
        expected,
        `${rel}: ${why}`,
      );
      fs.writeFileSync(path.join(cwd, rel), before);
    }
  });
});

// A token in a comment, a message or a pattern is not a call. Left unprojected
// the content probes answer on PROSE, and this file's own history is the proof:
// explaining the component decorator in a comment made `impact.ts` classify
// itself `visual`, its own copy of the behavior tokens made it `behavioral`, and
// the workaround was to reword the comment. Measured over this repo's 868 tracked
// JS/TS paths, the behavior probe claimed 44 raw and 15 as code — 29 files, two
// thirds of every match, were claimed by prose alone.
test('a mention is not a call: the content probes read code, not comments', () => {
  const PROSE = [
    '// Sends the invoice. Callers used to navigate away here and the router lost',
    '// the pending state, so the onClick handler now awaits the response first.',
    '/** @see docs/architecture/router.md — and Angular spells this @Component({…}) */',
    "export const RECEIPT_HINT = 'call navigate() after createBrowserRouter is ready';",
    'export const ROUTER_PREFIX = /^\\/router\\//;',
    'export const CLICK_ATTR = /\\bonClick\\b/;',
    // A leading slash written as a class rather than escaped: the scan has to
    // know `/` inside `[…]` is not the terminator, or it ends the literal early
    // and leaves the rest of the pattern behind as code.
    'export const NAV_SEGMENT = /^[/](?:router|navigate)$/;',
    'export const send = (id: string) => fetch(`/api/invoices/${id}`, { method: \'POST\' });',
  ].join('\n');

  withProject((cwd) => {
    setupReact(cwd);
    const profile = capabilityProfileForProject(cwd, EXISTING_REACT);
    const rel = 'apps/web/src/lib/invoice-send.ts';
    fs.writeFileSync(path.join(cwd, rel), `${PROSE}\n`);
    assert.equal(
      deriveUiImpact(cwd, profile, [rel]).impact,
      'nonvisual',
      'a comment, a message and two patterns naming the tokens are not a browser call',
    );

    // Each fixture guard below re-adds ONE real use of the same token and must
    // flip the answer, so the assertion above cannot pass by matching nothing.
    for (const [label, addition, expected] of [
      ['a call', "export const go = () => navigate('/pay');", 'behavioral'],
      ['a handler binding', 'export const form = { onSubmit: () => undefined };', 'behavioral'],
      // A template SUBSTITUTION is code: dropping the literal text must not drop
      // the expressions inside it.
      ['a template substitution', 'export const to = (p: string) => `${navigate(p)}`;', 'behavioral'],
      // The regex scan has to stop at the literal's own closing slash, escapes
      // included, or it eats the code after it.
      ['a call after a pattern', 'const RE = /^\\/v1\\//; export const g = () => RE && navigate("/v1/x");', 'behavioral'],
      // And a `/` that DIVIDES must not be read as one: mistaking this one for a
      // pattern strips forward to the slash in `"/"` and swallows the call.
      ['a call after a division', 'export const back = (n: number) => n / 2 < 1 && navigate("/");', 'behavioral'],
      ['a component declaration', "@Component({ template: '<h1>hi</h1>' }) export class H {}", 'visual'],
    ] as Array<[string, string, UiImpact]>) {
      fs.writeFileSync(path.join(cwd, rel), `${PROSE}\n${addition}\n`);
      assert.equal(
        deriveUiImpact(cwd, profile, [rel]).impact,
        expected,
        `fixture guard: ${label} is real evidence and must still be recognized`,
      );
    }

    // A self-closing JSX tag in a `.js` file — MARKUP_RE lists `.jsx` and not
    // `.js`, so Babel-style JSX does reach here. Its `/>` sits exactly where a
    // pattern may start, and only the two bounds on that scan stop it from being
    // read as one and swallowing the call below: end-of-line, and a closing slash
    // whose flags do not run into an identifier. Either alone rejects this input,
    // so this row pins the PAIR — removing both lowers it to `nonvisual`.
    const babel = 'apps/web/src/lib/row.js';
    fs.writeFileSync(path.join(cwd, babel), [
      'export const Row = ({ id }) => <img src={id} />;',
      "export const open = (id) => navigate(`/invoices/${id}`);",
      '',
    ].join('\n'));
    assert.equal(
      deriveUiImpact(cwd, profile, [babel]).impact,
      'behavioral',
      'a pattern scan must stop at the end of its line, not eat the code after it',
    );
  });

  // The demonstrated defect, on the file that demonstrated it: a classifier whose
  // verdict depends on how its own comments are phrased is not measuring code.
  // `impact.ts` describes the component decorator and carries the behavior tokens
  // in a regex literal; against a web profile it must still be `nonvisual`.
  withProject((cwd) => {
    setupReact(cwd);
    const profile = capabilityProfileForProject(cwd, EXISTING_REACT);
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    for (const rel of [
      'src/shared/verification-contract/impact.ts',
      'src/shared/__tests__/verification-contract.test.ts',
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.match(
        source,
        /@Component\s*\(|\bnavigate\b/,
        `fixture guard: ${rel} must still MENTION the tokens, or it proves nothing`,
      );
      const local = 'apps/web/src/lib/classifier.ts';
      fs.writeFileSync(path.join(cwd, local), source);
      assert.equal(
        deriveUiImpact(cwd, profile, [local]).impact,
        'nonvisual',
        `${rel} classifies itself on its own prose`,
      );
    }
  });
});

// The last NAME arm in the scan, and it sat in the most expensive position:
// FIRST in the chain and straight to `visual`, so a match bought the
// three-viewport sweep with no changed-hunk discrimination underneath it. Its
// alternation ended `(?:\/|[.-])`, which claims filename PREFIXES as readily as
// directories, and it was asked of every language. Measured over this repo's own
// 1323 tracked paths it claimed 27 — every `visual` verdict the corpus produced
// — and not one was a stylesheet, an image or a design token: 24 were the token
// ACCOUNTING code (everything under `runners/token-report`, `token-logger.ts`,
// `override/token.ts`) and 3 were documentation, one of them a `SKILL.md` whose
// only offence was living under `token-usage-report/`. All 27 moved down and
// none up.
//
// The rows below are in two halves and both are load-bearing. The declined half
// is the lowering; the retained half is what stops it being vacuous, because a
// classifier that had simply stopped answering would pass the first half alone.
test('a visual-sounding path name is not evidence; the visual arms read the file itself', () => {
  const DECLINED: Array<[string, string, string]> = [
    [
      'src/runners/token-report/aggregate.ts',
      'export const total = (rows: number[]): number => rows.reduce((a, b) => a + b, 0);\n',
      'token ACCOUNTING: `token` before a `-`, the largest victim class in this repo',
    ],
    [
      'src/shared/token-logger.ts',
      'export const log = (used: number): string => `used ${used}`;\n',
      'a logger, claimed by the same prefix',
    ],
    [
      'src/shared/override/token.ts',
      'export const parse = (raw: string): string => raw.trim();\n',
      '`token` before a `.` — a FILENAME, which the trailing `[.-]` claimed too',
    ],
    [
      'docs/frontend/styles.md',
      '# Styling\n\nUse the design system for spacing and colour.\n',
      'documentation ABOUT styling is not styling, and prose cannot be screenshotted',
    ],
    [
      'docs/token-usage-report/GUIDE.md',
      '# Token usage\n\nHow to read the per-run cost report.\n',
      'a directory segment read as a design token',
    ],
    [
      'internal/layout-engine.go',
      'package internal\n\nfunc Paginate(n int) int { return n }\n',
      'a backend package no browser can load: the arm was never bounded by language',
    ],
  ];

  // The same five words as evidence rather than as spelling. If the visual arms
  // ever stop answering, these move and the half above stops meaning anything.
  const RETAINED: Array<[string, string, string]> = [
    ['src/styles/theme.css', 'body { color: black; }\n', 'a stylesheet, by EXTENSION'],
    [
      'tailwind.config.ts',
      'export default { content: [] };\n',
      'the utility-CSS config, by exact FILENAME',
    ],
    [
      'src/layout/Header.tsx',
      'export const Header = () => <header>Traffic One</header>;\n',
      'a layout COMPONENT, by an extension that means markup',
    ],
  ];

  withProject((cwd) => {
    setupReact(cwd);
    const profile = capabilityProfileForProject(cwd, EXISTING_REACT);
    for (const [rel, body] of [...DECLINED, ...RETAINED]) {
      fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), body);
    }

    for (const [rel, body, why] of DECLINED) {
      assert.match(
        rel,
        /(?:^|\/)(?:styles?|theme|tokens?|assets?|layout)(?:\/|[.-])/i,
        `fixture guard: ${rel} must still MATCH the deleted arm, or it proves nothing`,
      );
      assert.doesNotMatch(
        body,
        /onClick|onSubmit|navigate|\brouter\b|@Component|defineComponent|customElements/,
        `fixture guard: ${rel} must hold none of the tokens the surviving probes read`,
      );
      assert.equal(
        deriveUiImpact(cwd, profile, [rel]).impact,
        'nonvisual',
        `${rel}: ${why}`,
      );
    }

    for (const [rel, , why] of RETAINED) {
      assert.equal(
        deriveUiImpact(cwd, profile, [rel]).impact,
        'visual',
        `${rel}: ${why} — intrinsic evidence still answers`,
      );
    }

    // The name survives in exactly ONE place, and this is the reason it is not
    // the same call: a scaffold output is a path the plan has not created yet,
    // so there are no bytes to read and no intrinsic answer to prefer. The pair
    // below is the whole distinction — the identical path is `visual` as a
    // PLANNED output and `nonvisual` as a CHANGED one.
    const planned = 'src/theme/tokens.ts';
    const architecture = compileArchitecture(cwd, 'R', EXISTING_REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });
    assert.equal(
      plannedUiImpactFloor(cwd, {
        ...architecture,
        modules: [],
        scaffoldOutputs: [{ path: planned, ownerRole: 'senior-frontend', kind: 'scaffold' }],
      }),
      'visual',
      `${planned}: unwritten, so its declared name is the only evidence there is`,
    );
    fs.mkdirSync(path.join(cwd, 'src/theme'), { recursive: true });
    fs.writeFileSync(path.join(cwd, planned), 'export const spacing = 8;\n');
    assert.equal(
      deriveUiImpact(cwd, profile, [planned]).impact,
      'nonvisual',
      `${planned}: once it exists the file itself is the evidence, and it holds none`,
    );
  });
});

// The complement of the test above, and the two are a pair: that one pins that a
// visual-SOUNDING name buys nothing, this one pins the single class readmitted
// after it and the bounds that keep it from growing back into the name arm.
//
// Every row below holds BYTE-IDENTICAL content, so the only thing any assertion
// can be answering is the path. The pairs are the point — each declined row is
// its raised row moved by exactly one bound.
test('CSS-in-JS under a presentational directory is visual, and each bound is load-bearing', () => {
  const TOKENS = 'export const tokens = { color: { brand: "#0af" }, space: { md: 8 } };\n';

  const RAISED: Array<[string, string]> = [
    ['apps/web/src/theme/tokens.ts', 'design tokens: no markup, no handler, nothing intrinsic to read'],
    ['apps/web/src/styles/colors.ts', 'a `styles/` module the CSS extension arm cannot see'],
    ['apps/web/src/assets/index.ts', 'an asset barrel: which images render is a visual fact'],
  ];

  const DECLINED: Array<[string, string]> = [
    [
      'packages/cli/src/theme/tokens.ts',
      'the sourceRoots bound: identical bytes, identical directory name, terminal theming',
    ],
    [
      'apps/web/src/token-report/aggregate.ts',
      'the anchor bound: `token-report` is not `tokens/`, and this is the 24-path victim class',
    ],
    [
      'apps/web/src/token-logger.ts',
      'the anchor bound again, filename form — what the deleted arm claimed via `[.-]`',
    ],
    [
      'apps/web/src/theme/README.md',
      'the webModule bound: prose ABOUT the tokens is not the tokens, and no browser loads it',
    ],
  ];

  withProject((cwd) => {
    setupReact(cwd);
    const profile = capabilityProfileForProject(cwd, EXISTING_REACT);
    // Fixture guard: if the profile ever stops declaring this root, the
    // sourceRoots bound disarms and every RAISED row would fail rather than
    // pass for the wrong reason — but the declined CLI row would pass
    // vacuously, so the pair is only meaningful while this holds.
    assert.deepEqual(
      profile.sourceRoots,
      ['apps/web/src'],
      'fixture guard: the web root the bound is asked about',
    );

    for (const [rel] of [...RAISED, ...DECLINED]) {
      fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), TOKENS);
    }

    for (const [rel, why] of RAISED) {
      assert.equal(deriveUiImpact(cwd, profile, [rel]).impact, 'visual', `${rel}: ${why}`);
    }
    for (const [rel, why] of DECLINED) {
      assert.equal(deriveUiImpact(cwd, profile, [rel]).impact, 'nonvisual', `${rel}: ${why}`);
    }
  });
});

test('Astro template edits are visual impact and require the visual QA contract', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'packages/marketing/src/pages'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'packages/marketing/package.json'), JSON.stringify({
      dependencies: { astro: '5.0.0' },
    }));
    const page = 'packages/marketing/src/pages/index.astro';
    fs.writeFileSync(path.join(cwd, page), '<main class="hero">Traffic One</main>\n');
    const state = {
      mode: 'existing-codebase',
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { framework: 'none' },
    };
    const profile = capabilityProfileForProject(cwd, state);
    assert.equal(profile.profileId, 'astro');
    assert.equal(deriveUiImpact(cwd, profile, [page]).impact, 'visual');

    const architecture = compileArchitecture(cwd, 'ASTRO', state, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    });
    const verification = compileVerificationContract(cwd, 'ASTRO', state, architecture, {
      changedPaths: [page],
    });
    assert.equal(verification.uiImpact, 'visual');
    assert.equal(verification.browserRequired, true);
    assert.deepEqual(verification.requiredScreenshotWidths, [390, 1440]);
  });
});

test('agent-raised impact cannot cross the runtime capability surface', () => {
  withProject((cwd) => {
    setupReact(cwd);
    const web = compileArchitecture(cwd, 'WEB', EXISTING_REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });
    assert.throws(
      () => compileVerificationContract(cwd, 'WEB', EXISTING_REACT, web, {
        changedPaths: [],
        agentRaisedImpact: 'native-ui',
      }),
      /invalid for a web-ui profile/,
    );

    fs.rmSync(path.join(cwd, 'apps'), { recursive: true, force: true });
    fs.rmSync(path.join(cwd, 'package.json'), { force: true });
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.test/api\n');
    const backendState = {
      mode: 'existing-codebase',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
    };
    const backend = compileArchitecture(cwd, 'API', backendState, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'health-service', name: 'Health', kind: 'service' }],
    });
    assert.throws(
      () => compileVerificationContract(cwd, 'API', backendState, backend, {
        changedPaths: [],
        agentRaisedImpact: 'visual',
      }),
      /without a UI surface/,
    );
  });
});

test('Git baseline hunks classify handler-only TSX as behavioral and markup changes as visual', () => {
  withProject((cwd) => {
    setupReact(cwd);
    const page = path.join(cwd, 'apps/web/src/pages/Home.tsx');
    fs.writeFileSync(page, [
      'export function Home() {',
      '  const [open, setOpen] = useState(false);',
      '  return <button onClick={() => setOpen(true)}>Open</button>;',
      '}',
      '',
    ].join('\n'));
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'qa@example.test'], { cwd });
    execFileSync('git', ['config', 'user.name', 'QA Test'], { cwd });
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });

    const architecture = compileArchitecture(cwd, 'R', EXISTING_REACT, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    });
    fs.writeFileSync(page, [
      'export function Home() {',
      '  const [open, setOpen] = useState(false);',
      '  return <button onClick={() => { track("analytics"); setOpen(!open); }}>Open</button>;',
      '}',
      '',
    ].join('\n'));
    const behavioral = compileVerificationContract(cwd, 'R', EXISTING_REACT, architecture, {
      changedPaths: ['apps/web/src/pages/Home.tsx'],
    });
    assert.equal(behavioral.uiImpact, 'behavioral');
    assert.equal(behavioral.uiImpactReason, undefined);
    assert.deepEqual(behavioral.requiredScreenshotWidths, []);

    fs.writeFileSync(page, [
      'export function Home() {',
      '  const [open, setOpen] = useState(false);',
      '  return <button className="primary wide" onClick={() => { track("analytics"); setOpen(!open); }}>Open account</button>;',
      '}',
      '',
    ].join('\n'));
    const visual = compileVerificationContract(cwd, 'R2', EXISTING_REACT, {
      ...architecture,
      runId: 'R2',
    }, {
      changedPaths: ['apps/web/src/pages/Home.tsx'],
    });
    assert.equal(visual.uiImpact, 'visual');
    assert.deepEqual(visual.requiredScreenshotWidths, [390, 1440]);
    assert.equal(visual.performance.required, false);
    assert.equal(visual.performance.explicitThresholds?.seoMin, undefined);
  });
});

test('IMPLEMENTED refresh raises a pre-implementation contract from the real baseline diff without hash churn', () => {
  withProject((cwd) => {
    setupReact(cwd);
    const page = path.join(cwd, 'apps/web/src/pages/Home.tsx');
    fs.writeFileSync(page, 'export function Home() { return <main>Home</main>; }\n');
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'qa@example.test'], { cwd });
    execFileSync('git', ['config', 'user.name', 'QA Test'], { cwd });
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });

    const architecture = compileArchitecture(cwd, 'R', EXISTING_REACT, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    });
    const planned = compileVerificationContract(cwd, 'R', EXISTING_REACT, architecture);
    assert.equal(planned.uiImpact, 'nonvisual');
    assert.equal(planned.browserRequired, false);

    fs.writeFileSync(
      page,
      'export function Home() { return <main className="wide">Updated home</main>; }\n',
    );
    const refreshed = compileVerificationContract(cwd, 'R', EXISTING_REACT, architecture);
    assert.equal(refreshed.uiImpact, 'visual');
    assert.equal(refreshed.browserRequired, true);
    assert.deepEqual(refreshed.requiredScreenshotWidths, [390, 1440]);
    assert.notEqual(refreshed.contractHash, planned.contractHash);

    const retried = compileVerificationContract(cwd, 'R', EXISTING_REACT, architecture);
    assert.equal(retried.contractHash, refreshed.contractHash);
    assert.equal(retried.generatedAt, refreshed.generatedAt);
  });
});

test('Git baseline verification includes deletions and rejects an unplanned deleted path', () => {
  withProject((cwd) => {
    setupReact(cwd);
    fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
    const deletedPath = path.join(cwd, 'docs', 'legacy.md');
    fs.writeFileSync(deletedPath, 'legacy contract\n');
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'qa@example.test'], { cwd });
    execFileSync('git', ['config', 'user.name', 'QA Test'], { cwd });
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });

    const architecture = compileArchitecture(cwd, 'R', EXISTING_REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });
    const contract = compileVerificationContract(cwd, 'R', EXISTING_REACT, architecture, {
      changedPaths: ['apps/web/src/lib/Mapping.ts'],
    });
    fs.rmSync(deletedPath);

    const current = currentVerificationSourceHash(cwd, contract);
    assert.equal(current.complete, false);
    assert.match(current.reason || '', /outside verification contract.*docs\/legacy\.md/);
  });
});

test('missing hunk bodies conservatively classify markup-capable edits as visual with a reason', () => {
  withProject((cwd) => {
    setupReact(cwd);
    fs.writeFileSync(
      path.join(cwd, 'apps/web/src/pages/Home.tsx'),
      'export function Home(){ const handle=()=>track(); return <button onClick={handle}>Open</button> }\n',
    );
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    });
    const contract = compileVerificationContract(cwd, 'R', REACT, architecture, {
      changedPaths: ['apps/web/src/pages/Home.tsx'],
    });
    assert.equal(contract.uiImpact, 'visual');
    assert.match(contract.uiImpactReason || '', /diff evidence was unavailable.*file-manifest/i);
  });
});

test('a compiled page missing from the immutable baseline is mechanically a new visual page', () => {
  withProject((cwd) => {
    setupReact(cwd);
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    });
    const contract = compileVerificationContract(cwd, 'R', REACT, architecture, {
      changedPaths: [],
    });
    assert.equal(contract.uiImpact, 'visual');
    assert.deepEqual(contract.changedRoutes, ['/']);
    assert.deepEqual(contract.requiredScreenshotWidths, [390, 1440]);
    // A UI change is a reason to MEASURE page speed, not to block a run against
    // a budget nobody declared (10co died on FCP 1.65s vs a 1.5s default while
    // scoring Performance 99). Advisory keeps the audit and drops the veto.
    assert.equal(contract.performance.required, false);
    assert.equal(contract.performance.advisory, true);
    assert.equal(contract.performance.reason, 'visual-risk');
    assert.equal(contract.performance.explicitThresholds?.seoMin, undefined);
  });
});

test('visual screenshots require 390/1440 and add 768 only for detected tablet risk', () => {
  withProject((cwd) => {
    setupReact(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Home.tsx'), 'export const Home = () => <main />;\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/styles.css'), '@media (min-width: 768px) { main { display:grid } }\n');
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    });
    const defaultVisual = compileVerificationContract(cwd, 'R', REACT, architecture, {
      changedPaths: ['apps/web/src/pages/Home.tsx'],
    });
    assert.deepEqual(defaultVisual.requiredScreenshotWidths, [390, 1440]);
    const tablet = compileVerificationContract(cwd, 'R2', REACT, {
      ...architecture,
      runId: 'R2',
    }, {
      changedPaths: ['apps/web/src/pages/Home.tsx', 'apps/web/src/styles.css'],
    });
    assert.deepEqual(tablet.requiredScreenshotWidths, [390, 768, 1440]);
  });
});

test('global visual changes cover every compiled route and advisory performance risk requires Lighthouse', () => {
  withProject((cwd) => {
    setupReact(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/styles.css'), 'body { color: black; }\n');
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [
        { id: 'home-route', path: '/', moduleId: 'home' },
        { id: 'news-route', path: '/news', moduleId: 'news' },
      ],
      modules: [
        { id: 'home', name: 'Home', kind: 'page' },
        { id: 'news', name: 'News', kind: 'page' },
      ],
    });
    const contract = compileVerificationContract(cwd, 'R', REACT, architecture, {
      changedPaths: ['apps/web/src/styles.css'],
      advisoryLighthouse: { performanceMin: 90 },
    });
    assert.deepEqual(contract.changedRoutes, ['/', '/news']);
    assert.equal(contract.performance.required, false);
    assert.equal(contract.performance.advisory, true);
    assert.equal(contract.performance.reason, 'visual-risk');
  });
});

test('Tailwind breakpoints and shared component edits are visual and cover every dependent route conservatively', () => {
  withProject((cwd) => {
    setupReact(cwd);
    fs.writeFileSync(
      path.join(cwd, 'tailwind.config.ts'),
      "export default { theme: { screens: { md: '768px' } } };\n",
    );
    fs.writeFileSync(
      path.join(cwd, 'apps/web/src/components/Nav.tsx'),
      'export function Nav(){ return <nav className="wide">Nav</nav>; }\n',
    );
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [
        { id: 'home-route', path: '/', moduleId: 'home' },
        { id: 'news-route', path: '/news', moduleId: 'news' },
      ],
      modules: [
        { id: 'home', name: 'Home', kind: 'page' },
        { id: 'news', name: 'News', kind: 'page' },
        { id: 'nav', name: 'Nav', kind: 'component' },
      ],
    });
    const contract = compileVerificationContract(cwd, 'R', REACT, architecture, {
      changedPaths: [
        'tailwind.config.ts',
        'apps/web/src/components/Nav.tsx',
      ],
    });
    assert.equal(contract.uiImpact, 'visual');
    assert.equal(contract.tabletRisk, true);
    assert.deepEqual(contract.requiredScreenshotWidths, [390, 768, 1440]);
    assert.deepEqual(contract.changedRoutes, ['/', '/news']);
    assert.equal(contract.performance.required, false);
    assert.equal(contract.performance.advisory, true);
    assert.equal(contract.performance.reason, 'visual-risk');
  });
});

test('native Swift/Kotlin profiles choose emulator QA and never Playwright', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'Package.swift'), '// swift-tools-version:6.2\n');
    const architecture = compileArchitecture(cwd, 'R', {
      stack: 'custom-frontend', frontend: 'none', backend: 'none', mobile: { framework: 'swift-native' },
    }, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'home-screen', name: 'Home Screen', kind: 'page' }],
    });
    const contract = compileVerificationContract(cwd, 'R', {}, architecture, { changedPaths: ['Features/HomeView.swift'] });
    assert.equal(contract.uiImpact, 'native-ui');
    assert.equal(contract.browserRequired, false);
    assert.equal(contract.nativeAdapter, 'xcode-simulator');
  });
});

test('backend and native profiles never compile Lighthouse requirements', () => {
  const fixtures = [
    {
      marker: ['go.mod', 'module example.test/api\n'],
      state: {
        stack: 'custom-backend', frontend: 'none', backend: 'go', mobile: { framework: 'none' },
      },
      module: { id: 'health-service', name: 'Health Service', kind: 'service' as const },
      changedPath: 'internal/health.go',
    },
    {
      marker: ['pyproject.toml', '[project]\nname="worker"\nversion="0.1.0"\n'],
      state: {
        stack: 'custom-backend', frontend: 'none', backend: 'python', mobile: { framework: 'none' },
      },
      module: { id: 'worker-service', name: 'Worker Service', kind: 'service' as const },
      changedPath: 'src/worker.py',
    },
    {
      marker: ['Package.swift', '// swift-tools-version:6.2\n'],
      state: {
        stack: 'custom-frontend', frontend: 'none', backend: 'none', mobile: { framework: 'swift-native' },
      },
      module: { id: 'home-screen', name: 'Home Screen', kind: 'page' as const },
      changedPath: 'Features/HomeView.swift',
    },
  ];
  for (const fixture of fixtures) {
    withProject((cwd) => {
      fs.writeFileSync(path.join(cwd, fixture.marker[0]!), fixture.marker[1]!);
      const architecture = compileArchitecture(cwd, 'R', fixture.state, {
        schemaVersion: 1,
        routes: [],
        modules: [fixture.module],
      });
      assert.throws(() => compileVerificationContract(cwd, 'R', fixture.state, architecture, {
        changedPaths: [fixture.changedPath],
        explicitLighthouse: { performanceMin: 90 },
      }), /Lighthouse options require a web-ui/);
      const nativePerformance = compileVerificationContract(cwd, 'R2', fixture.state, {
        ...architecture,
        runId: 'R2',
      }, {
        changedPaths: [fixture.changedPath],
        performanceRisk: true,
      });
      assert.equal(nativePerformance.performance.required, false);
      assert.equal(nativePerformance.performance.reason, 'not-required');
      assert.ok(nativePerformance.requiredChecks.includes('stack-performance'));
    });
  }
});

test('non-Git changed-path comparison uses the same whole-project scope as its baseline', () => {
  withProject((cwd) => {
    setupReact(cwd);
    fs.mkdirSync(path.join(cwd, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'tests/smoke.test.ts'), 'export {};\n');
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });

    assert.deepEqual(changedPathsFromBaseline(cwd, architecture), {
      paths: [],
      complete: true,
    });

    fs.writeFileSync(path.join(cwd, 'tests/new.test.ts'), 'export const added = true;\n');
    fs.writeFileSync(path.join(cwd, 'project.config.json'), '{}\n');
    const changed = changedPathsFromBaseline(cwd, architecture);
    assert.equal(changed.complete, true);
    assert.deepEqual(changed.paths, ['project.config.json', 'tests/new.test.ts']);
  });
});

test('derived artifacts (lockfiles, test-results, tsbuildinfo) never appear as changed paths', () => {
  // 5co-codex regression: the format-parity gate demanded `prettier`,
  // `pnpm install` wrote pnpm-lock.yaml, and the verification refresh then
  // denied every IMPLEMENTED as "outside the frozen verification/WorkUnit
  // authority" — with the tester's test-results/ killing the QA manifest the
  // same way. Both sides (capture + compare) must skip these by construction.
  withProject((cwd) => {
    setupReact(cwd);
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });

    fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}\n');
    fs.mkdirSync(path.join(cwd, 'test-results'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'test-results/.last-run.json'), '{}\n');
    fs.mkdirSync(path.join(cwd, 'playwright-report'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'playwright-report/index.html'), '<html></html>\n');
    fs.writeFileSync(path.join(cwd, 'tsconfig.tsbuildinfo'), '{}\n');
    fs.writeFileSync(path.join(cwd, '.DS_Store'), '\n');
    // a real source change is still visible next to the ignored artifacts
    fs.writeFileSync(path.join(cwd, 'apps/web/src/lib/data.ts'), 'export const x = 1;\n');

    const changed = changedPathsFromBaseline(cwd, architecture);
    assert.equal(changed.complete, true);
    assert.deepEqual(changed.paths, ['apps/web/src/lib/data.ts']);
  });
});

test('non-Git verification diff and source hash fail closed on a new symbolic link', () => {
  withProject((cwd) => {
    setupReact(cwd);
    fs.mkdirSync(path.join(cwd, 'external-source'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'external-source/Evil.tsx'), 'export const Evil = () => <main />;\n');
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });
    const contract = compileVerificationContract(cwd, 'R', REACT, architecture, {
      changedPaths: [],
    });

    fs.symlinkSync(
      path.join(cwd, 'external-source'),
      path.join(cwd, 'apps/web/src/linked'),
      'dir',
    );
    const changed = changedPathsFromBaseline(cwd, architecture);
    assert.equal(changed.complete, false);
    assert.match(changed.reason || '', /symbolic link.*apps\/web\/src\/linked/i);

    const source = currentVerificationSourceHash(cwd, contract);
    assert.equal(source.complete, false);
    assert.match(source.reason || '', /symbolic link.*apps\/web\/src\/linked/i);
  });
});

test('Git verification diff fails closed on an untracked symbolic link', () => {
  withProject((cwd) => {
    setupReact(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Home.tsx'), 'export const Home = () => <main />;\n');
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });

    fs.symlinkSync(
      path.join(cwd, 'apps/web/src/pages'),
      path.join(cwd, 'apps/web/src/linked'),
      'dir',
    );
    const changed = changedPathsFromBaseline(cwd, architecture);
    assert.equal(changed.complete, false);
    assert.match(changed.reason || '', /symbolic link.*apps\/web\/src\/linked/i);
  });
});

test('the materialized CLAUDE.md → AGENTS.md alias never makes a verification scan incomplete', () => {
  // 1cu-cursor: the immutable baseline accepted this alias (materialization's
  // own output) while both verification scans failed closed on it, so the
  // architect's PLAN_READY was denied with STRUCT_SCAN_INCOMPLETE until the
  // parent hand-replaced the symlink with a copy.
  withProject((cwd) => {
    setupReact(cwd);
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Project agents\n');
    fs.symlinkSync('AGENTS.md', path.join(cwd, 'CLAUDE.md'));
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });
    const contract = compileVerificationContract(cwd, 'R', REACT, architecture, { changedPaths: [] });

    const changed = changedPathsFromBaseline(cwd, architecture);
    assert.equal(changed.complete, true, changed.reason);
    // identity-tracked, not content-hashed → not reported as a change
    assert.equal(changed.paths.includes('CLAUDE.md'), false);

    const source = currentVerificationSourceHash(cwd, contract);
    assert.equal(source.complete, true, source.reason);
  });

  // Git baseline path: the alias is an untracked entry in `ls-files --others`,
  // which is exactly where the segment inspection used to fail closed.
  withProject((cwd) => {
    setupReact(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Home.tsx'), 'export const Home = () => <main />;\n');
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Project agents\n');
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });

    fs.symlinkSync('AGENTS.md', path.join(cwd, 'CLAUDE.md'));
    const changed = changedPathsFromBaseline(cwd, architecture);
    assert.equal(changed.complete, true, changed.reason);
    assert.equal(changed.paths.includes('CLAUDE.md'), true);
  });

  // Only the canonical shape is exempt — a CLAUDE.md pointing anywhere else
  // still fails closed.
  withProject((cwd) => {
    setupReact(cwd);
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Project agents\n');
    fs.writeFileSync(path.join(cwd, 'OTHER.md'), '# Other\n');
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });
    fs.symlinkSync('OTHER.md', path.join(cwd, 'CLAUDE.md'));
    const changed = changedPathsFromBaseline(cwd, architecture);
    assert.equal(changed.complete, false);
    assert.match(changed.reason || '', /symbolic link.*CLAUDE\.md/i);
  });
});

test('runtime-maintained root context (AGENTS.md) never enters the contract identity or churns the source hash', () => {
  // 13cl: materialization re-appends root AGENTS.md/CLAUDE.md every session,
  // and the frozen verification authority then denied verdicts on the
  // runtime's own write ("AGENTS.md restored to baseline — the gitnexus hook
  // re-appends"). The raw scan still sees the file; the judgment ignores it.
  withProject((cwd) => {
    setupReact(cwd);
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Project agents\n');
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'qa@example.test'], { cwd });
    execFileSync('git', ['config', 'user.name', 'QA Test'], { cwd });
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });
    const architecture = compileArchitecture(cwd, 'R', EXISTING_REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });

    fs.appendFileSync(path.join(cwd, 'AGENTS.md'), '\n<!-- GENERATED BY traffic-one: project-local active rules -->\n');
    const changed = changedPathsFromBaseline(cwd, architecture);
    assert.equal(changed.complete, true, changed.reason);
    assert.ok(changed.paths.includes('AGENTS.md'), 'the raw baseline diff still reports the file');

    const contract = compileVerificationContract(cwd, 'R', EXISTING_REACT, architecture);
    assert.equal(contract.changedPaths.includes('AGENTS.md'), false,
      'runtime-maintained context must stay out of the contract identity');
    assert.equal(contract.observedChangedPaths?.includes('AGENTS.md'), false);
    const first = currentVerificationSourceHash(cwd, contract);
    assert.equal(first.complete, true, first.reason);

    // Another runtime re-append: no out-of-contract extra, no hash churn.
    fs.appendFileSync(path.join(cwd, 'AGENTS.md'), 'kernel re-append\n');
    const second = currentVerificationSourceHash(cwd, contract);
    assert.equal(second.complete, true, second.reason);
    assert.equal(second.hash, first.hash);
  });
});

test('Git verification source identity is project-relative inside a larger worktree and changes on every mutation', () => {
  withProject((worktree) => {
    const cwd = path.join(worktree, 'services', 'traffic-app');
    fs.mkdirSync(cwd, { recursive: true });
    setupReact(cwd);
    const sourcePath = 'apps/web/src/pages/Home.tsx';
    fs.writeFileSync(
      path.join(cwd, sourcePath),
      "export function Home() { return <button onClick={() => track('a')}>Open</button>; }\n",
    );
    fs.mkdirSync(path.join(worktree, 'sibling'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'sibling/untouched.ts'), 'export const sibling = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: worktree });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktree });
    execFileSync('git', ['add', '.'], { cwd: worktree });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: worktree });

    const architecture = compileArchitecture(cwd, 'NESTED', EXISTING_REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });
    fs.writeFileSync(
      path.join(cwd, sourcePath),
      "export function Home() { return <button onClick={() => track('b')}>Open</button>; }\n",
    );
    const changed = changedPathsFromBaseline(cwd, architecture);
    assert.deepEqual(changed, { paths: [sourcePath], complete: true });

    const contract = compileVerificationContract(cwd, 'NESTED', EXISTING_REACT, architecture);
    assert.equal(contract.scanComplete, true);
    assert.equal(contract.uiImpact, 'behavioral', 'nested Git show/diff must compare the correct baseline file');
    assert.ok(contract.changedPaths.includes(sourcePath));
    assert.ok(contract.changedPaths.every((entry) => !entry.startsWith('services/traffic-app/')));
    const first = currentVerificationSourceHash(cwd, contract);
    assert.equal(first.complete, true, first.reason);

    // Same path and similar file size: source identity must use bytes, not
    // worktree-root path text, mtime, or a one-time diff snapshot.
    fs.writeFileSync(
      path.join(cwd, sourcePath),
      "export function Home() { return <button onClick={() => track('c')}>Open</button>; }\n",
    );
    const second = currentVerificationSourceHash(cwd, contract);
    assert.equal(second.complete, true, second.reason);
    assert.notEqual(second.hash, first.hash);

    // A mutation elsewhere in the umbrella worktree is outside this Traffic
    // One project and must neither contaminate its diff nor change its hash.
    fs.writeFileSync(path.join(worktree, 'sibling/untouched.ts'), 'export const sibling = 2;\n');
    const siblingOnly = currentVerificationSourceHash(cwd, contract);
    assert.equal(siblingOnly.complete, true, siblingOnly.reason);
    assert.equal(siblingOnly.hash, second.hash);

    const projectAlias = path.join(worktree, 'traffic-app-alias');
    fs.symlinkSync(cwd, projectAlias, 'dir');
    const aliasedRoot = changedPathsFromBaseline(projectAlias, architecture);
    assert.equal(aliasedRoot.complete, false);
    assert.match(aliasedRoot.reason || '', /project root.*symbolic link/i);

    fs.writeFileSync(path.join(cwd, 'unexpected.ts'), 'export const unexpected = true;\n');
    const outsideContract = currentVerificationSourceHash(cwd, contract);
    assert.equal(outsideContract.complete, false);
    assert.match(outsideContract.reason || '', /outside verification contract.*unexpected\.ts/);
  });
});

test('a missing project scan root is incomplete instead of silently passing', () => {
  withProject((cwd) => {
    setupReact(cwd);
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapping-service', name: 'Mapping', kind: 'service' }],
    });
    fs.rmSync(cwd, { recursive: true, force: true });
    const changed = changedPathsFromBaseline(cwd, architecture);
    assert.equal(changed.complete, false);
    assert.match(changed.reason || '', /cannot resolve/);
  });
});

test('handler-only edits are behavioral in every framework, not just React', () => {
  withProject((cwd) => {
    setupReact(cwd);
    const profile = capabilityProfileForProject(cwd, REACT);
    fs.mkdirSync(path.join(cwd, 'apps/web/src/pages'), { recursive: true });

    // Handler syntax per framework, with the value it starts from and the value
    // the edit changes it to. Only React's `on[A-Z]` form was recognized before,
    // so a handler-only hunk in any of the others read as VISUAL and paid for a
    // three-viewport screenshot sweep plus Lighthouse.
    const cases: Array<[string, string, string]> = [
      ['React.tsx', '<button onClick={() => save(1)}>Go</button>', '<button onClick={() => save(1, 2)}>Go</button>'],
      ['Vue.vue', '<button @click="save(1)">Go</button>', '<button @click="save(1, 2)">Go</button>'],
      ['Directive.vue', '<button v-on:click="save(1)">Go</button>', '<button v-on:click="save(1, 2)">Go</button>'],
      ['Alpine.html', '<button x-on:click="save(1)">Go</button>', '<button x-on:click="save(1, 2)">Go</button>'],
      ['Live.blade.php', '<button wire:click="save(1)">Go</button>', '<button wire:click="save(1, 2)">Go</button>'],
      ['Svelte.svelte', '<button on:click={() => save(1)}>Go</button>', '<button on:click={() => save(1, 2)}>Go</button>'],
      ['Ng.html', '<button (click)="save(1)">Go</button>', '<button (click)="save(1, 2)">Go</button>'],
      // Plain HTML's own spelling, and the one the camelCase arm cannot reach:
      // `onclick` is lowercase, carries no colon, `@` or `(x)`, and so was
      // stripped NOWHERE — not even in `.html`, where it is native. A
      // handler-only edit here read `visual` while the React row above it read
      // `behavioral` for the same edit.
      ['Plain.html', '<button onclick="save(1)">Go</button>', '<button onclick="save(1, 2)">Go</button>'],
    ];

    for (const [name, before] of cases) {
      fs.writeFileSync(path.join(cwd, `apps/web/src/pages/${name}`), `${before}\n`);
    }
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Styled.vue'), '<button class="p-6">Go</button>\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Filter.html'), '<ul data-only="active"><li>One</li></ul>\n');
    execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
    execFileSync('git', [
      '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'base',
    ], { cwd, stdio: 'ignore' });
    const baseline = captureArchitectureBaseline(cwd, profile);
    assert.equal(baseline.kind, 'git-head', 'fixture guard: hunk evidence needs a git baseline');

    for (const [name, , after] of cases) {
      const rel = `apps/web/src/pages/${name}`;
      fs.writeFileSync(path.join(cwd, rel), `${after}\n`);
      const impact = deriveUiImpact(cwd, profile, [rel], baseline).impact;
      assert.equal(impact, 'behavioral', `${name}: a handler-only change must not be visual`);
    }

    // A styling change in the same file shape stays visual.
    const styled = 'apps/web/src/pages/Styled.vue';
    fs.writeFileSync(path.join(cwd, styled), '<button class="rounded-xl bg-white p-6 shadow">Go</button>\n');
    assert.equal(deriveUiImpact(cwd, profile, [styled], baseline).impact, 'visual');

    // What bounds the lowercase arm. `data-only` and Astro's `client:only`
    // contain `on` at a word boundary but are ordinary rendered structure, and
    // every real collision found has that shape: the `on` is the TAIL of a
    // hyphenated or namespaced name, never a name of its own. Strip one and it
    // leaves BOTH sides of the projection, so a real attribute change reads as
    // no change at all — the silent direction, which is why the guard is worth
    // its lookbehind. The row is only meaningful because it is the same file
    // shape as `Plain.html` above: same extension, same tag, one attribute.
    const namespaced = 'apps/web/src/pages/Filter.html';
    fs.writeFileSync(path.join(cwd, namespaced), '<ul data-only="all"><li>One</li></ul>\n');
    assert.equal(
      deriveUiImpact(cwd, profile, [namespaced], baseline).impact,
      'visual',
      'data-only is an attribute, not a handler: on at the tail of a hyphenated name is not on',
    );
  });
});

test('a bare 768 in backend code does not force the tablet viewport', () => {
  withProject((cwd) => {
    setupReact(cwd);
    const profile = capabilityProfileForProject(cwd, REACT);
    const rel = 'apps/web/src/lib/ports.ts';
    fs.mkdirSync(path.join(cwd, 'apps/web/src/lib'), { recursive: true });
    // A literal 768 that is not a breakpoint: it used to add a whole viewport to
    // every route in the sweep.
    fs.writeFileSync(path.join(cwd, rel), 'export const MAX_FRAME_BYTES = 768;\n');
    assert.equal(deriveUiImpact(cwd, profile, [rel]).tabletRisk, false);

    const responsive = 'apps/web/src/pages/Responsive.tsx';
    fs.writeFileSync(
      path.join(cwd, responsive),
      'export const R = () => <main className="md:flex lg:block">x</main>;\n',
    );
    assert.equal(deriveUiImpact(cwd, profile, [responsive]).tabletRisk, true);
  });
});

// A page-speed budget may only BLOCK when someone declared one. Observed 10co:
// `visual-risk` silently opted every UI change into a synthetic budget, and the
// run ended on FCP 1.65s vs a 1.5s default while scoring Performance 99.
test('only a declared budget makes Lighthouse a required gate; visual risk is advisory', () => {
  withProject((cwd) => {
    setupReact(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/styles.css'), 'body { color: black; }\n');
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    });
    const compile = (options: Record<string, unknown>): ReturnType<typeof compileVerificationContract> =>
      compileVerificationContract(cwd, 'R', REACT, architecture, {
        changedPaths: ['apps/web/src/styles.css'],
        ...options,
      });

    const advisory = compile({});
    assert.equal(advisory.performance.required, false);
    assert.equal(advisory.performance.advisory, true);
    assert.equal(advisory.performance.reason, 'visual-risk');

    for (const [label, options] of [
      ['explicit', { explicitLighthouse: { performanceMin: 95 } }],
      ['performance-risk', { performanceRisk: true }],
      ['redesign', { redesign: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      const declared = compile(options);
      assert.equal(declared.performance.required, true, `${label} must block`);
      assert.equal(declared.performance.advisory, false, `${label} is not advisory`);
    }
  });
});

// One authority: the contract publishes the EFFECTIVE budget so the QA report
// and the standalone runner cannot reach opposite verdicts on the same audit.
test('the contract publishes an effective Lighthouse budget, defaults included', () => {
  withProject((cwd) => {
    setupReact(cwd);
    const architecture = compileArchitecture(cwd, 'R', REACT, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    });

    const fallback = compileVerificationContract(cwd, 'R', REACT, architecture, { changedPaths: [] });
    // No first-paint budget by default — that is the number that ended 10co.
    // Checked before the deepEqual below, whose assertion signature would
    // narrow `thresholds` to the defaults' literal type.
    assert.equal(fallback.performance.thresholds.fcpMaxMs, undefined);
    assert.deepEqual(fallback.performance.thresholds, { ...DEFAULT_LIGHTHOUSE_THRESHOLDS });

    const declared = compileVerificationContract(cwd, 'R', REACT, architecture, {
      changedPaths: [],
      explicitLighthouse: { performanceMin: 95, fcpMaxMs: 1800 },
    });
    assert.equal(declared.performance.thresholds.performanceMin, 95, 'a declared value overrides the default');
    assert.equal(declared.performance.thresholds.fcpMaxMs, 1800, 'a declared FCP budget is published');
    assert.equal(declared.performance.thresholds.clsMax, DEFAULT_LIGHTHOUSE_THRESHOLDS.clsMax, 'undeclared keys keep the default');
  });
});
