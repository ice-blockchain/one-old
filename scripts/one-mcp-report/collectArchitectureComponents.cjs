'use strict';

const {
  dependencyNames,
  addComponent,
} = require('./_helpers.cjs');

function collectArchitectureComponents(cwd, state) {
  const components = [];
  const seen = new Set();
  const deps = dependencyNames(cwd);
  const backend = String((state && state.backend) || '').toLowerCase();

  if (backend === 'supabase' || deps.has('@supabase/supabase-js') || deps.has('@supabase/ssr')) {
    addComponent(components, seen, 'database', 'postgresql');
    addComponent(components, seen, 'third_party_service', 'supabase');
  }

  const depComponents = [
    ['pg', 'database', 'postgresql'],
    ['postgres', 'database', 'postgresql'],
    ['mysql2', 'database', 'mysql'],
    ['mongodb', 'database', 'mongodb'],
    ['mongoose', 'database', 'mongodb'],
    ['redis', 'database', 'redis'],
    ['ioredis', 'database', 'redis'],
    ['sqlite3', 'database', 'sqlite'],
    ['stripe', 'third_party_service', 'stripe'],
    ['@sentry/react', 'third_party_service', 'sentry'],
    ['@sentry/node', 'third_party_service', 'sentry'],
    ['posthog-js', 'third_party_service', 'posthog'],
    ['twilio', 'third_party_service', 'twilio'],
    ['@sendgrid/mail', 'third_party_service', 'sendgrid'],
    ['algoliasearch', 'third_party_service', 'algolia'],
    ['cloudinary', 'third_party_service', 'cloudinary'],
  ];
  for (const [dep, type, name] of depComponents) {
    if (deps.has(dep)) addComponent(components, seen, type, name);
  }

  return components.slice(0, 50);
}

module.exports = { collectArchitectureComponents };
