import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { removeLaunchConfig, writeLaunchConfig } from '../launch-config';

interface Cfg {
  name?: string;
  port?: number;
  runtimeArgs?: string[];
}

function withDir(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-launch-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function configs(cwd: string): Cfg[] {
  const parsed = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'launch.json'), 'utf8')) as { configurations?: Cfg[] };
  return Array.isArray(parsed.configurations) ? parsed.configurations : [];
}

function seedUserLaunch(cwd: string): void {
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'launch.json'), JSON.stringify({ version: '0.0.1', configurations: [{ name: 'my-dev', port: 3000 }] }), 'utf8');
}

test('writeLaunchConfig registers the traffic-one-setup entry with the wizard port', () => {
  withDir((cwd) => {
    writeLaunchConfig(cwd, 51820);
    const entry = configs(cwd).find((c) => c.name === 'traffic-one-setup');
    assert.ok(entry, 'entry written');
    assert.equal(entry?.port, 51820);
    assert.ok(entry?.runtimeArgs?.includes('--port'));
    assert.ok(entry?.runtimeArgs?.includes('51820'));
  });
});

test('writeLaunchConfig preserves the user\'s configs and never duplicates ours', () => {
  withDir((cwd) => {
    seedUserLaunch(cwd);
    writeLaunchConfig(cwd, 51820);
    writeLaunchConfig(cwd, 51999); // re-register → replace in place
    const all = configs(cwd);
    assert.ok(all.find((c) => c.name === 'my-dev'), 'user config preserved');
    const ours = all.filter((c) => c.name === 'traffic-one-setup');
    assert.equal(ours.length, 1, 'single traffic-one-setup entry');
    assert.equal(ours[0]?.port, 51999);
  });
});

test('removeLaunchConfig removes only our entry', () => {
  withDir((cwd) => {
    seedUserLaunch(cwd);
    writeLaunchConfig(cwd, 51820);
    removeLaunchConfig(cwd);
    const all = configs(cwd);
    assert.ok(all.find((c) => c.name === 'my-dev'), 'user config kept');
    assert.equal(all.filter((c) => c.name === 'traffic-one-setup').length, 0);
  });
});

test('writeLaunchConfig ignores an invalid port', () => {
  withDir((cwd) => {
    writeLaunchConfig(cwd, 0);
    assert.equal(fs.existsSync(path.join(cwd, '.claude', 'launch.json')), false);
  });
});
