---
# Always loaded
---

# Git Workflow

## Commit messages
```
<type>: <imperative description>

<optional body explaining WHY, not WHAT>
```
Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

- Subject line ≤ 72 chars, imperative mood ("add", not "added").
- One logical change per commit — no mixed refactor + feature.
- Body answers *why* the change is needed; the diff already shows *what*.

## Branching (GitHub Flow, default)
- `main` is always deployable.
- Feature branches from `main`; name `feat/short-desc`, `fix/short-desc`.
- Short-lived — merge within 1–3 days. Long branches = merge hell.
- PR → review → CI green → merge → deploy.

## Pull requests
- Title ≤ 70 chars; use the body for detail.
- Summarize the *why* in 1–3 bullets.
- Include a test plan (checklist of what to verify).
- Analyze the FULL commit history (`git diff base...HEAD`), not just the latest commit, when writing the description.

## Hygiene
- Never commit secrets, `.env`, or large binaries. `.env.local` must be gitignored.
- Never force-push to `main`/`master`.
- Prefer new commits over `--amend` once a commit is pushed.
- Do not skip hooks (`--no-verify`) — fix the underlying issue.
