#!/usr/bin/env node
// Maintainer host resync: Claude is the Cursor source (Imported). Never install
// ~/.cursor/plugins/local/traffic-one when Claude user-scope is enabled — that
// duplicates every hook. thirdPartyExtensibility must stay enabled so hooks fire.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const DIST = path.resolve(__dirname, '..', '..', 'dist');
const VERSION = require(path.join(__dirname, '..', '..', 'package.json')).version;

function run(label, args, opts = {}) {
  process.stdout.write(`\n>> ${label}\n`);
  const r = spawnSync(args[0], args.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  const out = [r.stdout, r.stderr].filter(Boolean).join('').trim();
  if (out) process.stdout.write(`${out}\n`);
  if (r.status !== 0 && !opts.allowFailure) {
    throw new Error(`${label} failed with status ${r.status}`);
  }
  return r;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function main() {
  if (!fs.existsSync(DIST)) throw new Error(`missing dist at ${DIST}`);
  process.stdout.write(`resync ${VERSION} from ${DIST}\n`);

  rmrf(path.join(HOME, '.claude', 'plugins', 'cache', 'traffic-one', 'traffic-one'));
  rmrf(path.join(HOME, '.codex', 'plugins', 'cache', 'traffic-one-local', 'traffic-one'));
  const cursorLocal = path.join(HOME, '.cursor', 'plugins', 'local', 'traffic-one');
  if (fs.existsSync(cursorLocal)) {
    rmrf(cursorLocal);
    process.stdout.write('removed Cursor local install (prevents Local+Imported duplicate)\n');
  } else {
    process.stdout.write('Cursor local install already absent\n');
  }

  const db = path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (fs.existsSync(db)) {
    run('enable Cursor third-party import', [
      'sqlite3', db,
      "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('thirdPartyExtensibilityEnabled', 'true');",
    ], { allowFailure: true });
  }

  run('claude marketplace add', ['claude', 'plugin', 'marketplace', 'add', DIST, '--scope', 'user'], { allowFailure: true });
  run('claude uninstall', ['claude', 'plugin', 'uninstall', 'traffic-one@traffic-one', '--scope', 'user'], { allowFailure: true });
  run('claude install', ['claude', 'plugin', 'install', 'traffic-one@traffic-one', '--scope', 'user']);
  run('claude enable', ['claude', 'plugin', 'enable', 'traffic-one@traffic-one', '--scope', 'user'], { allowFailure: true });
  run('claude list', ['claude', 'plugin', 'list'], { allowFailure: true });

  const mkt = path.join(HOME, '.codex', 'local-marketplaces', 'traffic-one-local');
  const pluginDir = path.join(mkt, 'plugins', 'traffic-one');
  fs.mkdirSync(pluginDir, { recursive: true });
  run('codex rsync', ['rsync', '-a', '--delete', `${DIST}/`, `${pluginDir}/`]);
  fs.writeFileSync(path.join(mkt, 'marketplace.json'), `${JSON.stringify({
    name: 'traffic-one-local',
    interface: { displayName: 'Traffic One Local' },
    plugins: [{
      name: 'traffic-one',
      source: { source: 'local', path: './plugins/traffic-one' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Engineering',
    }],
  }, null, 2)}\n`);
  run('codex marketplace remove', ['codex', 'plugin', 'marketplace', 'remove', 'traffic-one-local'], { allowFailure: true });
  run('codex marketplace add', ['codex', 'plugin', 'marketplace', 'add', mkt], { allowFailure: true });
  run('codex plugin add', ['codex', 'plugin', 'add', 'traffic-one@traffic-one-local'], { allowFailure: true });
  run('codex list', ['codex', 'plugin', 'list'], { allowFailure: true });

  for (const host of ['opencode', 'kilo', 'windsurf']) {
    const script = path.join(DIST, 'scripts', `${host}-host.cjs`);
    if (fs.existsSync(script)) {
      run(`${host}-host install`, ['node', script, 'install', '--yes'], { allowFailure: true });
    }
  }

  process.stdout.write('\n--- verify ---\n');
  process.stdout.write(`claude cache: ${fs.existsSync(path.join(HOME, '.claude', 'plugins', 'cache', 'traffic-one', 'traffic-one', VERSION)) ? VERSION : 'missing'}\n`);
  process.stdout.write(`codex cache/local: ${fs.existsSync(pluginDir) ? 'present' : 'missing'}\n`);
  process.stdout.write(`cursor local: ${fs.existsSync(cursorLocal) ? 'PRESENT_DUPLICATE_RISK' : 'absent_ok'}\n`);
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'));
    process.stdout.write(`enabledPlugins: ${JSON.stringify(settings.enabledPlugins || null)}\n`);
  } catch (err) {
    process.stdout.write(`enabledPlugins: unreadable (${err.message})\n`);
  }
  process.stdout.write('DONE\n');
}

main();
