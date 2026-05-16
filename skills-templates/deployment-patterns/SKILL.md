---
name: deployment-patterns
description: Deployment workflows, static-host SPA/Supabase deployment artifacts, CI/CD pipeline patterns, Docker containerization, health checks, rollback strategies, and production readiness checklists for web and Capacitor applications.
metadata:
  source: everything-claude-code
  source_path: skills/deployment-patterns/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

Traffic One precedence: follow this skill only where it does not conflict with Traffic One AGENTS.md and rules/*.md. Forced stack choices, approved libraries, i18n, styling, services, state, testing, accessibility, security, and backend technology rules from Traffic One take precedence.

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
- Generating Vercel/Netlify/Cloudflare Pages + Supabase deployment artifacts
- Preparing Capacitor/Ionic app-store build and submission artifacts

## Traffic One Deployment Artifact Default

Generate deployment artifacts in this order:

1. **Static host manifest first for SPA + Supabase.** A Vite React SPA backed by
   Supabase ships as static assets plus Supabase services. Create exactly one
   host manifest for the selected target (`vercel.json`, `netlify.toml`,
   Cloudflare Pages `_redirects` / `_headers` / `wrangler.toml`). Do not add a
   Dockerfile unless the plan chooses self-hosting, BYOC, SSR/server runtime, or
   another container-only path.
2. **Environment map.** Keep `.env.example` committed and secrets in encrypted
   host/CI variables. Use separate Supabase projects for development, preview,
   staging, and production when those environments exist; never point PR
   previews at production data.
3. **Committed Supabase migrations.** Schema changes live in
   `supabase/migrations/*.sql` and are applied through CI or Supabase Branching.
   Do not instruct production operators to click changes in the dashboard.
4. **CI/CD by default.** GitHub Actions is the baseline: install -> typecheck ->
   test -> build -> preview deploy on PR -> production deploy on `main`/release
   merge. Use `supabase/setup-cli` for migration/function jobs.
5. **Pinned runtime.** Check in `engines`, `packageManager`, `.nvmrc`, and the
   package-manager lockfile. CI uses frozen lockfile install and fails on drift.
6. **Health/status.** For static SPAs, add a `/health` route through a Supabase
   Edge Function, static-host function, or hosted heartbeat endpoint for uptime
   monitors. Capacitor apps also need a simple force-update/version check.
7. **Post-deploy observability.** Add the smallest founder-actionable
   observability set before calling production complete: Supabase Logs Explorer
   visibility for Supabase services, Sentry release tags tied to the git SHA,
   source-map uploads in CI/build, PostHog or explicitly chosen LogRocket replay
   with privacy masking, synthetic checks for `/` and `/health`, email plus one
   chat alert route, SLO burn-rate alerts, and a failed-deploy log analysis
   path.
8. **Launch readiness.** For public launches, invoke `app-launch-checklist` and
   verify SEO metadata/assets, cookie consent, privacy/terms, account deletion,
   data export/right-to-access, WCAG 2.2 AA critical flows, support routing,
   admin hardening, backup restore evidence, payment production tests, staging
   soft-launch, status page, and mobile store-readiness evidence where
   applicable.
9. **Rollback.** Frontend rollback means redeploying the previous immutable
   build/deployment. Database rollback is a forward-only undo migration, not
   `pg_restore` and not editing an already-applied migration.
10. **Domain hardening.** Configure the custom domain, automatic TLS, security
   headers, and an HSTS preload readiness check before calling production done.

### Post-Deploy Observability Baseline

Generate guidance or artifacts only for the app being deployed; do not build a
custom observability platform inside the plugin.

- **Centralized logs:** Supabase projects use the Dashboard Logs Explorer for
  API/PostgREST, Auth, Edge Functions, Postgres, Storage, and Realtime logs.
  App runtime logs write to stdout/stderr for the host to collect; no app-managed
  log files.
- **Client errors:** React/Ionic apps initialize Sentry before application
  imports, set `release` to the commit SHA, upload source maps every production
  build, and remove or block public `.map` files after upload.
- **Edge Function errors:** Supabase Edge Functions use the Sentry Deno SDK with
  per-request `withScope` or direct capture context. Do not store user/tenant
  request data in global Sentry scope because the runtime may be reused.
- **Replay and analytics:** PostHog is the default for replay, funnels, product
  analytics, and feature flags. LogRocket is acceptable when explicit/existing.
  Replay is blocked until inputs, text, query strings, request/response bodies,
  payment/auth/account/admin surfaces, and sensitive DOM regions are masked.
- **Uptime:** Configure synthetic checks for `/` and `/health` every 1-5 minutes
  with email plus one chat destination. Mention the exact monitor provider as
  selected by the project or mark it `Unverified`.
- **SLOs:** Start with simple SLIs such as auth request success rate, API non-2xx
  rate, and uptime. Alert on multi-window burn rate instead of raw error count.
- **API failures:** Track non-2xx rate by endpoint, status family, user/tenant
  hash, and role where available without PII.
- **Slow queries:** For Supabase/Postgres, enable `pg_stat_statements` and
  report normalized query, p95/mean execution time, calls, rows read when
  available, and one suggested index or an `EXPLAIN ANALYZE` follow-up.
- **Failed deploys:** On deploy failure, pull provider build logs, identify the
  failing step, and map common causes to canned fixes: lockfile mismatch,
  missing env var, source-map upload/auth failure, migration conflict, failing
  typecheck/test/build, or missing Supabase link/project secret.
- **AI fix suggestions:** For each error class, propose one patch and a short
  explanation. Require explicit user approval before opening a PR, pushing a
  branch, changing provider settings, running migrations, or redeploying.

### Static Host SPA Manifests

Pick one target and create only that target's files.

**Vercel (`apps/web/vercel.json` or root `vercel.json`):**

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" }
      ]
    }
  ]
}
```

**Netlify (`netlify.toml`):**

```toml
[build]
command = "pnpm build"
publish = "dist"

[[redirects]]
from = "/*"
to = "/index.html"
status = 200
```

**Cloudflare Pages (`public/_redirects` plus `_headers`, or `wrangler.toml` when selected):**

```text
/* /index.html 200
```

```toml
pages_build_output_dir = "dist"
```

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

Let the chosen static host handle the actual preview/production deploy when its
GitHub integration is enabled. Add CLI deploy steps only when the host requires
them or the project deliberately avoids provider Git integrations.

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

### Multi-Stage Dockerfile (Go)

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /server ./cmd/server

FROM alpine:3.19 AS runner
RUN apk --no-cache add ca-certificates
RUN adduser -D -u 1001 appuser
USER appuser

COPY --from=builder /server /server

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["/server"]
```

### Multi-Stage Dockerfile (Python/Django)

```dockerfile
FROM python:3.12-slim AS builder
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY requirements.txt .
RUN uv pip install --system --no-cache -r requirements.txt

FROM python:3.12-slim AS runner
WORKDIR /app

RUN useradd -r -u 1001 appuser
USER appuser

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY . .

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health/')" || exit 1
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "4"]
```

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
          # Platform-specific deployment command
          # Railway: railway up
          # Vercel: vercel --prod
          # K8s: kubectl set image deployment/app app=ghcr.io/${{ github.repository }}:${{ github.sha }}
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
# Docker/Kubernetes: point to previous image
kubectl rollout undo deployment/app

# Vercel: promote previous deployment
vercel rollback

# Railway: redeploy previous commit
railway up --commit <previous-sha>

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
- [ ] Application metrics exported (request rate, latency, errors)
- [ ] Sentry release is tied to git SHA and source maps upload on every build
- [ ] Supabase Logs Explorer covers API/Auth/Edge/Postgres logs where Supabase is used
- [ ] Alerts use SLO burn-rate thresholds, not only raw error counts
- [ ] Log aggregation set up (stdout/stderr, structured, searchable, PII scrubbed)
- [ ] Uptime monitoring on `/` and `/health` at 1-5 minute interval
- [ ] Email plus one chat route exists, with known-flaky third parties suppressed
- [ ] PostHog/LogRocket replay has documented masking/consent before enablement

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
