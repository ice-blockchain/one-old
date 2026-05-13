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
  const sourceExts = new Set([
    '.tsx', '.ts', '.jsx', '.js',
    '.vue', '.svelte',
    '.go', '.rs', '.py', '.java', '.kt', '.kts', '.cs', '.php', '.rb',
    '.swift', '.dart', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
  ]);

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

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function detectFrontendFromText(text) {
  if (/\b(next\.?js|nextjs)\b/.test(text)) return 'nextjs';
  if (/\bvue\b|\bnuxt\b/.test(text)) return 'vue';
  if (/\bsvelte\b|\bsveltekit\b/.test(text)) return 'svelte';
  if (/\bangular\b/.test(text)) return 'angular';
  if (/\bastro\b/.test(text)) return 'astro';
  if (/\bsolid\b/.test(text)) return 'solid';
  if (/\bremix\b/.test(text)) return 'remix';
  if (/\breact\b|\bvite\b/.test(text)) return 'react-vite';
  return null;
}

function detectBackendFromText(text) {
  if (/\bsupabase\b/.test(text)) return 'supabase';
  if (/\bfirebase\b|\bfirestore\b/.test(text)) return 'firebase';
  if (/\bmongo(db)?\b/.test(text)) return 'mongo';
  if (/\bnest(js)?\b/.test(text)) return 'nestjs';
  if (/\bfastapi\b/.test(text)) return 'fastapi';
  if (/\bdjango\b/.test(text)) return 'django';
  if (/\bpython\b/.test(text)) return 'python';
  if (/\bgolang\b|\bgo backend\b|\bgo api\b/.test(text)) return 'go';
  if (/\brust\b/.test(text)) return 'rust';
  if (/\bspring\b|\bspring boot\b/.test(text)) return 'java';
  if (/\bkotlin\b|\bktor\b/.test(text)) return 'kotlin';
  if (/\blaravel\b/.test(text)) return 'laravel';
  if (/\bphp\b/.test(text)) return 'php';
  if (/\b\.net\b|\bdotnet\b|\bc#\b/.test(text)) return 'dotnet';
  if (/\bnode\b|\bexpress\b|\btypescript backend\b/.test(text)) return 'node';
  if (/\bown api\b|\bexisting api\b|\bexternal api\b/.test(text)) return 'external-api';
  if (/\bno backend\b|\bfrontend[- ]only\b|\bstatic only\b/.test(text)) return 'none';
  return null;
}

function detectMobileFromText(text) {
  const hasMobileIntent = includesAny(text, [
    /\bmobile app\b/, /\bios\b/, /\bandroid\b/, /\bapp store\b/, /\bplay store\b/,
    /\bcapacitor\b/, /\bionic\b/, /\breact native\b/, /\bexpo\b/, /\brn\b/,
  ]);
  if (!hasMobileIntent) {
    return { enabled: false, framework: 'none', source: 'none', intentDetected: false };
  }
  if (/\breact native\b|\bexpo\b|\brn\b/.test(text)) {
    return { enabled: true, framework: 'react-native-expo', source: 'explicit', intentDetected: true };
  }
  return { enabled: true, framework: 'ionic-capacitor', source: 'explicit', intentDetected: true };
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
  } else if (mobile.enabled && !frontend) {
    stack = explicitCustomBackend ? 'custom-stack' : 'custom-frontend';
    resolvedFrontend = mobile.framework === 'ionic-capacitor' ? 'react-vite' : 'none';
    resolvedBackend = resolvedBackend === 'none' ? 'supabase' : resolvedBackend;
  } else if (explicitCustomFrontend && explicitCustomBackend) {
    stack = 'custom-stack';
  } else if (explicitCustomFrontend) {
    stack = 'custom-frontend';
    resolvedBackend = resolvedBackend === 'none' ? 'supabase' : resolvedBackend;
  } else if (explicitCustomBackend || noBackend) {
    stack = 'custom-backend';
  } else if (backendNeed) {
    stack = 'default';
  } else if (frontend === 'react-vite') {
    stack = resolvedBackend === 'none' ? 'custom-backend' : 'default';
  } else {
    stack = 'minimal';
    resolvedFrontend = 'none';
    resolvedBackend = 'none';
  }

  return {
    stack,
    frontend: resolvedFrontend,
    backend: resolvedBackend,
    mobile: {
      enabled: mobile.enabled,
      framework: mobile.framework,
      source: mobile.source,
    },
    shouldAskMobile: !mobile.intentDetected && stack !== 'minimal',
    evidence: {
      frontend: frontend || null,
      backend: backend || null,
      mobileIntentDetected: mobile.intentDetected,
      backendNeed,
      wantsMinimal,
    },
  };
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
  const hasGoMod = fs.existsSync(path.join(cwd, 'go.mod'));

  if (hasGoMod) {
    out.stack = 'custom-backend';
    out.backend = 'go';
    out.frontend = 'none';
    out.evidence.push('go.mod detected → apply Go backend skills');
  }

  if (Object.keys(deps).length === 0) {
    return out;
  }

  const isNative  = Boolean(deps.expo || deps['react-native']);
  const isReact   = Boolean(deps.react);
  const frameworkDetections = [
    {
      frontend: 'nextjs',
      matches: Boolean(deps.next),
      evidence: 'next in deps → apply custom-frontend stack + Next.js provider-first recommendations',
    },
    {
      frontend: 'vue',
      matches: Boolean(deps.vue || deps.nuxt || deps['@vitejs/plugin-vue']),
      evidence: 'vue/nuxt in deps → apply custom-frontend stack + Vue-native patterns',
    },
    {
      frontend: 'svelte',
      matches: Boolean(deps.svelte || deps['@sveltejs/kit']),
      evidence: 'svelte/sveltekit in deps → apply custom-frontend stack + Svelte-native patterns',
    },
    {
      frontend: 'angular',
      matches: Boolean(deps['@angular/core'] || deps['@angular/cli']),
      evidence: 'angular in deps → apply custom-frontend stack + Angular-native patterns',
    },
    {
      frontend: 'astro',
      matches: Boolean(deps.astro),
      evidence: 'astro in deps → apply custom-frontend stack + Astro-native patterns',
    },
    {
      frontend: 'solid',
      matches: Boolean(deps['solid-js'] || deps['@solidjs/start']),
      evidence: 'solid in deps → apply custom-frontend stack + Solid-native patterns',
    },
    {
      frontend: 'remix',
      matches: Boolean(deps['@remix-run/react'] || deps['@remix-run/node'] || deps['@remix-run/dev']),
      evidence: 'remix in deps → apply custom-frontend stack + Remix-native patterns',
    },
    {
      frontend: 'gatsby',
      matches: Boolean(deps.gatsby),
      evidence: 'gatsby in deps → apply custom-frontend stack + Gatsby-native patterns',
    },
    {
      frontend: 'qwik',
      matches: Boolean(deps['@builder.io/qwik'] || deps['@builder.io/qwik-city']),
      evidence: 'qwik in deps → apply custom-frontend stack + Qwik-native patterns',
    },
    {
      frontend: 'preact',
      matches: Boolean(deps.preact),
      evidence: 'preact in deps → apply custom-frontend stack + Preact-native patterns',
    },
    {
      frontend: 'lit',
      matches: Boolean(deps.lit || deps['lit-html'] || deps['lit-element']),
      evidence: 'lit in deps → apply custom-frontend stack + Lit-native patterns',
    },
    {
      frontend: 'ember',
      matches: Boolean(deps['ember-source'] || deps['ember-cli']),
      evidence: 'ember in deps → apply custom-frontend stack + Ember-native patterns',
    },
    {
      frontend: 'alpine',
      matches: Boolean(deps.alpinejs),
      evidence: 'alpinejs in deps → apply custom-frontend stack + Alpine-native patterns',
    },
    {
      frontend: 'stencil',
      matches: Boolean(deps['@stencil/core']),
      evidence: 'stencil in deps → apply custom-frontend stack + Stencil-native patterns',
    },
    {
      frontend: 'marko',
      matches: Boolean(deps.marko),
      evidence: 'marko in deps → apply custom-frontend stack + Marko-native patterns',
    },
  ];
  const detectedFramework = frameworkDetections.find((candidate) => candidate.matches);

  if (detectedFramework) {
    out.stack    = 'custom-frontend';
    out.frontend = detectedFramework.frontend;
    out.evidence.push(detectedFramework.evidence);
  } else if (isNative) {
    out.stack = 'custom-frontend';
    out.frontend = 'none';
    out.mobile = { enabled: true, framework: 'react-native-expo', source: 'explicit' };
    out.evidence.push('react-native/expo in deps');
  } else if (isReact) {
    out.stack = deps['@supabase/supabase-js'] || deps['@supabase/ssr'] ? 'default' : 'custom-backend';
    out.frontend = 'react-vite';
    out.evidence.push('react in deps');
  }

  if (deps['@supabase/supabase-js'] || deps['@supabase/ssr']) {
    out.backend = 'supabase';
    out.evidence.push('supabase detected → recommend our fork once');
  } else if (deps.firebase || deps['firebase-admin']) {
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

module.exports = {
  loadPackageJson,
  dependenciesFromPackage,
  hasWorkspaces,
  workspaceYamlPresent,
  countSourceFiles,
  detectMode,
  detectStackFromCodebase,
  classifyPromptForStack,
};
