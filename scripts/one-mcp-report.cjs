#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  isAuthenticatedLocal,
} = require('./traffic-one-auth.cjs');

const DEFAULT_ENDPOINT = 'https://nkjomfwbtpvrhdrodmwz.supabase.co/functions/v1/one-mcp';
const ID_FILE = '.one-mcp-id';
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

function uuidV7(date = new Date()) {
  const millis = BigInt(date.getTime()).toString(16).padStart(12, '0').slice(-12);
  const random = crypto.randomBytes(10);
  const randA = (((random[0] << 8) | random[1]) & 0x0fff).toString(16).padStart(3, '0');
  const variant = ((random[2] & 0x3f) | 0x80).toString(16).padStart(2, '0');
  const tail = Buffer.from(random.subarray(4, 10)).toString('hex');
  return `${millis.slice(0, 8)}-${millis.slice(8)}-7${randA}-${variant}${random[3].toString(16).padStart(2, '0')}-${tail}`;
}

function validReportId(value) {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(String(value || '').trim());
}

function readReportIdState(cwd) {
  const idPath = path.join(cwd, ID_FILE);
  const existing = readText(idPath);
  if (existing !== null) {
    const id = existing.trim();
    return validReportId(id) ? { id, created: false } : { id, created: false, invalid: true };
  }
  return null;
}

function createReportId(cwd) {
  const idPath = path.join(cwd, ID_FILE);
  const id = uuidV7();
  let fd = null;
  try {
    fd = fs.openSync(idPath, 'wx');
    fs.writeFileSync(fd, `${id}\n`, 'utf8');
    return { id, created: true };
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return readReportIdState(cwd) || { id: '', created: false, invalid: true };
    }
    throw error;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

function ensureReportId(cwd) {
  return readReportIdState(cwd) || createReportId(cwd);
}

function stageReportId(cwd) {
  try {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: 2000,
    });
    if (inside.status !== 0) return false;
    const added = spawnSync('git', ['add', '--', ID_FILE], {
      cwd,
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: 2000,
    });
    return added.status === 0;
  } catch {
    return false;
  }
}

function hasRealCodebase(cwd) {
  const directMarkers = [
    'package.json',
    'go.mod',
    'Cargo.toml',
    'pyproject.toml',
    'pom.xml',
    'build.gradle',
    'pubspec.yaml',
    'Package.swift',
  ];
  if (directMarkers.some((name) => fs.existsSync(path.join(cwd, name)))) return true;

  const workspaceDirs = ['apps', 'packages', 'src', 'app', 'pages', 'supabase'];
  return workspaceDirs.some((name) => fs.existsSync(path.join(cwd, name)));
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

function collectFileExtensions(cwd) {
  const totals = {};
  walkFiles(cwd, (absPath, relPath) => {
    const ext = extensionFor(relPath);
    if (!ext) return;
    const text = readText(absPath);
    if (text === null || text.includes('\u0000')) return;
    totals[ext] = (totals[ext] || 0) + countLines(text);
  });
  return Object.fromEntries(
    Object.entries(totals)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 50),
  );
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

function collectTechnologies(cwd, state, fileExtensions) {
  const techs = new Set();
  const stateTech = state && state.technologies && typeof state.technologies === 'object' ? state.technologies : {};
  for (const values of Object.values(stateTech)) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized) techs.add(normalized);
    }
  }

  for (const dep of dependencyNames(cwd)) addTechForDependency(techs, dep);
  if (fileExtensions.ts || fileExtensions.tsx) techs.add('typescript');
  if (fileExtensions.js || fileExtensions.jsx || fileExtensions.mjs || fileExtensions.cjs) techs.add('javascript');
  if (fileExtensions.go) techs.add('go');
  if (fileExtensions.rs) techs.add('rust');
  if (fileExtensions.py) techs.add('python');
  if (fileExtensions.kt || fileExtensions.kts) techs.add('kotlin');
  if (fileExtensions.swift) techs.add('swift');
  if (fileExtensions.dart) techs.add('dart');
  if (fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) techs.add('pnpm');
  return [...techs].filter(Boolean).sort().slice(0, 50);
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

function collectArchitectureComponents(cwd, state) {
  const components = [];
  const seen = new Set();
  const deps = dependencyNames(cwd);
  const backend = String((state && state.backend) || '').toLowerCase();

  if (backend === 'supabase' || deps.has('@supabase/supabase-js') || deps.has('@supabase/ssr')) {
    addComponent(components, seen, 'database', 'postgresql');
    addComponent(components, seen, 'third_party_service', 'supabase');
  }

  const depComponents = [
    ['pg', 'database', 'postgresql'],
    ['postgres', 'database', 'postgresql'],
    ['mysql2', 'database', 'mysql'],
    ['mongodb', 'database', 'mongodb'],
    ['mongoose', 'database', 'mongodb'],
    ['redis', 'database', 'redis'],
    ['ioredis', 'database', 'redis'],
    ['sqlite3', 'database', 'sqlite'],
    ['stripe', 'third_party_service', 'stripe'],
    ['@sentry/react', 'third_party_service', 'sentry'],
    ['@sentry/node', 'third_party_service', 'sentry'],
    ['posthog-js', 'third_party_service', 'posthog'],
    ['twilio', 'third_party_service', 'twilio'],
    ['@sendgrid/mail', 'third_party_service', 'sendgrid'],
    ['algoliasearch', 'third_party_service', 'algolia'],
    ['cloudinary', 'third_party_service', 'cloudinary'],
  ];
  for (const [dep, type, name] of depComponents) {
    if (deps.has(dep)) addComponent(components, seen, type, name);
  }

  return components.slice(0, 50);
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

function collectMetadata(cwd, state, reportId) {
  const fileExtensions = collectFileExtensions(cwd);
  return {
    report_id: reportId,
    technologies: collectTechnologies(cwd, state, fileExtensions),
    file_extensions: fileExtensions,
    architecture_components: collectArchitectureComponents(cwd, state),
    infrastructure_vendor: detectInfrastructureVendor(cwd),
  };
}

function buildMcpPayload(metadata) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'report_codebase_metadata',
      arguments: metadata,
    },
  };
}

function parseTimestamp(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : 0;
}

function shouldAttempt(status, nowMs = Date.now()) {
  if (!status || typeof status !== 'object') return true;
  if (status.status === 'ok') return false;
  const last = parseTimestamp(status.lastAttemptAt || status.queuedAt);
  if (!last) return true;
  if (status.status === 'queued' || status.status === 'pending') {
    return nowMs - last > QUEUED_RETRY_MS;
  }
  if (status.status === 'failed') {
    return nowMs - last > FAILED_RETRY_MS;
  }
  return true;
}

function stateForReport(root, options = {}) {
  return options.state && typeof options.state === 'object'
    ? options.state
    : readJson(path.join(root, '.traffic-one.json'), {});
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

function prepareReport(cwd, options = {}) {
  if (process.env.TRAFFIC_ONE_DISABLE_ONE_MCP === '1') {
    return { started: false, reason: 'disabled' };
  }
  if (!isAuthenticatedLocal()) {
    return { started: false, reason: 'auth-required' };
  }
  const root = path.resolve(cwd);
  if (!hasRealCodebase(root)) {
    return { started: false, reason: 'no-codebase' };
  }

  const existingIdState = readReportIdState(root);
  if (existingIdState && existingIdState.invalid) {
    return { started: false, reason: 'invalid-report-id' };
  }
  if (existingIdState) {
    const debugPayloadSaved = backfillDebugPayload(root, existingIdState.id, options);
    return {
      started: false,
      reason: 'already-registered',
      reportId: existingIdState.id,
      ...(debugPayloadSaved ? { debugPayloadSaved: true } : {}),
    };
  }

  const idState = createReportId(root);
  if (idState.invalid) {
    return { started: false, reason: 'invalid-report-id' };
  }
  if (!idState.created) {
    return { started: false, reason: 'already-registered', reportId: idState.id };
  }
  stageReportId(root);

  const statusPath = path.join(root, STATUS_FILE);
  const status = readJson(statusPath, null);
  if (status && status.reportId === idState.id && !shouldAttempt(status)) {
    return { started: false, reason: status && status.status ? status.status : 'recent' };
  }

  const state = stateForReport(root, options);
  const nextStatus = {
    status: 'queued',
    reportId: idState.id,
    endpoint: options.endpoint || DEFAULT_ENDPOINT,
    queuedAt: nowIso(),
    lastAttemptAt: status && status.lastAttemptAt ? status.lastAttemptAt : null,
    attempts: status && Number.isInteger(status.attempts) ? status.attempts : 0,
    trigger: options.trigger || 'hook',
    mcpPayload: debugPayloadForReport(root, state, idState.id),
  };
  writeJson(statusPath, nextStatus);

  if (options.spawn === false || process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN === '1') {
    return { started: true, reportId: idState.id, spawned: false };
  }

  const child = spawn(process.execPath, [__filename, root], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TRAFFIC_ONE_ONE_MCP_ENDPOINT: options.endpoint || process.env.TRAFFIC_ONE_ONE_MCP_ENDPOINT || DEFAULT_ENDPOINT,
    },
  });
  child.unref();
  return { started: true, reportId: idState.id, spawned: true };
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

async function runReport(cwd, options = {}) {
  const root = path.resolve(cwd);
  const endpoint = options.endpoint || process.env.TRAFFIC_ONE_ONE_MCP_ENDPOINT || DEFAULT_ENDPOINT;
  const idState = readReportIdState(root);
  if (!idState) {
    return { ok: false, skipped: 'missing-report-id' };
  }
  if (idState.invalid) {
    return { ok: false, skipped: 'invalid-report-id' };
  }

  const state = readJson(path.join(root, '.traffic-one.json'), {});
  const statusPath = path.join(root, STATUS_FILE);
  const previous = readJson(statusPath, {});
  if (options.requireQueued !== false) {
    const queuedForThisId = previous
      && previous.status === 'queued'
      && previous.reportId === idState.id;
    if (!queuedForThisId) {
      return { ok: false, skipped: 'not-queued' };
    }
  }

  const payload = collectMetadata(root, state, idState.id);
  const mcpPayload = buildMcpPayload(payload);
  const attempts = previous && Number.isInteger(previous.attempts) ? previous.attempts + 1 : 1;
  writeJson(statusPath, {
    status: 'pending',
    reportId: idState.id,
    endpoint,
    queuedAt: previous && previous.queuedAt ? previous.queuedAt : null,
    lastAttemptAt: nowIso(),
    attempts,
    trigger: previous && previous.trigger ? previous.trigger : null,
    mcpPayload,
  });

  try {
    await (options.transport || mcpRequest)(endpoint, payload);
    writeJson(statusPath, {
      status: 'ok',
      reportId: idState.id,
      endpoint,
      queuedAt: previous && previous.queuedAt ? previous.queuedAt : null,
      reportedAt: nowIso(),
      attempts,
      trigger: previous && previous.trigger ? previous.trigger : null,
      mcpPayload,
    });
    return { ok: true, reportId: idState.id };
  } catch (error) {
    writeJson(statusPath, {
      status: 'failed',
      reportId: idState.id,
      endpoint,
      queuedAt: previous && previous.queuedAt ? previous.queuedAt : null,
      lastAttemptAt: nowIso(),
      attempts,
      trigger: previous && previous.trigger ? previous.trigger : null,
      mcpPayload,
      error: error && error.message ? error.message : String(error || 'unknown error'),
    });
    return { ok: false, error };
  }
}

function maybeStartOneMcpReport(cwd, options = {}) {
  try {
    return prepareReport(cwd, options);
  } catch (error) {
    return { started: false, reason: 'error', error };
  }
}

async function main() {
  const cwd = process.argv[2] || process.cwd();
  await runReport(cwd);
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 0;
  });
}

module.exports = {
  buildMcpPayload,
  collectArchitectureComponents,
  collectFileExtensions,
  collectMetadata,
  collectTechnologies,
  hasRealCodebase,
  maybeStartOneMcpReport,
  prepareReport,
  readReportIdState,
  runReport,
  stageReportId,
  shouldAttempt,
  uuidV7,
  validReportId,
};
