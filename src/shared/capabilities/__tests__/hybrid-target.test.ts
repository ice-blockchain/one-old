import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { capabilityProfileForProject } from '../index';
import { hybridUiTargetAsk, splitHybridOfferText } from '../hybrid-target';

const fixtures: string[] = [];
test.after(() => {
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function withProject(fn: (cwd: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-hybrid-ask-')));
  fixtures.push(dir);
  fn(dir);
}

function plantSplit(cwd: string): void {
  fs.mkdirSync(path.join(cwd, 'apps/web/app'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
    dependencies: { next: '16.0.0', react: '19.0.0' },
  }));
  fs.mkdirSync(path.join(cwd, 'apps/mobile'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'apps/mobile/package.json'), JSON.stringify({
    dependencies: { expo: '55.0.0', react: '19.0.0', 'react-native': '0.83.0' },
  }));
}

const STATE = {
  mode: 'existing-codebase',
  stack: 'custom-frontend',
  frontend: 'none',
  backend: 'none',
  mobile: { framework: 'none' },
};

test('hybridUiTargetAsk: split apps/web + apps/mobile offers workspace members', () => {
  withProject((cwd) => {
    plantSplit(cwd);
    assert.equal(capabilityProfileForProject(cwd, STATE).profileId, 'unsupported-hybrid');
    const ask = hybridUiTargetAsk(cwd, STATE);
    assert.ok(ask);
    assert.equal(ask.webFramework, 'nextjs');
    assert.equal(ask.nativeFramework, 'react-native-expo');
    assert.deepEqual(ask.split, { webRoot: 'apps/web', nativeRoot: 'apps/mobile' });
    assert.match(splitHybridOfferText(ask.split!), /workspace members/);
  });
});

test('hybridUiTargetAsk: architectureTarget already chosen is not an ask', () => {
  withProject((cwd) => {
    plantSplit(cwd);
    assert.equal(hybridUiTargetAsk(cwd, { ...STATE, architectureTarget: 'web-ui' }), null);
    assert.equal(capabilityProfileForProject(cwd, { ...STATE, architectureTarget: 'web-ui' }).profileId, 'next-app');
  });
});

test('hybridUiTargetAsk: a single-surface project is not an ask', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    fs.mkdirSync(path.join(cwd, 'app'), { recursive: true });
    assert.equal(hybridUiTargetAsk(cwd, STATE), null);
  });
});
