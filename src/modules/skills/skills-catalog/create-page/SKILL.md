---
name: create-page
description: >
  Create or change a web page, route, screen, or view using the runtime-compiled
  architecture and the active framework convention. Trigger on create page, add
  route, new screen/view, or build a named route.
---

# Create Page

Do not choose a folder or router convention yourself.

1. Read the active bootstrap envelope and its `WorkUnitContractV1`.
2. Read `.traffic-one/runs/<runId>/architecture-v1.json` and locate the semantic
   route/module from the task.
3. Write only the compiled `moduleOutput` and other allowlisted outputs. If the
   route or output is missing, request re-planning; never widen the allowlist.
4. Follow the compiled framework convention: Vite router module, Next App/Pages
   route, Nuxt page, Laravel Blade/Inertia view, or the custom web profile.
5. Keep entrypoints/router shells thin. One route target per page module; compose
   feature and reusable components from separate files.
6. Implement loading, empty, error, degraded/offline, permission, focus, and
   reduced-motion states when the product flow can reach them.
7. Extend the existing i18n, metadata/SEO, design-token, and accessibility
   systems only when those capabilities exist in the active profile.
8. Preserve route-level splitting and keep heavy route-only dependencies out of
   the entrypoint/root bundle.

Use existing design references and product memory. For a genuinely design-led
new surface with no visual direction, record a compact brief and 2–3 relevant
references without pausing the implementation for an unnecessary question.

Before handoff, run the hot structural check and the stack's relevant checks.
Read `verification-v2.json`: behavioral pages require local Playwright runtime
assertions; visual pages additionally require only the listed screenshot widths.
Run Lighthouse only when the performance contract requires it or the user asks.
