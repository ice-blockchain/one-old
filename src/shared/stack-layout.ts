// src/shared/stack-layout.ts
// OPTIONAL convenience: proposes default owned-path SEEDS per detected stack id so the
// architect has a starting point when authoring the per-run assignments manifest.
// This is NOT authoritative and NOT load-bearing: the architect overrides seeds with
// the real directory tree (existing project) or the Module map it designs (new project),
// and unknown stacks simply get [] — the architect then writes the real paths. Correctness
// (conflict-freedom, no deadlock) is enforced by the assignment manifest + the run-team
// gate, never by this map. Keys mirror FRONTEND_IDS / BACKEND_IDS / MOBILE_FRAMEWORK_IDS
// in src/config/state.ts so the vocabulary stays in sync.

export interface LayoutSeed {
  frontend: string[];
  backend: string[];
  mobile: string[];
}

// Idiomatic top-level source locations per framework. Trailing '/' = directory prefix.
const FRONTEND_LAYOUTS: Record<string, string[]> = {
  'react-vite': ['src/', 'public/'],
  nextjs: ['src/app/', 'app/', 'src/components/', 'components/', 'src/lib/', 'src/styles/', 'public/'],
  vue: ['src/', 'public/'],
  svelte: ['src/', 'static/'],
  angular: ['src/app/', 'src/'],
  astro: ['src/pages/', 'src/components/', 'src/layouts/', 'src/styles/', 'public/'],
  solid: ['src/', 'public/'],
  remix: ['app/', 'public/'],
};

const BACKEND_LAYOUTS: Record<string, string[]> = {
  supabase: ['supabase/migrations/', 'supabase/functions/'],
  node: ['src/server/', 'src/api/', 'server/'],
  nestjs: ['src/modules/', 'src/main.ts'],
  python: ['app/', 'api/'],
  fastapi: ['app/api/', 'app/models/', 'app/schemas/', 'alembic/'],
  django: ['*/models.py', '*/views.py', '*/serializers.py', '*/migrations/', 'manage.py'],
  laravel: ['app/Http/', 'app/Models/', 'routes/', 'database/', 'config/'],
  go: ['cmd/', 'internal/', 'pkg/'],
  rust: ['src/', 'migrations/'],
  java: ['src/main/java/', 'src/main/resources/'],
  kotlin: ['src/main/kotlin/', 'src/main/resources/'],
  php: ['src/', 'public/'],
  dotnet: ['Controllers/', 'Models/', 'Services/'],
  firebase: ['functions/'],
};

const MOBILE_LAYOUTS: Record<string, string[]> = {
  'react-native-expo': ['app/', 'src/screens/', 'src/components/', 'assets/'],
  'ionic-capacitor': ['src/pages/', 'src/components/', 'src/app/'],
};

function idOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function proposeLayoutSeed(state: {
  frontend?: unknown;
  backend?: unknown;
  mobile?: unknown;
}): LayoutSeed {
  const mobile = state.mobile && typeof state.mobile === 'object'
    ? (state.mobile as { framework?: unknown }).framework
    : undefined;
  return {
    frontend: FRONTEND_LAYOUTS[idOf(state.frontend)] ?? [],
    backend: BACKEND_LAYOUTS[idOf(state.backend)] ?? [],
    mobile: MOBILE_LAYOUTS[idOf(mobile)] ?? [],
  };
}
