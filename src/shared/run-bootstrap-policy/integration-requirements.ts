// src/shared/run-bootstrap-policy/integration-requirements.ts
// Integration requirements compiled from the role's work-unit outputs and the
// capability surfaces — the "definition of done" the reviewer kept
// re-discovering in 8co. Stored on the bootstrap envelope and rendered into the
// child's SessionStart header (the readable delivery surface since the per-run
// context-pack snapshot was removed; the deterministic STRUCT_* gates verify
// these regardless of delivery).

/**
 * The public site-URL variable for the compiled stack. Each framework only exposes
 * env vars with its own prefix, so naming `VITE_SITE_URL` at a Nuxt or Next project
 * asked the role for a variable its bundler would never read.
 */
function siteUrlEnvVar(outputs: readonly string[]): string {
  const has = (re: RegExp): boolean => outputs.some((output) => re.test(output));
  if (has(/(?:^|\/)nuxt\.config\.[cm]?[jt]s$/)) return 'NUXT_PUBLIC_SITE_URL';
  if (has(/(?:^|\/)next\.config\.[cm]?[jt]s$/) || has(/(?:^|\/)app\/layout\.tsx$/)) return 'NEXT_PUBLIC_SITE_URL';
  if (has(/(?:^|\/)svelte\.config\.[cm]?[jt]s$/)) return 'PUBLIC_SITE_URL';
  if (has(/(?:^|\/)artisan$/) || has(/(?:^|\/)resources\/views\//)) return 'APP_URL';
  if (has(/(?:^|\/)angular\.json$/)) return 'SITE_URL';
  return 'VITE_SITE_URL';
}

export function compileIntegrationRequirements(
  role: string,
  surfaces: readonly string[],
  outputs: readonly string[],
): string[] {
  const requirements: string[] = [];
  if (role === 'senior-frontend') {
    const apiPackage = outputs.find((output) => /^packages\/[^/]*(?:api|client|sdk)[^/]*\//i.test(output));
    if (apiPackage || surfaces.includes('api')) {
      requirements.push('Every learner-facing page consumes the planned typed API package (live-or-demo with explicit loading/error/degraded states) — an app that renders only static fixtures fails STRUCT_API_CLIENT_UNUSED.');
    }
    requirements.push('Every planned component/feature module must have a real call site (imported by a page or a used barrel) — dead deliverables fail STRUCT_ORPHAN_MODULE.');
    requirements.push("Style with the project's ACTUAL styling system: Tailwind utility classes without a tailwindcss dependency/config fail STRUCT_TAILWIND_NO_TOOLCHAIN.");
    requirements.push('Apply the compiled/existing i18n contract: every static React child uses <Trans> with ns, i18nKey, and fallback; t() is string-value-only; every declared locale has non-empty key parity. New-project i18n findings block.');
    if (outputs.includes('eslint.config.js')) {
      requirements.push('The seeded `eslint.config.js` and `.prettierrc` are the project quality bar: install `eslint` and `prettier`, expose `lint`/`format`/`format:check` scripts that run them, and keep them green. A config with no installed tool and no script is inert — and raising a limit in it to pass your own change is a config-tamper violation, not a fix.');
    }
    if (outputs.some((output) => /public\/(?:sitemap\.xml|robots\.txt)$/.test(output))) {
      requirements.push(`Generate crawl assets (sitemap.xml, robots.txt) from \`${siteUrlEnvVar(outputs)}\` (seeded in .env.example) and fail generation when it is unset — invented or relative origins fail the crawl-origin gate.`);
    }
  }
  if (role === 'senior-backend') {
    const apiPackage = outputs.find((output) => /^packages\/[^/]*(?:api|client|sdk)[^/]*\//i.test(output));
    if (apiPackage) {
      requirements.push(`The typed client package under \`${apiPackage.split('/').slice(0, 2).join('/')}\` is the frontend's ONLY data contract — export real functions for every planned flow and keep identifiers/slugs consistent with seed data.`);
    }
    requirements.push('Keep seed data and schema identifiers consistent with the frontend fixtures the plan names — mismatched slugs strand live mode (observed 8co: 3 of 4 seed slugs diverged).');
  }
  return requirements;
}
