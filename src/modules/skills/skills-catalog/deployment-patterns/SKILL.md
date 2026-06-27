---
name: deployment-patterns
description: Deployment workflows, static-host SPA/Supabase deployment artifacts, CI/CD pipeline patterns, Docker containerization, health checks, rollback strategies, and production readiness checklists for web and Capacitor applications.
metadata:
  source: everything-claude-code
  source_path: skills/deployment-patterns/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Deployment Patterns

Production deployment workflows and CI/CD best practices. For Traffic One
React SPA + Supabase projects, the default output is the smallest set of
production artifacts that can ship reliably: one static-host manifest, one
CI/CD workflow, environment documentation, Supabase migrations, and a concrete
rollback path. Docker is only for self-hosted, BYOC, or server-runtime targets.

## When to Activate

- Setting up CI/CD pipelines
- Dockerizing an application
- Planning deployment strategy (blue-green, canary, rolling)
- Implementing health checks and readiness probes
- Preparing for a production release
- Configuring environment-specific settings
- Generating the Traffic One `/deploy` build artifacts (a host-agnostic static `dist/` output) + Supabase deployment artifacts
- Preparing Capacitor/Ionic app-store build and submission artifacts

## Traffic One Deployment Artifact Default

Generate deployment artifacts in this order:

1. **Static build output first for SPA + Supabase.** A Vite React SPA backed by
   Supabase ships as static assets (a `dist/` build) plus Supabase services.
   Produce a host-agnostic static build — Traffic One owns web deploy via its own
   `/deploy`, which ships that `dist/` to our infra; do NOT add a third-party web
   host or its manifest (`vercel.json`, `netlify.toml`, Cloudflare `wrangler.toml`,
   etc.). Do not add a Dockerfile unless the plan chooses self-hosting, BYOC,
   SSR/server runtime, or another container-only path.
2. **Environment map.** Keep `.env.example` committed and secrets in encrypted
   host/CI variables. Use separate Supabase projects for development, preview,
   staging, and production when those environments exist; never point PR
   previews at production data.
3. **Committed Supabase migrations.** Schema changes live in
   `supabase/migrations/*.sql` and are applied through CI or Supabase Branching.
   Do not instruct production operators to click changes in the dashboard.
4. **CI/CD by default.** GitHub Actions is the baseline: install -> typecheck ->
   test -> build (produce the static `dist/`). Deployment is Traffic One's own:
   the gated `senior-shipper` pre-flight runs Traffic One `/deploy` (preview on
   PR, production on `main`/release merge) — do not wire a third-party host's
   deploy action into CI. Use `supabase/setup-cli` for migration/function jobs.
5. **Pinned runtime.** Check in `engines`, `packageManager`, `.nvmrc`, and the
   package-manager lockfile. CI uses frozen lockfile install and fails on drift.
6. **Health/status.** For static SPAs, add a `/health` route through a Supabase
   Edge Function, static-host function, or hosted heartbeat endpoint for uptime
   monitors. Capacitor apps also need a simple force-update/version check.
7. **Post-deploy observability (logging, error tracking, replay privacy, SLOs,
   AI-fix approval): see the `observability` skill.**
8. **Launch readiness.** For public launches, invoke `app-launch-checklist` and
   verify SEO metadata/assets, cookie consent, privacy/terms, account deletion,
   data export/right-to-access, WCAG 2.2 AA critical flows, support routing,
   admin hardening, backup restore evidence, payment production tests, staging
   soft-launch, status page, and mobile store-readiness evidence where
   applicable.
9. **Rollback.** Frontend rollback means redeploying the previous immutable
   build/deployment. Database rollback is a forward-only undo migration, not
   `pg_restore` and not editing an already-applied migration.
10. **Domain hardening.** Custom domain, automatic TLS, security headers, and an
   HSTS preload readiness check are part of the Traffic One `/deploy` configuration —
   verify them before calling production done.

### Static Build Output (host-agnostic)

Web deployment is Traffic One's own (`/deploy`) — do NOT generate a third-party
host manifest (`vercel.json`, `netlify.toml`, `wrangler.toml`, `_redirects`/`_headers`).
Produce a clean static build and let Traffic One `/deploy` ship it:

- **Build to `dist/`.** `pnpm build` emits the static assets; that `dist/` IS the
  deploy artifact Traffic One ships.
- **SPA fallback.** A client-routed SPA needs every unknown path served
  `index.html` (HTTP 200). Traffic One `/deploy` applies this fallback; do not
  hand-roll a host-specific rewrite file.
- **Security headers.** The deploy must set, at minimum, these response headers
  (Traffic One `/deploy` applies them; they are also the values a security review
  expects):
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`

### Supabase Environment + Migration Workflow

- Environment secrets in CI/host: `SUPABASE_ACCESS_TOKEN`,
  `<ENV>_SUPABASE_PROJECT_ID`, `<ENV>_SUPABASE_DB_PASSWORD`, plus app-facing
  `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` per host environment.
- Local commands are idempotent and documented:
  `supabase migration new <name>`, `supabase db diff -f <name>`,
  `supabase db push --linked`, `supabase migration list`.
- Production applies only committed migrations. Never write `DROP TABLE` or
  destructive `DROP COLUMN` without a tested forward undo migration and a
  two-phase rollout plan.
- Supabase Branching should be enabled for PR previews when available. Preview
  branches get isolated project credentials and no copied production data.

### GitHub Actions (React SPA + Supabase default)

```yaml
name: Deploy

on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build

  supabase:
    needs: verify
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    environment: production
    env:
      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      SUPABASE_DB_PASSWORD: ${{ secrets.PRODUCTION_SUPABASE_DB_PASSWORD }}
      SUPABASE_PROJECT_ID: ${{ secrets.PRODUCTION_SUPABASE_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: supabase link --project-ref "$SUPABASE_PROJECT_ID"
      - run: supabase db push
```

Traffic One `/deploy` performs the actual preview/production deploy of the built
`dist/` to our infra, after the gated `senior-shipper` pre-flight. Do not wire a
third-party host's Git integration or CLI deploy step into CI — web deploy is
Traffic One's own.

### Capacitor / Ionic Release Artifacts

When the project includes Capacitor delivery, generate or verify:

- `capacitor.config.ts` with stable reverse-DNS `appId`, correct `appName`,
  `webDir` pointing at the Vite build output, and the production deep-link
  scheme/domain.
- iOS signing identity and provisioning profile references stored in CI secrets.
- Android keystore, alias, and passwords stored as CI secrets, never committed.
- Apple Universal Links and Android App Links files served from the web domain:
  `/.well-known/apple-app-site-association` and
  `/.well-known/assetlinks.json`.
- Store submission metadata: bundle ID/application ID, version/build number
  bump, screenshots, age rating, App Privacy/Data Safety answers, privacy
  policy URL, support URL, review notes/demo access, in-app account deletion
  when account creation exists, and iOS `PrivacyInfo.xcprivacy` plus required
  SDK privacy manifests/required-reason API declarations.
- Google Play target API compliance, Play App Signing, Android App Bundle
  readiness, and Data Safety answers verified against current official docs.
- ASO assets: app name, iOS subtitle/keywords, Android short/long description,
  localized screenshots for required device sizes, content rating, and release
  notes.
- Permission prompts shown in context, not on launch.
- TestFlight and Play Internal Testing evidence from at least five external
  testers before public release unless the user explicitly accepts a smaller
  private-launch risk.
- OTA/live update strategy for web-only fixes, such as Capgo or Capacitor Live
  Updates, with a release-channel rollback plan.

## Deployment Strategies

### Rolling Deployment (Default)

Replace instances gradually — old and new versions run simultaneously during rollout.

```
Instance 1: v1 → v2  (update first)
Instance 2: v1        (still running v1)
Instance 3: v1        (still running v1)

Instance 1: v2
Instance 2: v1 → v2  (update second)
Instance 3: v1

Instance 1: v2
Instance 2: v2
Instance 3: v1 → v2  (update last)
```

**Pros:** Zero downtime, gradual rollout
**Cons:** Two versions run simultaneously — requires backward-compatible changes
**Use when:** Standard deployments, backward-compatible changes

### Blue-Green Deployment

Run two identical environments. Switch traffic atomically.

```
Blue  (v1) ← traffic
Green (v2)   idle, running new version

# After verification:
Blue  (v1)   idle (becomes standby)
Green (v2) ← traffic
```

**Pros:** Instant rollback (switch back to blue), clean cutover
**Cons:** Requires 2x infrastructure during deployment
**Use when:** Critical services, zero-tolerance for issues

### Canary Deployment

Route a small percentage of traffic to the new version first.

```
v1: 95% of traffic
v2:  5% of traffic  (canary)

# If metrics look good:
v1: 50% of traffic
v2: 50% of traffic

# Final:
v2: 100% of traffic
```

**Pros:** Catches issues with real traffic before full rollout
**Cons:** Requires traffic splitting infrastructure, monitoring
**Use when:** High-traffic services, risky changes, feature flags

## Docker

Use this section only when the selected deployment target needs a container
(self-hosted Node service, BYOC, worker/runtime that cannot be static-hosted,
or a multi-service backend). For a React/Vite SPA plus Supabase, generate the
static-host artifacts above instead of a Dockerfile.

### Multi-Stage Dockerfile (Node.js)

```dockerfile
# Stage 1: Install dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Stage 2: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN npm prune --production

# Stage 3: Production image
FROM node:22-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001
USER appuser

COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/package.json ./

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
```

The same multi-stage shape ports to other runtimes:

- **Go:** `golang:1.22-alpine` builder with `CGO_ENABLED=0 GOOS=linux go build
  -ldflags="-s -w"`, copy the single static binary into `alpine:3.19` (add
  `ca-certificates`), non-root user, `HEALTHCHECK` against `/health`.
- **Python/Django:** `python:3.12-slim` builder installing deps with `uv pip
  install --system`, copy `site-packages` + `/usr/local/bin` into a slim runner,
  non-root user, `ENV PYTHONUNBUFFERED=1`, run via `gunicorn config.wsgi`.

### Docker Best Practices

```
# GOOD practices
- Use specific version tags (node:22-alpine, not node:latest)
- Multi-stage builds to minimize image size
- Run as non-root user
- Copy dependency files first (layer caching)
- Use .dockerignore to exclude node_modules, .git, tests
- Add HEALTHCHECK instruction
- Set resource limits in docker-compose or k8s

# BAD practices
- Running as root
- Using :latest tags
- Copying entire repo in one COPY layer
- Installing dev dependencies in production image
- Storing secrets in image (use env vars or secrets manager)
```

## CI/CD Pipeline

### GitHub Actions (Container Pipeline)

Use this instead of the React SPA + Supabase default only when the deployment
target actually builds and ships a container image.

```yaml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test -- --coverage
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage
          path: coverage/

  build:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    environment: production
    steps:
      - name: Deploy to production
        run: |
          # Web app: Traffic One owns deploy — the gated senior-shipper pre-flight
          #          runs `/deploy`, which ships the built dist/ to our infra.
          #          Do NOT call a third-party web host CLI here.
          # Self-hosted / container (BYOC only): kubectl set image deployment/app app=ghcr.io/${{ github.repository }}:${{ github.sha }}
          echo "Deploying ${{ github.sha }}"
```

### Pipeline Stages

```
PR opened:
  lint → typecheck → unit tests → integration tests → preview deploy

Merged to main:
  lint → typecheck → unit tests → integration tests → build static artifact or image → deploy staging → smoke tests → deploy production
```

## Health Checks

### Health Check Endpoint

```typescript
// Simple health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Detailed health check (for internal monitoring)
app.get("/health/detailed", async (req, res) => {
  const checks = {
    database: await checkDatabase(),
    redis: await checkRedis(),
    externalApi: await checkExternalApi(),
  };

  const allHealthy = Object.values(checks).every(c => c.status === "ok");

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION || "unknown",
    uptime: process.uptime(),
    checks,
  });
});

async function checkDatabase(): Promise<HealthCheck> {
  try {
    await db.query("SELECT 1");
    return { status: "ok", latency_ms: 2 };
  } catch (err) {
    return { status: "error", message: "Database unreachable" };
  }
}
```

### Kubernetes Probes

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 2

startupProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 0
  periodSeconds: 5
  failureThreshold: 30    # 30 * 5s = 150s max startup time
```

## Environment Configuration

### Twelve-Factor App Pattern

```bash
# All config via environment variables — never in code
DATABASE_URL=postgres://user:pass@host:5432/db
REDIS_URL=redis://host:6379/0
API_KEY=${API_KEY}           # injected by secrets manager
LOG_LEVEL=info
PORT=3000

# Environment-specific behavior
NODE_ENV=production          # or staging, development
APP_ENV=production           # explicit app environment
```

### Configuration Validation

```typescript
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

// Validate at startup — fail fast if config is wrong
export const env = envSchema.parse(process.env);
```

## Rollback Strategy

### Instant Rollback

```bash
# Web (Traffic One owns deploy): re-ship the previous immutable /deploy build
#   (the senior-shipper rollback step promotes the prior deploy on our infra)

# Self-hosted / container (BYOC only): point to previous image
kubectl rollout undo deployment/app

# Database: apply a new forward-only undo migration
pnpm db:push
```

### Rollback Checklist

- [ ] Previous image/artifact is available and tagged
- [ ] Database migrations are backward-compatible or have a tested forward undo migration
- [ ] Feature flags can disable new features without deploy
- [ ] Monitoring alerts configured for error rate spikes
- [ ] Rollback tested in staging before production release

## Production Readiness Checklist

Before any production deployment:

### Application
- [ ] All tests pass (unit, integration, E2E)
- [ ] No hardcoded secrets in code or config files
- [ ] Error handling covers all edge cases
- [ ] Logging is structured (JSON) and does not contain PII
- [ ] Health check endpoint returns meaningful status

### Infrastructure
- [ ] Static artifact or Docker image builds reproducibly (pinned versions)
- [ ] Environment variables documented and validated at startup
- [ ] Resource limits set (CPU, memory)
- [ ] Horizontal scaling configured (min/max instances)
- [ ] SSL/TLS enabled on all endpoints

### Monitoring
- Post-deploy observability (logging, error tracking, replay privacy, SLOs,
  AI-fix approval): see the `observability` skill.

### Security
- [ ] Dependencies scanned for CVEs
- [ ] CORS configured for allowed origins only
- [ ] Rate limiting enabled on public endpoints
- [ ] Authentication and authorization verified
- [ ] Security headers set (CSP, HSTS, X-Frame-Options)

### Operations
- [ ] Rollback plan documented and tested
- [ ] Database migration tested against production-sized data
- [ ] Runbook for common failure scenarios
- [ ] On-call rotation and escalation path defined
