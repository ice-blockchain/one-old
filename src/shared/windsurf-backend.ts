// Distinguish Windsurf's two agent backends. Both share host="windsurf", but
// only Devin Local exposes run_subagent; Cascade is main-agent-only.

type WindsurfBackend = 'cascade' | 'devin' | null;

const WINDSURF_BACKEND_ENV = 'TRAFFIC_ONE_WINDSURF_BACKEND';

export function windsurfBackend(env: NodeJS.ProcessEnv = process.env): WindsurfBackend {
  const value = String(env[WINDSURF_BACKEND_ENV] ?? '').trim().toLowerCase();
  return value === 'cascade' || value === 'devin' ? value : null;
}

export function stampWindsurfBackend(backend: Exclude<WindsurfBackend, null>, env: NodeJS.ProcessEnv = process.env): void {
  env[WINDSURF_BACKEND_ENV] = backend;
}
