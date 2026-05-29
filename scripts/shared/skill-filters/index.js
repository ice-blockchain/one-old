"use strict";
// src/shared/skill-filters/index.ts
// Stack-aware skill filtering. Ported 1:1 from scripts/hook-runtime/skill-filters/*.
//   - activeSkillsFor(state) → the skill set for a stack (_common ∪ stack sets).
//   - pruneSkillsDirective → the [ACTIVE SKILLS]/[DO NOT INVOKE] SessionStart block.
//   - cleanActiveSkills/copyActiveSkills → cache surgery (plugin install path only).
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
exports.restoreDisabledSkills = exports.pruneCacheSkills = exports.SKILL_FILTERS = exports.BOOTSTRAP_SKILLS = void 0;
exports.activeSkillsFor = activeSkillsFor;
exports.pruneSkillsDirective = pruneSkillsDirective;
exports.listAllSkills = listAllSkills;
exports.cleanActiveSkills = cleanActiveSkills;
exports.copyActiveSkills = copyActiveSkills;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const paths_1 = require("../paths");
const SKILLS_TEMPLATES_DIR = 'skills-catalog';
const SKILLS_ACTIVE_DIR = 'skills';
exports.BOOTSTRAP_SKILLS = new Set(['traffic-one-doctor']);
exports.SKILL_FILTERS = {
    _common: new Set([
        'library-pick', 'context-budget', 'execution-discipline',
        'git-commit', 'refactor', 'security-review', 'security-scan',
        'repo-scan', 'verification-loop', 'tdd-workflow',
        'coding-standards', 'i18n-text', 'ui-demo', 'design-system',
        'architecture-decision-records', 'deployment-patterns',
        'auto-documentation-generator', 'project-memory',
        'api-design', 'api-connector-builder', 'adaptive-communication',
        'documentation-lookup', 'observability', 'app-launch-checklist',
        'design-audit', 'browser-qa', 'supabase-setup', 'predeploy-security-check',
        'senior-eng-orchestrator', 'traffic-one-doctor', 'token-usage-report', 'model-tier-sync',
    ]),
    'react-vite': new Set([
        'create-component', 'create-feature', 'create-page', 'create-service',
        'frontend-design', 'frontend-patterns', 'accessibility', 'ionic-mobile',
        'vite-patterns', 'click-path-audit', 'seo', 'e2e-testing', 'ai-regression-testing',
        'monorepo-architecture',
    ]),
    nextjs: new Set([
        'frontend-design', 'frontend-patterns', 'accessibility', 'click-path-audit', 'seo',
        'e2e-testing', 'nextjs-turbopack',
    ]),
    'custom-web': new Set([
        'frontend-design', 'frontend-patterns', 'accessibility', 'click-path-audit', 'seo', 'e2e-testing',
    ]),
    'ionic-capacitor': new Set([
        'ionic-mobile', 'frontend-design', 'frontend-patterns', 'accessibility', 'e2e-testing', 'browser-qa',
    ]),
    'react-native-expo': new Set([
        'create-native-component', 'create-native-feature', 'create-native-screen', 'create-native-service',
        'frontend-patterns', 'accessibility', 'e2e-testing',
    ]),
    supabase: new Set(['backend-patterns', 'postgres-review', 'postgres-patterns', 'database-migrations', 'supabase-setup']),
    node: new Set([
        'backend-patterns', 'nestjs-patterns', 'postgres-review', 'postgres-patterns', 'database-migrations',
        'hexagonal-architecture', 'docker-patterns', 'bun-runtime', 'mcp-server-patterns', 'dashboard-builder',
    ]),
    go: new Set(['golang-patterns', 'golang-testing', 'backend-patterns']),
    python: new Set(['python-patterns', 'python-testing', 'backend-patterns']),
    django: new Set(['django-patterns', 'django-security', 'django-tdd', 'django-verification', 'backend-patterns']),
    rust: new Set(['rust-patterns', 'rust-testing', 'backend-patterns']),
    java: new Set(['java-coding-standards', 'springboot-patterns', 'springboot-security', 'springboot-tdd', 'springboot-verification', 'backend-patterns']),
    kotlin: new Set(['kotlin-patterns', 'kotlin-testing', 'kotlin-ktor-patterns', 'kotlin-exposed-patterns', 'backend-patterns']),
    php: new Set(['laravel-patterns', 'laravel-security', 'laravel-tdd', 'laravel-verification', 'backend-patterns']),
    dotnet: new Set(['dotnet-patterns', 'csharp-testing', 'backend-patterns']),
    cpp: new Set(['cpp-coding-standards', 'cpp-testing', 'backend-patterns']),
    perl: new Set(['perl-patterns', 'perl-security', 'perl-testing', 'backend-patterns']),
};
function addSkillSet(out, name) {
    const stackSet = exports.SKILL_FILTERS[name];
    if (!stackSet)
        return;
    for (const skillName of stackSet)
        out.add(skillName);
}
function normalizedSkillState(input) {
    if (input && typeof input === 'object') {
        const i = input;
        return {
            mode: i.mode || 'unknown',
            stack: i.stack || 'minimal',
            frontend: i.frontend || 'none',
            backend: i.backend || 'none',
            onboardingComplete: i.onboardingComplete === true,
            mobile: i.mobile && typeof i.mobile === 'object'
                ? i.mobile
                : { enabled: false, framework: 'none', source: 'none' },
        };
    }
    const stack = typeof input === 'string' ? input : 'minimal';
    const none = { enabled: false, framework: 'none', source: 'none' };
    if (stack === 'default' || stack === 'react-realtime-monorepo') {
        return { mode: 'unknown', stack: 'default', frontend: 'react-vite', backend: 'supabase', onboardingComplete: true, mobile: none };
    }
    if (stack === 'react-frontend-only') {
        return { mode: 'unknown', stack: 'custom-backend', frontend: 'react-vite', backend: 'none', onboardingComplete: true, mobile: none };
    }
    if (stack === 'react-native-expo-monorepo' || stack === 'react-native-expo-app') {
        return { mode: 'unknown', stack: 'custom-frontend', frontend: 'none', backend: 'supabase', onboardingComplete: true, mobile: { enabled: true, framework: 'react-native-expo', source: 'explicit' } };
    }
    return { mode: 'unknown', stack, frontend: 'none', backend: 'none', onboardingComplete: true, mobile: none };
}
function activeSkillsFor(stackOrState) {
    const state = normalizedSkillState(stackOrState);
    if (state.mode === 'new-project' && state.onboardingComplete !== true) {
        return new Set(exports.BOOTSTRAP_SKILLS);
    }
    const out = new Set(exports.SKILL_FILTERS._common);
    if (state.frontend === 'react-vite')
        addSkillSet(out, 'react-vite');
    else if (state.frontend === 'nextjs')
        addSkillSet(out, 'nextjs');
    else if (state.frontend && state.frontend !== 'none')
        addSkillSet(out, 'custom-web');
    if (state.mobile && state.mobile.framework === 'ionic-capacitor')
        addSkillSet(out, 'ionic-capacitor');
    if (state.mobile && state.mobile.framework === 'react-native-expo')
        addSkillSet(out, 'react-native-expo');
    if (state.backend === 'supabase' || state.backend === 'our-fork')
        addSkillSet(out, 'supabase');
    else if (state.backend === 'nestjs')
        addSkillSet(out, 'node');
    else if (state.backend === 'fastapi')
        addSkillSet(out, 'python');
    else if (state.backend === 'laravel')
        addSkillSet(out, 'php');
    else if (state.backend === 'csharp')
        addSkillSet(out, 'dotnet');
    else if (state.backend && state.backend !== 'none' && state.backend !== 'external-api' && state.backend !== 'other') {
        addSkillSet(out, state.backend);
    }
    return out;
}
function pruneSkillsDirective(stackOrState, allSkills) {
    const active = activeSkillsFor(stackOrState);
    const wrongStack = [];
    for (const name of allSkills) {
        if (!active.has(name))
            wrongStack.push(name);
    }
    const activeList = [...active].sort();
    if (activeList.length === 0)
        return '';
    const wrongStackPreview = wrongStack.slice(0, 30).join(', ');
    const wrongStackSuffix = wrongStack.length > 30 ? `, ... +${wrongStack.length - 30} more` : '';
    let directive = `[ACTIVE SKILLS for stack=${normalizedSkillState(stackOrState).stack}]: ${activeList.join(', ')}\n`;
    if (wrongStack.length > 0) {
        directive += `[DO NOT INVOKE — wrong stack]: ${wrongStackPreview}${wrongStackSuffix}\n`;
    }
    return directive;
}
function listAllSkills() {
    const skillsDir = path.join((0, paths_1.pluginRoot)(), SKILLS_ACTIVE_DIR);
    const out = new Set();
    let entries;
    try {
        entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.'))
            out.add(entry.name);
    }
    return out;
}
function copyDirSync(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory())
            copyDirSync(s, d);
        else if (entry.isFile())
            fs.copyFileSync(s, d);
    }
}
function cleanActiveSkills() {
    if (!(0, paths_1.isInPluginCache)())
        return 0;
    const skillsDir = path.join((0, paths_1.pluginRoot)(), SKILLS_ACTIVE_DIR);
    if (!fs.existsSync(skillsDir))
        return 0;
    let removed = 0;
    let entries;
    try {
        entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || exports.BOOTSTRAP_SKILLS.has(entry.name))
            continue;
        try {
            fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
            removed += 1;
        }
        catch {
            // best-effort
        }
    }
    return removed;
}
function copyActiveSkills(stackOrState) {
    if (!(0, paths_1.isInPluginCache)())
        return 0;
    const templatesDir = path.join((0, paths_1.pluginRoot)(), SKILLS_TEMPLATES_DIR);
    const activeDir = path.join((0, paths_1.pluginRoot)(), SKILLS_ACTIVE_DIR);
    if (!fs.existsSync(templatesDir))
        return 0;
    if (!fs.existsSync(activeDir)) {
        try {
            fs.mkdirSync(activeDir, { recursive: true });
        }
        catch {
            return 0;
        }
    }
    let copied = 0;
    for (const name of activeSkillsFor(stackOrState)) {
        if (exports.BOOTSTRAP_SKILLS.has(name))
            continue;
        const src = path.join(templatesDir, name);
        const dst = path.join(activeDir, name);
        if (!fs.existsSync(src) || fs.existsSync(dst))
            continue;
        try {
            copyDirSync(src, dst);
            copied += 1;
        }
        catch {
            // best-effort
        }
    }
    return copied;
}
// Deprecated no-op shims (kept for export-surface compatibility).
const pruneCacheSkills = () => 0;
exports.pruneCacheSkills = pruneCacheSkills;
const restoreDisabledSkills = () => 0;
exports.restoreDisabledSkills = restoreDisabledSkills;
