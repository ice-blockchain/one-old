"use strict";
// src/shared/materialize/render-agents.ts
// Renders the project-local AGENTS.md (+ CLAUDE.md symlink). Ported 1:1 from the
// renderAgents family in scripts/hook-runtime/materialize/_helpers.cjs. The
// kernel/read-routing prose is parity-critical — kept verbatim.
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
exports.renderAgents = renderAgents;
exports.preserveManualRootContext = preserveManualRootContext;
exports.renderAgentsWithLocalContext = renderAgentsWithLocalContext;
exports.renderClaudeFallback = renderClaudeFallback;
exports.writeRootAgents = writeRootAgents;
exports.writeRootClaude = writeRootClaude;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fsjson_1 = require("../fsjson");
const fs_text_1 = require("../fs-text");
const paths_1 = require("../paths");
const stacks_1 = require("../stacks");
const generated_1 = require("./generated");
const has_assets_1 = require("./has-assets");
function unique(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        if (!value || seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}
function compactRuleKernel() {
    return [
        '## Active Rule Kernel',
        '',
        'This compact kernel is always-on. Full rule bodies are materialized under `.traffic-one/rules/**`; read the matching rule before work whose behavior, security, data shape, architecture, or UX depends on it.',
        '',
        '- Read project memory first for non-trivial work: `.traffic-one/.agentignore`, product/stack/coding/security notes, known issues, schema, and recent agent log when present.',
        '- Keep changes surgical: preserve existing structure, avoid unrelated refactors, never revert user edits, and match local style even when a different style would be tempting.',
        '- Prefer the selected Traffic One stack and local helpers. Do not add libraries, abstractions, alternate modes, or extension points without a real current caller.',
        '- Security stays active: no secrets in source or memory, validate input at boundaries, enforce auth and authorization server-side, avoid credentialed wildcard CORS, use parameterized SQL, and keep production errors sanitized.',
        '- New-project onboarding gates are blocking: mobile, code graph, and team choices must be persisted before scaffolding; when `team.mode="subagents"`, the parent coordinates and role agents own feature-source writes.',
        '- UI work must satisfy i18n, SEO for public routes, accessibility, responsive layout, real visual polish, stable dimensions, and verification screenshots when the change is visual.',
        '- Backend/data work must keep API contracts explicit, schema changes reviewed, migrations reversible where practical, RLS/storage policies safe, and generated clients or schema snapshots refreshed when applicable.',
        '- Verification should match risk: reproduce bugs when practical, run focused tests/build/lint for touched surfaces, and report any skipped check with the exact reason.',
        '- External or destructive actions still need explicit current confirmation: deploy, publish, push protected environments, run shared/prod migrations, send messages, delete data/files, or call side-effecting external APIs.',
        '',
    ];
}
function compactReadRouting() {
    return [
        '## Read Rules When',
        '',
        '- Starting/scaffolding/onboarding: `rules/modes/new-project.md`, `rules/common/senior-engineer-team.md`, `rules/common/stack-recommendations.md`, `rules/common/project-memory.md`, `rules/common/documentation.md`.',
        '- Editing existing code: `rules/modes/existing-codebase.md`, `rules/common/execution-discipline.md`, `rules/common/clean-code.md`, plus the stack rule for touched files.',
        '- Building UI/pages/components/styles: `rules/frontend/ui-quality.md`, `rules/frontend/typography.md`, `rules/frontend/i18n.md`, `rules/frontend/accessibility.md`, and the framework-specific frontend rules.',
        '- Working on React/Vite state, services, realtime, testing, performance, or security: read the matching `rules/frontend/react/*.md` file before editing.',
        '- Touching Supabase, auth, storage, RLS, SQL, migrations, or schema snapshots: `rules/common/security.md`, `rules/frontend/react/supabase-client.md`, and `rules/backend/postgres.md`.',
        '- Adding APIs, connectors, libraries, observability, docs, SEO, tests, release, or deployment work: read the matching common rule and trigger the matching skill from `.traffic-one/skills/**`.',
        '- Running subagents or fix cycles: `rules/common/agent-handoff-digests.md`, `rules/common/codebase-graph.md`, and the role-scoped rules named in the task prompt.',
        '',
    ];
}
function renderRuleIndexSection(title, relPaths) {
    if (!Array.isArray(relPaths) || relPaths.length === 0)
        return [];
    return [`### ${title}`, '', ...relPaths.map((relPath) => `- .traffic-one/${relPath}`), ''];
}
function ruleGroupsForOptions(rules, options) {
    const mandatory = unique(options.mandatoryRules || []);
    const reference = unique(options.referenceRules || []).filter((relPath) => !mandatory.includes(relPath));
    if (mandatory.length > 0 || reference.length > 0)
        return { mandatory, reference };
    return { mandatory: unique(rules), reference: [] };
}
function renderAgents(state, rules, skills, options = {}) {
    const leanMode = options.leanMode === true;
    const mobile = state.mobile;
    const lines = [
        '# Traffic One Local Agent Context',
        '',
        generated_1.GENERATED_MARKER,
        '',
        leanMode
            ? 'Use the compact project-local rule kernel and index below before falling back to plugin-root rules.'
            : 'Use the project-local active rule bundle below before falling back to plugin-root rules.',
        leanMode
            ? 'Compact context mode keeps critical guidance always-on and reads full `.traffic-one` rules on demand.'
            : 'Host runtimes may read AGENTS.md directly, so active rule contents are inlined instead of relying on host-specific import syntax.',
        '',
        '## Active State',
        '',
        `- Stack: ${state.stack || 'minimal'}`,
        `- Frontend: ${state.frontend || 'none'}`,
        `- Backend: ${state.backend || 'none'}`,
        `- Mobile: ${(mobile && mobile.framework) || 'none'}`,
        '',
        '## Active Rules',
        '',
        ...rules.map((relPath) => `- .traffic-one/${relPath}`),
        '',
        '## Active Skills',
        '',
        ...skills.map((name) => `- .traffic-one/skills/${name}/SKILL.md`),
        '',
    ];
    if (leanMode) {
        const { mandatory, reference } = ruleGroupsForOptions(rules, options);
        lines.push(...compactRuleKernel(), ...compactReadRouting(), '## Active Rule Index', '', 'Full rule content is materialized under `.traffic-one/<path>`.', 'Read only the specific rules needed for the current file or task; the kernel above is the always-on baseline.', '', ...renderRuleIndexSection('Mandatory Baseline', mandatory), ...renderRuleIndexSection('Reference On Demand', reference));
        return `${lines.join('\n')}\n`;
    }
    const root = (0, paths_1.pluginRoot)();
    lines.push('## Active Rule Contents', '');
    for (const relPath of rules) {
        const source = (0, fsjson_1.readText)(path.join(root, (0, stacks_1.templatePath)(relPath)));
        lines.push(`### ${relPath}`, '');
        if (typeof source === 'string' && source.trim()) {
            lines.push(source.trimEnd(), '');
        }
        else {
            lines.push(`Rule source missing in plugin root: ${(0, stacks_1.templatePath)(relPath)}`, '');
        }
    }
    return `${lines.join('\n')}\n`;
}
function localContextName(fileName) {
    return fileName === 'CLAUDE.md' ? 'CLAUDE.local.md' : 'AGENTS.local.md';
}
function preserveManualRootContext(cwd, fileName, state) {
    const rootPath = path.join(cwd, fileName);
    if (!fs.existsSync(rootPath))
        return false;
    const stat = fs.lstatSync(rootPath);
    if (stat.isSymbolicLink() || (0, generated_1.isGenerated)(rootPath))
        return false;
    if (!state || state.mode !== 'new-project')
        return false;
    const localPath = path.join(cwd, '.traffic-one', localContextName(fileName));
    const existing = (0, fsjson_1.readText)(rootPath) || '';
    const preserved = [
        `# Preserved ${fileName}`,
        '',
        `This content existed before Traffic One generated root ${fileName}.`,
        '',
        '---',
        '',
        existing.trimEnd(),
        '',
    ].join('\n');
    if (!fs.existsSync(localPath))
        (0, fs_text_1.writeTextIfChanged)(localPath, preserved);
    fs.rmSync(rootPath, { force: true });
    return true;
}
function localContextBlocks(cwd) {
    const blocks = [];
    for (const fileName of ['AGENTS.local.md', 'CLAUDE.local.md']) {
        const content = (0, fsjson_1.readText)(path.join(cwd, '.traffic-one', fileName));
        if (typeof content === 'string' && content.trim()) {
            blocks.push(`### .traffic-one/${fileName}\n\n${content.trimEnd()}`);
        }
    }
    return blocks;
}
function renderAgentsWithLocalContext(cwd, state, rules, skills, options = {}) {
    const base = renderAgents(state, rules, skills, { leanMode: (0, has_assets_1.isLeanMaterialization)(cwd, state), ...options }).trimEnd();
    const localBlocks = localContextBlocks(cwd);
    if (localBlocks.length === 0)
        return `${base}\n`;
    return [base, '', '## Preserved Project Notes', '', ...localBlocks, ''].join('\n');
}
function renderClaudeFallback() {
    return `${['# Traffic One Claude Context', '', generated_1.GENERATED_MARKER, '', 'Read the canonical root agent context:', '', '@AGENTS.md', ''].join('\n')}\n`;
}
function writeRootAgents(cwd, content) {
    const rootAgents = path.join(cwd, 'AGENTS.md');
    if (fs.existsSync(rootAgents) && !fs.lstatSync(rootAgents).isSymbolicLink() && !(0, generated_1.isGenerated)(rootAgents))
        return false;
    if (fs.existsSync(rootAgents))
        fs.rmSync(rootAgents, { force: true });
    return (0, fs_text_1.writeTextIfChanged)(rootAgents, content);
}
function writeRootClaude(cwd) {
    const rootClaude = path.join(cwd, 'CLAUDE.md');
    if (fs.existsSync(rootClaude) && !fs.lstatSync(rootClaude).isSymbolicLink() && !(0, generated_1.isGenerated)(rootClaude))
        return false;
    if (fs.existsSync(rootClaude))
        fs.rmSync(rootClaude, { force: true });
    try {
        fs.symlinkSync('AGENTS.md', rootClaude);
        return true;
    }
    catch {
        return (0, fs_text_1.writeTextIfChanged)(rootClaude, renderClaudeFallback());
    }
}
