"use strict";
// src/shared/materialize/materialize.ts
// The materialization writer: copies the active rules + skills into the project's
// .traffic-one/, renders AGENTS.md/CLAUDE.md, writes the manifest, and cleans up
// stale generated assets. Ported 1:1 from materializeProjectAssets.cjs.
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
exports.materializeProjectAssets = materializeProjectAssets;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const authoring_root_1 = require("../authoring-root");
const fs_text_1 = require("../fs-text");
const paths_1 = require("../paths");
const skill_filters_1 = require("../skill-filters");
const stacks_1 = require("../stacks");
const text_1 = require("../text");
const cleanup_1 = require("./cleanup");
const generated_1 = require("./generated");
const has_assets_1 = require("./has-assets");
const render_agents_1 = require("./render-agents");
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
function materializeProjectAssets(cwd, state) {
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd)) {
        return { rules: 0, skills: 0, written: 0, removed: 0, contextProfile: 'plugin-authoring', skipped: 'plugin-authoring-root' };
    }
    const root = (0, paths_1.pluginRoot)();
    const leanMode = (0, has_assets_1.isLeanMaterialization)(cwd, state);
    const spec = (0, stacks_1.stackSpecForState)(state);
    const mandatoryRules = unique([...spec.mandatory, ...(0, cleanup_1.modeRulesForState)(root, state)])
        .filter((relPath) => fs.existsSync(path.join(root, (0, stacks_1.templatePath)(relPath))));
    const referenceRules = unique(spec.optional)
        .filter((relPath) => fs.existsSync(path.join(root, (0, stacks_1.templatePath)(relPath))));
    const rules = unique([...mandatoryRules, ...referenceRules]);
    const skills = [...(0, skill_filters_1.activeSkillsFor)(state)]
        .filter((name) => !skill_filters_1.BOOTSTRAP_SKILLS.has(name)) // bootstrap skills live in the host skills/ dir, not per-project
        .filter((name) => fs.existsSync(path.join(root, 'skills-catalog', name, 'SKILL.md')))
        .sort();
    const previous = (0, cleanup_1.loadPreviousManifest)(cwd);
    const removed = (0, cleanup_1.cleanupPrevious)(cwd, previous, new Set(rules), new Set(skills));
    let written = 0;
    const projectMemoryRoot = path.join(cwd, '.traffic-one');
    for (const relPath of rules) {
        const source = fs.readFileSync(path.join(root, (0, stacks_1.templatePath)(relPath)), 'utf8').trimEnd();
        const content = `${generated_1.GENERATED_MARKER}\n<!-- SOURCE: ${(0, stacks_1.templatePath)(relPath)} -->\n\n${source}\n`;
        if ((0, fs_text_1.writeTextIfChanged)(path.join(projectMemoryRoot, relPath), content))
            written += 1;
    }
    const skillsRoot = path.join(cwd, '.traffic-one', 'skills');
    for (const name of skills) {
        if ((0, generated_1.copySkillDir)(path.join(root, 'skills-catalog', name), path.join(skillsRoot, name)))
            written += 1;
    }
    if ((0, render_agents_1.preserveManualRootContext)(cwd, 'AGENTS.md', state))
        written += 1;
    if ((0, render_agents_1.preserveManualRootContext)(cwd, 'CLAUDE.md', state))
        written += 1;
    const localAgents = (0, render_agents_1.renderAgentsWithLocalContext)(cwd, state, rules, skills, { mandatoryRules, referenceRules });
    if ((0, render_agents_1.writeRootAgents)(cwd, localAgents))
        written += 1;
    if ((0, render_agents_1.writeRootClaude)(cwd))
        written += 1;
    const mobile = state.mobile;
    const manifest = {
        generatedBy: 'traffic-one',
        generatedAt: (0, text_1.nowIsoNoMs)(),
        contextProfile: leanMode ? 'lean' : 'full',
        stack: state.stack || 'minimal',
        frontend: state.frontend || 'none',
        backend: state.backend || 'none',
        mobile: (mobile && mobile.framework) || 'none',
        rules: rules.map(fs_text_1.toPosix),
        skills,
    };
    if ((0, fs_text_1.writeTextIfChanged)(path.join(cwd, '.traffic-one', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)) {
        written += 1;
    }
    return { rules: rules.length, skills: skills.length, written, removed, contextProfile: leanMode ? 'lean' : 'full' };
}
