"use strict";
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
exports.toPosix = toPosix;
exports.relativePath = relativePath;
exports.nowIso = nowIso;
exports.timestampSlug = timestampSlug;
exports.runCommand = runCommand;
exports.hasCommand = hasCommand;
exports.isInsideGitWorkTree = isInsideGitWorkTree;
exports.gitOutput = gitOutput;
exports.splitNul = splitNul;
exports.shouldIgnoreFingerprint = shouldIgnoreFingerprint;
exports.trafficStateHasOnlyStampFields = trafficStateHasOnlyStampFields;
exports.normalizeTrafficState = normalizeTrafficState;
exports.hashFileForFingerprint = hashFileForFingerprint;
exports.walkFiles = walkFiles;
exports.listFingerprintFiles = listFingerprintFiles;
exports.readTextFile = readTextFile;
exports.projectFiles = projectFiles;
exports.lineForIndex = lineForIndex;
exports.parseArgs = parseArgs;
exports.helpText = helpText;
exports.createReporter = createReporter;
exports.hasAllowComment = hasAllowComment;
exports.isDocumentationOrFixturePath = isDocumentationOrFixturePath;
exports.isRuntimeAppSecurityPath = isRuntimeAppSecurityPath;
exports.isSecurityHeaderConfigPath = isSecurityHeaderConfigPath;
exports.parseAuditJson = parseAuditJson;
exports.missingToolInstallPrompt = missingToolInstallPrompt;
exports.readPackageJson = readPackageJson;
// src/runners/security-check/helpers.ts
// Low-level helpers: process/git exec, fingerprint + file walking, path
// classifiers, audit-json parsing, CLI args, the reporter, and package.json IO.
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const constants_1 = require("./constants");
function toPosix(filePath) {
    return filePath.split(path.sep).join('/');
}
function relativePath(cwd, filePath) {
    return toPosix(path.relative(cwd, filePath));
}
function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function timestampSlug(iso) {
    return iso.replace(/[-:]/g, '').replace('T', '-').replace('Z', 'Z');
}
function runCommand(command, args, options = {}) {
    const result = (0, child_process_1.spawnSync)(command, args, {
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer || 50 * 1024 * 1024,
    });
    return {
        command,
        args,
        status: typeof result.status === 'number' ? result.status : 1,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error || null,
    };
}
function hasCommand(command, cwd, env) {
    const result = runCommand(command, ['--version'], { cwd, env, maxBuffer: 1024 * 1024 });
    return {
        found: !result.error && result.status === 0,
        version: `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0] || null,
    };
}
function isInsideGitWorkTree(cwd) {
    const result = runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return !result.error && result.status === 0 && result.stdout.trim() === 'true';
}
function gitOutput(cwd, args) {
    const result = runCommand('git', args, { cwd });
    return result.status === 0 ? result.stdout : '';
}
function splitNul(text) {
    return text.split('\0').filter(Boolean);
}
function shouldIgnoreFingerprint(relPath) {
    const normalized = toPosix(relPath);
    return constants_1.FINGERPRINT_IGNORES.some((ignored) => normalized === ignored || normalized.startsWith(ignored));
}
function trafficStateHasOnlyStampFields(cwd, relPath) {
    const normalized = toPosix(relPath);
    if (normalized !== constants_1.STATE_REL_PATH && normalized !== constants_1.LEGACY_STATE_REL_PATH) {
        return false;
    }
    try {
        const decoded = JSON.parse(fs.readFileSync(path.join(cwd, relPath), 'utf8'));
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
            return false;
        }
        const copy = { ...decoded };
        for (const field of constants_1.SECURITY_STAMP_FIELDS) {
            delete copy[field];
        }
        return Object.keys(copy).length === 0;
    }
    catch {
        return false;
    }
}
function normalizeTrafficState(content) {
    try {
        const decoded = JSON.parse(content);
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
            return content;
        }
        const rec = decoded;
        for (const field of constants_1.SECURITY_STAMP_FIELDS) {
            delete rec[field];
        }
        return `${JSON.stringify(rec, null, 2)}\n`;
    }
    catch {
        return content;
    }
}
function hashFileForFingerprint(cwd, relPath) {
    const absPath = path.join(cwd, relPath);
    if (!fs.existsSync(absPath)) {
        return '<deleted>';
    }
    const bytes = fs.readFileSync(absPath);
    const normalized = toPosix(relPath);
    if (normalized === constants_1.STATE_REL_PATH || normalized === constants_1.LEGACY_STATE_REL_PATH) {
        return normalizeTrafficState(bytes.toString('utf8'));
    }
    return bytes;
}
function walkFiles(cwd) {
    const out = [];
    const walk = (currentDir) => {
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (constants_1.WALK_IGNORES.has(entry.name))
                continue;
            const fullPath = path.join(currentDir, entry.name);
            const rel = relativePath(cwd, fullPath);
            if (rel.startsWith('.traffic-one/reports/security/'))
                continue;
            if (entry.isDirectory()) {
                walk(fullPath);
            }
            else if (entry.isFile()) {
                out.push(rel);
            }
        }
    };
    walk(cwd);
    return out.sort();
}
function listFingerprintFiles(cwd) {
    if (isInsideGitWorkTree(cwd)) {
        const tracked = splitNul(gitOutput(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
        return [...new Set(tracked)]
            .map(toPosix)
            .filter((filePath) => !shouldIgnoreFingerprint(filePath))
            .filter((filePath) => !trafficStateHasOnlyStampFields(cwd, filePath))
            .sort();
    }
    return walkFiles(cwd)
        .filter((filePath) => !shouldIgnoreFingerprint(filePath))
        .filter((filePath) => !trafficStateHasOnlyStampFields(cwd, filePath))
        .sort();
}
function readTextFile(cwd, relPath) {
    const absPath = path.join(cwd, relPath);
    let buffer;
    try {
        buffer = fs.readFileSync(absPath);
    }
    catch {
        return null;
    }
    if (buffer.length > 1024 * 1024)
        return null;
    if (buffer.includes(0))
        return null;
    const ext = path.extname(relPath).toLowerCase();
    const base = path.basename(relPath).toLowerCase();
    if (!constants_1.TEXT_EXTENSIONS.has(ext) && !base.startsWith('.env') && base !== '_headers') {
        return null;
    }
    return buffer.toString('utf8');
}
function projectFiles(cwd) {
    if (isInsideGitWorkTree(cwd)) {
        const files = splitNul(gitOutput(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
        return [...new Set(files)].map(toPosix).filter((filePath) => !shouldIgnoreFingerprint(filePath)).sort();
    }
    return walkFiles(cwd).filter((filePath) => !shouldIgnoreFingerprint(filePath));
}
function lineForIndex(text, index) {
    return text.slice(0, index).split(/\r?\n/).length;
}
function parseArgs(argv) {
    const options = { cwd: process.cwd(), strict: false, stamp: false, reportDir: null };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--strict')
            options.strict = true;
        else if (arg === '--stamp')
            options.stamp = true;
        else if (arg === '--no-stamp')
            options.stamp = false;
        else if (arg === '--report-dir') {
            options.reportDir = argv[index + 1] || null;
            index += 1;
        }
        else if (arg === '--cwd') {
            options.cwd = argv[index + 1] || options.cwd;
            index += 1;
        }
        else if (arg === '--help' || arg === '-h')
            options.help = true;
    }
    return options;
}
function helpText() {
    return [
        'Usage: node scripts/security-check-runner.cjs [--strict] [--stamp|--no-stamp] [--report-dir <dir>]',
        '',
        'Runs the Traffic One pre-deployment security scanner.',
        '--strict     Fail on high-confidence security issues and missing required scanners.',
        '--stamp      On a passing run, write lastSecurityCheck* fields to .traffic-one/.one.json.',
        '--no-stamp   Do not write .traffic-one/.one.json. This is the CI default.',
    ].join('\n');
}
function createReporter() {
    const issues = [];
    const addIssue = (severity, category, message, details = {}) => {
        issues.push({
            severity,
            category,
            message,
            file: details.file || null,
            line: details.line || null,
            evidence: details.evidence || null,
            remediation: details.remediation || null,
        });
    };
    return { issues, addIssue };
}
function hasAllowComment(text, index, token) {
    const start = Math.max(0, index - 500);
    const context = text.slice(start, index + 500).toLowerCase();
    return context.includes(token.toLowerCase());
}
function isDocumentationOrFixturePath(filePath) {
    const normalized = toPosix(filePath);
    const base = path.basename(normalized).toLowerCase();
    return (normalized.endsWith('.md')
        || normalized.endsWith('.mdc')
        || normalized.startsWith('skills/')
        || normalized.startsWith('rules/')
        || normalized.startsWith('agents/')
        || normalized.startsWith('docs/')
        || normalized.startsWith('.cursor/rules/')
        || normalized.startsWith('test/')
        || normalized.startsWith('tests/')
        || normalized.includes('/test/')
        || normalized.includes('/tests/')
        || normalized.includes('/__tests__/')
        || normalized.includes('/fixtures/')
        || normalized.includes('/__fixtures__/')
        || normalized.includes('/mocks/')
        || normalized.includes('/__mocks__/')
        || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
        || /^test-.*\.[cm]?js$/.test(base)
        || ['agents.md', 'claude.md', 'readme.md'].includes(base));
}
function isRuntimeAppSecurityPath(filePath) {
    const normalized = toPosix(filePath);
    if (isDocumentationOrFixturePath(normalized))
        return false;
    return (normalized.startsWith('apps/')
        || normalized.startsWith('src/')
        || normalized.startsWith('server/')
        || normalized.startsWith('api/')
        || normalized.startsWith('services/')
        || normalized.startsWith('supabase/functions/')
        || normalized.startsWith('packages/api')
        || normalized.startsWith('packages/ws-client/')
        || normalized.startsWith('packages/ui/')
        || normalized.startsWith('packages/ui-native/')
        || /\.(route|controller)\.[cm]?[jt]s$/.test(normalized));
}
function isSecurityHeaderConfigPath(filePath) {
    const normalized = toPosix(filePath);
    const base = path.basename(normalized).toLowerCase();
    return (base === '_headers'
        || base === 'vercel.json'
        || base === 'netlify.toml'
        || base === 'wrangler.toml'
        || base === 'next.config.js'
        || base === 'next.config.mjs'
        || base === 'next.config.ts'
        || normalized.includes('/nginx')
        || normalized.includes('/caddyfile'));
}
function parseAuditJson(stdout) {
    try {
        const parsed = JSON.parse(stdout);
        const metadata = parsed.metadata;
        const vulns = metadata && typeof metadata === 'object' ? metadata.vulnerabilities : undefined;
        if (vulns) {
            return { parsed: true, high: Number(vulns.high || 0), critical: Number(vulns.critical || 0) };
        }
        if (Array.isArray(parsed.vulnerabilities)) {
            const items = parsed.vulnerabilities;
            return {
                parsed: true,
                high: items.filter((item) => item.severity === 'high').length,
                critical: items.filter((item) => item.severity === 'critical').length,
            };
        }
        if (parsed.advisories && typeof parsed.advisories === 'object') {
            const values = Object.values(parsed.advisories);
            return {
                parsed: true,
                high: values.filter((item) => item.severity === 'high').length,
                critical: values.filter((item) => item.severity === 'critical').length,
            };
        }
    }
    catch {
        // fall through
    }
    return { parsed: false, high: 0, critical: 0 };
}
function missingToolInstallPrompt(missingTools, cwd = process.cwd()) {
    const brew = hasCommand('brew', cwd, process.env);
    const installCommand = brew.found
        ? `brew install ${missingTools.join(' ')}`
        : '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n'
            + `brew install ${missingTools.join(' ')}`;
    return [
        'Traffic One needs local security scanners before it can run the pre-deployment gate.',
        '',
        `Missing: ${missingTools.join(', ')}`,
        '',
        'Benefits of installing them:',
        '- gitleaks scans the working tree and full git history for API keys, service-role keys, tokens, and committed .env secrets before they reach production.',
        '- trufflehog verifies/flags known and unknown secrets across git history, catching leaks that simple pattern matching misses.',
        '- Together they make the local deploy gate match CI instead of discovering credential leaks only after a push.',
        '',
        brew.found
            ? 'Recommended install command:'
            : 'Homebrew was not found. Ask the user to install Homebrew first, then install the scanners:',
        '',
        installCommand,
    ].join('\n');
}
function readPackageJson(cwd) {
    try {
        return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    }
    catch {
        return null;
    }
}
