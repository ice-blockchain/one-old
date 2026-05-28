"use strict";
// src/shared/detection/index.ts
// Project mode + stack detection from package.json / workspace files / prompt
// text. Read-only. Ported 1:1 from scripts/hook-runtime/detection/*.
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
exports.loadPackageJson = loadPackageJson;
exports.dependenciesFromPackage = dependenciesFromPackage;
exports.hasWorkspaces = hasWorkspaces;
exports.workspaceYamlPresent = workspaceYamlPresent;
exports.countSourceFiles = countSourceFiles;
exports.detectMode = detectMode;
exports.detectStackFromCodebase = detectStackFromCodebase;
exports.classifyPromptForStack = classifyPromptForStack;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fsjson_1 = require("../fsjson");
function loadPackageJson(cwd) {
    return (0, fsjson_1.readJson)(path.join(cwd, 'package.json'), {});
}
function dependenciesFromPackage(pkg) {
    const p = pkg && typeof pkg === 'object' ? pkg : {};
    const deps = p.dependencies && typeof p.dependencies === 'object' ? p.dependencies : {};
    const dev = p.devDependencies && typeof p.devDependencies === 'object' ? p.devDependencies : {};
    return { ...deps, ...dev };
}
function hasWorkspaces(pkg) {
    const p = pkg && typeof pkg === 'object' ? pkg : {};
    return Boolean(p.workspaces) || Object.prototype.hasOwnProperty.call(p, 'pnpm');
}
function workspaceYamlPresent(cwd) {
    return fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml')) || fs.existsSync(path.join(cwd, 'pnpm-workspace.yml'));
}
const SOURCE_EXTS = new Set([
    '.tsx', '.ts', '.jsx', '.js', '.vue', '.svelte',
    '.go', '.rs', '.py', '.java', '.kt', '.kts', '.cs', '.php', '.rb',
    '.swift', '.dart', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
]);
function countSourceFiles(cwd) {
    let count = 0;
    function walk(currentDir) {
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git')
                    continue;
                walk(fullPath);
                continue;
            }
            if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name)))
                count += 1;
        }
    }
    walk(cwd);
    return count;
}
function detectMode(cwd) {
    const deps = dependenciesFromPackage(loadPackageJson(cwd));
    const fileCount = countSourceFiles(cwd);
    if (fileCount <= 5)
        return 'new-project';
    if (deps['@supabase/supabase-js'] || deps['@supabase/ssr'])
        return 'existing-with-supabase';
    return 'existing-codebase';
}
// ── text classification ──────────────────────────────────────────────────────
function includesAny(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
}
function detectFrontendFromText(text) {
    if (/\b(next\.?js|nextjs)\b/.test(text))
        return 'nextjs';
    if (/\bvue\b|\bnuxt\b/.test(text))
        return 'vue';
    if (/\bsvelte\b|\bsveltekit\b/.test(text))
        return 'svelte';
    if (/\bangular\b/.test(text))
        return 'angular';
    if (/\bastro\b/.test(text))
        return 'astro';
    if (/\bsolid\b/.test(text))
        return 'solid';
    if (/\bremix\b/.test(text))
        return 'remix';
    if (/\breact\b|\bvite\b/.test(text))
        return 'react-vite';
    return null;
}
function detectBackendFromText(text) {
    if (/\bsupabase\b/.test(text))
        return 'supabase';
    if (/\bfirebase\b|\bfirestore\b/.test(text))
        return 'firebase';
    if (/\bmongo(db)?\b/.test(text))
        return 'mongo';
    if (/\bnest(js)?\b/.test(text))
        return 'nestjs';
    if (/\bfastapi\b/.test(text))
        return 'fastapi';
    if (/\bdjango\b/.test(text))
        return 'django';
    if (/\bpython\b/.test(text))
        return 'python';
    if (/\bgolang\b|\bgo backend\b|\bgo api\b/.test(text))
        return 'go';
    if (/\brust\b/.test(text))
        return 'rust';
    if (/\bspring\b|\bspring boot\b/.test(text))
        return 'java';
    if (/\bkotlin\b|\bktor\b/.test(text))
        return 'kotlin';
    if (/\blaravel\b/.test(text))
        return 'laravel';
    if (/\bphp\b/.test(text))
        return 'php';
    if (/\b\.net\b|\bdotnet\b|\bc#\b/.test(text))
        return 'dotnet';
    if (/\bnode\b|\bexpress\b|\btypescript backend\b/.test(text))
        return 'node';
    if (/\bown api\b|\bexisting api\b|\bexternal api\b/.test(text))
        return 'external-api';
    if (/\bno backend\b|\bfrontend[- ]only\b|\bstatic only\b/.test(text))
        return 'none';
    return null;
}
function detectMobileFromText(text) {
    const hasMobileIntent = includesAny(text, [
        /\bmobile app\b/, /\bios\b/, /\bandroid\b/, /\bapp store\b/, /\bplay store\b/,
        /\bcapacitor\b/, /\bionic\b/, /\breact native\b/, /\bexpo\b/, /\brn\b/,
    ]);
    if (!hasMobileIntent)
        return { enabled: false, framework: 'none', source: 'none', intentDetected: false };
    if (/\breact native\b|\bexpo\b|\brn\b/.test(text)) {
        return { enabled: true, framework: 'react-native-expo', source: 'explicit', intentDetected: true };
    }
    return { enabled: true, framework: 'ionic-capacitor', source: 'explicit', intentDetected: true };
}
function detectStackFromCodebase(cwd) {
    const out = { stack: null, backend: null, frontend: null, realtime: null, evidence: [] };
    const deps = dependenciesFromPackage(loadPackageJson(cwd));
    if (fs.existsSync(path.join(cwd, 'go.mod'))) {
        out.stack = 'custom-backend';
        out.backend = 'go';
        out.frontend = 'none';
        out.evidence.push('go.mod detected → apply Go backend skills');
    }
    if (Object.keys(deps).length === 0)
        return out;
    const isNative = Boolean(deps.expo || deps['react-native']);
    const isReact = Boolean(deps.react);
    const frameworkDetections = [
        { frontend: 'nextjs', matches: Boolean(deps.next), evidence: 'next in deps → apply custom-frontend stack + Next.js provider-first recommendations' },
        { frontend: 'vue', matches: Boolean(deps.vue || deps.nuxt || deps['@vitejs/plugin-vue']), evidence: 'vue/nuxt in deps → apply custom-frontend stack + Vue-native patterns' },
        { frontend: 'svelte', matches: Boolean(deps.svelte || deps['@sveltejs/kit']), evidence: 'svelte/sveltekit in deps → apply custom-frontend stack + Svelte-native patterns' },
        { frontend: 'angular', matches: Boolean(deps['@angular/core'] || deps['@angular/cli']), evidence: 'angular in deps → apply custom-frontend stack + Angular-native patterns' },
        { frontend: 'astro', matches: Boolean(deps.astro), evidence: 'astro in deps → apply custom-frontend stack + Astro-native patterns' },
        { frontend: 'solid', matches: Boolean(deps['solid-js'] || deps['@solidjs/start']), evidence: 'solid in deps → apply custom-frontend stack + Solid-native patterns' },
        { frontend: 'remix', matches: Boolean(deps['@remix-run/react'] || deps['@remix-run/node'] || deps['@remix-run/dev']), evidence: 'remix in deps → apply custom-frontend stack + Remix-native patterns' },
        { frontend: 'gatsby', matches: Boolean(deps.gatsby), evidence: 'gatsby in deps → apply custom-frontend stack + Gatsby-native patterns' },
        { frontend: 'qwik', matches: Boolean(deps['@builder.io/qwik'] || deps['@builder.io/qwik-city']), evidence: 'qwik in deps → apply custom-frontend stack + Qwik-native patterns' },
        { frontend: 'preact', matches: Boolean(deps.preact), evidence: 'preact in deps → apply custom-frontend stack + Preact-native patterns' },
        { frontend: 'lit', matches: Boolean(deps.lit || deps['lit-html'] || deps['lit-element']), evidence: 'lit in deps → apply custom-frontend stack + Lit-native patterns' },
        { frontend: 'ember', matches: Boolean(deps['ember-source'] || deps['ember-cli']), evidence: 'ember in deps → apply custom-frontend stack + Ember-native patterns' },
        { frontend: 'alpine', matches: Boolean(deps.alpinejs), evidence: 'alpinejs in deps → apply custom-frontend stack + Alpine-native patterns' },
        { frontend: 'stencil', matches: Boolean(deps['@stencil/core']), evidence: 'stencil in deps → apply custom-frontend stack + Stencil-native patterns' },
        { frontend: 'marko', matches: Boolean(deps.marko), evidence: 'marko in deps → apply custom-frontend stack + Marko-native patterns' },
    ];
    const detected = frameworkDetections.find((candidate) => candidate.matches);
    if (detected) {
        out.stack = 'custom-frontend';
        out.frontend = detected.frontend;
        out.evidence.push(detected.evidence);
    }
    else if (isNative) {
        out.stack = 'custom-frontend';
        out.frontend = 'none';
        out.mobile = { enabled: true, framework: 'react-native-expo', source: 'explicit' };
        out.evidence.push('react-native/expo in deps');
    }
    else if (isReact) {
        out.stack = deps['@supabase/supabase-js'] || deps['@supabase/ssr'] ? 'default' : 'custom-backend';
        out.frontend = 'react-vite';
        out.evidence.push('react in deps');
    }
    if (deps['@supabase/supabase-js'] || deps['@supabase/ssr']) {
        out.backend = 'supabase';
        out.evidence.push('supabase detected → recommend our fork once');
    }
    else if (deps.firebase || deps['firebase-admin']) {
        out.backend = 'firebase';
        out.evidence.push('firebase detected');
    }
    if (!out.backend && out.stack === 'custom-backend' && out.frontend === 'react-vite') {
        out.backend = 'none';
    }
    if (deps['socket.io-client'] || deps['socket.io'] || deps.ws) {
        out.realtime = 'light';
        out.evidence.push('websocket lib detected');
    }
    return out;
}
function classifyPromptForStack(prompt) {
    const text = String(prompt || '').toLowerCase();
    const frontend = detectFrontendFromText(text);
    const backend = detectBackendFromText(text);
    const mobile = detectMobileFromText(text);
    const wantsMinimal = includesAny(text, [
        /\blanding page\b/, /\bpresentation\b/, /\bbrochure\b/, /\bportfolio\b/,
        /\bone[- ]page\b/, /\bstatic\b/, /\bsimple website\b/,
    ]);
    const backendNeed = includesAny(text, [
        /\bauth\b/, /\blogin\b/, /\bsign ?up\b/, /\busers?\b/, /\bprofiles?\b/,
        /\bcrud\b/, /\bdatabase\b/, /\bdb\b/, /\bbackend\b/, /\bapi\b/,
        /\buploads?\b/, /\bfiles?\b/, /\brealtime\b/, /\breal[- ]time\b/,
        /\bdashboard\b/, /\badmin\b/, /\bpayments?\b/, /\bmarketplace\b/,
        /\bsaas\b/, /\bmvp\b/, /\bplatform\b/, /\bapp\b/,
    ]);
    const explicitCustomFrontend = Boolean(frontend && frontend !== 'react-vite');
    const explicitCustomBackend = Boolean(backend && backend !== 'supabase' && backend !== 'none');
    const noBackend = backend === 'none';
    let resolvedFrontend = frontend || 'react-vite';
    let resolvedBackend = backend || (backendNeed || mobile.enabled ? 'supabase' : 'none');
    let stack;
    if (wantsMinimal && !backendNeed && !frontend && !mobile.enabled) {
        stack = 'minimal';
        resolvedFrontend = 'none';
        resolvedBackend = 'none';
    }
    else if (mobile.enabled && !frontend) {
        stack = explicitCustomBackend ? 'custom-stack' : 'custom-frontend';
        resolvedFrontend = mobile.framework === 'ionic-capacitor' ? 'react-vite' : 'none';
        resolvedBackend = resolvedBackend === 'none' ? 'supabase' : resolvedBackend;
    }
    else if (explicitCustomFrontend && explicitCustomBackend) {
        stack = 'custom-stack';
    }
    else if (explicitCustomFrontend) {
        stack = 'custom-frontend';
        resolvedBackend = resolvedBackend === 'none' ? 'supabase' : resolvedBackend;
    }
    else if (explicitCustomBackend || noBackend) {
        stack = 'custom-backend';
    }
    else if (backendNeed) {
        stack = 'default';
    }
    else if (frontend === 'react-vite') {
        stack = resolvedBackend === 'none' ? 'custom-backend' : 'default';
    }
    else {
        stack = 'minimal';
        resolvedFrontend = 'none';
        resolvedBackend = 'none';
    }
    return {
        stack,
        frontend: resolvedFrontend,
        backend: resolvedBackend,
        mobile: { enabled: mobile.enabled, framework: mobile.framework, source: mobile.source },
        shouldAskMobile: stack !== 'minimal',
        evidence: {
            frontend: frontend || null,
            backend: backend || null,
            mobileIntentDetected: mobile.intentDetected,
            backendNeed,
            wantsMinimal,
        },
    };
}
