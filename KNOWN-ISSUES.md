# Known issues

Limitations of this release that you can hit in normal use. Every entry was
checked against the code before it was written here, and each says what is
verified and how, so you can tell a measurement from a reading.

Entries 5 and 16 were closed in this cycle (Rust run-sim cases; override
quarantine sidecar). Numbers are not compacted so existing pins keep their
subjects. If you hit something that is not here, that is worth reporting —
see `SUPPORT.md`.

---

## 1. A project with both a web UI and a mobile UI still drives only one surface

**Affects:** any repository where Traffic One sees both a web framework and a
native one — one manifest carrying `next` and `react-native`, or a workspace with
`apps/web` and `apps/mobile`.

**What happens:** the capability profile comes back as `unsupported-hybrid` with
one blocking issue, and architecture compilation refuses until a surface is
chosen:

```
CAPABILITY_HYBRID_UI_TARGET_REQUIRED
Both web-ui and native-ui were detected; set runtime/user-owned
architectureTarget to web-ui or native-ui before architecture compilation.
```

The onboarding wizard and `doctor` now **ask**, with the two answers
(`web-ui` / `native-ui`). A split layout (`apps/web` + `apps/mobile`) also
gets an offer to register those directories as workspace members so each is
a single-surface project. Single-surface runs stay the design: there is no
setting that makes one run drive both surfaces.

**Workaround:** set `architectureTarget` to `web-ui` or `native-ui`, or
register the split roots as workspace members.

**Verified** by `hybridUiTargetAsk` in `src/shared/capabilities/hybrid-target.ts`,
the wizard ask in `src/shared/onboarding-server/flow-view.ts`, and
`HYBRID_UI_TARGET_REQUIRED` in `src/runners/doctor/findings.ts`.

---

## 2. On OpenCode, Kilo and Windsurf, spawning the same role twice still gives you two agents

**Affects:** `opencode`, `kilo`, `windsurf`. Not Claude, Codex, Cursor or
Copilot.

**What happens:** host-identity probes now exist (`src/shared/state/run-agent/host-liveness.ts`):
OpenCode/Kilo on-disk session JSON; Windsurf host-supplied `trajectory_id`.
A host leaves `HOSTS_WITHOUT_VERIFIABLE_REUSE` only when a **live-captured**
fixture pins that probe. The files under `tests/fixtures/host-liveness/`
document the published layouts; they are not live captures, so the set is
still `['opencode', 'kilo', 'windsurf']`. On those hosts the reuse registry
stands down and a second spawn proceeds as a fresh one.

**Why it is deliberate.** Honouring an unverified row would make
orchestrator-authored text authority to deny the role's next spawn.
Standing down costs duplicate context; trusting it would cost correctness.

**Workaround:** on these hosts, spawn each role once per run. Or use a certified
host.

**Verified** by reading `HOSTS_WITHOUT_VERIFIABLE_REUSE` in
`src/shared/state/run-agent/registry.ts` and the stand-down comment beside it.

---

## 3. Subagent round-trips are not certified on any host

**Affects:** all seven hosts, certified ones included.

**What happens:** the release harness cannot read a subagent run manifest or
subagent digests back out of a headless run. Every host row the harness can
drive carries `headlessSubagents: 'unsupported'`, and the two rows that carry no
such field at all — `copilot` and `windsurf` — are `e2eSupported: false`, so the
harness never drives them. Assertions that depend on a subagent
round-trip report `UNSUPPORTED` rather than passing.

A maintainer headless Claude `-p` probe authenticated and exposed `Task`,
but did not load Traffic One and wrote no `.traffic-one/digests/<run>/`
and no run manifest. That is not a flip. Cursor stays a **dated manual
certification record** — no scriptable install.

**What this does *not* mean:** subagents work. This is a gap in automated
*proof*, not a gap in function.

**Verified** by reading every host row in
`src/test-environment/config/hosts.ts`. A maintainer spike that authenticated
headless Claude and saw `Task` still produced no plugin digests or run
manifest (plugin not loaded; cwd was the source repo).

---

## 4. Kilo does not support typed subagents, and its wrapper has never met a real Kilo

**Affects:** `kilo`.

**Two separate things, both real:**

`typedSubagents: false` in Kilo's capability row. Roles that rely on a typed
subagent surface do not get one. Kilo is not alone in this — `codex`, `kilo`,
`copilot` and `windsurf` all have it false, and only `claude`, `cursor` and
`opencode` have it true — but it compounds with the second half below.
This is a host fact, not fixable here.

**And the wrapper's session behaviour is fixture-verified only.** Kilo's plugin
wrapper is a generated JavaScript file that resolves the project root by walking
up from the session directory and stopping at `$HOME`. Every test of that
behaviour works by **pointing `HOME` at a fixture directory** and importing the
generated wrapper. There is no recorded live Kilo session and no
`~/.config/kilo/.traffic-one-debug` payload in this tree. No live payload
was invented.

Kilo is `uncertified` for exactly this class of reason, and installing on it
refuses by default.

**Verified** by reading `src/shared/host/capability-schema.ts`,
`src/runners/kilo-host/wrapper-source.ts`, and the empty live path on this
machine.

---

## 6. Windows composition and Job Object teardown are untested

**Affects:** Windows.

24 non-test source files under `src/` branch on `'win32'` — `.cmd` shim
resolution, zip extraction with an `Expand-Archive` fallback, Defender-lock
tolerant renames, the flat npm-prefix layout, and the QA runner's teardown.
Test files are deliberately not counted. Windows does not run on
`windows-latest`. Composition (`test:env`) and Job Object teardown remain
untested. The `generate-check` matrix is `ubuntu-latest` and `macos-latest`.
`test:env --strict` stays POSIX. Job Object teardown is not claimed fixed.

Windows has no signalling process group. The runner uses
`taskkill /PID <leader> /T /F` from a leader that has to still be alive.
Two cases stay unreachable: a leader that has already exited (a Windows pid
is immediately recyclable, so `/F` at a dead one is a forced kill of
whatever tree now owns that number), and a `setsid`-equivalent escape.
The kernel-exact remedy is a Job Object created with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; that needs a native addon, which a
dependency-free hook runtime cannot have.

The managed-runtime downloader: it resolves a pinned Node for Windows on x64
**and** arm64, and a pinned Python for Windows on x64. What has no asset is
Python on Windows-ARM.

See `PLATFORMS.md`. **Verified** by reading the CI matrix and
`src/config/managed-runtimes.ts`.

---

## 7. Nested `.traffic-one/` paths already tracked stay tracked

**Affects:** repositories that committed a workspace member's `.traffic-one/`
before the generated ignore lines used `**/.traffic-one/<entry>`.

**What happens:** new clones and new files match `**/.traffic-one/runs/` and
its siblings (including `.onboarding-main-sessions.json`). Git does not untrack
what is already in the index, so a previously committed `web/.traffic-one/runs/`
tree stays in the repo until someone `git rm --cached` it.

**Workaround:** `git rm -r --cached web/.traffic-one/runs/` (and the other
run-state entries) once, then commit. Traffic One never rewrites lines outside
its marked block.

**Verified** by `TRAFFIC_ONE_RUN_STATE_ENTRIES` in
`src/shared/architecture-contract/scaffold-content.ts` emitting
`**/.traffic-one/<entry>`, plus `git check-ignore` on a nested member path in
`src/shared/__tests__/scaffold-content.test.ts`.

---

## 8. Key revocation still depends on a cross-repository string; unknown codes are now visible

**Affects:** nobody today; worth knowing because it fails in a direction most
software does not.

Traffic One decides whether a 401 from the auth endpoint means "your key is
revoked" or "we could not check" by reading the server's `error.code` and
matching `invalid_token`. That string is a contract between two repositories
with no shared artifact and no version. If the server ever renames it, **nothing
in Traffic One's test suite goes red** — the client still grants every
unrecognised rejection the offline grace window.

The bias is unchanged and points away from you: an unparseable revocation gives
you 7 more days rather than locking you out. A 401 whose `error.code` is not
in `AUTH_GATE_401_CODES` now writes a machine sidecar and a log line, and
`doctor` reports `AUTH_GATE_401_CODE_UNKNOWN`. The four codes are pinned
verbatim in `src/runners/auth/__tests__/validate-key.test.ts` so a deliberate
change is at least a conversation.

**Verified** by reading `AUTH_GATE_401_CODES` in
`src/runners/auth/validate-key.ts` and `src/shared/auth/auth-gate-drift.ts`.

---

## 9. Below Node 22, Traffic One warns rather than refusing

**Affects:** anyone whose *host application* — not their terminal — launches with
an old Node. Launching a host from the Dock, Start menu or Spotlight never
sources the shell startup files where `nvm` lives, so a terminal reporting Node
22 proves nothing about the hooks.

When a **cached managed Node** is present (`ensureManagedRuntime`), the
entry/shim re-execs under it. When none is available, Traffic One writes one
stderr line naming your Node, the floor and the usual cause, and continues
(`Continuing anyway`). It does not refuse, because a hook that throws becomes a
deny nobody can override, and a launcher that exits early reads to the host as
"this gate had nothing to say" — every gate silently off.

Diagnose with `node ~/.traffic-one/bin/doctor.cjs`; the finding is
`HOOK_RUNTIME_NODE_BELOW_FLOOR`. See `PLATFORMS.md`.

**Verified** by `nodeFloorGuardSource` in `src/shared/node-floor.ts` and
`src/shared/node-floor-reexec.ts`.

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

The fold now writes a small marker under `.traffic-one/runs/.once/`; the next
UserPromptSubmit or SessionStart turns it into a **non-denying** context line
naming the `### <path>` heading (`consumeArchitectureFoldNotice`). A
case-mismatched `packages` symlink is **reported** (`packages-case-mismatch`),
not silently refused. The migrated section warns when it exceeds eight `###`
blocks (`MIGRATED_SECTION_BLOCK_WARN`).

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

Phase 3d records per-file hashes in `manifest.json` and reconverges on hash
drift. **The never-delete-on-torn rule still holds:** a torn plugin root
refuses and leaves every project byte alone. This entry is kept on purpose
(correct fail-closed). Narrowing to "admit plain source writes when the
project's own copy is complete" was considered and not taken — every mutating
call runs `materializeProjectIfNeeded`.

**Workaround:** complete or redo the installation, then repeat the tool call.

**Verified** by `tornRootRefusal` in `src/shared/materialize/materialize.ts`
and `src/shared/materialize/__tests__/file-hash-reconverge.test.ts`.

---

## 12. A forged or stale workspace registry can hide a nested stray

**Affects:** a Traffic One WORKSPACE whose `.one.json` member list is writable
by anyone who can write the project.

**What happens:** the doctor now does a state read per nested root. A directory
whose `.one.json` is a workspace container, or which is a member of one, is
not listed under `NESTED_TRAFFIC_ONE_ROOTS`. An unreadable nested registry
names its descendants under `NESTED_TRAFFIC_ONE_ROOTS_MEMBERSHIP_UNKNOWN`
and offers no cleanup advice.

What remains: anyone who can add `{ path: 'tools/scratch' }` to a container's
`.one.json` can silence the stray finding for that path, and an entry left
behind after a member was deleted does the same by accident. Suppression is
the safe direction — a false negative costs an unreported stray; a false
positive costs a live project its runs, claims and plan.

**Workaround:** run the doctor at the workspace container. Never point the
cleanup runner at a directory that holds a `plan.md` or a `runs/` folder you
recognise.

**Verified** by `strayNestedTrafficOneRoots` in `src/runners/doctor/findings.ts`
and `src/runners/doctor/__tests__/workspace-nested-roots.test.ts`.

---

## 13. Leftover Traffic One folders inside a recognised module are no longer cleaned up for you

**Affects:** any repository containing a module directory that carries its own
`build.gradle`, `build.gradle.kts`, `pom.xml`, `mix.exs`, `setup.py`,
`setup.cfg`, an MSBuild project file, or (when nothing above it declares a
project) a `requirements.txt`.

**What happens:** those directories are recognised as modules. A stray
`.traffic-one/` inside one is no longer treated as a leak, so the start-of-
session sweep leaves it alone. A nested directory that already carries
`plan.md`, run digests, a consent record, or `onboardingComplete` is kept as
a project (`nestedRootHasProjectEvidence`). Leftovers without that evidence
stay advisory (doctor) rather than auto-deleted.

**Workaround:** delete an unwanted nested `.traffic-one/` by hand.

**Verified** by `src/shared/retention.ts` and
`src/shared/__tests__/marker-widening-retention-direction.test.ts`.

---

## 14. An onboarded project becomes a workspace container only with an explicit convert

**Affects:** a repository root that Traffic One already classified as an
ordinary project — most easily a JavaScript/TypeScript monorepo root.

**What happens:** registration as a workspace container is still refused
while the directory is a project. The refusal names
`traffic-one-workspace.cjs --convert-to-container`. That command is allowed
when the root has no runs and no plan; with `--yes` it archives existing
state under `.traffic-one/.converted-<ts>/` first. Converting without that
archive would make every gate refuse work at that root.

**Workaround:** run the named command, or register members in the directory
that HOLDS the projects.

**Verified** by `src/runners/traffic-one-workspace/index.ts` and
`src/shared/state/workspace-convert.ts`.

---

## 15. A damaged operator-override record still de-certifies every run on disk

**Affects:** a project where an operator override was ever minted, on a machine
where something other than you can write `~/.traffic-one/overrides/`.

**What happens:** when the override record stops accounting for itself, no run
in that project can settle `verified` or `shipped` until
`doctor --reconcile-overrides`. That repair still quarantines **every** run
directory on disk (v2: the signed digest of a sidecar listing them). A
per-run signed "no override consumed" attestation — so repair would skip
runs that already carry one — is designed and not shipped. Whoever damaged
the record can damage it again after each repair.

**What bounds it.** It is loud (signed acknowledgement, doctor prints the
state). An unreadable record cannot be fingerprinted, so the repair refuses
before charging. Re-running on an unchanged record is `nothing-to-reconcile`.

**Workaround:** runs minted AFTER a repair certify normally. If it happens
more than once, fix who can write `~/.traffic-one/`.

**Verified** by `src/shared/override/__tests__/reconcile.test.ts` (every run
on disk still pays) and `src/runners/doctor/unblock.ts` (`projectRunIds`).

---

## 17. On a case-insensitive disk, two override folders for one project are not merged if both already exist

**Affects:** macOS and Windows default volumes.

**What happens:** `projectRootHash` now uses `fs.realpathSync.native` (on-disk
case). A one-time rename moves a leftover miscased-hash folder onto the
canonical name when that folder is **absent**. Tokens minted under the old
hash keep matching via `projectRootHashAliases`. If **both** the canonical
folder and a miscased folder already exist, the rename does not merge them —
consent, prefs and override history stay split.

**Workaround:** refer to a project by the spelling your host opened it with.
If you have two folders under `~/.traffic-one/projects/` for one directory,
keep the canonical one and stop using the other spelling.

**Verified** by `migrateMiscasedPrefsBucket` in
`src/shared/state/local-prefs/prefs-store.ts` (`if (fs.existsSync(dest)) return null`).

---

## 18. A planted unsigned `verified` no longer locks `--unblock`; same-uid can still forge a MAC

**Affects:** any project, on a machine where something other than you can write
`.traffic-one/` inside it — which includes the agent.

**What happens:** `--unblock` refuses a run whose settlement reads `verified`
**and** carries a `settlementMac` this install signed. An unsigned `verified`
is treated as planted: the mint proceeds, and the refusal text plus
`planted-verified.jsonl` name it. `settlementHash` is still an unkeyed digest.

**What remains:** whoever can read the per-user override key can forge a MAC.
Same-uid is the trust boundary. An agent that can run arbitrary shell as you
can read the key file; that agent can also overwrite the plugin.

**Workaround:** start a new run if an honest certificate is blocking recovery
and you have ruled out a planted file. If it keeps happening, fix what can
write your project directory.

**Verified** by `src/shared/override/settlement-mac.ts` and
`src/runners/doctor/__tests__/unblock.test.ts`.

---

## 19. An in-process gate cannot enforce a wall-clock deadline

**Affects:** every host. The hook runtime is synchronous (`spawnSync`,
`readFileSync`, `Atomics.wait`).

**What happens:** a timer in the same thread cannot preempt a hang. A FIFO
open, a stuck `Atomics.wait`, or a child that ignores signals until the
parent's `spawnSync` returns holds the gate until the OS or the host kills
the process. Exit 1 is non-blocking on Claude/Codex/Windsurf; a hung hook
is a hung turn.

A real deadline needs a supervising parent that writes the deny and kills
the child. That process is not in this runtime. Bounded reads and
`spawnSync` timeouts cover some I/O; they do not cover an in-process wait
that never returns.

**Verified** by the synchronous runtime shape and the FIFO/hang pins in
`src/shared/__tests__/bounded-read-taxonomy.test.ts` and
`src/shared/bounded-read.ts`.

---

## Reporting something not on this list

`SUPPORT.md` has the runbook and what to attach. `doctor --bundle` produces a
redacted diagnostic bundle that is safe to send.
