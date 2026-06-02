"use strict";
// src/runners/gitnexus/bootstrap.ts
// Foreground GitNexus bootstrap. Mirror of the graphify runner — same return
// shape, same opt-out semantics — used by the post-build code-graph hint and
// the orchestrator's Phase 5 when `state.codeGraphProvider === 'gitnexus'`.
// Ported 1:1 from scripts/gitnexus-runner/{_helpers,bootstrap}.cjs.
//
// LICENSE NOTICE: GitNexus is PolyForm Noncommercial-licensed. This runner only
// fires when the user explicitly picked `codeGraphProvider: "gitnexus"` during
// onboarding — that choice is the consent record. The runner emits a license
// reminder in its return payload so the calling hook can surface it.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFLICT_PATHS = exports.REPORT_FRESH_MS = exports.GITNEXUS_DIR = void 0;
exports.ensureGitnexusTool = ensureGitnexusTool;
exports.bootstrap = bootstrap;
const child_process_1 = require("child_process");
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const exec_1 = require("../../shared/exec");
const materialize_1 = require("../../shared/materialize");
const state_1 = require("../../shared/state");
const text_1 = require("../../shared/text");
const toolchain_1 = require("../toolchain");
const nvm_1 = require("./nvm");
const which = exec_1.exec.which;
exports.GITNEXUS_DIR = '.gitnexus';
exports.REPORT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
exports.CONFLICT_PATHS = ['AGENTS.md', 'CLAUDE.md', '.claude/skills'];
function runStampForFs() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}
function readState(cwd) {
    return (0, state_1.readEffectiveState)(cwd);
}
function writeStateMerge(cwd, patch) {
    try {
        (0, state_1.mergeProjectPrefs)(cwd, patch);
    }
    catch {
        // best-effort; the runner never throws
    }
}
function sha1OfPath(absPath) {
    if (!fs.existsSync(absPath))
        return null;
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
        // Hash the recursive listing (paths + sizes); good enough to detect changes.
        const hash = crypto.createHash('sha1');
        const walk = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true })
                .sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    hash.update(`d:${path.relative(absPath, full)}\n`);
                    walk(full);
                }
                else if (entry.isFile()) {
                    const s = fs.statSync(full);
                    hash.update(`f:${path.relative(absPath, full)}:${s.size}\n`);
                }
            }
        };
        walk(absPath);
        return hash.digest('hex');
    }
    return crypto.createHash('sha1').update(fs.readFileSync(absPath)).digest('hex');
}
function copyRecursive(src, dst) {
    if (!fs.existsSync(src))
        return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dst, { recursive: true });
    }
    else {
        fs.copyFileSync(src, dst);
    }
}
function backupConflicts(cwd, runStamp) {
    const backupRoot = path.join(cwd, '.traffic-one', 'backups', runStamp);
    const recorded = [];
    for (const rel of exports.CONFLICT_PATHS) {
        const src = path.join(cwd, rel);
        if (!fs.existsSync(src))
            continue;
        const dst = path.join(backupRoot, rel);
        try {
            copyRecursive(src, dst);
            recorded.push({ rel, sha: sha1OfPath(src) });
        }
        catch {
            // best-effort; absence of backup is non-fatal
        }
    }
    return { backupRoot, recorded };
}
function restoreIfOverwritten(cwd, backups) {
    const restored = [];
    for (const { rel, sha } of backups.recorded) {
        const livePath = path.join(cwd, rel);
        const liveSha = sha1OfPath(livePath);
        if (liveSha && sha && liveSha !== sha) {
            const backupPath = path.join(backups.backupRoot, rel);
            try {
                if (fs.existsSync(livePath)) {
                    if (fs.statSync(livePath).isDirectory()) {
                        fs.rmSync(livePath, { recursive: true, force: true });
                    }
                }
                copyRecursive(backupPath, livePath);
                restored.push(rel);
            }
            catch {
                // best-effort
            }
        }
    }
    return restored;
}
function gitnexusPackageSpec() {
    const spec = (0, toolchain_1.getToolSpec)('gitnexus');
    return typeof spec?.recommended === 'string' && spec.recommended
        ? `gitnexus@${spec.recommended}`
        : 'gitnexus';
}
function probeGitnexusVersion(gitnexusBin, nodeBin) {
    if (nodeBin && fs.existsSync(nodeBin)) {
        try {
            const result = (0, child_process_1.spawnSync)(nodeBin, [gitnexusBin, '--version'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 10 * 1000,
            });
            const blob = `${(result.stdout || '').trim()}\n${(result.stderr || '').trim()}`;
            const regex = new RegExp((0, toolchain_1.getToolSpec)('gitnexus')?.versionRegex || 'v?(\\d+\\.\\d+\\.\\d+)');
            const match = regex.exec(blob);
            return match && match[1] ? match[1] : null;
        }
        catch {
            return null;
        }
    }
    return (0, toolchain_1.probeToolVersion)('gitnexus', { binPath: gitnexusBin });
}
function stampToolchain(cwd, gitnexusBin, version) {
    if (!version)
        return;
    const current = readState(cwd);
    const updated = (0, toolchain_1.mergeToolchainStamp)(current, 'gitnexus', {
        version,
        binPath: gitnexusBin,
        at: (0, text_1.nowIso)(),
    });
    writeStateMerge(cwd, { toolchain: updated.toolchain });
}
function installNode22WithNvm() {
    if (!(0, nvm_1.nvmPresent)())
        return { ok: false, error: 'nvm is not installed, so the hook cannot prepare Node 22 for GitNexus automatically' };
    const result = (0, child_process_1.spawnSync)('bash', ['-lc', `. "$HOME/.nvm/nvm.sh" && nvm install ${nvm_1.GITNEXUS_MIN_NODE_MAJOR}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5 * 60 * 1000,
    });
    if (result.status === 0)
        return { ok: true, error: null };
    return { ok: false, error: `nvm install ${nvm_1.GITNEXUS_MIN_NODE_MAJOR} failed: ${(result.stderr || result.stdout || '').trim() || 'non-zero exit'}` };
}
function npmForGitnexus() {
    const nvm22 = (0, nvm_1.findNvmNode22)();
    if (nvm22 && nvm22.npm && nvm22.node) {
        return { npmCmd: nvm22.npm, nodeBin: nvm22.node, action: 'installed-managed-nvm-v22', error: null };
    }
    const major = (0, nvm_1.currentNodeMajor)();
    if (major !== null && major >= nvm_1.GITNEXUS_MIN_NODE_MAJOR && which('npm')) {
        return { npmCmd: 'npm', nodeBin: which('node'), action: 'installed-managed-npm', error: null };
    }
    const nvmInstall = installNode22WithNvm();
    if (nvmInstall.ok) {
        const installed = (0, nvm_1.findNvmNode22)();
        if (installed && installed.npm && installed.node) {
            return { npmCmd: installed.npm, nodeBin: installed.node, action: 'installed-managed-nvm-v22', error: null };
        }
    }
    return {
        npmCmd: '',
        nodeBin: null,
        action: 'install-skipped',
        error: nvmInstall.error || `GitNexus needs Node >=${nvm_1.GITNEXUS_MIN_NODE_MAJOR}, and no compatible npm is available for hook-owned install.`,
    };
}
function tryInstall(cwd) {
    const npm = npmForGitnexus();
    if (npm.error || !npm.npmCmd) {
        return {
            action: 'install-skipped',
            error: npm.error || 'npm unavailable for GitNexus install',
        };
    }
    const prefix = (0, toolchain_1.managedNpmPrefix)('gitnexus');
    const result = (0, child_process_1.spawnSync)(npm.npmCmd, ['install', '-g', '--prefix', prefix, gitnexusPackageSpec()], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180 * 1000,
    });
    const installedAbs = (0, toolchain_1.managedNpmBin)('gitnexus', 'gitnexus');
    if (result.status === 0 && fs.existsSync(installedAbs)) {
        const installedVersion = probeGitnexusVersion(installedAbs, npm.nodeBin);
        stampToolchain(cwd, installedAbs, installedVersion);
        return { action: npm.action, error: null, gitnexusBin: installedAbs, nodeBin: npm.nodeBin, installedVersion };
    }
    const stderr = (result.stderr || '').trim();
    return {
        action: 'install-skipped',
        error: `managed npm install of gitnexus failed: ${stderr || 'non-zero exit'}`,
    };
}
function runGitnexus(cwd, opts) {
    // Pick the gitnexus binary in priority order: explicit opts.gitnexusBin (just
    // installed) → absolute nvm-v22 gitnexus (PATH-independent) → npx fallback →
    // bare `gitnexus` from PATH.
    let cmd;
    let baseArgs = ['analyze', '.'];
    const nvm22 = (0, nvm_1.findNvmNode22)();
    let nodeUsed;
    if (opts.gitnexusBin && fs.existsSync(opts.gitnexusBin) && opts.nodeBin && fs.existsSync(opts.nodeBin)) {
        cmd = opts.nodeBin;
        baseArgs = [opts.gitnexusBin, ...baseArgs];
        nodeUsed = opts.nodeBin;
    }
    else if (opts.gitnexusBin && fs.existsSync(opts.gitnexusBin)) {
        cmd = opts.gitnexusBin;
    }
    else if (opts.useNpx) {
        cmd = 'npx';
        baseArgs = ['gitnexus@latest', ...baseArgs];
    }
    else if (nvm22 && nvm22.gitnexus) {
        cmd = nvm22.gitnexus;
    }
    else {
        cmd = 'gitnexus';
    }
    // Fresh scaffolds typically don't have `.git/` initialised yet. GitNexus
    // refuses non-git folders by default with a tip it writes to STDOUT (not
    // stderr), so a naïve runner would surface an opaque non-zero with empty
    // stderr. Pre-detect and pass `--skip-git` ourselves.
    const hasGit = fs.existsSync(path.join(cwd, '.git'));
    if (!hasGit)
        baseArgs.push('--skip-git');
    const result = (0, child_process_1.spawnSync)(cmd, baseArgs, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5 * 60 * 1000,
    });
    return {
        status: typeof result.status === 'number' ? result.status : 1,
        stderr: (result.stderr || '').trim(),
        stdout: (result.stdout || '').trim(),
        skippedGit: !hasGit,
        binUsed: cmd,
        nodeUsed,
    };
}
function ensureGitnexusTool(cwd = process.cwd(), opts = {}) {
    const state = readState(cwd);
    if (state.codeGraphAutoRun === false || state.graphifyAutoRun === false) {
        return { ok: false, action: 'install-skipped', error: 'codeGraphAutoRun is false in local Traffic One preferences', gitnexusBin: null };
    }
    const nvm22 = (0, nvm_1.findNvmNode22)();
    const major = typeof opts.nodeMajor === 'number' ? opts.nodeMajor : (0, nvm_1.currentNodeMajor)();
    const managedBin = (0, toolchain_1.managedNpmBin)('gitnexus', 'gitnexus');
    const candidates = [
        { binPath: fs.existsSync(managedBin) ? managedBin : null, action: 'used-managed', nodeBin: (nvm22 && nvm22.node) || (major !== null && major >= nvm_1.GITNEXUS_MIN_NODE_MAJOR ? which('node') : null) },
        { binPath: nvm22 && nvm22.gitnexus ? nvm22.gitnexus : null, action: 'used-nvm-v22', nodeBin: nvm22 && nvm22.node },
        { binPath: which('gitnexus'), action: 'used-existing', nodeBin: null },
    ];
    for (const candidate of candidates) {
        if (!candidate.binPath)
            continue;
        const version = candidate.nodeBin
            ? probeGitnexusVersion(candidate.binPath, candidate.nodeBin)
            : (0, toolchain_1.probeTool)('gitnexus', candidate.binPath).version;
        const status = (0, toolchain_1.toolStatus)('gitnexus', version);
        const usable = version ? (0, toolchain_1.isToolUsable)(status.status) : false;
        if (usable) {
            stampToolchain(cwd, candidate.binPath, version);
            return { ok: true, action: candidate.action, error: null, gitnexusBin: candidate.binPath, nodeBin: candidate.nodeBin, installedVersion: version };
        }
    }
    if (opts.skipInstall) {
        return { ok: false, action: 'install-skipped', error: 'gitnexus is missing or below the minimum supported version and skipInstall=true', gitnexusBin: null };
    }
    const installResult = tryInstall(cwd);
    if (installResult.error || !installResult.gitnexusBin) {
        writeStateMerge(cwd, { gitnexusLastErrorAt: (0, text_1.nowIso)(), gitnexusLastError: installResult.error || 'gitnexus still not available after install attempt' });
        return { ok: false, action: installResult.action, error: installResult.error || 'gitnexus not available after install', gitnexusBin: null };
    }
    return {
        ok: true,
        action: installResult.action,
        error: null,
        gitnexusBin: installResult.gitnexusBin,
        nodeBin: installResult.nodeBin,
        installedVersion: installResult.installedVersion,
    };
}
function bootstrap(cwd = process.cwd(), opts = {}) {
    const startedAt = Date.now();
    const reportAbs = path.join(cwd, exports.GITNEXUS_DIR);
    // Opt-out: provider-agnostic `codeGraphAutoRun: false`; the older
    // `graphifyAutoRun: false` is also honoured for forward compatibility.
    const state = readState(cwd);
    if (state.codeGraphAutoRun === false || state.graphifyAutoRun === false) {
        return { ok: false, action: 'install-skipped', report: null, error: 'codeGraphAutoRun is false in local Traffic One preferences', durationMs: 0 };
    }
    // Fresh-cache short-circuit.
    if (!opts.force && fs.existsSync(reportAbs)) {
        let mtimeMs = 0;
        try {
            mtimeMs = fs.statSync(reportAbs).mtimeMs;
        }
        catch {
            mtimeMs = 0;
        }
        if (mtimeMs > 0 && (Date.now() - mtimeMs) < exports.REPORT_FRESH_MS) {
            return { ok: true, action: 'fresh', report: reportAbs, error: null, durationMs: 0, license: 'PolyForm Noncommercial' };
        }
    }
    let action = 'used-existing';
    let useNpx = false;
    const ensured = ensureGitnexusTool(cwd, opts);
    action = ensured.action;
    if (!ensured.ok || !ensured.gitnexusBin) {
        return {
            ok: false,
            action,
            report: null,
            error: ensured.error || 'gitnexus not available after install',
            durationMs: Date.now() - startedAt,
            license: 'PolyForm Noncommercial',
            nodeMajor: typeof opts.nodeMajor === 'number' ? opts.nodeMajor : (0, nvm_1.currentNodeMajor)(),
            requiredNodeMajor: nvm_1.GITNEXUS_MIN_NODE_MAJOR,
        };
    }
    // Conflict mitigation: GitNexus auto-writes AGENTS.md / CLAUDE.md /
    // .claude/skills/ which overlap traffic-one's own. Back up first.
    const runStamp = runStampForFs();
    const backups = backupConflicts(cwd, runStamp);
    const run = runGitnexus(cwd, { useNpx, gitnexusBin: ensured.gitnexusBin, nodeBin: ensured.nodeBin });
    if (run.status !== 0) {
        // GitNexus writes diagnostic tips to STDOUT, not stderr; surface stdout
        // when stderr is empty so the agent has something actionable to relay.
        const detail = run.stderr || run.stdout || 'gitnexus exited non-zero';
        writeStateMerge(cwd, { gitnexusLastErrorAt: (0, text_1.nowIso)(), gitnexusLastError: detail });
        return { ok: false, action, report: null, error: detail, durationMs: Date.now() - startedAt, license: 'PolyForm Noncommercial', backupRoot: backups.backupRoot };
    }
    // Restore traffic-one's versions of AGENTS.md / CLAUDE.md / .claude/skills
    // if GitNexus's run changed them.
    const restored = restoreIfOverwritten(cwd, backups);
    // Sanity-check that GitNexus actually produced its index.
    if (!fs.existsSync(reportAbs)) {
        writeStateMerge(cwd, { gitnexusLastErrorAt: (0, text_1.nowIso)(), gitnexusLastError: 'gitnexus ran but .gitnexus/ was not produced' });
        return { ok: false, action, report: null, error: 'gitnexus ran but .gitnexus/ was not produced', durationMs: Date.now() - startedAt, license: 'PolyForm Noncommercial', backupRoot: backups.backupRoot, restored };
    }
    // Probe the just-run binary's `--version` and stamp local preferences →
    // `toolchain.gitnexus` so doctor + future runners can compare installed-vs-
    // recommended without re-probing.
    let installedVersion = null;
    let probedBin = null;
    try {
        const binCandidate = ensured.gitnexusBin || run.binUsed || (which('gitnexus') || null);
        if (binCandidate && run.nodeUsed && fs.existsSync(binCandidate.replace(/\s.*/, ''))) {
            probedBin = binCandidate;
            installedVersion = probeGitnexusVersion(binCandidate, run.nodeUsed);
        }
        else if (binCandidate && fs.existsSync(binCandidate.replace(/\s.*/, ''))) {
            probedBin = binCandidate;
            installedVersion = (0, toolchain_1.probeToolVersion)('gitnexus', { binPath: binCandidate });
        }
        else if (binCandidate) {
            // npx case — `binCandidate` is "npx" with args appended; probe via PATH.
            installedVersion = (0, toolchain_1.probeToolVersion)('gitnexus');
        }
        if (installedVersion) {
            const current = readState(cwd);
            const updated = (0, toolchain_1.mergeToolchainStamp)(current, 'gitnexus', {
                version: installedVersion,
                binPath: probedBin || undefined,
                at: (0, text_1.nowIso)(),
            });
            writeStateMerge(cwd, { toolchain: updated.toolchain });
        }
    }
    catch {
        // best-effort; never fail the run because the version probe glitched.
    }
    writeStateMerge(cwd, { gitnexusLastRunAt: (0, text_1.nowIso)() });
    // Write the compact graph preview so subagent SessionStart hooks can inline
    // a ~500-token module listing instead of forcing a full Read.
    try {
        (0, materialize_1.writeGraphPreview)(cwd, 'gitnexus');
    }
    catch {
        // best-effort; never fail the run because preview write glitched.
    }
    return {
        ok: true,
        action,
        report: reportAbs,
        error: null,
        durationMs: Date.now() - startedAt,
        license: 'PolyForm Noncommercial',
        backupRoot: backups.backupRoot,
        restored,
        installedVersion,
    };
}
