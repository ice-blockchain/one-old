// Scaffold content seeding (1.0.37, 8co): .prettierignore ships its canonical
// skip list and .env.example ships the VITE_SITE_URL contract — content is
// runtime knowledge, seeded only when the file is missing or blank.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureScaffoldContent, scaffoldFileContent } from '../architecture-contract';

function withTempDir<T>(body: (cwd: string) => T): T {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-scaffold-content-'));
  try {
    return body(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('canonical bodies exist for .prettierignore and .env.example only', () => {
  assert.match(String(scaffoldFileContent('.prettierignore')), /\.traffic-one\//);
  assert.match(String(scaffoldFileContent('.prettierignore')), /pnpm-lock\.yaml/);
  assert.match(String(scaffoldFileContent('.prettierignore')), /\.turbo\//);
  assert.match(String(scaffoldFileContent('.env.example')), /VITE_SITE_URL=/);
  assert.equal(scaffoldFileContent('package.json'), null);
  assert.equal(scaffoldFileContent('apps/web/src/App.tsx'), null);
});

test('seeds missing and blank files; never overwrites agent content', () => {
  withTempDir((cwd) => {
    const outputs = [
      { path: '.prettierignore' },
      { path: '.env.example' },
      { path: 'apps/web/package.json' },
    ];
    // Blank .prettierignore (the exact 8co shape) + no .env.example.
    fs.writeFileSync(path.join(cwd, '.prettierignore'), '\n');
    const written = ensureScaffoldContent(cwd, outputs);
    assert.deepEqual(written.sort(), ['.env.example', '.prettierignore']);
    assert.match(fs.readFileSync(path.join(cwd, '.prettierignore'), 'utf8'), /\.traffic-one\//);
    assert.match(fs.readFileSync(path.join(cwd, '.env.example'), 'utf8'), /VITE_SITE_URL=/);

    // A second pass changes nothing, and agent-authored content is preserved.
    fs.writeFileSync(path.join(cwd, '.prettierignore'), 'custom-entry\n');
    const second = ensureScaffoldContent(cwd, outputs);
    assert.deepEqual(second, []);
    assert.equal(fs.readFileSync(path.join(cwd, '.prettierignore'), 'utf8'), 'custom-entry\n');
  });
});
