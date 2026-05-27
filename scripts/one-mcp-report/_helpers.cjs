'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const {
  STATE_FILE,
  LEGACY_STATE_FILE,
} = require('../hook-runtime/config.cjs');

const DEFAULT_ENDPOINT = 'https://nkjomfwbtpvrhdrodmwz.supabase.co/functions/v1/one-mcp';
const ONE_UID_FIELD = 'one-uid';
const LEGACY_ID_FILE = '.one-mcp-id';
const STATUS_FILE = path.join('.traffic-one', 'one-mcp-report.json');
const QUEUED_RETRY_MS = 5 * 60 * 1000;
const FAILED_RETRY_MS = 60 * 60 * 1000;

const SKIP_DIRS = new Set([
  '.cache',
  '.git',
  '.gitnexus',
  '.next',
  '.nuxt',
  '.traffic-one',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'graphify-out',
  'node_modules',
  'out',
  'Pods',
  'target',
  'vendor',
]);

const SKIP_FILES = new Set([
  '.DS_Store',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJson(filePath, fallback = null) {
  const text = readText(filePath);
  if (text === null) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function statePath(cwd) {
  return path.join(cwd, STATE_FILE);
}

function legacyStatePath(cwd) {
  return path.join(cwd, LEGACY_STATE_FILE);
}

function readProjectState(cwd) {
  const nextState = readJson(statePath(cwd), null);
  if (nextState && typeof nextState === 'object') return nextState;
  const legacyState = readJson(legacyStatePath(cwd), null);
  return legacyState && typeof legacyState === 'object' ? legacyState : {};
}

function writeProjectState(cwd, state) {
  writeJson(statePath(cwd), state && typeof state === 'object' ? state : {});
}

function createReportId(cwd) {
  const existing = readReportIdState(cwd);
  if (existing) return existing;

  const id = uuidV7();
  const state = readProjectState(cwd);
  state[ONE_UID_FIELD] = id;
  writeProjectState(cwd, state);
  return { id, created: true };
}

function ensureReportId(cwd) {
  return readReportIdState(cwd) || createReportId(cwd);
}

function shouldSkipFile(relPath, fileName) {
  const normalized = relPath.replace(/\\/g, '/');
  if (SKIP_FILES.has(fileName)) return true;
  if (/\.(min|bundle)\.(js|css)$/i.test(fileName)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(fileName)) return true;
  if (/\.g\.dart$/i.test(fileName) || /\.pb\.(go|ts|js)$/i.test(fileName)) return true;
  if (/(^|\/)(__tests__|tests?|fixtures?|vendor)(\/|$)/i.test(normalized)) return true;
  return false;
}

function walkFiles(cwd, visitor, relDir = '') {
  const dir = path.join(cwd, relDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(cwd, visitor, path.join(relDir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    const relPath = path.join(relDir, entry.name);
    if (shouldSkipFile(relPath, entry.name)) continue;
    visitor(path.join(cwd, relPath), relPath);
  }
}

function extensionFor(filePath) {
  const base = path.basename(filePath);
  if (base === 'Dockerfile') return 'dockerfile';
  const ext = path.extname(base).replace(/^\./, '').toLowerCase();
  return ext && ext.length <= 64 ? ext : null;
}

function countLines(text) {
  if (!text) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function packageJsonFiles(cwd) {
  const files = [];
  walkFiles(cwd, (absPath, relPath) => {
    if (path.basename(relPath) === 'package.json') files.push(absPath);
  });
  files.sort();
  return files;
}

function dependencyNames(cwd) {
  const names = new Set();
  for (const filePath of packageJsonFiles(cwd)) {
    const pkg = readJson(filePath, {});
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg && pkg[section] && typeof pkg[section] === 'object' ? pkg[section] : {};
      for (const name of Object.keys(deps)) names.add(name);
    }
    if (typeof pkg.packageManager === 'string') {
      const manager = pkg.packageManager.split('@')[0].toLowerCase();
      if (manager) names.add(`package-manager:${manager}`);
    }
  }
  return names;
}

function addTechForDependency(techs, dep) {
  const map = new Map([
    ['@nestjs/core', 'nestjs'],
    ['@reduxjs/toolkit', 'redux'],
    ['@supabase/ssr', 'supabase'],
    ['@supabase/supabase-js', 'supabase'],
    ['@tanstack/react-query', 'tanstack-query'],
    ['next', 'next.js'],
    ['posthog-js', 'posthog'],
    ['prisma', 'prisma'],
    ['react', 'react'],
    ['react-native', 'react-native'],
    ['tailwindcss', 'tailwindcss'],
    ['turbo', 'turborepo'],
    ['typescript', 'typescript'],
    ['vite', 'vite'],
    ['zustand', 'zustand'],
  ]);
  if (map.has(dep)) techs.add(map.get(dep));
  if (dep === 'package-manager:pnpm') techs.add('pnpm');
  if (dep === 'package-manager:npm') techs.add('npm');
  if (dep === 'package-manager:yarn') techs.add('yarn');
}

function addComponent(components, seen, type, name, uses = []) {
  const key = `${type}:${name}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (type === 'custom_service') {
    components.push({ type, name, uses });
  } else {
    components.push({ type, name });
  }
}

function detectInfrastructureVendor(cwd) {
  const checks = [
    ['vercel.json', 'vercel'],
    ['netlify.toml', 'netlify'],
    ['wrangler.toml', 'cloudflare'],
    ['fly.toml', 'fly'],
    ['render.yaml', 'render'],
    ['railway.json', 'railway'],
  ];
  for (const [fileName, vendor] of checks) {
    if (fs.existsSync(path.join(cwd, fileName))) return vendor;
  }
  if (fs.existsSync(path.join(cwd, '.github', 'workflows'))) return 'unknown';
  return 'unknown';
}

function parseTimestamp(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : 0;
}

function stateForReport(root, options = {}) {
  return options.state && typeof options.state === 'object'
    ? options.state
    : readProjectState(root);
}

function debugPayloadForReport(root, state, reportId) {
  return buildMcpPayload(collectMetadata(root, state, reportId));
}

function backfillDebugPayload(root, reportId, options = {}) {
  const statusPath = path.join(root, STATUS_FILE);
  const status = readJson(statusPath, null);
  if (!status || status.reportId !== reportId || status.mcpPayload) return false;
  const state = stateForReport(root, options);
  writeJson(statusPath, {
    ...status,
    mcpPayload: debugPayloadForReport(root, state, reportId),
  });
  return true;
}

function mcpRequest(endpoint, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const body = JSON.stringify(buildMcpPayload(payload));

    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      port: url.port || 443,
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode || 'unknown'}`));
          return;
        }
        if (/"error"\s*:/.test(responseBody)) {
          reject(new Error('MCP error response'));
          return;
        }
        resolve(responseBody);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Several private helpers above reference exported functions that live in
// sibling files (`uuidV7`, `readReportIdState`, `buildMcpPayload`,
// `collectMetadata`). To keep every function body byte-for-byte identical and
// avoid a circular top-level require capturing a partial export, these
// hoisted forwarders resolve the real implementations lazily at call time.
function uuidV7(...args) {
  return require('./uuidV7.cjs').uuidV7(...args);
}

function readReportIdState(...args) {
  return require('./readReportIdState.cjs').readReportIdState(...args);
}

function buildMcpPayload(...args) {
  return require('./buildMcpPayload.cjs').buildMcpPayload(...args);
}

function collectMetadata(...args) {
  return require('./collectMetadata.cjs').collectMetadata(...args);
}

module.exports = {
  DEFAULT_ENDPOINT,
  ONE_UID_FIELD,
  LEGACY_ID_FILE,
  STATUS_FILE,
  QUEUED_RETRY_MS,
  FAILED_RETRY_MS,
  SKIP_DIRS,
  SKIP_FILES,
  nowIso,
  readText,
  readJson,
  writeJson,
  statePath,
  legacyStatePath,
  readProjectState,
  writeProjectState,
  createReportId,
  ensureReportId,
  shouldSkipFile,
  walkFiles,
  extensionFor,
  countLines,
  packageJsonFiles,
  dependencyNames,
  addTechForDependency,
  addComponent,
  detectInfrastructureVendor,
  parseTimestamp,
  stateForReport,
  debugPayloadForReport,
  backfillDebugPayload,
  mcpRequest,
};
