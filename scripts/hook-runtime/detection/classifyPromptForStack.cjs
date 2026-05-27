'use strict';

const {
  includesAny,
  detectFrontendFromText,
  detectBackendFromText,
  detectMobileFromText,
} = require('./_helpers.cjs');

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

module.exports = { classifyPromptForStack };
