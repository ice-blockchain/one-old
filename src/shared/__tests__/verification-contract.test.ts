import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  compileArchitecture,
  type ArchitectureInputV1,
} from '../architecture-contract';
import {
  changedPathsFromBaseline,
  compileVerificationContract,
  currentVerificationSourceHash,
  deriveUiImpact,
} from '../verification-contract';
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
    assert.equal(contract.performance.required, true);
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
    assert.equal(contract.performance.required, true);
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
    assert.equal(contract.performance.required, true);
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
