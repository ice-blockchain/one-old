# Known issues

Limitations of this release that you can hit in normal use. Every entry was
checked against the code before it was written here, and each says what is
verified and how, so you can tell a measurement from a reading.

Ordered by how likely you are to meet it. If you hit something that is not here,
that is worth reporting — see `SUPPORT.md`.

---

## 1. A project with both a web UI and a mobile UI stops and asks you to choose

**Affects:** any repository where Traffic One sees both a web framework and a
native one — one manifest carrying `next` and `react-native`, or a workspace with
`apps/web` and `apps/mobile`.

**What happens:** the capability profile comes back as `unsupported-hybrid` with
one blocking issue, and architecture compilation refuses until it is resolved:

```
CAPABILITY_HYBRID_UI_TARGET_REQUIRED
Both web-ui and native-ui were detected; set runtime/user-owned
architectureTarget to web-ui or native-ui before architecture compilation.
```

**Workaround:** set `architectureTarget` to `web-ui` or `native-ui`. Traffic One
then works normally on that surface. There is no setting that makes it drive
both surfaces in one run.

**Verified** by measurement, not by reading: three fixture projects (single
manifest with `next` + `react-native`; single manifest with `next` + `expo`;
split workspaces `apps/web` + `apps/mobile`) run through
`capabilityProfileForProject`. All three reported
`surfaces = ["web-ui","native-ui"]`, `profileId = unsupported-hybrid`, and the
blocking issue above.

**A correction, because it points the wrong way in our own notes.** This is
sometimes described internally as "a monorepo with both `next` and
`react-native` reports **no** mobile surface". That is not what happens. The
mobile surface *is* detected — `native = react-native-expo`, and the skill
buckets include `native-ui` — in the split layout *and* in the single-manifest
layout. The problem is a refusal to proceed without a target, which is a
different symptom with a different fix.

---

## 2. On OpenCode, Kilo and Windsurf, spawning the same role twice gives you two agents

**Affects:** `opencode`, `kilo`, `windsurf`. Not Claude, Codex, Cursor or
Copilot.

**What happens:** normally Traffic One keeps one live agent per role — a second
spawn of the same role is refused and the orchestrator is pointed at the agent
already running, so that role's context loads once instead of once per task. On
these three hosts, the reuse registry **stands down entirely** and the second
spawn proceeds as a fresh one. You get two agents for one role, the newer one
takes over, and you pay for the context twice.

**Why it is deliberate.** On these hosts the recorded agent id cannot be
corroborated against host identity — it comes from orchestrator-authored text
(the child's first chat message, or the requested spawn profile), never from the
host. Honouring such a row would make it authority to *deny* the role's next
spawn and to release another thread's live claim: absent evidence behaving as
evidence of no problem. Standing down costs duplicate context; trusting it would
cost correctness.

**Workaround:** on these hosts, spawn each role once per run. Or use a certified
host.

**Verified** by reading `HOSTS_WITHOUT_VERIFIABLE_REUSE` in
`src/shared/state/run-agent/registry.ts`, which is exactly
`['opencode', 'kilo', 'windsurf']`, and the code path it gates.

---

## 3. Subagent round-trips are not certified on any host

**Affects:** all seven hosts, certified ones included.

**What happens:** the release harness cannot read a subagent run manifest or
subagent digests back out of a headless run. Every host row the harness can
drive carries `headlessSubagents: 'unsupported'`, and the two rows that carry no
such field at all — `copilot` and `windsurf` — are `e2eSupported: false`, so the
harness never drives them in the first place. Assertions that depend on a subagent
round-trip report `UNSUPPORTED` rather than passing — which is the honest
outcome and is why you can trust the rest of the harness, but it does mean this
one path is proven by manual work rather than by CI.

**What this does *not* mean:** subagents work. This is a gap in automated
*proof*, not a gap in function.

**Cursor has a second, related asymmetry.** It is a certified host, but release
CI cannot drive it — it has no scriptable install, auto-importing Claude Code's
user-scope bundle through an editor-only `/add-plugin` pointer. Its release
evidence is therefore a **dated manual certification record**, fingerprinted to
the exact build it was taken against. Same certification slot the four
uncertified hosts use.

**Verified** by reading every host row in
`src/test-environment/config/hosts.ts` and the `certification` field in
`src/shared/host/capability-schema.ts`.

---

## 4. Kilo does not support typed subagents, and its wrapper has never met a real Kilo

**Affects:** `kilo`.

**Two separate things, both real:**

`typedSubagents: false` in Kilo's capability row. Roles that rely on a typed
subagent surface do not get one. Kilo is not alone in this — `codex`, `kilo`,
`copilot` and `windsurf` all have it false, and only `claude`, `cursor` and
`opencode` have it true — but it compounds with the second half below.

**And the wrapper's session behaviour is fixture-verified only.** Kilo's plugin
wrapper is a generated JavaScript file that resolves the project root by walking
up from the session directory and stopping at `$HOME`. Every test of that
behaviour — including the "stand down for a session opened directly in the home
directory" case — works by **pointing `HOME` at a fixture directory** and
importing the generated wrapper. That proves the logic. It does not prove that a
real Kilo session presents the directory the wrapper expects, and no recorded
live Kilo session exists in this repository to say either way.

Kilo is `uncertified` for exactly this class of reason, and installing on it
refuses by default.

**Verified** by reading `src/shared/host/capability-schema.ts`,
`src/runners/kilo-host/wrapper-source.ts`, and every `HOME`-manipulating test in
`src/runners/kilo-host/__tests__/index.test.ts`.

---

## 5. Rust projects are not exercised by the release harness

**Affects:** Rust projects.

**What happens:** Traffic One has Rust-aware pieces — `rustfmt.toml`
scaffolding, `target/` and `Cargo.lock` in the skip authority — so a Rust project
will not be obviously broken. But `npm run test:env -- --strict`, the only test
that exercises how the gates, the architecture compiler, the QA runner and
settlement *compose*, drives no Rust project. Go and Python are driven; Rust is
not.

**What that means practically:** nothing proves an end-to-end Rust run works.
Treat Rust as untested rather than unsupported, and expect to be the first to
find whatever is wrong.

**Verified** by measurement: zero occurrences of `rust` or `cargo`,
case-insensitive and matched at a word boundary, across every file in
`src/test-environment/config/cases/` — a directory whose run-simulation cases do
name the other two backends outright, as `backend: 'go'` and
`backend: 'python'`.

---

## 6. Windows is written for but not tested

**Affects:** Windows.

19 non-test source files under `src/` branch on `'win32'` — `.cmd` shim
resolution, zip extraction with an `Expand-Archive` fallback, Defender-lock
tolerant renames, the flat npm-prefix layout. Test files are deliberately not
counted: a test that branches on Windows is scaffolding, not Windows support,
and counting it would overstate exactly the thing this entry exists to warn you
about. It is the same population `PLATFORMS.md` states, so the two agree. None of
it runs in CI: the matrix is `ubuntu-latest` and `macos-latest`, and there is no
manual record for Windows either.

The managed-runtime downloader belongs to that written-but-untested half rather
than to some excluded one: it resolves a pinned Node for Windows on x64 **and**
arm64, and a pinned Python for Windows on x64, then unpacks a `.zip` through
PowerShell. What has no asset is Python on Windows-ARM, and any other
platform/architecture pair — there the download returns nothing and the caller
skips rather than failing.

See `PLATFORMS.md`. **Verified** by reading the CI matrix and
`src/config/managed-runtimes.ts`.

---

## 7. In a polyglot workspace, only the top-level `.traffic-one/` is gitignored

**Affects:** repositories with more than one project root — `web/`, `api/`,
`mobile/` each with their own `.traffic-one/`.

**What happens:** every entry in the generated `.gitignore` block is written as
`.traffic-one/runs/`, which git anchors to the directory containing the
`.gitignore`. A workspace member's own `web/.traffic-one/runs/` therefore does
**not** match, and its run artifacts — including an append-only debug log that
grows — become untracked files you will eventually `git add .`.

**Workaround:** add `**/.traffic-one/runs/` and its siblings to your own
`.gitignore`. Traffic One never rewrites lines outside its marked block, so
yours are safe.

**Verified** by reading `TRAFFIC_ONE_RUN_STATE_ENTRIES` and the template that
consumes it in `src/shared/architecture-contract/scaffold-content.ts`, whose own
comment names this case and the one-line change that would fix it.

---

## 8. Key revocation depends on a cross-repository string that nothing checks

**Affects:** nobody today; worth knowing because it fails in a direction most
software does not.

Traffic One decides whether a 401 from the auth endpoint means "your key is
revoked" or "we could not check" by reading the server's `error.code` and
matching `invalid_token`. That string is a contract between two repositories
with no shared artifact and no version. If the server ever renames it, **nothing
in Traffic One's test suite goes red** — the client would simply grant every
rejection the offline grace window.

The bias is deliberate and points away from you: an unparseable revocation gives
you 7 more days rather than locking you out, because the way back in runs through
the same endpoint. The four codes are pinned verbatim in
`src/runners/auth/__tests__/validate-key.test.ts` so a deliberate change is at
least a conversation.

**Verified** by reading `AUTH_GATE_401_CODES` in
`src/runners/auth/validate-key.ts` and the test that pins it. The file's own
header states the drift.

---

## 9. Below Node 22, Traffic One warns rather than refusing

**Affects:** anyone whose *host application* — not their terminal — launches with
an old Node. Launching a host from the Dock, Start menu or Spotlight never
sources the shell startup files where `nvm` lives, so a terminal reporting Node
22 proves nothing about the hooks.

Traffic One writes one stderr line naming your Node, the floor and the usual
cause, and continues. It does not refuse, because a hook that throws becomes a
deny nobody can override, and a launcher that exits early reads to the host as
"this gate had nothing to say" — every gate silently off.

Diagnose with `node ~/.traffic-one/bin/doctor.cjs`; the finding is
`HOOK_RUNTIME_NODE_BELOW_FLOOR`. See `PLATFORMS.md`.

---

## 10. Five ordinary documentation filenames at your repository root are treated as Traffic One's own

**Affects:** any repository that already keeps `api.md`, `database.md`,
`deployment.md`, `environment-setup.md` or `security.md` at its top level —
documentation-heavy repositories especially.

**What happens:** when Traffic One materializes a project you have opted in, the
contents of any of those five files are copied into `.traffic-one/` under the
same name. Your file at the root is **not** moved, renamed or deleted, and the
copy is skipped when the same text is already there. What you are left with is
two copies, and the one under `.traffic-one/` is the one Traffic One's own rules
read. Rewrite the root file later and its new text is appended as a further
block rather than replacing the old one, so the two drift apart with the
`.traffic-one/` copy carrying both versions.

There is a second thing that can remove the root file, and it is not a hook: the
documentation skill tells the agent to treat those five names as legacy and move
their content into `.traffic-one/`. That is an action you can see in the
transcript and decline, which a silent rewrite would not be.

**Workaround:** rename the file, or keep it below the top level, if you want it
to stay yours alone. Only those exact five names, and only at the repository
root, are matched.

**Verified** by reading the five-name list and the adoption routine in
`src/shared/materialize/cleanup.ts` — it copies, and contributes nothing to the
run's removal count because it removes nothing — and the legacy-documents rule
in the `auto-documentation-generator` skill.

---

## 11. An incomplete plugin installation refuses every file change until you complete it

**Affects:** any project running against a Traffic One installation that is
incomplete at that moment — most easily by rebuilding the folder you installed
from while a session is open, but equally an interrupted install or a host
plugin cache updating in the background.

**What happens:** before letting anything write, Traffic One checks that the
installation actually carries every rule and skill your project needs. A short
installation fails that check, and Traffic One refuses rather than proceeding,
because proceeding would delete what it could not resupply — `.traffic-one/rules`
and `.traffic-one/skills` are your project's only copy.

Nothing in your project is lost or changed while this lasts, and each refused
call says so and says why: that the installation is incomplete, how many entries
each of its two content trees resolved against how many your project needs, the
first few that are missing, and the command that will diagnose the installation
for you. It also states that re-issuing the same call draws the same refusal, so
what you should get is the agent reporting the problem to you rather than
looping on it. Reading, searching, and anything else that changes no file is
unaffected, so an agent can keep making progress while you sort the install out.

**Workaround:** complete or redo the installation, then repeat the tool call.
There is no project-side repair to do afterwards, because nothing in the project
was changed. If you install from a locally built copy, finish building it before
starting a session rather than during one.

**Verified** by measurement as well as by reading: a project holding its full
materialized skill set, run against an installation missing all but one skill,
comes back having removed nothing, written nothing, and leaving every tracked
file byte-identical. Separately, every outcome this check can produce was
rendered and hashed for both a file-changing and a read-only call — each
incomplete-install refusal carries its own diagnosis and ends on something its
reader can act on, and the two "already up to date" outcomes are unchanged. The
refusal and the diagnosis are in `src/shared/materialize/`; the branch that
chooses between them is in `src/modules/onboarding-gate/handler.ts`.

---

## Reporting something not on this list

`SUPPORT.md` has the runbook and what to attach. `doctor --bundle` produces a
redacted diagnostic bundle that is safe to send.
