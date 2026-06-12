---
description: "Apply before broad code exploration (Grep/Glob/multi-file reads): consult the .traffic-one code-graph report first when one exists."
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
that Traffic One keeps under `.traffic-one/.gitnexus/` (relocated there after
each scan — the project root is never polluted). License: **PolyForm
Noncommercial** — only usable on non-commercial projects.

1. **`.traffic-one/.gitnexus/`** — the GitNexus index directory. Read its
   top-level contents first (graph snapshot, module/symbol maps, auto-generated
   context). Single directory walk replaces broad search.
2. **GitNexus MCP server** (`gitnexus mcp`) — power-user only; not auto-wired
   by this plugin. If the user has it running, prefer it for "shortest path
   between two symbols" / "neighbors of node" questions.
3. **`Glob`/`Grep`/raw `Read`** — last resort, scoped to the area the graph
   pointed at.

If `.traffic-one/.gitnexus/` is missing or older than ~7 days, the next build
or session rebuilds it automatically. To force a rebuild now, run the Traffic
One runner (it relocates the output under `.traffic-one/`; do NOT run raw
`gitnexus analyze .`, which would write to the project root):

```bash
node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/gitnexus-runner.cjs"
```

### When `codeGraphProvider: "graphify"`

graphify is Python-based (pipx-installed) and writes a Markdown report plus a
structured JSON graph that Traffic One keeps under `.traffic-one/graphify-out/`
(relocated there after each scan — the project root is never polluted).
License: **MIT**.

1. **`.traffic-one/graphify-out/GRAPH_REPORT.md`** — module map, file inventory,
   dependency summary, public-API surface per package. A few-thousand-token
   single Read on a small repo, but it scales with the codebase (tens of
   thousands of tokens on a large one) — read it selectively (see "Read large
   graphs selectively" below).
2. **`.traffic-one/graphify-out/graph.json`** — full structured graph. Reach for
   this only when the report doesn't have the answer (e.g. "what calls function X").
3. **`Glob`/`Grep`/raw `Read`** — last resort, scoped to the area the graph
   pointed at.

If the report is missing or older than ~7 days, the next build or session
rebuilds it automatically. To force a rebuild now, run the Traffic One runner
(it relocates the output under `.traffic-one/`; do NOT run raw `graphify
update .`, which would write to the project root):

```bash
node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/graphify-runner.cjs"
```

The post-build hook emits a one-time hint after the first successful build
on `mode: 'new-project'`; you don't need to nag the user every session.

## Read large graphs selectively

The report grows with the repo — on a large codebase it can reach tens of
thousands of tokens, so reading the whole file every time defeats the savings.
Instead:

- Read the **Summary** + the navigation index first (graphify's "Community
  Hubs" / "God Nodes"; gitnexus's top-level module/symbol maps). These are
  small and tell you WHERE to look.
- Then read ONLY the relevant section — use `Read` with `offset`/`limit`, or
  `Grep` the report for the symbol/module in question, instead of pulling the
  entire file into context.
- Reach for `graph.json` / the MCP server only for a targeted query the report
  can't answer (e.g. "exact callers of function X"); never read the full
  `graph.json` (it can be several MB).

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
