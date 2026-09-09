import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  JSONC_CONFIG_BACKUP_SUFFIX,
  parseJsoncObject,
  parseJsoncText,
  writeConfig,
} from '../wrapper-jsonc';

function withFile(fn: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-wrapper-jsonc-'));
  try {
    fn(path.join(dir, 'config.jsonc'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('writeConfig creates a pretty JSON file when none exists, and leaves no backup', () => {
  withFile((file) => {
    writeConfig(file, { model: 'x', plugin: [] });
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify({ model: 'x', plugin: [] }, null, 2)}\n`);
    assert.equal(fs.existsSync(`${file}${JSONC_CONFIG_BACKUP_SUFFIX}`), false);
  });
});

test('writeConfig splices missing keys and keeps line plus block comments', () => {
  withFile((file) => {
    fs.writeFileSync(file, [
      '{',
      '  // user setting',
      '  "model": "opencode/big-pickle",',
      '  /* keep this */',
      '  "plugin": [',
      '    "file://already",',
      '  ],',
      '}',
      '',
    ].join('\n'), 'utf8');
    writeConfig(file, {
      model: 'opencode/big-pickle',
      plugin: ['file://already'],
      $schema: 'https://opencode.ai/config.json',
    });
    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /\/\/ user setting/);
    assert.match(raw, /\/\* keep this \*\//);
    assert.match(raw, /"model": "opencode\/big-pickle"/);
    assert.deepEqual(parseJsoncText(raw), {
      model: 'opencode/big-pickle',
      plugin: ['file://already'],
      $schema: 'https://opencode.ai/config.json',
    });
    assert.equal(fs.existsSync(`${file}${JSONC_CONFIG_BACKUP_SUFFIX}`), false);
  });
});

test('writeConfig appends an array element without rewriting sibling comments', () => {
  withFile((file) => {
    fs.writeFileSync(file, [
      '{',
      '  // keep',
      '  "plugin": [',
      '    "other",',
      '  ],',
      '}',
      '',
    ].join('\n'), 'utf8');
    writeConfig(file, { plugin: ['other', 'ours'] });
    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /\/\/ keep/);
    assert.match(raw, /"other"/);
    assert.match(raw, /"ours"/);
    assert.deepEqual(parseJsoncText(raw), { plugin: ['other', 'ours'] });
  });
});

test('writeConfig removes a matching array element and leaves unmanaged comments', () => {
  withFile((file) => {
    fs.writeFileSync(file, [
      '{',
      '  // keep',
      '  "plugin": [',
      '    "ours",',
      '    "other"',
      '  ],',
      '}',
      '',
    ].join('\n'), 'utf8');
    writeConfig(file, { plugin: ['other'] });
    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /\/\/ keep/);
    assert.match(raw, /"other"/);
    assert.equal(raw.includes('"ours"'), false);
    assert.deepEqual(parseJsoncText(raw), { plugin: ['other'] });
  });
});

test('writeConfig inserts nested managed keys into an existing object', () => {
  withFile((file) => {
    fs.writeFileSync(file, [
      '{',
      '  // keep',
      '  "mcp": {',
      '    "user-server": { "enabled": true }',
      '  }',
      '}',
      '',
    ].join('\n'), 'utf8');
    writeConfig(file, {
      mcp: {
        'user-server': { enabled: true },
        'traffic-one-mcp': { type: 'remote', enabled: false },
      },
    });
    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /\/\/ keep/);
    assert.match(raw, /"user-server"/);
    assert.match(raw, /"traffic-one-mcp"/);
    assert.deepEqual(parseJsoncText(raw)?.mcp, {
      'user-server': { enabled: true },
      'traffic-one-mcp': { type: 'remote', enabled: false },
    });
  });
});

test('writeConfig keeps compact JSON parseable when adding keys', () => {
  withFile((file) => {
    fs.writeFileSync(file, '{"model":"user/model"}\n', 'utf8');
    writeConfig(file, { model: 'user/model', $schema: 'https://app.kilo.ai/config.json' });
    const raw = fs.readFileSync(file, 'utf8');
    assert.deepEqual(JSON.parse(raw), { model: 'user/model', $schema: 'https://app.kilo.ai/config.json' });
    assert.equal(fs.existsSync(`${file}${JSONC_CONFIG_BACKUP_SUFFIX}`), false);
  });
});

test('replacing an object value is unsafe: backup the original and stringify', () => {
  withFile((file) => {
    const original = [
      '{',
      '  // keep',
      '  "user": { "a": 1 }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(file, original, 'utf8');
    writeConfig(file, { user: { b: 2 } });
    const backup = `${file}${JSONC_CONFIG_BACKUP_SUFFIX}`;
    assert.equal(fs.readFileSync(backup, 'utf8'), original);
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify({ user: { b: 2 } }, null, 2)}\n`);
    assert.equal(fs.readFileSync(file, 'utf8').includes('// keep'), false);
  });
});

test('parseJsoncObject still returns {} for a missing file and parses JSONC comments', () => {
  withFile((file) => {
    assert.deepEqual(parseJsoncObject(file), {});
    fs.writeFileSync(file, '{ // c\n  "a": 1,\n}\n', 'utf8');
    assert.deepEqual(parseJsoncObject(file), { a: 1 });
  });
});
