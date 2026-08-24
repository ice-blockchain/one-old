# Privacy

What Traffic One transmits, what it writes to your disk, and — the part most
people care about and most documents skip — **what it puts into your git
repository**.

Everything below was derived by reading the code that does it. Where a statement
would have been convenient but is not true of this tree, it is not here. Where
something is a real disclosure, it is stated plainly rather than softened.

---

## Summary

- Traffic One sends **your API key** to one endpoint, and **anonymous structural
  facts about your codebase** to another. It never sends your source code, file
  contents, file names, paths, repository name, prompts, or agent transcripts to
  anything.
- The anonymous report is **opt-in per project** and requires an explicit
  recorded `yes`.
- Traffic One writes a lot to your disk, in two places, and most of it never
  leaves the machine.
- **Your first prompt is not committed.** It is kept on this machine only, in
  your per-user preference file, outside the repository. A project set up by an
  older version has its copy moved out automatically. See "What lands in your
  git repository" for the one case that cannot be repaired.

---

## What leaves your machine

Four kinds of outbound request exist. There is no fifth: no telemetry pipeline,
no crash reporter, no analytics SDK, no background beacon.

### 1. Authenticated: your API key, to the Traffic One MCP endpoint

**Endpoint:** `https://otxgutlmatdihqkbsvvh.supabase.co/functions/v1/traffic-one-mcp/mcp`
(compiled in as `DEFAULT_ENDPOINT`; there is no environment override).

**When:** at wizard intake, when you paste a key; and thereafter at most **once
every 24 hours per machine**, fired detached from SessionStart. Not once per
session — auth is machine-level, and a per-session probe would cost one network
call per project per session for one machine-wide answer.

**What is sent, exactly:** an HTTPS POST whose body is

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"updates","arguments":{}}}
```

with headers `authorization: Bearer <your API key>`, `content-type`,
`accept`, `content-length`. On a later page the `arguments` carry a `cursor`
string returned by a previous response, passed back verbatim.

**That is the whole payload.** No project path, no repository identity, no
hostname, no machine id, no prompt, no file data. The request is identical for
every project on your machine, because it is a question about your subscription
and not about your work.

One request serves two purposes deliberately: it revalidates the key *and*
returns your `updates` announcement feed, because the server rate-limits per
user identity and two calls would spend twice the budget to learn what one call
proves.

**What comes back:** announcement records with `title`/`body` text. These are
rows in a remote database that end up in agent-visible context, so they are
bounded and sanitised on arrival: 500 characters per field, at most 100 items,
2000 characters per rendered block.

**The key itself is never echoed anywhere.** Not into session context, not into
advisories, not into `doctor` output — deliberately, including not as a suffix
or hint, because those strings land in transcripts, logs and pasted issues.

**When the endpoint cannot be reached**, Traffic One keeps working on the key
already stored, for a bounded 7-day grace window, and after that keeps working
while saying so once per session. It does not fail closed on an unanswered
question, because being unable to reach the internet is not evidence that your
subscription lapsed.

### 2. Anonymous: model configuration sync

**Endpoint:** `.../traffic-one-mcp/public-mcp` — the public mount. **No bearer,
no cookie, no API key.** A failure here, 401 and 403 included, can never
invalidate your stored credential.

**What is sent:** a `get_config` tool call whose arguments are
`{ config_name, version }` — the host-keyed row name
(`traffic_one_<host>_plugin_ai_model_configuration`) and an integer cache
version. Nothing about your project.

**When:** at SessionStart, in a project you explicitly opted into.

### 3. Anonymous: the one-time structural first-look report

**Endpoint:** the same public mount, no bearer.

**Gating:** strict opt-in. It requires a durable, recorded per-project
`pluginUse.enabled === true`. A missing answer is **not** consent and is never
treated as "not declined". It is sent once per project, deduplicated by a
`one-uid`.

**What is sent — the complete field list, and nothing else:**

| Field | Content |
|---|---|
| `report_id` | a generated UUIDv7 |
| `technologies` | identifiers drawn from a **fixed, finite vocabulary** compiled into the plugin (`react`, `go`, `postgres`, …). Unknown state prose is ignored rather than transmitted |
| `file_extensions` | per-extension **line counts**, top 50, extensions drawn from a fixed vocabulary. `{"ts": 41203, "md": 5100}` — counts, never names, never contents |
| `architecture_components` | at most 50 structural component identifiers |
| `infrastructure_vendor` | one of `vercel`, `netlify`, `cloudflare`, `fly`, `render`, `railway`, or `unknown`, decided by the presence of a config file |

The vocabularies are finite **on purpose**: a project-controlled string —
a filename suffix, a dependency name — could otherwise carry an email address, a
repository name or arbitrary text out with it. Anything not in the vocabulary is
dropped, not transmitted.

No source, no paths, no URLs, no names, no prompts.

To send nothing at all, decline the plugin for that project.

### 4. Availability probes and downloads

- **Dashboard reachability:** a request to `https://traffic.io/onboarding/agent`
  to decide whether to send you to the hosted wizard or the loopback fallback.
  The onboarding **port and token ride in the URL fragment** (`#p=…&t=…`), which
  browsers never transmit — so they never reach traffic.io's servers or logs.
- **Managed runtime downloads,** only when your machine has no suitable
  Python/Node: `nodejs.org` and the `astral-sh/python-build-standalone` GitHub
  releases, each verified against the publisher's own checksum file. Disable with
  `TRAFFIC_ONE_MANAGED_RUNTIME_OFF=1`.
- **Third-party tool installs** through `npm`/`pip` when you choose a code-graph
  provider or OpenCode delegation. See `THIRD-PARTY-NOTICES.md`.

---

## What is written to your machine

### Per-user machine state — `~/.traffic-one/`

(`$XDG_STATE_HOME/traffic-one` when that variable is set.)

| Path | Contents |
|---|---|
| `one.json` | The consolidated user settings envelope. **This is where your API key lives**, under `auth.apiKey`, in a file created mode `0600`. Also the code-graph provider choice. Never copy it into a project |
| `one-mcp.json` | Cached model catalog from the public sync |
| `auth-revalidation.json`, `auth-updates.json` | The 24-hour revalidation cadence stamp and the update-feed cursor |
| `projects/<hash>/preferences.json` | **Per-project preferences, keyed by a hash of the project path.** Your `pluginUse` yes/no answer lives here — outside the repository, so a declined project carries no Traffic One files at all. **This is also where your first prompt is stored**, under `originalPrompt` |
| `bin/` | Version-stable runner shims, so host command approvals survive plugin upgrades |
| `toolchains/` | Managed third-party tools and standalone runtimes. Can exceed 1 GB |
| `overrides/` | The operator-override HMAC key, audit ledger, and pre-override snapshots |
| `debug/hook-trace.on` | Marker file that arms the hook tracer. Absent unless you created it |

### Per-project state — `<your project>/.traffic-one/`

| Path | Contents | In git? |
|---|---|---|
| `.one.json` | Project state: mode, stack, detected surfaces, run pointers, and the onboarding questionnaire's short summary and typed answers. **Not your first prompt** — see below | **Committed** |
| `rules/`, `skills/` | Materialized rule and skill content for your stack | **Committed** |
| `digests/` | Handoff records between roles | **Committed**, deliberately |
| `runs/<id>/` | Per-run artifacts, claims, ledger | Ignored |
| `runs/<id>/debug/decisions.jsonl` | The decision log — append-only, on by default, bounded by bytes | Ignored |
| `debug/` | Project-level debug, including `hook-trace.jsonl` when the tracer is armed | Ignored |
| `reports/`, `backups/`, `one-mcp-report.json` | Reports, backups, report status | Ignored |

**Before you have answered the use-plugin question, Traffic One writes nothing
into your project — not even a marker.** That is enforced by a write fence on the
path, inside the shared IO layer, so a new writer is refused by default rather
than by remembering to ask. Declining removes the runtime residue it may already
have created.

### The decision log

`.traffic-one/runs/<id>/debug/decisions.jsonl` records every verdict the hook
pipeline produced: the event, host, decision, gate id, deny id, correlation id
and timestamps. It is **on by default** and is the thing that makes "why did this
wedge?" answerable.

Its `inputs` field carries per-gate context, and for a prompt-submit decision
**that includes your prompt text verbatim**. Its `stateWrites` field can echo
file paths and small value fragments.

Both facts are why `doctor --bundle` — the artifact you attach to a bug report —
**drops `inputs` and `stateWrites` entirely** rather than trying to pattern-match
them. It also redacts, to the literal string `[redacted]`:

- **every field whose name contains the word `prompt`** — `originalPrompt` in
  your per-user preferences, `originalPrompt` in the project state, and
  `projectContext.originalPrompt` in an older project that still has one;
- `projectContext.summary` and `projectContext.answers`, which are the
  questionnaire text you typed;
- every credential-shaped key name, and every credential-shaped *value*
  (connection strings with passwords, `sk-` keys, bearer JWTs) wherever they
  appear.

Plain `doctor` stdout gets the same redaction, because an agent parses it and it
lands in the host transcript.

The log is gitignored, and the retention sweep removes stale entries. It stays on
your machine unless you send it somewhere.

### The hook trace

Off by default. Armed only by `TRAFFIC_ONE_HOOK_TRACE` or by creating
`~/.traffic-one/debug/hook-trace.on` yourself.

**As this tree stands, it records the SHAPE of a hook payload, never its
values.** Each line carries which keys the host sent, nested where, of what type
and what byte size — `{"tool_input": {"command": "string(42)"}}`, not the
command. Environment variables are allowlisted by name, denied by
secret-shaped name, and truncated to 256 characters. File **paths** are recorded
(`tool.filePath`, which is how a line is correlated to a run); file **contents**
never are.

This is a deliberate change from an earlier version that appended up to 8 KB of
raw stdin — which is the entire text of a `Write` (a `.env` body, verbatim) or a
`Bash` command line (an inline bearer token) into a plain JSONL file inside your
project.

---

## What lands in your git repository

This is the section that matters most, because a file in your repository can be
pushed to a shared remote and read by everyone with access to it.

`.traffic-one/` is **not** ignored wholesale. The generated `.gitignore` block
ignores exactly `runs/`, `reports/`, `backups/`, `debug/` and
`one-mcp-report.json`. Everything else under `.traffic-one/` is tracked on
purpose — the root `AGENTS.md` Traffic One materializes references the rules,
skills and digests on 15 lines, and a fresh clone with those files ignored gets
a kernel pointing at roughly 50 files that are not in the repository.

### `.traffic-one/.one.json` is committed, and your first prompt is not in it

`.one.json` is committed by design: it is the project's mode-bearing state file,
and a clone without it cannot resolve the project root.

**Your first prompt is not part of it.** The text you type when you set a project
up — "build me a learning platform with React and Go" — is stored once, in your
per-user preference file at
`~/.traffic-one/projects/<hash>/preferences.json`, under `originalPrompt`. That
file is outside your repository, is never committed, and is per-machine and
per-user: a colleague who clones the project does not get your copy.

What the committed file *does* carry from the setup wizard is the
`projectContext` block: the **one-line summary** you typed in the Summary box,
the **answers** you typed into the questionnaire fields, and a timestamp. Those
are your words too — short, and about the project rather than about you, but
committed and pushed all the same. If you would not want a questionnaire answer
read by everyone with access to the repository, do not type it there. Leaving the
Summary box blank is safe: it falls back to your stated audience, or to the
placeholder `MVP`, and never to your prompt.

**If you set this project up with an older version of Traffic One**, the prompt
was written into `.one.json` — as `projectContext.originalPrompt`, and, if you
left the Summary box blank, a second time as `projectContext.summary`. Traffic
One repairs that for you: on the next session in that project, both copies are
removed from the committed file and the text is moved into your per-user
preference file. Nothing is lost — the wizard defaults and stack derivation that
read it keep working — and the summary is replaced with the same short
description a fresh setup would have produced.

Two limits on that repair, stated because they are real:

- **A commit already pushed keeps the prompt in git history.** The repair edits
  the working file. It cannot rewrite commits you have already made, and it
  cannot reach a remote. If the prompt is already in a pushed commit and it says
  something it should not, that is a history-rewrite problem
  (`git filter-repo` and a force push, coordinated with everyone who has a
  clone), not something a plugin upgrade can fix for you.
- **A project where you have not yet answered "use Traffic One here?" keeps its
  copy until you do.** Traffic One writes nothing into a project before that
  answer, and the repair is a write. Answer the question — either way — and the
  next session performs it. Declining also removes the runtime residue.

What is true either way:

- The prompt never leaves your machine through Traffic One. The anonymous report
  cannot carry it: the vocabulary is finite and free text is not in it.
- `doctor --bundle` redacts it, in the preference file and the project state
  alike, so attaching a bug report does not disclose it.

**If you want to check your own project:** open `.traffic-one/.one.json` and
search it for your prompt. On a repaired project you will not find it. If you do
— because the project is still awaiting the use-plugin answer — you can delete
the value by hand; nothing downstream requires it to be intact.

### The other committed paths

`.traffic-one/rules/` and `.traffic-one/skills/` are Traffic One's own content,
materialized for your stack — no prompts, no user text.
`.traffic-one/digests/` holds handoff records written by agent roles during a
run: summaries of work done, in the agents' words. They are committed
deliberately (the handoff record is worth keeping) and they describe your
project. If your project is sensitive, review them like any other committed
artifact.

---

## Things Traffic One does not do

Stated because their absence is itself a claim, and each is verifiable in this
tree:

- No source code, file contents or file names are transmitted anywhere.
- No prompts or agent transcripts are transmitted anywhere.
- No usage analytics, no session telemetry, no crash reporting.
- No machine fingerprint, hostname, username or IP-derived identifier is
  assembled or sent.
- The anonymous endpoints never receive your API key, and never receive any
  bearer, cookie or credential at all.
- The authenticated endpoint receives only your key — never anything about the
  project you are working in.

---

## Turning things off

| To stop | Do |
|---|---|
| All Traffic One activity in a project | Decline the plugin when asked. Every hook stands down and the project is left untouched |
| The anonymous report and model sync | Same — both require the recorded per-project opt-in |
| The decision log | `T1_DECISION_LOG=off` |
| The hook trace | It is already off. Do not set `TRAFFIC_ONE_HOOK_TRACE` and do not create the marker file |
| Managed runtime downloads | `TRAFFIC_ONE_MANAGED_RUNTIME_OFF=1` |
| The code-graph tools entirely | `"codeGraphAutoRun": false` in your local Traffic One preferences |
| Everything, permanently | `node /path/to/traffic-one/dist/scripts/traffic-one-uninstall.cjs --yes` removes host integrations, all of `~/.traffic-one` (key included), the bundle, and generated host Task/subagent files whose marker matches. Onboarded project content stays (`.traffic-one/` except generated role files under `.traffic-one/agents/`, AGENTS.md, plan, memory, runs) |

---

## Corrections

If any statement here does not match what the code does, that is a defect of the
most serious kind this document can have, and we would rather be told. See
`SUPPORT.md`.
