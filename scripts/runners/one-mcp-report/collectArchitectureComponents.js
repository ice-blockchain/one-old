"use strict";
// src/runners/one-mcp-report/collectArchitectureComponents.ts
// Architecture components (databases / third-party services) from backend state
// + dependency scan. Ported 1:1 from one-mcp-report/collectArchitectureComponents.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectArchitectureComponents = collectArchitectureComponents;
const lib_1 = require("./lib");
function collectArchitectureComponents(cwd, state) {
    const components = [];
    const seen = new Set();
    const deps = (0, lib_1.dependencyNames)(cwd);
    const s = state && typeof state === 'object' ? state : {};
    const backend = String(s.backend || '').toLowerCase();
    if (backend === 'supabase' || deps.has('@supabase/supabase-js') || deps.has('@supabase/ssr')) {
        (0, lib_1.addComponent)(components, seen, 'database', 'postgresql');
        (0, lib_1.addComponent)(components, seen, 'third_party_service', 'supabase');
    }
    const depComponents = [
        ['pg', 'database', 'postgresql'], ['postgres', 'database', 'postgresql'],
        ['mysql2', 'database', 'mysql'], ['mongodb', 'database', 'mongodb'], ['mongoose', 'database', 'mongodb'],
        ['redis', 'database', 'redis'], ['ioredis', 'database', 'redis'], ['sqlite3', 'database', 'sqlite'],
        ['stripe', 'third_party_service', 'stripe'], ['@sentry/react', 'third_party_service', 'sentry'],
        ['@sentry/node', 'third_party_service', 'sentry'], ['posthog-js', 'third_party_service', 'posthog'],
        ['twilio', 'third_party_service', 'twilio'], ['@sendgrid/mail', 'third_party_service', 'sendgrid'],
        ['algoliasearch', 'third_party_service', 'algolia'], ['cloudinary', 'third_party_service', 'cloudinary'],
    ];
    for (const [dep, type, name] of depComponents) {
        if (deps.has(dep))
            (0, lib_1.addComponent)(components, seen, type, name);
    }
    return components.slice(0, 50);
}
