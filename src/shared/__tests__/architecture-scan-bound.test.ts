import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { isInertScanPath } from '../../config/reporting';
import {
  ARCHITECTURE_SCAN_MAX_FILES,
  baselinePathSet,
  compileArchitecture,
  compileListingPathspecs,
  isArchitectureScanBoundError,
  isDeletableStrayArtifact,
  type ArchitectureInputV1,
} from '../architecture-contract';
import { chosenRoot } from '../architecture-contract/naming';
import {
  changedPathsFromBaseline,
  changedPathsFromImmutableBaseline,
} from '../verification-contract/git';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-scan-bound-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function gitCommitAll(cwd: string, message = 'baseline'): void {
  // stdin/stdout discarded; stderr piped so a real failure still lands in the
  // exception and never on the reporter. windows-latest CI sets
  // `core.autocrlf=true` globally: `git add` of the 10_001-file vendor / PNG /
  // source trees then emits one "LF will be replaced by CRLF" warning per
  // file, node:test reprints each as a TAP `#` line, and the Actions log
  // spends tens of minutes ingesting them (observed: still on f07911.go at
  // 45m). Local config overrides the runner for every later git in this repo.
  const quiet = { cwd, stdio: ['ignore', 'ignore', 'pipe'] as const };
  execFileSync('git', ['init', '-q'], quiet);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], quiet);
  execFileSync('git', ['config', 'core.safecrlf', 'false'], quiet);
  execFileSync('git', ['config', 'user.email', 'qa@example.test'], quiet);
  execFileSync('git', ['config', 'user.name', 'QA Test'], quiet);
  execFileSync('git', ['add', '.'], quiet);
  execFileSync('git', ['commit', '-qm', message], quiet);
}

function writeMany(dir: string, count: number, name: (i: number) => string, body = ''): void {
  for (let i = 0; i < count; i += 1) {
    const rel = name(i);
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

function seedLaravelApi(cwd: string): void {
  fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
    require: { 'laravel/framework': '^12.0' },
  }));
  fs.writeFileSync(path.join(cwd, 'artisan'), '#!/usr/bin/env php\n');
  fs.mkdirSync(path.join(cwd, 'app/Http/Controllers'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'app/Models'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'routes'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'app/Http/Controllers/Controller.php'), '<?php\n');
  fs.writeFileSync(path.join(cwd, 'app/Models/User.php'), '<?php\n');
  fs.writeFileSync(path.join(cwd, 'routes/web.php'), '<?php\n');
  fs.writeFileSync(path.join(cwd, 'routes/api.php'), '<?php\n');
}

const LARAVEL_API_STATE = {
  mode: 'existing-codebase',
  stack: 'custom-backend',
  frontend: 'none',
  backend: 'laravel',
  mobile: { framework: 'none' },
};

const GO_API_STATE = {
  mode: 'existing-codebase',
  stack: 'custom-backend',
  frontend: 'none',
  backend: 'go',
  mobile: { framework: 'none' },
};

const DJANGO_STATE = {
  mode: 'existing-codebase',
  stack: 'custom-backend',
  frontend: 'none',
  backend: 'django',
  mobile: { framework: 'none' },
};

const SERVICE_INPUT: ArchitectureInputV1 = {
  schemaVersion: 1,
  routes: [],
  modules: [{ id: 'sync-service', name: 'Sync Service', kind: 'service' }],
};

const REACT_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { framework: 'none' },
};

test('isInertScanPath is bound-only: rasters and fonts, never svg/js/css', () => {
  assert.equal(isInertScanPath('public/favicon.ico'), true);
  assert.equal(isInertScanPath('src/assets/logo.PNG'), true);
  assert.equal(isInertScanPath('app.js.map'), true);
  assert.equal(isInertScanPath('src/assets/logo.svg'), false);
  assert.equal(isInertScanPath('public/assets/global/plugins/foo.js'), false);
  assert.equal(isInertScanPath('app.css'), false);
});

test('compileListingPathspecs lists wiring trees, package.json, and Django settings', () => {
  const specs = compileListingPathspecs({
    sourceRoots: ['apps/web/src', 'src'],
    entrypoints: ['apps/web/src/main.tsx', 'src/main.tsx'],
    layerRoots: {
      pages: ['apps/web/src/pages'],
      components: ['apps/web/src/components'],
      features: ['apps/web/src/features'],
      lib: ['apps/web/src/lib'],
    },
  } as never);
  assert.ok(specs.includes('apps/web/src'));
  assert.ok(specs.includes('apps/web/src/pages'));
  assert.ok(specs.includes('apps/web/app'));
  assert.ok(specs.includes('app'));
  assert.ok(specs.includes('internal'));
  assert.ok(specs.includes('cmd'));
  assert.ok(specs.includes('pkg'));
  assert.ok(specs.includes('src'));
  assert.ok(specs.includes('package.json'));
  assert.ok(specs.includes('*/settings.py'));
  assert.equal(specs.includes('public'), false);
  assert.equal(specs.includes('public/assets/global/plugins'), false);
});

test('Git website with 10_001 public PNGs compiles; plugin JS is absent; PNG change is visible', {
  timeout: 120_000,
}, () => {
  withProject((cwd) => {
    seedLaravelApi(cwd);
    writeMany(cwd, 10_001, (i) => `public/assets/${String(i).padStart(5, '0')}.png`);
    fs.mkdirSync(path.join(cwd, 'public/assets/global/plugins/jquery'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'public/assets/global/plugins/jquery/jquery.js'), '/* plugin */\n');
    fs.writeFileSync(path.join(cwd, 'public/assets/global/plugins/bootbox.js'), '/* plugin */\n');
    gitCommitAll(cwd);

    const architecture = compileArchitecture(cwd, 'R', LARAVEL_API_STATE, SERVICE_INPUT);
    assert.equal(architecture.baseline.kind, 'git-head');
    const listing = baselinePathSet(
      cwd,
      architecture.baseline,
      compileListingPathspecs(architecture.profile),
    );
    assert.equal(listing.has('public/assets/00000.png'), false);
    assert.equal(listing.has('public/assets/global/plugins/jquery/jquery.js'), false);
    assert.equal(listing.has('public/assets/global/plugins/bootbox.js'), false);
    assert.ok(listing.has('app/Models/User.php'));
    assert.ok(listing.has('package.json') || listing.has('composer.json') || listing.has('app/Http/Controllers/Controller.php'));

    assert.deepEqual(changedPathsFromImmutableBaseline(cwd, architecture.baseline), {
      paths: [],
      complete: true,
    });
    fs.writeFileSync(path.join(cwd, 'public/assets/00000.png'), 'changed');
    const changed = changedPathsFromBaseline(cwd, architecture);
    assert.ok(changed.complete, changed.reason);
    assert.ok(changed.paths.includes('public/assets/00000.png'));

    fs.writeFileSync(path.join(cwd, 'public/new-raster.png'), 'post');
    assert.equal(isDeletableStrayArtifact(cwd, 'public/new-raster.png', architecture), true);
  });
});

test('tracked vendor/** does not trip the compile listing or leftover-walk cap', { timeout: 120_000 }, () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
    fs.mkdirSync(path.join(cwd, 'internal'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'internal/api.go'), 'package internal\n');
    writeMany(cwd, ARCHITECTURE_SCAN_MAX_FILES + 1, (i) => (
      `vendor/github.com/example/pkg/f${String(i).padStart(5, '0')}.go`
    ), 'package pkg\n');
    gitCommitAll(cwd);

    const architecture = compileArchitecture(cwd, 'R', GO_API_STATE, SERVICE_INPUT);
    assert.equal(architecture.modules[0]?.output, 'internal/sync_service.go');
    const listing = baselinePathSet(
      cwd,
      architecture.baseline,
      compileListingPathspecs(architecture.profile),
    );
    assert.equal([...listing].some((entry) => entry.startsWith('vendor/')), false);

    // Leftover walks pass no pathspecs; skip must be isScanSkippedPath, not
    // pathspec exclusion alone — vendor still must not trip the cap.
    const leftover = baselinePathSet(cwd, architecture.baseline);
    assert.equal([...leftover].some((entry) => entry.startsWith('vendor/')), false);
    assert.ok(leftover.has('internal/api.go'));
  });
});

test('backend-only Laravel/Go chosenRoot sees app/ and internal/, never leftover resources/js', () => {
  const leftoverJs = new Set(['resources/js/app.ts', 'resources/js/Pages/Home.tsx']);
  assert.equal(chosenRoot(['app', 'src', 'internal'], 'app', leftoverJs), 'app');
  assert.equal(
    chosenRoot(['app', 'src', 'internal'], 'app', new Set([...leftoverJs, 'app/Models/User.php'])),
    'app',
  );
  assert.equal(chosenRoot(['internal', 'cmd', 'pkg', 'src'], 'internal', leftoverJs), 'internal');
  assert.equal(
    chosenRoot(['internal', 'cmd', 'pkg', 'src'], 'internal', new Set([...leftoverJs, 'internal/api.go'])),
    'internal',
  );

  withProject((cwd) => {
    seedLaravelApi(cwd);
    fs.mkdirSync(path.join(cwd, 'resources/js'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'resources/js/bootstrap.js'), '/* leftover */\n');
    gitCommitAll(cwd);
    const architecture = compileArchitecture(cwd, 'R', LARAVEL_API_STATE, SERVICE_INPUT);
    assert.equal(architecture.profile.profileId, 'backend-only');
    assert.equal(architecture.modules[0]?.output, 'app/Services/SyncService.php');
    assert.equal(architecture.modules[0]?.output.startsWith('resources/js'), false);
    const listing = compileListingPathspecs(architecture.profile);
    assert.ok(listing.includes('app'));
    assert.ok(!listing.includes('resources/js'));
  });

  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
    fs.mkdirSync(path.join(cwd, 'internal'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'internal/api.go'), 'package internal\n');
    fs.mkdirSync(path.join(cwd, 'resources/js'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'resources/js/app.ts'), 'export {}\n');
    gitCommitAll(cwd);
    const architecture = compileArchitecture(cwd, 'R', GO_API_STATE, SERVICE_INPUT);
    assert.equal(architecture.profile.profileId, 'backend-only');
    assert.equal(architecture.modules[0]?.output, 'internal/sync_service.go');
    assert.ok(compileListingPathspecs(architecture.profile).includes('internal'));
  });
});

test('Django config/settings.py stays a wiring output and package.json stays in the listing', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'manage.py'), '# manage\n');
    fs.mkdirSync(path.join(cwd, 'config'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'config/settings.py'), 'DEBUG = False\n');
    fs.writeFileSync(path.join(cwd, 'config/urls.py'), 'urlpatterns = []\n');
    gitCommitAll(cwd);
    const architecture = compileArchitecture(cwd, 'R', DJANGO_STATE, SERVICE_INPUT);
    const listing = baselinePathSet(
      cwd,
      architecture.baseline,
      compileListingPathspecs(architecture.profile),
    );
    assert.ok(listing.has('config/settings.py'));
    assert.ok((architecture.scaffoldOutputs || []).some((output) => (
      output.path === 'config' || output.path === 'config/settings.py'
    )));
  });

  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src/main.tsx'), 'export {}\n');
    gitCommitAll(cwd);
    const architecture = compileArchitecture(cwd, 'R', {
      ...REACT_STATE,
      mode: 'existing-codebase',
      stack: 'custom-frontend',
    }, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
      ],
    });
    const listing = baselinePathSet(
      cwd,
      architecture.baseline,
      compileListingPathspecs(architecture.profile),
    );
    assert.equal(listing.has('package.json'), true);
  });
});

test('file-manifest 10k PNGs do not trip the cap; inert stays hashed; post-capture raster is deletable', {
  timeout: 120_000,
}, () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    fs.mkdirSync(path.join(cwd, 'src/assets'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src/main.tsx'), 'export {}\n');
    fs.writeFileSync(path.join(cwd, 'src/assets/logo.svg'), '<svg/>\n');
    fs.mkdirSync(path.join(cwd, 'public'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'public/favicon.ico'), '');
    // 10k inert + a handful of sources stays under the verification walk's
    // separate 10k cap (that walk still counts inert). Compile listing does not.
    writeMany(cwd, 9_996, (i) => `public/assets/${String(i).padStart(5, '0')}.png`);

    const architecture = compileArchitecture(cwd, 'R', {
      ...REACT_STATE,
      mode: 'existing-codebase',
      stack: 'custom-frontend',
    }, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
      ],
    });
    assert.equal(architecture.baseline.kind, 'file-manifest');
    assert.ok((architecture.baseline.files || []).some((entry) => entry.path === 'public/favicon.ico'));
    assert.ok((architecture.baseline.files || []).some((entry) => entry.path === 'src/assets/logo.svg'));
    assert.ok((architecture.baseline.files || []).some((entry) => entry.path === 'public/assets/00000.png'));

    assert.deepEqual(changedPathsFromImmutableBaseline(cwd, architecture.baseline), {
      paths: [],
      complete: true,
    });
    fs.writeFileSync(path.join(cwd, 'public/assets/00000.png'), 'changed');
    const changed = changedPathsFromImmutableBaseline(cwd, architecture.baseline);
    assert.ok(changed.complete, changed.reason);
    assert.ok(changed.paths.includes('public/assets/00000.png'));

    assert.equal(isDeletableStrayArtifact(cwd, 'public/favicon.ico', architecture), false);
    assert.equal(isDeletableStrayArtifact(cwd, 'src/assets/logo.svg', architecture), false);
    fs.writeFileSync(path.join(cwd, 'public/post-capture.png'), 'new');
    assert.equal(isDeletableStrayArtifact(cwd, 'public/post-capture.png', architecture), true);
  });
});

test('file-manifest 10_001 PNGs compile; inert is stored; no verification walk', {
  timeout: 120_000,
}, () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src/main.tsx'), 'export {}\n');
    writeMany(cwd, 10_001, (i) => `public/assets/${String(i).padStart(5, '0')}.png`);

    const architecture = compileArchitecture(cwd, 'R', {
      ...REACT_STATE,
      mode: 'existing-codebase',
      stack: 'custom-frontend',
    }, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
      ],
    });
    assert.equal(architecture.baseline.kind, 'file-manifest');
    assert.ok((architecture.baseline.files || []).some((entry) => (
      entry.path === 'public/assets/00000.png'
    )));
  });
});

test('tracked public/foo.png is not a stray on a tree that does not overflow', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src/main.tsx'), 'export {}\n');
    fs.mkdirSync(path.join(cwd, 'public'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'public/foo.png'), '');
    gitCommitAll(cwd);
    assert.equal(
      execFileSync('git', ['-C', cwd, 'config', '--get', 'core.autocrlf'], { encoding: 'utf8' }).trim(),
      'false',
    );

    const architecture = compileArchitecture(cwd, 'R', {
      ...REACT_STATE,
      mode: 'existing-codebase',
      stack: 'custom-frontend',
    }, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
      ],
    });
    assert.equal(architecture.baseline.kind, 'git-head');
    execFileSync('git', ['-C', cwd, 'ls-files', '--error-unmatch', '--', 'public/foo.png'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    assert.equal(isDeletableStrayArtifact(cwd, 'public/foo.png', architecture), false);
  });
});

test('10_001 source-surface files throw a distinguishable scan-bound error', {
  timeout: 120_000,
}, () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src/main.tsx'), 'export {}\n');
    writeMany(cwd, 10_001, (i) => `src/bulk/${String(i).padStart(5, '0')}.ts`, 'export {}\n');
    gitCommitAll(cwd);

    let thrown: unknown;
    try {
      compileArchitecture(cwd, 'R', {
        ...REACT_STATE,
        mode: 'existing-codebase',
        stack: 'custom-frontend',
      }, {
        schemaVersion: 1,
        routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
        modules: [
          { id: 'app-shell', name: 'App', kind: 'app-shell' },
          { id: 'home', name: 'Home', kind: 'page' },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(isArchitectureScanBoundError(thrown), true);
    assert.ok(isArchitectureScanBoundError(thrown) && thrown.count > ARCHITECTURE_SCAN_MAX_FILES);
  });
});
