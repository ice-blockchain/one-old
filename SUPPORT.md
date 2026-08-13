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

**A `failed` run in the report is the other genuine wedge**, and the only one
with no way out from inside the run itself. `failed` is terminal in the
strictest sense the ledger has: nothing transitions out of it, not even the
authorized resume that reopens a `blocked` run. So a project whose
`currentRunId` still names a failed run can do nothing at all — no role binds a
claim, no spawn starts — and the fastest way in is the command that ends a run,
`run-status.cjs --run-id <id> --status failed`.

One command gets a project out of it:

```
node ~/.traffic-one/bin/traffic-one-reset.cjs --run-id <id>
```

Like plain `doctor`, that exact spelling is admitted by the gates, so you can
run it inside the stuck session. That is the whole point: a wedged project is
precisely where you cannot get past a gate to fix anything.

**If the gate refuses it,** the file at that path was written by a different
installed plugin version. `~/.traffic-one/bin` is user-scoped and shared by
every version you have installed, and the gate admits that shim only while it
byte-matches the version that is running — so on a machine with two versions
installed it belongs to whichever one started a session last. Either fix is
cheap: start a new session and run it again, because session start rewrites the
shim for the version you are running; or run it in your own terminal outside any
agent session, where no hook fires and nothing is gated. The runner itself is
the same either way — only the spelling's admission changes.

It retires the failed run and mints a fresh planned one in a single transaction
under the project state lock — `currentRunId` moves to the successor, the
retired run's agent claims and per-file locks are released, and the next spawn
starts normally. Pass the wedged run's id, the one `doctor` prints.

**Nothing is deleted and nothing is rewritten.** The failed run keeps its
`run.json` byte for byte, along with its directory, its digests and its QA
evidence; only the pointer moves. No writer in the product reopens a terminal
settlement, so the recovery is a retirement rather than a re-opening. That is a
rule the code keeps rather than a property of the file — `settlementHash` is an
unkeyed digest, so anything able to write the tree can produce a record this
parser accepts in any status it likes. This command neither raises that floor
nor relies on it.

**It is not a way to clear a limit you have hit.** Gate state that exists to
stop a loop travels with you: the repeat-deny ladder that tells an agent to stop
retrying and report `BLOCKED`, the per-role exploration tallies, the models
condemned by a rate limit, the live-agent registry behind "this reviewer may not
be the agent that wrote the code", and a build pause that is waiting on your
answer — all carried onto the successor run rather than left behind with the
retired one. State that only describes the finished run — its frozen model
policy, its bootstrap envelopes, its compiled contract — does reset, because
keeping it would refuse the recovered project the first spawn it needs.

Every reset is appended to `.traffic-one/runs/.resets.json`, and that record is
read: **from the third reset onward the carry widens.** A role that had already
exhausted every model it could rotate to keeps that verdict on the successor, so
recovering again is still possible but no longer free — the way out of it is the
same enable/retry answer the model question always asks you for, not another
reset.

It refuses anything that is not that exact situation: a run that is not the
project's current one, a run that is `planned`, `active` or `blocked` (a blocked
run resumes with `run-status.cjs --run-id <id> --status active --reason
user-authorized-extra-cycle`, which costs your explicit authorization), or a run
whose ledger cannot be read. It also refuses, by name, when
`.traffic-one/.one.json` is itself unparseable — then your state file is what is
broken rather than your run, and no run command repairs that.

**It does not clear an override-evidence refusal.** If `doctor` reports
`OVERRIDE_EVIDENCE_INCOMPLETE`, or settlement refuses with a reason starting
`override-`, nothing is wedged and this is not the repair: reset will either
refuse (the run is not `failed`) or retire the run and mint a successor that
cannot certify either. See *nothing can settle as verified* below.

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
`--yes`, no environment variable, and no test-only bypass.

Treat that as a speed bump rather than a wall: a program that allocates a
pseudo-terminal satisfies both checks and can read the nonce back off it. What
protects you is what a mint leaves behind — an audit line naming who minted it,
and a run that can never settle as verified or shipped.

That record is checked for completeness, so the obvious ways of unpicking it do
not work: deleting the audit file, deleting the whole per-project folder under
`~/.traffic-one/overrides/`, or duplicating a signed line to keep the count up
all leave a project that can no longer certify anything. **It is not airtight,
and the limits are worth knowing rather than guessing at.** These are measured,
not assumed, and they are the whole list:

- editing the machine-wide `~/.traffic-one/one.json` — deleting this project's
  mint counter, corrupting the file, or restoring a copy taken before the
  mint — still reaches a clean verdict for a mint that has already happened. What
  it can no longer do is buy *future* free mints: a settings file that will not
  accept a write refuses the next `--unblock` outright and `doctor` reports the
  counter as unusable, so the freeze is loud rather than silent;
- pointing the machine-state directory (`XDG_STATE_HOME`) at a copy of itself
  with the override folder removed. Nothing is deleted and every witness reads an
  empty store;
- settling under a different **case-spelling** of the project directory. On a
  case-insensitive filesystem `/x/Proj` and `/x/proj` are one directory with two
  override folders, and the second is empty — no deletion, no environment
  variable, no key. Cheaper than the two above. It depends on who supplies the
  working directory to settlement, and whether an agent inside a session can
  change that was probed and **not** established;
- `rm -rf ~/.traffic-one`, key included. Afterwards there is nothing to have
  signed anything.

The audit trail is a deterrent and a record, not a vault; if you need a guarantee
that no gate was ever relaxed, take it from a machine the person you are asking
about does not administer.

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
- the run has already settled `verified`. The whole cost below — that the run can
  never settle as verified — cannot be imposed on a run that already did, so
  minting here would file an audit record devaluing a run whose verdict this
  command will not rewrite. Nothing is minted and the verdict is unchanged. This
  is a refusal by this command, not a property of the file: a settlement carries
  an integrity digest rather than a signature, so anything able to write the
  project can produce bytes that read as verified. Do the work in a run that has
  not certified: re-prompt the parent agent in this project so a new run is
  minted, then run the command again with `--run <that id>`. A run that settled
  `failed` or `blocked` still mints normally, and those are the states a wedge
  actually leaves you in;
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

## Symptom: nothing can settle as verified, and doctor blames the override record

`doctor` reports `OVERRIDE_EVIDENCE_INCOMPLETE` and settlement refuses every run
in the project with a reason starting `override-`. That means the operator-
override record under `~/.traffic-one/overrides/` no longer accounts for itself:
a pre-override snapshot no audit line names, an audit file that cannot be read
or parsed, more snapshot files than the scan will read, or a signed mint counter
ahead of the lines that are still there.

Sometimes that is a real erasure. Sometimes it is just damage — **a single junk
file written into that folder by anything running as you is enough**, and no
cleanup routine touches it. Either way the way out is the same, and it is
deliberately not a delete:

```
node ~/.traffic-one/bin/doctor.cjs --reconcile-overrides
```

**This deletes nothing.** It appends a signed statement that you, at a terminal,
looked at exactly this state and accepted it — the same TTY and typed-nonce
route as the mint above, and, like the mint, not gate-exempt. A command that
removed the orphaned files or truncated the audit file would hand out precisely
the capability the record exists to deny, so no such command exists.

**What it costs, permanently:** every run the project has on disk at that moment
can never settle as verified or shipped. An erased audit line took its run id
with it, so there is no way to tell which run was covered up and no way to
forgive one without forgiving all of them. It also pins this project's mint
counter, creating one at the current count if the project has none. Work started
after you reconcile certifies normally.

**It covers that state and no other.** One more orphaned snapshot, one more
appended junk byte, one more missing line, and the project refuses again until
you look again. When the audit file itself is illegible the acknowledgement also
pins the witnesses that state switches OFF — the snapshot files present and the
mint counter's exact value — so a later mint, or a snapshot appearing or
disappearing behind the damage, refuses again too. It refuses to run at all when
there is nothing wrong, when the state cannot be fingerprinted at all (a file
that cannot be READ, as opposed to one that cannot be parsed: fix the permissions,
nothing is lost, and it will not spend your runs on an acknowledgement that could
never match), and when the project has more runs than it can name — 256 is the
bound on the signed list, and a project past it has to prune run directories
before the repair is available.

**What it does not cover, and cannot:** the quarantine is a list of run directory
names, so copying a quarantined run to a new name gives you a run id the list
does not hold. That buys nothing by itself — the copy's verification contract
hashes its own run id and the QA report binds to that hash, so a renamed copy
arrives with evidence that does not describe it and settlement refuses it
(measured). What certifies a new run id is a new run's worth of evidence written
for that id — and "written for that id" is the whole of the claim, because
nothing here proves the evidence describes work that was really done. Evidence
fabricated for a fresh run id certifies it, measured, in any project, with no
override and no quarantine anywhere in the picture. That is this product's floor
and it is not raised by anything on this page; what the override record adds is
that the run somebody relaxed a gate for cannot be the one that certifies. An
override taints the run, not the tree.

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

**Where it goes: a GitHub issue on the public repository.** There is no support
email address, and that is deliberate rather than an omission — a bundle sent
privately helps exactly one person, while the same bundle on an issue is
findable by the next reader who hits your symptom. The bundle is designed to be
safe to attach in public for that reason.

The repository is not published yet, so this section prints no URL rather than
a link that would 404 today; `README.md` says the same of the marketplace
listing for the same reason. Until it exists, report through whoever gave you
this checkout.

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
| Mint counters and operator reconciliations | `~/.traffic-one/one.json` |
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
