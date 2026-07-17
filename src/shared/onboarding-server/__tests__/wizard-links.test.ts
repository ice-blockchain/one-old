import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { stampEmitMarker } from '../../once';
import { commitWizardLinksShown, wizardLinksShownWithin } from '../wizard-links';

test('wizard link marker is committed only by a payload containing dashboard and direct /local URLs', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-wizard-links-'));
  const token = 'secret-token';
  const dashboard = 'https://traffic.io/onboarding/agent#p=55174&t=secret-token';
  const local = 'http://127.0.0.1:55174/local?t=secret-token';
  try {
    assert.equal(commitWizardLinksShown(cwd, token, `Setup: ${dashboard}`, dashboard, local), false);
    assert.equal(wizardLinksShownWithin(cwd, token, 60_000), false);

    const complete = { context: `Setup: ${dashboard}\nDirect local fallback: ${local}` };
    assert.equal(commitWizardLinksShown(cwd, token, complete, dashboard, local), true);
    assert.equal(wizardLinksShownWithin(cwd, token, 60_000), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('legacy hosted-only wizard-url-shown marker cannot suppress the v2 local fallback', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-wizard-links-legacy-'));
  try {
    stampEmitMarker(cwd, 'wizard-url-shown');
    assert.equal(wizardLinksShownWithin(cwd, 'new-token', 60_000), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
