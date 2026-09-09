// run-sim.cases.ts
// Deterministic full-run simulations: onboarding is pre-completed, then scripted
// role writes drive the REAL post-onboarding chain (plan-write gate → PLAN_READY
// transaction → implement → QA → settlement). No host CLI, no LLM, no spend.
//
// A case declares SEMANTICS only. Compiled output paths are born inside the
// PLAN_READY transaction, so nothing here may name one — the driver reads them
// back from the published assignments instead.

import type { Case, MaintenanceTriageLeg } from '../../core/types';

// The user briefs these shapes simulate. Kept verbatim: the whole point is that
// a real request walks the chain, not a synthetic one shaped to pass.
export const BRIEF_LEARNING =
  'create a modern learning platform with courses for web development. '
  + 'use latest tech, make it responsive. no admin area for now.';

export const BRIEF_LEARNING_MAINTENANCE =
  'add new section news with listing and news info';

export const BRIEF_API =
  'i want an api project with products listing, products info, news listing and info';

export const BRIEF_API_MAINTENANCE =
  'add new endpoint with config (languages, payment options)';

export const BRIEF_AGENCY_MAINTENANCE =
  'add new section contact';

export const BRIEF_AGENCY =
  'create a modern agency presentation website. one landing page with projects '
  + 'listing, latest news, reviews.';

// The brochure site: the shape the classifier used to collapse to
// `minimal/none/none`. Deliberately free of the content vocabulary
// (news/blog/reviews/listings) that legitimately implies persistence, so it
// classifies to custom-frontend/react-vite/none — a web app with EXACTLY ONE
// implementer role and no backend.
export const BRIEF_BROCHURE =
  'create a modern agency presentation website. one landing page with a hero, '
  + 'our services, selected work, and a contact form.';

export const BRIEF_BROCHURE_MAINTENANCE =
  'add a new page for our team with short bios';
export const BRIEF_EXISTING_WEB =
  'add a reviews section with a customer reviews listing to my app';

// The commonest change shape in the product, and the one this tier never
// produced: a project WITH a web surface whose change touches no UI at all.
// Deliberately free of any page/section/screen vocabulary — the moment a plan
// declares a new page, component or app-shell, plannedUiImpactFloor raises the
// contract to `visual` and the shape stops being the one under test.
export const BRIEF_NONVISUAL_EXISTING_WEB =
  'the catalogue slugs are inconsistent — add a slug normaliser and a currency '
  + 'formatter for the item data, no UI changes';

// The learning-platform architecture, reused by every full-stack web shape. The
// COMPILED paths differ per framework — that is the point — but the semantics
// the architect declares do not.
const LEARNING_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [
    { id: 'home-route', path: '/', moduleId: 'home' },
    { id: 'courses-route', path: '/courses', moduleId: 'courses' },
    { id: 'course-detail-route', path: '/courses/:slug', moduleId: 'course-detail' },
    { id: 'login-route', path: '/login', moduleId: 'login' },
  ],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' as const },
    { id: 'home', name: 'Home', kind: 'page' as const },
    { id: 'courses', name: 'Courses', kind: 'page' as const },
    { id: 'course-detail', name: 'Course Detail', kind: 'page' as const },
    { id: 'login', name: 'Login', kind: 'page' as const },
    { id: 'course-card', name: 'Course Card', kind: 'component' as const },
    { id: 'auth', name: 'Auth', kind: 'feature' as const },
    { id: 'courses-api', name: 'Courses API', kind: 'service' as const },
  ],
};

// The agency site: a single landing page. Deliberately one route — it guards the
// opposite failure from the learning platform, that a legitimately single-page
// app is not flagged by the structural rules that replaced the retired
// multi-page/inline-page heuristics.
const AGENCY_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' as const },
    { id: 'home', name: 'Home', kind: 'page' as const },
    { id: 'project-card', name: 'Project Card', kind: 'component' as const },
    { id: 'review-card', name: 'Review Card', kind: 'component' as const },
  ],
};

// api-only: no routes, no web surface.
const API_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [],
  modules: [
    { id: 'products-service', name: 'Products Service', kind: 'service' as const },
    { id: 'news-service', name: 'News Service', kind: 'service' as const },
    { id: 'store', name: 'Store', kind: 'store' as const },
  ],
};

const WEB_QA = {
  mode: 'browser' as const,
  expectChecks: {
    'stack-build': 'passed' as const,
    'playwright-local': 'passed' as const,
    'dom-assertions': 'passed' as const,
    actions: 'passed' as const,
    routing: 'passed' as const,
    hydration: 'passed' as const,
    'console-errors': 'passed' as const,
    'network-errors': 'passed' as const,
    'responsive-screenshots': 'passed' as const,
  },
};

// The same brief against a repository that already exists. It plans only what
// is NEW: the existing repo already has its own store, and a plan that declared
// one would compile to the same path and overwrite working code that the rest
// of the project imports. Planning around what is already there is what
// "existing codebases must not break" means in practice — and the run proves it
// by building the merged tree with the real Go toolchain.
const EXISTING_API_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [],
  modules: [
    { id: 'products-service', name: 'Products Service', kind: 'service' as const },
    { id: 'news-service', name: 'News Service', kind: 'service' as const },
  ],
};


// The reviews delta against a WEB repository that already exists: a flat-src
// React/Vite SPA that never met Traffic One. Plans only what is NEW — the
// fixture's App/main stay untouched. The feature module matters twice: it is
// where the section's logic naturally lives, and its compiled directory is
// what puts the repo-convention extra writes below inside the frontend's
// runtime allowlist.
const EXISTING_WEB_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [{ id: 'reviews-route', path: '/reviews', moduleId: 'reviews' }],
  modules: [
    { id: 'reviews', name: 'Reviews', kind: 'page' as const },
    { id: 'review-card', name: 'Review Card', kind: 'component' as const },
    { id: 'reviews-feature', name: 'Reviews', kind: 'feature' as const },
  ],
};

// Writes the repo's OWN conventions produce — each one a deny under the
// prescribed-stack static checks on a new project (vanilla-extract import,
// `.css.ts` import, default export in features/, `: any`, static inline
// style). In existing-codebase mode every one must be ALLOWED: that is the
// stand-down this case exists to prove, on the real composed gate rather than
// the unit-tested guard.
const EXISTING_WEB_EXTRA_WRITES = [
  {
    role: 'senior-frontend',
    path: 'src/features/reviews/section.css.ts',
    content: [
      "import { style } from '@vanilla-extract/css';",
      '',
      'export const reviewsSection = style({',
      "  display: 'grid',",
      "  gap: '1rem',",
      '});',
      '',
    ].join('\n'),
  },
  {
    role: 'senior-frontend',
    path: 'src/features/reviews/ReviewsPanel.tsx',
    content: [
      "import { reviewsSection } from './section.css.ts';",
      '',
      'export default function ReviewsPanel({ heading }: { heading: any }) {',
      '  return (',
      "    <section className={reviewsSection} style={{ marginTop: '2rem' }}>",
      '      <h2>{heading}</h2>',
      '    </section>',
      '  );',
      '}',
      '',
    ].join('\n'),
  },
];

// The news delta the open-run leg plans on the existing web repo: everything
// the first run built stays, one new page + card arrives.
const EXISTING_WEB_NEWS_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [
    { id: 'reviews-route', path: '/reviews', moduleId: 'reviews' },
    { id: 'news-route', path: '/news', moduleId: 'news' },
  ],
  modules: [
    { id: 'reviews', name: 'Reviews', kind: 'page' as const },
    { id: 'review-card', name: 'Review Card', kind: 'component' as const },
    { id: 'reviews-feature', name: 'Reviews', kind: 'feature' as const },
    { id: 'news', name: 'News', kind: 'page' as const },
    { id: 'news-card', name: 'News Card', kind: 'component' as const },
  ],
};

// The quick-fix worker's bounded edit: the SAME repo-convention shape the
// extra-writes row landed (vanilla-extract import, default export, `any`,
// static inline style) with the "typo" corrected — in existing mode every one
// of those conventions must survive the trivial tier too, not just the
// orchestrated run.
const EXISTING_WEB_QUICK_FIX_PANEL = [
  "import { reviewsSection } from './section.css.ts';",
  '',
  'export default function ReviewsPanel({ heading }: { heading: any }) {',
  '  return (',
  "    <section className={reviewsSection} style={{ marginTop: '2rem' }}>",
  '      <h2>{heading} — Customer Reviews</h2>',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

// The small tier's bounded senior-frontend edit — one more variation of the
// same panel, written through the `<role>:bounded-maintenance` WorkUnit.
const EXISTING_WEB_SMALL_TIER_PANEL = [
  "import { reviewsSection } from './section.css.ts';",
  '',
  'export default function ReviewsPanel({ heading }: { heading: any }) {',
  '  return (',
  "    <section className={reviewsSection} style={{ marginTop: '2rem' }}>",
  '      <h2>{heading}</h2>',
  '      <p>What our customers say about us.</p>',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

// The nonvisual delta on a repo that HAS a web surface: two data-shaping
// modules and nothing that renders.
//
// Every kind is deliberate. `service`/`store` are the only module kinds
// plannedUiImpactFloor does not raise for — `app-shell`/`page`/`component` force
// `visual` and `feature` forces `behavioral` the moment they are new — so this is
// the only architecture shape that can hold a web-surface profile at `nonvisual`.
// No routes, for the same reason: a route needs a page module to bind to.
const NONVISUAL_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [],
  modules: [
    { id: 'slug-normalizer', name: 'Slug Normalizer', kind: 'service' as const },
    { id: 'money-formatter', name: 'Money Formatter', kind: 'service' as const },
  ],
};

// The api maintenance delta: one new endpoint alongside what exists.
const API_MAINTENANCE_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [],
  modules: [
    { id: 'products-service', name: 'Products Service', kind: 'service' as const },
    { id: 'news-service', name: 'News Service', kind: 'service' as const },
    { id: 'store', name: 'Store', kind: 'store' as const },
    { id: 'config-service', name: 'Config Service', kind: 'service' as const },
  ],
};

// The same delta against the EXISTING repo, which keeps its own store.
const EXISTING_API_MAINTENANCE_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [],
  modules: [
    { id: 'products-service', name: 'Products Service', kind: 'service' as const },
    { id: 'news-service', name: 'News Service', kind: 'service' as const },
    { id: 'config-service', name: 'Config Service', kind: 'service' as const },
  ],
};

// The brochure site on a frontend-only React/Vite profile: one route, no
// service module — there is no backend role to own one.
const BROCHURE_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' as const },
    { id: 'home', name: 'Home', kind: 'page' as const },
    { id: 'service-card', name: 'Service Card', kind: 'component' as const },
    { id: 'work-card', name: 'Work Card', kind: 'component' as const },
  ],
};

// The brochure site gains a team page.
const BROCHURE_MAINTENANCE_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [
    { id: 'home-route', path: '/', moduleId: 'home' },
    { id: 'team-route', path: '/team', moduleId: 'team' },
  ],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' as const },
    { id: 'home', name: 'Home', kind: 'page' as const },
    { id: 'team', name: 'Team', kind: 'page' as const },
    { id: 'service-card', name: 'Service Card', kind: 'component' as const },
    { id: 'work-card', name: 'Work Card', kind: 'component' as const },
  ],
};

// The agency site gains a contact section: a new route and page on a site that
// deliberately had exactly one.
const AGENCY_MAINTENANCE_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [
    { id: 'home-route', path: '/', moduleId: 'home' },
    { id: 'contact-route', path: '/contact', moduleId: 'contact' },
  ],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' as const },
    { id: 'home', name: 'Home', kind: 'page' as const },
    { id: 'contact', name: 'Contact', kind: 'page' as const },
    { id: 'project-card', name: 'Project Card', kind: 'component' as const },
    { id: 'review-card', name: 'Review Card', kind: 'component' as const },
  ],
};

const WEB_ASSERTIONS = [
  { id: 'state-matches-selection' },
  { id: 'onboarding-complete' },
  { id: 'run-sim-clean' },
  { id: 'run-sim-plan-ready-artifacts' },
  { id: 'run-sim-qa-evidence' },
  { id: 'run-sim-settlement' },
];

// Every post-build follow-up shape the existing-web flow must route correctly.
// Ordering is load-bearing: leg 4 pins that a FRESH quick-fix claim suppresses
// the next edit prompt's triage (continuation-first — the parent messages the
// live worker instead of minting a run), leg 5's rotation releases it, and the
// resolved run in leg 7 is what lets leg 8 route again.
const EXISTING_WEB_MAINTENANCE_LEGS: MaintenanceTriageLeg[] = [
  // Runtime control stays with the parent: no directive, no run, no worker.
  { kind: 'prompt', prompt: 'restart the dev server', expectRouting: 'none' },
  // Chat is not an edit request.
  { kind: 'prompt', prompt: 'thanks, looks great!', expectRouting: 'none' },
  // The trivial tier, end to end: rotation, frozen model policy, parent
  // fail-closed probe, bounded WorkUnit, out-of-scope deny, IMPLEMENTED digest.
  {
    kind: 'prompt',
    prompt: 'fix the typo in the reviews section heading',
    expectRouting: 'triage',
    expectTier: 'trivial',
    quickFix: {
      files: [{ path: 'src/features/reviews/ReviewsPanel.tsx', content: EXISTING_WEB_QUICK_FIX_PANEL }],
      outOfScope: { path: 'src/main.tsx', content: '// quick-fix must not touch this file\n' },
    },
  },
  // The quick-fix claim is still fresh: triage is deliberately suppressed so
  // the parent continues the LIVE worker instead of minting a second run.
  {
    kind: 'prompt',
    prompt: 'change the reviews heading copy to Customer Stories',
    expectRouting: 'none',
    expectTier: 'trivial',
  },
  // The complex tier re-enters the orchestrator: a fresh single-feature run
  // (this rotation is also what releases the quick-fix claim above).
  { kind: 'open-run', brief: 'add new section news with listing and news info', architecture: EXISTING_WEB_NEWS_ARCHITECTURE },
  // While that run is nonterminal (reviewer recorded findings), an edit prompt
  // must preserve it — no rotation, no greenfield flow, no quick-fix.
  {
    kind: 'prompt',
    prompt: 'fix the news card spacing on the news page',
    expectRouting: 'unresolved',
    expectTier: 'trivial',
  },
  { kind: 'resolve-run', qa: WEB_QA },
  // A settled run releases routing again; the ambiguous prompt lands on the
  // small tier (never trivial), and the directly-owning role writes through a
  // `senior-frontend:bounded-maintenance` WorkUnit — the seam the small tier
  // and the paid OpenCode-fallback worker both depend on.
  {
    kind: 'prompt',
    prompt: 'make the reviews panel look nicer',
    expectRouting: 'triage',
    expectTier: 'small',
    boundedRole: {
      role: 'senior-frontend',
      files: [{ path: 'src/features/reviews/ReviewsPanel.tsx', content: EXISTING_WEB_SMALL_TIER_PANEL }],
    },
  },
];

export const RUN_SIM_CASES: Case[] = [
  {
    id: 'sim-new-react-vite-supabase',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_LEARNING },
    },
    runSim: {
      brief: BRIEF_LEARNING,
      architecture: {
        schemaVersion: 1,
        routes: [
          { id: 'home-route', path: '/', moduleId: 'home' },
          { id: 'courses-route', path: '/courses', moduleId: 'courses' },
          { id: 'course-detail-route', path: '/courses/:slug', moduleId: 'course-detail' },
          { id: 'lesson-route', path: '/courses/:slug/lessons/:lessonId', moduleId: 'lesson' },
          { id: 'login-route', path: '/login', moduleId: 'login' },
        ],
        modules: [
          { id: 'app-shell', name: 'App', kind: 'app-shell' },
          { id: 'home', name: 'Home', kind: 'page' },
          { id: 'courses', name: 'Courses', kind: 'page' },
          { id: 'course-detail', name: 'Course Detail', kind: 'page' },
          { id: 'lesson', name: 'Lesson', kind: 'page' },
          { id: 'login', name: 'Login', kind: 'page' },
          { id: 'course-card', name: 'Course Card', kind: 'component' },
          { id: 'lesson-list', name: 'Lesson List', kind: 'component' },
          { id: 'auth', name: 'Auth', kind: 'feature' },
          { id: 'courses-api', name: 'Courses API', kind: 'service' },
        ],
      },
      // Greenfield web shapes compile to uiImpact 'visual' (every planned page
      // is absent from the baseline), so the contract requires real browser
      // evidence. The assertion cross-checks this declaration against the
      // PUBLISHED contract.browserRequired — a shape can never quietly slide
      // onto the cheap `stack` path.
      fixCycle: true,
      negativeGates: true,
      // The user's follow-up message after the first integration. The delta is
      // a news listing and a news detail page; everything already built stays.
      phase2: {
        brief: BRIEF_LEARNING_MAINTENANCE,
        architecture: {
          schemaVersion: 1,
          routes: [
            { id: 'home-route', path: '/', moduleId: 'home' },
            { id: 'courses-route', path: '/courses', moduleId: 'courses' },
            { id: 'course-detail-route', path: '/courses/:slug', moduleId: 'course-detail' },
            { id: 'lesson-route', path: '/courses/:slug/lessons/:lessonId', moduleId: 'lesson' },
            { id: 'login-route', path: '/login', moduleId: 'login' },
            { id: 'news-route', path: '/news', moduleId: 'news' },
            { id: 'news-detail-route', path: '/news/:slug', moduleId: 'news-detail' },
          ],
          modules: [
            { id: 'app-shell', name: 'App', kind: 'app-shell' },
            { id: 'home', name: 'Home', kind: 'page' },
            { id: 'courses', name: 'Courses', kind: 'page' },
            { id: 'course-detail', name: 'Course Detail', kind: 'page' },
            { id: 'lesson', name: 'Lesson', kind: 'page' },
            { id: 'login', name: 'Login', kind: 'page' },
            { id: 'news', name: 'News', kind: 'page' },
            { id: 'news-detail', name: 'News Detail', kind: 'page' },
            { id: 'course-card', name: 'Course Card', kind: 'component' },
            { id: 'lesson-list', name: 'Lesson List', kind: 'component' },
            { id: 'auth', name: 'Auth', kind: 'feature' },
            { id: 'courses-api', name: 'Courses API', kind: 'service' },
          ],
        },
        qa: WEB_QA,
      },
      qa: {
        mode: 'browser',
        expectChecks: {
          'stack-build': 'passed',
          'playwright-local': 'passed',
          'dom-assertions': 'passed',
          actions: 'passed',
          routing: 'passed',
          hydration: 'passed',
          'console-errors': 'passed',
          'network-errors': 'passed',
          'responsive-screenshots': 'passed',
        },
      },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'run-sim-clean' },
      { id: 'run-sim-plan-ready-artifacts' },
      { id: 'run-sim-qa-evidence' },
      { id: 'run-sim-settlement' },
      { id: 'run-sim-subagent-reuse' },
      { id: 'run-sim-maintenance-flip' },
      { id: 'run-sim-negative-gates' },
    ],
    notes: 'Shape 1: default stack, React/Vite + Supabase, with auth. The reference shape.',
  },
  {
    id: 'sim-new-nextjs-supabase',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'nextjs',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_LEARNING },
    },
    runSim: { brief: BRIEF_LEARNING, architecture: LEARNING_ARCHITECTURE, qa: WEB_QA },
    assertions: WEB_ASSERTIONS,
    notes: 'Shape 4: Next.js + Supabase, with auth. App-router layout and its own scaffold table.',
  },
  {
    id: 'sim-new-nuxt-nobackend',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      // NOT 'custom-backend': detect-frontend suppresses the configured-frontend
      // fallback for that id (it means "React frontend, bring your own backend"),
      // which compiles a backend-only profile and rejects the routes.
      stack: 'custom-frontend',
      frontend: 'nuxt',
      backend: 'none',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_AGENCY },
    },
    runSim: {
      brief: BRIEF_AGENCY,
      architecture: AGENCY_ARCHITECTURE,
      qa: WEB_QA,
      phase2: {
        brief: BRIEF_AGENCY_MAINTENANCE,
        architecture: AGENCY_MAINTENANCE_ARCHITECTURE,
        qa: WEB_QA,
      },
    },
    assertions: WEB_ASSERTIONS,
    notes: 'Shape 3: Nuxt, no backend. Also the single-page guard, and the profile whose build output (.output/public) builtAppIdentities had to learn.',
  },
  {
    id: 'sim-new-react-vite-nobackend',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      // The shape the classifier used to destroy. `custom-frontend` (not
      // `default`) is what a brochure brief derives now: React/Vite with NO
      // backend, so stateRequiresNewProjectMonorepo is FALSE while the compiled
      // web root is still apps/web — the one React/Vite combination no other
      // shape covers, and the one that must settle with a single implementer.
      stack: 'custom-frontend',
      frontend: 'react-vite',
      backend: 'none',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_BROCHURE },
    },
    runSim: {
      brief: BRIEF_BROCHURE,
      architecture: BROCHURE_ARCHITECTURE,
      qa: WEB_QA,
      phase2: {
        brief: BRIEF_BROCHURE_MAINTENANCE,
        architecture: BROCHURE_MAINTENANCE_ARCHITECTURE,
        qa: WEB_QA,
      },
    },
    assertions: WEB_ASSERTIONS,
    notes: 'Shape 10: React/Vite with no backend — exactly one implementer role, and no Turborepo contract. Guards the arm that used to emit minimal/none/none (zero implementers) for a brochure brief.',
  },
  {
    id: 'sim-new-vue-go-api',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'vue',
      backend: 'go',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_LEARNING },
    },
    runSim: { brief: BRIEF_LEARNING, architecture: LEARNING_ARCHITECTURE, qa: WEB_QA },
    assertions: WEB_ASSERTIONS,
    notes: 'Shape 5: Vue SPA with a Go API backend — two languages in one run.',
  },
  {
    id: 'sim-new-unsupported-framework',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-frontend',
      // Qwik is not in FRONTEND_IDS and state validation REJECTS unknown values,
      // which would make materialization incomplete. `other` is the escape hatch
      // onboarding offers, and it compiles to the generic-web profile. The brief
      // names the framework the user actually asked for.
      frontend: 'other',
      backend: 'none',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: `${BRIEF_AGENCY} use qwik.` },
    },
    runSim: { brief: `${BRIEF_AGENCY} use qwik.`, architecture: AGENCY_ARCHITECTURE, qa: WEB_QA },
    assertions: WEB_ASSERTIONS,
    notes: 'Shape 6: a framework Traffic One does not model. Characterises the CURRENT contract — degrade to generic-web and still settle — so any future change to that behaviour is deliberate.',
  },
  {
    id: 'sim-existing-go-api',
    category: 'run-sim',
    layer: 'run-sim',
    // A real Go repo that never met Traffic One. Not seeded from the greenfield
    // run: a copy of that output would already carry the configs phase 1 wrote,
    // and could not prove they are WITHHELD here.
    fixture: 'existing-go-api',
    preSeed: {
      mode: 'existing-codebase',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
    },
    runSim: {
      brief: BRIEF_API,
      architecture: EXISTING_API_ARCHITECTURE,
      qa: {
        mode: 'stack',
        expectChecks: {
          'stack-build': 'passed',
          'stack-test': 'passed',
          'stack-lint': 'passed',
        },
      },
      phase2: {
        brief: BRIEF_API_MAINTENANCE,
        architecture: EXISTING_API_MAINTENANCE_ARCHITECTURE,
        qa: {
          mode: 'stack',
          expectChecks: {
            'stack-build': 'passed',
            'stack-test': 'passed',
            'stack-lint': 'passed',
          },
        },
      },
      // The trivial tier on a backend-only repo: same bounded quick-fix
      // machinery, Go feature source instead of web.
      maintenance: [
        {
          kind: 'prompt',
          prompt: 'fix the typo in the products store comment',
          expectRouting: 'triage',
          expectTier: 'trivial',
          quickFix: {
            files: [{
              path: 'internal/store.go',
              content: [
                'package internal',
                '',
                '// Product is one catalogue entry.',
                'type Product struct {',
                '\tID    string',
                '\tSlug  string',
                '\tTitle string',
                '}',
                '',
                '// Store holds the in-memory product catalogue.',
                'type Store struct {',
                '\tproducts []Product',
                '}',
                '',
                '// NewStore builds a store seeded with the demo catalogue.',
                'func NewStore() *Store {',
                '\treturn &Store{products: []Product{',
                '\t\t{ID: "p-1", Slug: "desk-lamp", Title: "Desk Lamp"},',
                '\t}}',
                '}',
                '',
                '// Products returns every product in the catalogue.',
                'func (s *Store) Products() []Product {',
                '\treturn s.products',
                '}',
                '',
              ].join('\n'),
            }],
            outOfScope: { path: 'main.go', content: '// quick-fix must not touch this file\n' },
          },
        },
      ],
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'run-sim-clean' },
      { id: 'run-sim-plan-ready-artifacts' },
      { id: 'run-sim-qa-evidence' },
      { id: 'run-sim-settlement' },
      { id: 'run-sim-existing-mode' },
      { id: 'run-sim-maintenance-triage' },
    ],
    notes: 'Existing-codebase guard: no scaffolded config is written into a repo Traffic One did not create, integration findings are advisory, and the trivial tier routes a bounded quick-fix on Go source.',
  },
  {
    id: 'sim-existing-supabase-web',
    category: 'run-sim',
    layer: 'run-sim',
    // The SECOND existing mode. `existing-with-supabase` must behave exactly
    // like `existing-codebase` everywhere the `existing-*` family is the
    // predicate: maintenance from detection, architecture stand-down, no
    // scaffolded configs, and post-build triage routing. A regression that
    // keys any of those on the literal `existing-codebase` string turns this
    // case red while the sibling stays green.
    fixture: 'existing-react-vite',
    preSeed: {
      mode: 'existing-with-supabase',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
    },
    runSim: {
      brief: BRIEF_EXISTING_WEB,
      architecture: EXISTING_WEB_ARCHITECTURE,
      qa: WEB_QA,
      maintenance: [
        {
          kind: 'prompt',
          prompt: 'fix the typo in the home page heading',
          expectRouting: 'triage',
          expectTier: 'trivial',
          quickFix: {
            files: [{
              // The fixture's own pre-existing file, edited in place.
              path: 'src/App.tsx',
              content: [
                "import React from 'react';",
                '',
                '// Minimal pre-existing app. Test cases edit this file (e.g. rename the button',
                '// label, change the heading) or add components/pages alongside it.',
                'export function App(): React.ReactElement {',
                '  return (',
                '    <main>',
                '      <h1>Acme — Home</h1>',
                '      <p>An existing React + Vite application.</p>',
                '      <button type="button">Submit</button>',
                '    </main>',
                '  );',
                '}',
                '',
              ].join('\n'),
            }],
            outOfScope: { path: 'src/main.tsx', content: '// quick-fix must not touch this file\n' },
          },
        },
      ],
    },
    assertions: [
      ...WEB_ASSERTIONS,
      { id: 'run-sim-existing-mode' },
      { id: 'run-sim-maintenance-triage' },
    ],
    notes: 'existing-with-supabase parity: the second existing-* mode gets the same stand-down, settlement, and triage behavior as existing-codebase.',
  },
  {
    id: 'sim-existing-react-vite-web',
    category: 'run-sim',
    layer: 'run-sim',
    // A real flat-src React/Vite SPA that never met Traffic One — the web
    // counterpart of the existing-go-api guard, and the shape the observed
    // false deny came from (an existing vanilla-extract repo refused its own
    // `.css.ts` styling).
    fixture: 'existing-react-vite',
    preSeed: {
      mode: 'existing-codebase',
      stack: 'custom-frontend',
      frontend: 'react-vite',
      backend: 'none',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
    },
    runSim: {
      brief: BRIEF_EXISTING_WEB,
      architecture: EXISTING_WEB_ARCHITECTURE,
      // The rows the prescribed-stack checks would deny on a new project. The
      // run must complete WITH them on disk: allowed at write time, and still
      // standing through the completion gates and settlement.
      extraWrites: EXISTING_WEB_EXTRA_WRITES,
      qa: WEB_QA,
      // The ownership/sidecar gates must KEEP denying while the stack opinions
      // stand down — the inverse pair of the extraWrites proof above.
      negativeGates: true,
      // Then every post-build follow-up shape, routed through the real
      // prompt-boundary machinery.
      maintenance: EXISTING_WEB_MAINTENANCE_LEGS,
    },
    assertions: [
      ...WEB_ASSERTIONS,
      { id: 'run-sim-existing-mode' },
      { id: 'run-sim-negative-gates' },
      { id: 'run-sim-maintenance-triage' },
    ],
    notes: 'Existing-codebase stand-down on a WEB repo: off-stack styling/exports are allowed through the real plan-write gate, ownership gates still deny, and the full maintenance triage flow (trivial/quick-fix, claim suppression, unresolved-run preservation, small/bounded-role) routes correctly.',
  },
  {
    id: 'sim-new-laravel-inertia',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-stack',
      // Laravel + a named JS framework is Inertia territory: detect-frontend
      // returns `laravel-ui` for ANY configured frontend when the backend is
      // laravel (the 8cl regression — "laravel with vuejs" had compiled
      // backend-only and the requested UI vanished).
      frontend: 'react-vite',
      backend: 'laravel',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_LEARNING },
    },
    runSim: { brief: BRIEF_LEARNING, architecture: LEARNING_ARCHITECTURE, qa: WEB_QA },
    assertions: WEB_ASSERTIONS,
    notes: 'Shape 2: Laravel backend with an Inertia React UI — the server-rendered profile.',
  },
  {
    id: 'sim-new-laravel-blade',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-stack',
      // `other` + laravel is how the wizard encodes "a UI is wanted but no JS
      // framework was named" — Laravel's own Blade UI.
      frontend: 'other',
      backend: 'laravel',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_AGENCY },
    },
    runSim: { brief: BRIEF_AGENCY, architecture: AGENCY_ARCHITECTURE, qa: WEB_QA },
    assertions: WEB_ASSERTIONS,
    notes: 'Shape 9: Laravel full-stack Blade — @include references, {slug} routes, and directives that are code rather than copy.',
  },
  {
    id: 'sim-new-python-api',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'python',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_API },
    },
    runSim: {
      brief: BRIEF_API,
      architecture: API_ARCHITECTURE,
      qa: {
        mode: 'stack',
        // All three run for real: byte-compile, pytest, ruff. validateQaReportV2
        // refuses a justified `not-applicable` for stack-build ("a backend that
        // does not build is broken"), and byte-compiling IS Python's build — it
        // is what turns source into the artifact the interpreter runs, and it
        // fails on a syntax error anywhere in the tree. Pinned so a shape can
        // never quietly settle on checks that did not execute.
        expectChecks: {
          'stack-build': 'passed',
          'stack-test': 'passed',
          'stack-lint': 'passed',
        },
      },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'run-sim-clean' },
      { id: 'run-sim-plan-ready-artifacts' },
      { id: 'run-sim-qa-evidence' },
      { id: 'run-sim-settlement' },
    ],
    notes: 'Shape 8: Python API only. Requires pytest + ruff on PATH; stack-build is legitimately not-applicable.',
  },
  {
    id: 'sim-new-go-api',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_API },
    },
    runSim: {
      brief: BRIEF_API,
      architecture: {
        schemaVersion: 1,
        // No web surface: an API-only project has no routes to compile.
        routes: [],
        modules: [
          { id: 'products-service', name: 'Products Service', kind: 'service' },
          { id: 'news-service', name: 'News Service', kind: 'service' },
          { id: 'store', name: 'Store', kind: 'store' },
        ],
      },
      // No web-ui surface → uiImpact 'none' → requiredChecks are the stack
      // trio, which the `stack` runner produces for real. This is the shape
      // that was UNFINISHABLE before the v1 batch added that runner: the
      // checks had no producer, so validateQaReportV2 rejected every report
      // and settlement could never close.
      qa: {
        mode: 'stack',
        // Pinned, because stackReportStatus returns `passed` whenever nothing
        // FAILED — an all-`not-applicable` report would otherwise read as a
        // pass. Go has a canonical form for all three.
        expectChecks: {
          'stack-build': 'passed',
          'stack-test': 'passed',
          'stack-lint': 'passed',
        },
      },
      phase2: {
        brief: BRIEF_API_MAINTENANCE,
        architecture: API_MAINTENANCE_ARCHITECTURE,
        qa: {
          mode: 'stack',
          expectChecks: {
            'stack-build': 'passed',
            'stack-test': 'passed',
            'stack-lint': 'passed',
          },
        },
      },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'run-sim-clean' },
      { id: 'run-sim-plan-ready-artifacts' },
      { id: 'run-sim-qa-evidence' },
      { id: 'run-sim-settlement' },
    ],
    notes: 'Shape 7: Go API only. Requires `go` on PATH; the qa-evidence assertion reports INCONCLUSIVE rather than passing if the toolchain is missing.',
  },
  {
    id: 'sim-new-rust-api',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'rust',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_API },
    },
    runSim: {
      brief: BRIEF_API,
      architecture: API_ARCHITECTURE,
      qa: {
        mode: 'stack',
        // All four run for real: cargo build / test / clippy / fmt --check.
        // A missing cargo, clippy or rustfmt component is declared-not-runnable
        // and the qa-evidence assertion reports INCONCLUSIVE, the same as a
        // missing `go` or `pytest`.
        expectChecks: {
          'stack-build': 'passed',
          'stack-test': 'passed',
          'stack-lint': 'passed',
          'stack-format': 'passed',
        },
      },
      phase2: {
        brief: BRIEF_API_MAINTENANCE,
        architecture: API_MAINTENANCE_ARCHITECTURE,
        qa: {
          mode: 'stack',
          expectChecks: {
            'stack-build': 'passed',
            'stack-test': 'passed',
            'stack-lint': 'passed',
            'stack-format': 'passed',
          },
        },
      },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'run-sim-clean' },
      { id: 'run-sim-plan-ready-artifacts' },
      { id: 'run-sim-qa-evidence' },
      { id: 'run-sim-settlement' },
    ],
    notes: 'Shape 10: Rust API only. Requires `cargo` (plus clippy and rustfmt) on PATH; the qa-evidence assertion reports INCONCLUSIVE rather than passing if the toolchain is missing.',
  },
  {
    id: 'sim-nonvisual-existing-web',
    category: 'run-sim',
    layer: 'run-sim',
    // A Go binary that already serves its own browser bundle. The profile has a
    // WEB SURFACE — which is the whole point — and a root toolchain that really
    // executes here.
    fixture: 'existing-go-web',
    preSeed: {
      mode: 'existing-codebase',
      // Frontend AND backend, both chosen: `custom-stack` is the only STACK_IDS
      // member that means that. An id outside that set is rejected by state
      // validation, which makes materialization incomplete and the run
      // unfinishable for a reason unrelated to the shape.
      stack: 'custom-stack',
      // Vanilla ES modules under `web/`, not a framework Traffic One models.
      // `other` is the escape hatch onboarding offers and compiles to
      // generic-web, which profileHasWebUi answers true for — the fact that
      // makes baseImpact `nonvisual` instead of `none`.
      frontend: 'other',
      backend: 'go',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
    },
    runSim: {
      brief: BRIEF_NONVISUAL_EXISTING_WEB,
      architecture: NONVISUAL_ARCHITECTURE,
      // requiredChecks('nonvisual') is ['stack-build', 'stack-format',
      // 'stack-test'] — no browser, so this settles on a machine with no
      // Chromium. `stack-build`/`stack-test` come from go.mod, the toolchain
      // AGENTS.md already requires. `stack-format` is not-applicable WITH its
      // reason: this repo declares no formatter, and JUSTIFIED_NO_STACK_COMMAND
      // _CHECK_IDS accepts that for every stack check except the build.
      qa: {
        mode: 'stack',
        expectChecks: {
          'stack-build': 'passed',
          'stack-test': 'passed',
          'stack-format': 'not-applicable',
        },
      },
      expectUiImpact: 'nonvisual',
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'run-sim-clean' },
      { id: 'run-sim-plan-ready-artifacts' },
      { id: 'run-sim-ui-impact' },
      { id: 'run-sim-qa-evidence' },
      { id: 'run-sim-settlement' },
      { id: 'run-sim-existing-mode' },
    ],
    notes: 'Shape 9: the nonvisual impact — a project WITH a web surface whose change touches no UI. Requires `go` on PATH; a missing toolchain is INCONCLUSIVE, never a pass.',
  },
];
