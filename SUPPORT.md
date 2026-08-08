# Support runbook

For the person whose run is stuck and who needs it unstuck. Organised by
**symptom**, because that is what you have. Every step names a real diagnostic
that exists in this release, and says what its answer means.

This is not a command reference. It routes you to the tool that answers your
question and tells you how to read it.

---

## Start here, always

```
node ~/.traffic-one/bin/doctor.cjs
```

That exact spelling is admitted by Traffic One's own gates, so you can run it
inside a session — you do not have to escape the agent to diagnose it. It also
accepts `--run <id>`, `--bundle` and `--session <id>`, alone or combined.

Plain `doctor` already diagnoses the run your project currently points at. You do
not need `--run` unless you want a *different* run than the live one.

**How to read the output.** Two streams, two audiences, deliberately:

- **stdout is JSON** — the summary and findings, meant to be parsed. An agent
  reads this.
- **stderr is prose** — the run diagnostic, meant for you. Read this first. It is
  where "why is this stuck" is answered in sentences.

Both are redacted the same way — no API key, no personal access token, no
`originalPrompt`. That is not incidental: an agent parses stdout, so whatever it
prints lands in the host transcript on disk.

---

## Symptom: a gate refuses and I do not understand why

The refusal text carries two identifiers, and they do different work.

**The deny id** (e.g. `ARCHITECTURE_CONTRACT_MISSING`) names *which rule*
refused. It is stable and greppable — put it in an issue and it identifies the
gate exactly.

**The correlation ref** — printed as `(traffic-one ref: …)` at the end of the
deny — names *this specific refusal*. Find it in the decision log:

```
.traffic-one/runs/<runId>/debug/decisions.jsonl
```

One JSON object per line, append-only, on by default. Each record carries the
event, host, decision, gate id, deny id, correlation id and timestamps. Search
for the ref and you have the exact decision, in context, with everything that
came before it.

**If the deny carries no ref**, decision logging is off for this project — either
`T1_DECISION_LOG` is set to `off`/`false`/`0`, or the use-plugin question has not
been answered so nothing may be written yet. Traffic One deliberately omits the
ref rather than pointing you at a log it knows you will not find.

---

## Symptom: the run is wedged — nothing progresses, no error

```
node ~/.traffic-one/bin/doctor.cjs --run <runId>
```

The stderr report answers, in order: which agents are live, which claims are
held and by whom, where the ledger stands, and the top denies of this run. A
wedge is nearly always one of those four, and the report names which.

If you do not know the run id, run plain `doctor` — it falls back to the run your
project state points at, which is the live one.

**`GHOST_CURRENT_RUN_ID` in the findings** means your project points at a run
that no longer exists. That is a genuine wedge with a genuine fix, and the
finding says so.

---

## Symptom: hooks are not running at all

Nothing refuses, nothing is enforced, Traffic One appears absent.

**Check the host's Node, not your terminal's.** This is the most common cause and
the least intuitive one. Hooks run in a process the *host application* spawns, and
a host launched from the Dock, Start menu or Spotlight never sources your shell
startup files — which is where `nvm` lives entirely. Your terminal reporting
Node 22 proves nothing about the hooks.

`doctor` reports this as `HOOK_RUNTIME_NODE_BELOW_FLOOR`, naming the version it
actually found. Fix: install a system-wide Node ≥ 22, or launch the host from a
terminal that has one.

**If Node is fine**, the host was likely started before the plugin was installed
or updated. Hosts freeze their hook wiring at startup — an already-open session
keeps running the old bundle, silently. **Restart the host.**

---

## Symptom: I updated the plugin and nothing changed

Same cause as above, and it is worth stating on its own because it produces no
error anywhere: **the host must be restarted**. There is no message, no warning
and no degradation — the old bundle simply keeps running.

*(Maintainers only, in the plugin source repository:
`npm run plugin:sync -- --print-host` reports which host a sync would target,
and changes nothing. Use it when a sync appears to have gone to the wrong place.
This is not available in an installed plugin.)*

---

## Symptom: Traffic One says my API key is invalid, or keeps mentioning it

Traffic One revalidates your key at most once every 24 hours per machine, in the
background, and it fails **open**: an unanswered question never signs you out.

The three states, and how to tell them apart:

| What you see | What it means |
|---|---|
| Nothing | Key is good |
| One advisory per session, work continues | The endpoint could not be reached and the 7-day grace window has elapsed. This is a *network* statement, not a statement about your key |
| An explicit invalid-key message | The endpoint authoritatively rejected the key (`invalid_token`). This is the only case that is really about your subscription |

Only the third requires a new key. The second is a connectivity problem: check
whether your machine can reach the endpoint at all — a corporate proxy or captive
portal returning HTML to an HTTPS POST produces exactly this, and Traffic One
deliberately treats an unrecognised response as "unknown" rather than as a
rejection.

Your key lives in `~/.traffic-one/one.json` under `auth.apiKey`, mode `0600`. It
is never echoed into session context, advisories or `doctor` output — so if you
are looking for it to confirm what is stored, that file is the only place.

---

## Symptom: a gate is wrong and I need past it, now

There is an operator override. Understand what it costs before using it.

```
node ~/.traffic-one/bin/doctor.cjs --unblock <gateId> --run <runId> [--ttl 30m]
```

**It will refuse unless you are at a real terminal.** Both stdin and stdout must
be TTYs, and it prints a six-hex-digit nonce that you type back. There is no
`--yes`, no environment variable, and no test-only bypass. This is what stops an
agent minting its own override, and it is not configurable.

**Unlike every other `doctor` invocation, this one is not gate-exempt.** The
grammar that lets a stuck session diagnose itself deliberately does not admit
`--unblock` — diagnosis and relaxing a gate are not the same act. Open your own
terminal and run it there.

**It will also refuse, before asking you anything, when:**

- the gate never refused anything in this run (typo protection — the decision log
  knows which gates actually denied);
- every refusal that gate made is on the never-overridable list in
  `config/deny-ids.ts`. Those cannot be lifted by any override. Fix the cause, or
  settle the run and start a new one;
- there is no run to scope it to. Every override is run-scoped so the audit can
  name exactly one run.

**What it costs, permanently:**

- **that run can never settle as verified or shipped** — not after the override
  expires, not ever;
- the mint is recorded with your username and a pre-override snapshot (the run
  ledger and settlement, the refusals this gate had already made, and the git
  HEAD plus dirty paths), stored under the machine directory outside your
  project;
- nothing reviews the work the override lets through.

The window defaults to a bounded TTL and is capped at 24 hours. `--ttl` accepts
`<n>s`, `<n>m`, `<n>h`.

**The right instinct is that you should rarely need this.** A gate refusing
something legitimate is a bug worth reporting — see below. The override exists so
you are never *stuck*, not so you can route around enforcement routinely.

---

## Symptom: something is wrong and I want to report it

```
node ~/.traffic-one/bin/doctor.cjs --bundle
```

This produces a state-only diagnostic bundle designed to be **safe to attach**.
It is not plain `doctor` output with a filter over it; it removes whole
categories:

- the decision log's `inputs` and `stateWrites` fields are **dropped entirely**,
  not pattern-matched. `inputs` carries your prompt text verbatim on a
  prompt-submit decision, and `stateWrites` can echo file paths and value
  fragments — neither is worth trying to sanitise in place;
- `projectContext.originalPrompt`, `.summary` and `.answers` are redacted;
- every credential-shaped key name is redacted;
- every credential-shaped **value** is redacted wherever it appears — connection
  strings carrying passwords, `sk-` keys, bearer JWTs — including in places a
  key-name filter would miss.

**Read it before you send it anyway.** It is a good redactor and it is not a
promise about your project's contents.

**What makes a report actionable**, in rough order of value: the deny id, the
correlation ref, your host and its version, and the bundle. With the first two,
the exact decision can be located in your log without guessing.

Check `KNOWN-ISSUES.md` first — several confusing behaviours are known,
explained, and have workarounds.

---

## Symptom: I want Traffic One to stop

**For one project:** decline the plugin when asked. Every hook stands down and
the runtime residue is removed. Nothing further is written.

**For one gate, temporarily:** the override above.

**Everything, permanently:**

```
node /path/to/traffic-one/dist/scripts/traffic-one-uninstall.cjs --yes
```

Removes the host integrations, all of `~/.traffic-one` — your API key included —
and the bundle. Onboarded projects' `.traffic-one/` folders are deliberately left
alone: that is your content, in your repository, and removing it is your call.

---

## Where things are, when you need to look yourself

| What | Where |
|---|---|
| Decision log for a run | `.traffic-one/runs/<runId>/debug/decisions.jsonl` |
| Run ledger | `.traffic-one/runs/<runId>/run.json` |
| Project state (mode, stack, current run) | `.traffic-one/.one.json` |
| Machine state, API key, per-project preferences | `~/.traffic-one/` |
| Version-stable runner shims | `~/.traffic-one/bin/` |
| Override key, audit ledger, pre-override snapshots | `~/.traffic-one/overrides/` |
| Third-party tools and managed runtimes | `~/.traffic-one/toolchains/` |

`PRIVACY.md` says what each of these contains and what is committed.

---

## Turning up the detail

The hook tracer is **off by default** and records the *shape* of a hook payload
— which keys the host sent, nested where, of what type, of what byte size —
never the values. Arm it only when you are chasing a host-integration problem:

```
TRAFFIC_ONE_HOOK_TRACE=1
```

or create `~/.traffic-one/debug/hook-trace.on`. Output lands in
`.traffic-one/debug/hook-trace.jsonl`, which is gitignored. Turn it off when you
are done — it writes on every hook invocation.
