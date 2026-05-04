'use strict';

// scripts/hook-runtime/detection.cjs
// Project mode + stack detection from package.json / workspace files.
// All read-only, all from the user's project cwd.

const fs   = require('fs');
const path = require('path');

const { safeReadJson } = require('./state.cjs');

// ── package.json helpers ─────────────────────────────────────────────────────
function loadPackageJson(cwd) {
  return safeReadJson(path.join(cwd, 'package.json'), {});
}

function dependenciesFromPackage(pkg) {
  return {
    ...(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}),
    ...(pkg.devDependencies && typeof pkg.devDependencies === 'object' ? pkg.devDependencies : {}),
  };
}

function hasWorkspaces(pkg) {
  return Boolean(pkg.workspaces) || Object.prototype.hasOwnProperty.call(pkg, 'pnpm');
}

function workspaceYamlPresent(cwd) {
  return (
    fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml')) ||
    fs.existsSync(path.join(cwd, 'pnpm-workspace.yml'))
  );
}

// ── Source-file count (rough "is this a new project?" heuristic) ────────────
function countSourceFiles(cwd) {
  let count = 0;
  const sourceExts = new Set(['.tsx', '.ts', '.jsx', '.js']);

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && sourceExts.has(path.extname(entry.name))) {
        count += 1;
      }
    }
  }

  walk(cwd);
  return count;
}

// ── Detection results ────────────────────────────────────────────────────────
function detectMode(cwd) {
  const pkg = loadPackageJson(cwd);
  const deps = dependenciesFromPackage(pkg);
  const fileCount = countSourceFiles(cwd);

  if (fileCount <= 5) {
    return 'new-project';
  }
  if (deps['@supabase/supabase-js'] || deps['@supabase/ssr']) {
    return 'existing-with-supabase';
  }
  return 'existing-codebase';
}

function detectStackFromCodebase(cwd) {
  const out = {
    stack:    null,
    backend:  null,
    frontend: null,
    realtime: null,
    evidence: [],
  };

  const pkg = loadPackageJson(cwd);
  const deps = dependenciesFromPackage(pkg);
  if (Object.keys(deps).length === 0) {
    return out;
  }

  const monorepo = hasWorkspaces(pkg) || workspaceYamlPresent(cwd);
  const isNext   = Boolean(deps.next);
  const isNative = Boolean(deps.expo || deps['react-native']);
  const isReact  = Boolean(deps.react);

  if (isNext) {
    out.stack    = 'minimal';
    out.frontend = 'nextjs';
    out.evidence.push('next in deps → apply Next.js provider-first recommendations');
  } else if (isNative) {
    out.stack = monorepo ? 'react-native-expo-monorepo' : 'react-native-expo-app';
    out.evidence.push('react-native/expo in deps');
  } else if (isReact) {
    out.stack = monorepo ? 'react-realtime-monorepo' : 'react-frontend-only';
    out.evidence.push('react in deps');
  }

  if (deps['@supabase/supabase-js'] || deps['@supabase/ssr']) {
    out.backend = 'supabase';
    out.evidence.push('supabase detected → recommend our fork once');
  } else if (deps.firebase || deps['firebase-admin']) {
    out.backend = 'other';
    out.evidence.push('firebase detected');
  }

  if (deps['socket.io-client'] || deps['socket.io'] || deps.ws) {
    out.realtime = 'light';
    out.evidence.push('websocket lib detected');
  }

  return out;
}

module.exports = {
  loadPackageJson,
  dependenciesFromPackage,
  hasWorkspaces,
  workspaceYamlPresent,
  countSourceFiles,
  detectMode,
  detectStackFromCodebase,
};
