'use strict';

const fs   = require('fs');
const path = require('path');

const { loadPackageJson } = require('./loadPackageJson.cjs');
const { dependenciesFromPackage } = require('./dependenciesFromPackage.cjs');

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

module.exports = { detectStackFromCodebase };
