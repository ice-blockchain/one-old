import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { capabilityProfileForProject, skillBucketsForState } from '../index';

test('Ionic/Capacitor is a web overlay across Vite, Vue, and Angular profiles', () => {
  const cases = [
    { frontend: 'react-vite', profileId: 'vite-react', baseBucket: 'react-vite' },
    { frontend: 'vue', profileId: 'vue', baseBucket: 'custom-web' },
    { frontend: 'angular', profileId: 'angular', baseBucket: 'custom-web' },
  ] as const;

  for (const fixture of cases) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ionic-profile-'));
    try {
      const state = {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: fixture.frontend,
        backend: 'external-api',
        mobile: { framework: 'ionic-capacitor' },
      };
      const profile = capabilityProfileForProject(cwd, state);
      assert.equal(profile.profileId, fixture.profileId);
      assert.ok(profile.surfaces.includes('web-ui'));
      assert.ok(!profile.surfaces.includes('native-ui'));
      assert.ok(profile.skillBuckets.includes('ionic-capacitor'));
      assert.ok(profile.skillBuckets.includes(fixture.baseBucket));

      const materializedBuckets = skillBucketsForState(state);
      assert.ok(materializedBuckets.includes('ionic-capacitor'));
      assert.ok(materializedBuckets.includes(fixture.baseBucket));
      assert.equal(
        materializedBuckets.includes('react-vite'),
        fixture.frontend === 'react-vite',
        `${fixture.frontend} must not be translated to React`,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('Ionic/Capacitor never manufactures a web profile when no frontend is selected', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ionic-no-frontend-'));
  try {
    const state = {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'external-api',
      mobile: { framework: 'ionic-capacitor' },
    };
    const profile = capabilityProfileForProject(cwd, state);
    assert.equal(profile.profileId, 'backend-only');
    assert.ok(!profile.surfaces.includes('web-ui'));
    assert.ok(!profile.skillBuckets.includes('ionic-capacitor'));

    const materializedBuckets = skillBucketsForState(state);
    assert.ok(!materializedBuckets.includes('web-ui'));
    assert.ok(!materializedBuckets.includes('ionic-capacitor'));
    assert.ok(!materializedBuckets.includes('react-vite'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
