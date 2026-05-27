'use strict';

// scripts/hook-runtime/detection/_helpers.cjs
// Private text-classification helpers shared by detection functions.

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

module.exports = {
  includesAny,
  detectFrontendFromText,
  detectBackendFromText,
  detectMobileFromText,
};
