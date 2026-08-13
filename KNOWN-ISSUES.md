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

21 non-test source files under `src/` branch on `'win32'` — `.cmd` shim
resolution, zip extraction with an `Expand-Archive` fallback, Defender-lock
tolerant renames, the flat npm-prefix layout. Test files are deliberately not
counted: a test that branches on Windows is scaffolding, not Windows support,
and counting it would overstate exactly the thing this entry exists to warn you
about. It is the same population `PLATFORMS.md` states, so the two agree. None of
it runs in CI: the matrix is `ubuntu-latest` and `macos-latest`, and there is no
manual record for Windows either.

The shim resolution is written twice, which is worth knowing before you trust
it. Node refuses to spawn a `.cmd` or `.bat` without a shell, so a tool invoked
by bare name — `npm` resolving to `npm.cmd`, `./gradlew` to `gradlew.bat` — has
to be found on disk and routed through `cmd.exe` first, with its arguments
escaped for that shell. `src/shared/spawn-tool.ts` does this for the
synchronous callers; the QA evidence runner spawns asynchronously, so it cannot
use that wrapper and `src/runners/qa-evidence/native-process.ts` repeats the
resolution, importing the escaping rather than re-deriving it. One Windows rule,
two implementations, neither executed on Windows anywhere in this repository.
The second one's constructed command line is unit-asserted for `'win32'` from a
POSIX machine, which pins the escaping and the routing but says nothing about
how Windows runs the result.

A second gap in the same runner is narrower, and most of it has since been
closed. Nothing the QA runner spawns for long is a leaf: a test suite arrives
through a package manager wrapping a shell, `xcodebuild` owns a simulator,
`gradlew` owns a daemon, `npm run dev` wraps the listener that holds the port,
and the Lighthouse CLI owns a Chrome. So when one of those has to be cut short,
or leaves something behind after succeeding, the runner kills the whole process
GROUP — killing only the leader leaves a server holding a port that the NEXT
run's checks then answer against. Windows has no signalling process group:
`detached` there decides which console a child attaches to and creates nothing
to address, so a group kill has nothing to aim at and would degrade to the
leader alone, which for a `.cmd` shim is the shim and nothing it started.

What replaces it there is `taskkill /PID <leader> /T /F`, the platform's own
tree walk, issued at every teardown site and BEFORE the leader is killed rather
than after — a tree walk from a pid whose process has just been terminated finds
no children to take with it, so that ordering is the whole difference between
reaping the tree and reaping the shell. `/F` is not optional: without it
`taskkill` posts a window message, which a console process has nothing to
receive. It is no harsher than what already happened, because libuv answers
SIGTERM, SIGINT and SIGKILL alike with `TerminateProcess`. The dev-server
port-release wait therefore no longer times out by construction; what it can
still spend is its budget, because libuv sets neither `SO_REUSEADDR` nor
`SO_EXCLUSIVEADDRUSE` on a Windows bind, so a port still carrying TIME_WAIT
entries reads as held for as long as it holds them. That wait only gates an
escalation that is already a no-op on Windows, so it costs time and not
correctness.

Two things are still missing there, and both are the same shape. `taskkill /T`
builds its tree by parent pid from the running process list, so a leader that
has ALREADY EXITED names no tree — which means "leader gone, descendants alive",
reapable on POSIX through the group id, stays unreachable on Windows. The runner
deliberately does not try: a Windows pid is immediately recyclable, so a `/F` at
a dead one is a forced kill of whatever tree now owns that number. And a
`setsid`-equivalent escape has no meaning to walk out of, so the POSIX paragraph
below has no Windows counterpart. The kernel-exact remedy for both is a Job
Object created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, which tears the tree
down when the last handle to it closes; that needs a native addon, which a
dependency-free hook runtime cannot have. Recorded rather than fixed — but the
recording is now about those two cases and not about the whole teardown.

What Windows does not lose, and did not lose before this either, is the
VERDICT: the runner decides a run was cut short before it kills, so a Windows
run reports the same INCONCLUSIVE a POSIX one does and settles inside the same
bound.

On POSIX the same group kills have two consequences that are deliberate rather
than accidental, and both are recorded here rather than prevented.

A group SIGTERM reaches things a leader-only SIGTERM spared. Everything the
runner starts for a QA run is now put in its own group and the whole group is
signalled at teardown, so a process that a dev script started and that was meant
to OUTLIVE the run goes with it: a shared Gradle or Metro daemon warmed by the
dev server, a `docker compose` sidecar started from the same script and expected
to persist between runs. Nothing distinguishes those from the listener holding
the port — they are in the group the runner created, which is the only handle it
has. The alternative is the survivor incident this exists to prevent, where one
run's server answers the next run's checks, and a re-warmed daemon costs a
rebuild while a stale server costs a false green. If a project needs such a
process to persist, it has to be started outside the QA server command.

And a dev server that calls `setsid` itself is beyond reach either way. It leaves
the group the runner created, so neither a group SIGTERM nor a group SIGKILL
names it, and the leader-only kill it replaced never reached it either. Teardown
notices — it waits for the port and reports having given up on it — but it cannot
act; the backstop for a stale listener answering on a recycled port stays the
served-build-fingerprint check, which is what makes a foreign server a failed run
rather than a passing one.

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
root, are matched by the copy.

**A sixth name behaves differently, and this is the one to read carefully:
`architecture.md` is MOVED, not copied.** It is the pre-`plan.md` spelling of a
Traffic One plan, so when Traffic One converges a project it appends that file's
verbatim bytes to `.traffic-one/plan.md` under a `### <path>` heading naming where
they came from, and then deletes the file. Only three locations are folded:
`architecture.md` at the repository root, `.traffic-one/architecture.md`, and
`packages/<package>/architecture.md` — and only where those paths are really
inside your project, which is a bound in its own right below and not a figure of
speech. **`apps/`, `services/` and any other workspace layout your
`pnpm-workspace.yaml` declares are NOT folded** — a legacy document there keeps
sitting where it is, which is the safe direction, since everything the fold
reaches is a file it then deletes.

The fold also writes something of Traffic One's own into a file that is yours: an
HTML comment, `<!-- traffic-one:migrated <path> sha256:… -->`, above each migrated
block, and one `<!-- traffic-one:migrated-notes:end -->` marking the end of the
migrated section. They are invisible in a rendered markdown view and they are how
the fold recognises bytes it has already carried; deleting them costs you a
duplicate block on the next fold and nothing else.

Nothing announces the fold in the transcript on a project that needed no other
convergence work, because it is a hook and not an agent action. When convergence
has anything else to report, the report names what was folded and what was
deliberately left alone, with the reason. **On the quiet steady state — the
common one — a document is removed and its bytes relocated with nothing said
anywhere but `plan.md`**, which is measured rather than inferred: no outcome, no
notice, no transcript line. So the only record of either outcome there is
`plan.md` itself and the file still sitting where you left it, and the record of
a removal is a `### <path>` heading in a file you may not have opened. Making the
fold announce itself by reporting an outcome would deny the tool call that
triggered it, which is the wrong trade for a notice; the fix belongs on the
delete, and is not yet built.

When it is built, it will not replace `plan.md` as the record. Traffic One's
internal state-write ledger is a diagnostic channel, not an audit log: it holds
64 entries per hook invocation and discards *successful* writes first when it
overflows — and a completed removal is a success — it is written only while
decision logging is on, and `T1_DECISION_LOG=off` turns it off entirely. It also
has no field for where the bytes went, so it can record that a file was removed
but not that the removal was a *relocation*. The `### <path>` heading and the
`sha256:` marker beside it stay the only durable record of that, which is why
they are described above rather than treated as an implementation detail.

Seven things bound it, and each of them is the reason this is a documented
behaviour rather than a data-loss bug:

- it never runs in a project that has not answered "use Traffic One here?", or
  that answered no — such a project stays byte-identical, this file included;
- it never runs in a directory that does not hold a Traffic One state file that
  Traffic One can read;
- the removal is licensed by the CONTENT and not by the marker comment: the exact
  bytes, under that heading, are in `plan.md` **before** the file is removed, read
  back from disk after the write. Edit or re-wrap the migrated prose in your plan
  and the file stays where it is;
- a file whose bytes could not be read is not removed at all, and neither is a
  whitespace-only one, a symlink (the link is not followed, so nothing outside
  your project is ever copied in), or a document that changed on disk between
  being read and being removed;
- a document whose bytes OR whose PATH carry Traffic One's own marker grammar — an
  `opencode-delegate:start` block, a `traffic-one-verification:` marker, a
  `traffic-one:migrated` comment — is never folded, because `plan.md` is parsed
  for those and a vendored or third-party file must not be able to steer a run by
  sitting in the tree. A directory NAME is enough to try it, since the fold writes
  the path into the plan as well as the bytes, so a path that could add a line to
  the plan at all — one holding a newline, or an HTML comment delimiter — is
  refused on that ground alone. Either way the document is left exactly where it
  is and reported;
- a package that is its own Traffic One project, or that the workspace registry
  records as a member, is left alone — its documents are not folded into the
  container's plan;
- a `packages/` or `.traffic-one/` directory that is really a symlink out of your
  project is not walked into. Those two directory names are the only variable part
  of the three folded locations, so this is what makes "only three locations"
  true: without it, `packages` pointing at a parent directory folded sibling
  checkouts' hand-written documents into this project's plan and deleted them,
  reported under innocent-looking `packages/<name>/architecture.md` paths.

That last bound has a cost you will not be told about, and it is the one thing
here that can look like a bug in the fold rather than a decision. The check
compares paths exactly, including their case, because a comparison that ignored
case would treat a sibling checkout named `repo` as part of a project named
`Repo` and fold its documents in. The consequence is that a **legitimate**
`packages` symlink can be refused: if its target spells any part of the path to
your project in a different case than your shell did — the same directory, on
macOS or Windows, just spelled differently — nothing under `packages/` is folded,
and nothing says so. The document stays exactly where it is, which is the safe
direction, but the plan gate keeps asking for a plan that will never carry it. If
a `packages/<package>/architecture.md` is never migrated and you cannot see why,
check whether `packages` is a symlink and whether its target spells your project
directory the way you do.

A retained document is named in that report with the offending part of its path
replaced by `<unnameable>` when the path cannot be written into a line — a name
holding a newline, or an HTML comment delimiter. That report is read by an agent,
so a directory name is not allowed to add lines to it any more than to `plan.md`.

So the bytes survive, in `.traffic-one/plan.md`, but the file does not: if you
keep hand-written architecture notes at `architecture.md` in an opted-in project
and want them to stay at that path, rename the file. Re-creating it later folds it
in again on the next tool call, appending the new version to the plan **beside**
the old one rather than replacing it — no version the fold ever carried is
removed, so the migrated section grows by one block per distinct content that path
has ever had, and re-creating the file with bytes the plan already carries appends
nothing.

That growth is deliberately not capped, and it is worth knowing the size, because
it is linear in *saves* rather than in anything you would think of as a migration:
the fold removes the file, your editor's next save re-creates it, and each save is
one more block. Measured, 200 saves of a 5 KB document produced a 1.0 MB plan with
200 blocks in one section — the document's own size plus about 97 bytes each time.

**The plan stops being usable by the agents that read it well before that size,
and that is the real cost.** Traffic One's own architect role is told to keep
`.traffic-one/plan.md` under roughly 250 lines, and every agent in a materialized
project is told to read the plan; 40 saves already exceeds 250 lines, and a
1.0 MB plan is roughly 250,000 tokens, which does not fit in a 200,000-token
context at all. No *code* that reads the plan has a size limit, which is what
keeps this from being a crash, but the consumer this file is written for is a
model with a budget. Watch the size if you keep re-creating the file, and prune
the section by hand once it is no longer serving you: the alternative on Traffic
One's side would be a rule for deleting a version whose file the fold already
removed, and it will not do that. Deleting blocks you no longer want is an edit
you can make and see.

**Verified** by driving each claim above against the code, not by reading it: the
five-name list and the adoption routine in `src/shared/materialize/cleanup.ts` —
it copies, and contributes nothing to the run's removal count because it removes
nothing — the legacy-documents rule in the `auto-documentation-generator` skill,
and, for the sixth name, `src/shared/materialize/plan-migration.ts` behind the
behavioural pins in `src/shared/materialize/__tests__/`. Every bound listed above
is paired one-for-one with a test that drives the mechanism and fails when it is
deleted (`plan-migration-gate`'s item-10 table and the bijection row that refuses
a claim without a pin); alongside them, `plan-migration-destruction`'s three
routes to a destroyed document each with the control that keeps the bytes,
`plan-migration-fold-safety`'s marker-grammar, path, containment, symlink and
growth rows, and `plan-migration-window`'s second-process race and its
deterministic in-window rewrites.

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

## 12. `doctor` calls the members of a nested workspace strays, and offers to delete them

**Affects:** a Traffic One WORKSPACE that lives inside an ordinary Traffic One
project — a repository you onboarded normally, with a workspace container in a
subdirectory of it.

**What happens:** the doctor reports every `.traffic-one/` folder below the
directory it was run in that is not the project's own, under
`NESTED_TRAFFIC_ONE_ROOTS`, and tells you to point the cleanup runner at them
once you have confirmed the top-level project is the real one. When the doctor
runs at the workspace container itself, its members are correctly recognised and
none of them is reported. When it runs at an ordinary project ABOVE such a
container, they all are — the check reads the state of the directory it was run
in, so a workspace one level down is invisible to it and its members look like
leftovers. Following the advice would delete those members' runs, claims and
plans.

**Workaround:** run the doctor at the workspace container rather than above it,
and never point the cleanup runner at a directory that holds a `plan.md` or a
`runs/` folder you recognise. Nothing is deleted automatically: this is a
report, and the deletion is a separate command you have to issue.

**A related case now reads differently, and better.** When the doctor runs at a
workspace container whose own member list cannot be read — the file is torn, or
one entry in it is malformed — it no longer offers to delete the nested folders
it finds. It names them under an informational "membership unknown" note and
asks you to repair the container's `.one.json` instead. That matches what the
automatic start-of-session sweep does with the same unreadable list, which is to
leave everything below it alone: a report telling you to hand-delete what the
sweep spares is a worse outcome than either answer on its own.

**Verified** by measurement: `buildFindings` given an `existing-codebase`
project state and three nested roots — a container and its two members — names
all three in the finding. Given the container's own state, it names none of
them. Given a container with an unusable member list, in each of the four ways
one becomes unusable, it produces the informational note and no cleanup advice.
Closing the case this entry is about needs a state read per nested root, which
belongs in the doctor probe rather than in the pure findings builder
(`src/runners/doctor/findings.ts`, and the pins in
`src/runners/doctor/__tests__/workspace-nested-roots.test.ts`).

---

## 13. Leftover Traffic One folders inside a Java, Kotlin, Maven, .NET or Python module are no longer cleaned up for you

**Affects:** any repository containing a module directory that carries its own
`build.gradle`, `build.gradle.kts`, `pom.xml`, `mix.exs`, `setup.py`,
`setup.cfg`, an MSBuild project file, or (when nothing above it declares a
project) a `requirements.txt`.

**What happens:** Traffic One now recognises those directories as modules in
their own right, which is what lets them hold their own settings and be members
of a workspace. The same recognition means a stray `.traffic-one/` that once
accrued inside such a module is no longer treated as a leak, so the sweep that
used to remove it at the start of a session leaves it alone. Nothing is lost —
the folder simply stays until you delete it.

There is a second, much narrower consequence in the opposite direction. The leak
rule also asks whether the directory ABOVE holds a project, so a directory that
holds Traffic One state, carries no module file of its own, and sits inside a
newly recognised module can now be treated as a leak rather than a project. This
needs a tree with no version control anywhere above it: with a `.git`, `.hg` or
`.svn` in any ancestor the answer was already the same before the change.

**Workaround:** delete an unwanted nested `.traffic-one/` by hand. For the
second case, keeping the repository under version control removes it entirely.

**Verified** by measurement in
`src/shared/__tests__/marker-widening-retention-direction.test.ts`, which builds
each tree twice — once with a module file the list carries and once with one it
does not — and compares the sweep's verdict across the pair: swept before and
kept after for the first case, kept before and swept after for the second, and
identical in both columns as soon as the holder is a repository.

---

## 14. A directory Traffic One already onboarded as a project can never become a workspace container

**Affects:** a repository root that Traffic One classified as an ordinary
project — most easily a JavaScript/TypeScript monorepo root, because its
`package.json` both identifies it as a project and lets the stack be detected —
which you later want to register as a Traffic One workspace with members.

**What happens:** registration is refused permanently, with a message saying the
directory is already onboarded as a project and that a workspace is a container
OF projects rather than a project with members. This is deliberate — converting
it would make every gate refuse work at that root — but the classification that
closes the door can happen automatically, before you have been asked anything
about workspaces.

**Workaround:** register the members in the directory that HOLDS the projects,
which the refusal message names, rather than in the project root itself.

**Verified** by measurement across nine container shapes. The one-way door needs
BOTH a project marker and a detectable stack: a container carrying
`package.json` plus a React source file auto-stamps as `existing-codebase` and
is then permanently `rejected` for containerhood, at a repository root and in a
nested directory alike. Every other marker measured — `build.gradle`, `pom.xml`,
`requirements.txt`, `setup.py`, `settings.gradle`, an MSBuild project file —
stops at `undetectable`, writes nothing, and registers as a container normally,
so recognising those ecosystems moves container registration from refused to
written rather than towards this door.

---

## 15. A damaged operator-override record can be used to keep taking your runs' certification away

**Affects:** a project where an operator override was ever minted, on a machine
where something other than you can write `~/.traffic-one/overrides/` — a second
account with your home directory writable, a process running as you that you did
not start, or a restored backup of that folder.

**What happens:** when the override record stops accounting for itself — the
audit ledger, a pre-override snapshot and the signed mint counter no longer agree
— no run in that project can settle `verified` or `shipped` until an operator
repairs it with `doctor --reconcile-overrides`. That repair deletes nothing: it
appends a signed statement that you looked at exactly this state, and its price is
that every run already on disk becomes permanently ineligible for
verified/shipped. Whoever damaged the record can damage it again after each
repair, so the cycle — wedge, repair, lose the runs that exist — can be repeated.
It is denial of service and nothing else: no run becomes green, which is the
direction that matters.

**What bounds it.** Three things, and they are why this is an entry here rather
than a hole in the feature:

- it is loud. The repair is signed and on the record, and the doctor prints the
  state it observed, the number of acknowledgements on record and any gap between
  the mint counter and the lines that remain — every time. A repeated cycle is
  visible rather than a mystery.
- the cheapest damage is free. A record that is merely UNREADABLE — permissions,
  a symlink, a directory in the way — cannot be fingerprinted, so the repair
  refuses before quarantining anything. Fix the permissions and nothing was
  charged.
- each cycle costs a fresh write. An acknowledgement covers exactly the state it
  was minted against, so re-running the repair on an unchanged record has nothing
  left to forgive and declines with `nothing-to-reconcile`. The state has to be
  planted again for the next cycle.

**Workaround:** runs minted AFTER a repair certify normally, so work continues;
what is lost is certification for the runs that already existed. If it happens
more than once, the thing to fix is who can write `~/.traffic-one/`, not the
project.

**Verified** by measurement in
`src/shared/override/__tests__/reconcile.test.ts`: a single planted file wedges
certification and the repair unwedges it without deleting anything; exactly the
runs that already existed are quarantined; an acknowledgement stops excusing the
moment the state it named moves; and a repair that could not fingerprint the
damage refuses with nothing written.

---

## 16. A project with more than 256 runs on disk cannot repair a damaged override record at all

**Affects:** a project with more than 256 directories under `.traffic-one/runs/`,
or whose `runs/` folder cannot be listed, that needs the repair described in
item 15.

**What happens:** `doctor --reconcile-overrides` refuses with `too-many-runs` and
writes nothing, so certification stays refused for the whole project. The repair
has to NAME every run it quarantines — the list is signed, and settlement decides
each run by testing membership in it — so it cannot be minted against a run set it
is unable to enumerate. A partial quarantine would be an acknowledgement with
nothing behind it, which is the one thing this repair must never be.

**Workaround:** archive or delete old directories under `.traffic-one/runs/`
until fewer than 256 remain — a run directory is history, and nothing live depends
on an old one — or fix whatever stops the folder being listed, then run the repair
again. The refusal charges nothing, so there is no cost to hitting it.

**Verified** by reading, at both places that enforce it:
`MAX_QUARANTINED_RUNS = 256` in `src/shared/override/reconcile.ts`, checked by
the doctor before it prompts (`projectRunIds` in
`src/runners/doctor/unblock.ts`) and again by the writer that signs the
acknowledgement.

---

## 17. On a case-insensitive disk, the same project reached under a differently-cased path has its own override history

**Affects:** macOS and Windows default volumes, where `/Users/me/Proj` and
`/Users/me/proj` are one directory with two spellings.

**What happens:** a project's override record lives in a folder named by a hash of
its resolved path, and that hash does not case-fold. One directory reached under
two spellings therefore has two override records, and the second one is empty —
so a run settling under the other spelling reads no override history, and the
guard that makes an overridden run permanently ineligible for verified/shipped
has nothing to read. Nothing is deleted and no setting is changed for this to
happen, which is what makes it worth writing down.

**How reachable it is, and which route was tried.** It depends entirely on who
supplies the working directory that settlement runs against. The obvious route —
an agent moving into a differently-cased spelling so settlement inherits it — was
tried and does not work on macOS: the working directory a process reports comes
back in the directory's true case whatever spelling was used to enter it, so the
record lands in the same folder either way. The one adjacent place a project path
arrives as plain text is the QA evidence runner's `--project-root` argument,
which publishes reports and settles nothing. So this is a documented weakness of
the record, not a demonstrated bypass — and it is listed rather than left in a
source comment because a reader deciding how much to trust the record deserves
to see it.

**Workaround:** refer to a project by one spelling — the one your host opened it
with. There is no setting that folds the two together.

**Why it is not folded automatically**, corrected here because the reason given
in earlier releases was wrong: folding the two spellings would NOT invalidate
override tokens already issued — a project reached by its true spelling keeps
exactly the folder it has today, measured. What folding moves is the folder of a
project that has only ever been reached by the miscased spelling, and that
folder is its live one: its "use Traffic One here?" answer, its saved
preferences, and its whole override history would move to a fresh, empty folder
in a single upgrade, which reads to every check exactly like the history having
been deleted. Folding therefore needs a one-time migration that reads both
spellings, not a one-line change.

**Verified** by measurement and by reading: on this machine the two path
resolvers return the same spelling for a canonically-spelled directory and
different spellings for a miscased one; `projectRootHash`
(`src/shared/state/local-prefs/prefs-store.ts`) resolves symlinks but does not
case-fold; and the enumerated limits in `src/shared/override/integrity.ts` carry
this as a named row alongside the others this feature does not close.

---

## 18. Anything that can write your project can lock you out of `doctor --unblock` for a run

**Affects:** any project, on a machine where something other than you can write
`.traffic-one/` inside it — which includes the agent.

**What happens:** the override command refuses a run that has already settled
`verified`, because relaxing a gate for a run that already holds a certificate is
the one shape the whole feature exists to prevent. That check reads
`.traffic-one/runs/<id>/settlement-v2.json`, and that file carries an ordinary
integrity digest rather than a signature — so anything that can write the project
can produce a file that reads as a certified run, and the escape hatch is then
refused for that run. It can be done again for each new run.

**What it is not:** a way to make anything green. A planted certificate is not
believed by the parts that matter — an override that was actually minted still
makes its run permanently ineligible, and evidence is still checked when a run
tries to certify for real. This is denial of the recovery route, not a forged
pass.

**How to tell:** the refusal itself says so and tells you what to look at. An
honest certification is reached by the runtime after a run has been driven, so
its `revision` counts up from that run's earlier settlements, its `updatedAt`
lines up with when the run finished, and `run.json` beside it agrees. A record at
revision 1 on a run that was worked on for a while, a timestamp that does not
match, or a `run.json` that never left `active` is a planted file.

**Workaround:** start a new run — re-prompt the parent agent in the project so a
new run id is minted, then use `--run <that id>`. Work done after a certification
is outside what that certificate covers anyway. If it keeps happening, the thing
to fix is what can write your project directory; a planted certificate is worth
reporting to whoever owns the machine.

**Verified** by measurement:
`src/runners/doctor/__tests__/unblock.test.ts` plants a settlement with a
recomputed digest in each canonical status and pins that exactly one of them —
`verified` — refuses the mint, and that the refusal's wording names the
possibility of a planted record and how to check it. The residual is carried in
the enumerated limits in `src/shared/override/integrity.ts`.

---

## Reporting something not on this list

`SUPPORT.md` has the runbook and what to attach. `doctor --bundle` produces a
redacted diagnostic bundle that is safe to send.
