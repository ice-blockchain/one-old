---
# Always loaded. Tells every agent / skill / subagent to consult the
# active codebase-graph provider's report before falling back to broad
# Glob/Grep. The provider is chosen at onboarding and recorded as the
# machine-wide `codeGraphProvider` setting (required field), reused across projects.
---

# Codebase graph — token-cheap structure cache

When the user's repo has a codebase-graph artefact on disk, **read it before
answering any "where does X live / what calls Y / what's in module Z"
question.** It is a one-shot file-read that replaces dozens of `Glob` / `Grep`
calls and cuts cross-session token usage by an estimated 50–70% on multi-file
work.

The active provider is selected at onboarding and stored as the machine-wide
Traffic One `codeGraphProvider` setting in `~/.traffic-one/one.json`, reused
across projects (a provider already installed locally is detected and reused, so
onboarding stops re-prompting). Valid values:
`gitnexus`, `graphify`. Both produce different on-disk artefacts; the read
protocol below covers each.

## Provider-aware read protocol (priority order)

### When `codeGraphProvider: "gitnexus"`

GitNexus is Node-based (npm-installed) and writes a knowledge-graph index
plus auto-generated context files under `.gitnexus/`. License: **PolyForm
Noncommercial** — only usable on non-commercial projects.

1. **`.gitnexus/`** — the GitNexus index directory. Read its top-level
   contents first (graph snapshot, module/symbol maps, auto-generated
   context). Single directory walk replaces broad search.
2. **GitNexus MCP server** (`gitnexus mcp`) — power-user only; not auto-wired
   by this plugin. If the user has it running, prefer it for "shortest path
   between two symbols" / "neighbors of node" questions.
3. **`Glob`/`Grep`/raw `Read`** — last resort, scoped to the area the graph
   pointed at.

If `.gitnexus/` is missing or older than ~7 days, the post-build hook in
`scripts/hook-runtime/handlers.cjs` will rebuild it. Manual rebuild:

```bash
npm install -g gitnexus   # one-time install (Node CLI; npx works too)
gitnexus analyze .
```

### When `codeGraphProvider: "graphify"`

graphify is Python-based (pipx-installed) and writes a Markdown report plus
a structured JSON graph under `graphify-out/`. License: **MIT**.

1. **`graphify-out/GRAPH_REPORT.md`** — module map, file inventory,
   dependency summary, public-API surface per package. Few-thousand-tokens,
   single Read.
2. **`graphify-out/graph.json`** — full structured graph. Reach for this only
   when the report doesn't have the answer (e.g. "what calls function X").
3. **`Glob`/`Grep`/raw `Read`** — last resort, scoped to the area the graph
   pointed at.

If the report is missing or older than ~7 days, manual rebuild:

```bash
pipx install graphifyy   # one-time install (Python tool)
graphify update .
graphify hook install    # optional: regenerate on every git commit
```

The post-build hook emits a one-time hint after the first successful build
on `mode: 'new-project'`; you don't need to nag the user every session.

## License & conflict notes

- **gitnexus** is PolyForm Noncommercial. The onboarding question records
  the user's choice as their consent that the project qualifies. GitNexus
  auto-writes `AGENTS.md`, `CLAUDE.md`, and `.claude/skills/` which overlap
  traffic-one's own files; the runner backs up and restores traffic-one's
  versions automatically.
- **graphify** is MIT. No conflict mitigation needed.

## Skip when

- The user is asking a non-structural question (a feature change, a UI tweak,
  a styling decision). The graph is for *where things live*, not *what should
  they look like*.
- You only need the contents of one specific file the user already named.

## Opt-out

Set `"codeGraphAutoRun": false` in local Traffic One preferences to disable
auto-build/auto-install for the active provider. (Legacy
`"graphifyAutoRun": false` is honoured for one version of forward
compatibility.)
