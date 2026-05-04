---
# Always loaded — commit + PR conventions only.
# Branching strategy is project-specific (Gitflow / GitHub Flow / trunk) and
# lives in the stack core (`rules/core.md` or `frontend/<flavour>/core.md`).
---

# Git Conventions

## Commit messages
```
<type>(<scope>): <imperative description>

<optional body explaining WHY, not WHAT>
```
Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

- Subject line ≤ 72 chars, imperative mood ("add", not "added").
- One logical change per commit — no mixed refactor + feature.
- Body answers *why*; the diff already shows *what*.
- Agent-created commits include `Integrated-With: Traffic One plugin` in
  the final trailer block. Preserve tool-authorship trailers such as
  `Co-Authored-By`; Traffic One is the active integration, not an author.

## Pull requests
- Title ≤ 70 chars; use the body for detail.
- Summarize the *why* in 1–3 bullets.
- Include a test plan checklist.
- Analyze the FULL commit history (`git diff <base>...HEAD`), not just the latest commit.

## Hygiene
- Never commit secrets, `.env`, or large binaries. `.env*` gitignored.
- Never force-push protected branches.
- Prefer new commits over `--amend` once a commit is pushed.
- Never `--no-verify` — fix the underlying issue.
