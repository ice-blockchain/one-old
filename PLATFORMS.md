# Supported platforms

What Traffic One is tested on, and what "supported" means in each case. Every
row is read out of the code or the CI configuration; nothing here is an
intention.

Three axes matter independently: your **agent host**, your **Node**, and your
**operating system**. A combination is only as strong as its weakest axis.

---

## Agent hosts

Traffic One supports **seven hosts** (eight products — Copilot CLI and VS Code
Copilot are one host to Traffic One). They are declared in `HOST_CAPABILITIES`
(`src/shared/host/capability-schema.ts`), which carries two independent fields
per host and it is worth keeping them apart:

- **`tier`** answers *"can Traffic One guarantee its enforcement here?"* This is
  the one that changes what you get.
- **`certification`** answers *"how is that proven before a release?"* — by an
  unattended, scriptable install→run→verify→settle sequence
  (`contract+live-auto`), or by a dated manual record reproduced by a human
  against the same contract (`contract+manual-e2e`).

| Host | Tier | Release evidence | Primary blocking point |
|---|---|---|---|
| Claude Code (`claude`) | certified | `contract+live-auto` | `PreToolUse` |
| Codex CLI / Desktop (`codex`) | certified | `contract+live-auto` | `PreToolUse` |
| Cursor (`cursor`) | certified | `contract+manual-e2e` | `preToolUse` |
| OpenCode (`opencode`) | uncertified | `contract+manual-e2e` | `tool.execute.before` |
| Kilo (`kilo`) | uncertified | `contract+manual-e2e` | `tool.execute.before` |
| GitHub Copilot (`copilot`) | uncertified | `contract+manual-e2e` | `PreToolUse` |
| Windsurf / Devin Cascade (`windsurf`) | uncertified | `contract+manual-e2e` | `pre_write_code` |

### Certified

**Claude Code, Codex and Cursor.** Every release exercises these hosts'
enforcement points against real host behaviour before shipping.

**Cursor is the asymmetric one and you should know why.** It is certified for
end-user enforcement, but release CI cannot drive it: Cursor has no scriptable
install — it auto-imports Claude Code's user-scope bundle through an
editor-only `/add-plugin` pointer — so its evidence is a **dated manual
certification record** rather than a live automated run. That record is bound to
the exact bytes it was taken against (`installedPluginFingerprint` is the SHA-256
of the built tree), so it cannot be recycled across builds and cannot be forged
by CI.

### Uncertified

**OpenCode, Kilo, Copilot and Windsurf.** Traffic One's gates still run on these
hosts. What is missing is release-time proof that they *keep* running after a
host update.

Installing for an uncertified host **refuses by default**, names the host, and
points at the opt-out:

```
TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST=1
```

Copilot is the exception to the refusal — it installs through its own native
`copilot plugin install`, which Traffic One does not control — so there the
notice arrives as a non-blocking SessionStart banner instead. An unrecognised
host string counts as uncertified, so a typo in `TRAFFIC_ONE_HOST` cannot
silence either surface.

### What is genuinely not covered anywhere

**No configured host supports headless subagents.** Every host row the release
harness can drive headlessly carries `headlessSubagents: 'unsupported'`
(`src/test-environment/config/hosts.ts`). The two rows that carry no such field
at all — Copilot and Windsurf — are the two marked `e2eSupported: false`: they
have no unattended CLI entrypoint, so there is no headless run for the field to
describe. Either way the harness cannot read a subagent run manifest or subagent
digests back out of a headless run on *any* host. Subagent round-trips therefore
cannot be certified automatically anywhere, on certified hosts included. Those
assertions report `UNSUPPORTED` rather than passing quietly. See
`KNOWN-ISSUES.md`.

---

## Node.js

**Node 22 or newer.** That is the declared support contract, stated in three
places that are pinned to each other by tests: `package.json`
`engines: { node: ">=22" }`, `NODE_FLOOR_MAJOR` in `src/shared/node-floor.ts`,
and the README's prose.

Below the floor, Traffic One **warns and continues** — it never refuses. Every
generated launcher stamps a version guard that writes one line to stderr naming
your Node, the floor, and the usual cause. Refusing would be worse than the
problem: a hook handler that throws becomes a deny no operator override can
lift, and a launcher that exits early produces no output at all, which hosts read
as "this gate had nothing to say" — every gate silently off.

For completeness rather than as a promise: the newest unguarded language feature
in the shipped runtime is global `fetch` (Node 18). The floor is deliberately
higher than that, because enforcing 18 would bless a runtime nobody tests on.
**Run 22+.**

**A terminal with Node 22 is not the same as a host with Node 22.** Hooks run in
a process the host application spawns, and a host launched from the Dock, Start
menu or Spotlight never sources your shell startup files — which is where `nvm`
lives entirely. Diagnose with `node ~/.traffic-one/bin/doctor.cjs`; the finding
is `HOOK_RUNTIME_NODE_BELOW_FLOOR`.

---

## Operating systems

| OS | Status | Evidence |
|---|---|---|
| macOS | Exercised on every push | `macos-latest` in the `generate-check` CI matrix: typecheck, determinism gates, the full unit + golden suite, compiled-runtime smoke |
| Linux | Exercised on every push, most thoroughly | `ubuntu-latest` in the same matrix, **plus** the two jobs that run nowhere else: the serial hook-timing/latency budget, and `test:env --strict`, the only test of how the gates, the architecture compiler, the QA runner and settlement compose |
| Windows | **Code paths exist; no automated coverage** | 19 non-test source files under `src/` branch on `'win32'` (`.cmd` shim resolution, zip extraction, `Expand-Archive` fallback, Defender-lock-tolerant renames, flat npm-prefix layout). None of it is exercised by CI, and there is no manual certification record for it |

**Read the Windows row literally.** Traffic One is written to work on Windows and
has been thought about carefully there — but nothing in this repository proves
it does, so it is not a supported platform. If you run it on Windows you are the
test.

The managed-runtime downloader has a matrix of its own, and the asset maps in
`src/config/managed-runtimes.ts` are what decide it — read those rather than the
prose around them. A pinned **Node** asset resolves for **macOS, Linux and
Windows on x64 and arm64**; a pinned **Python** asset for **macOS and Linux on
x64 and arm64, plus Windows on x64**. The one hole is deliberate and named in
code: there is no `aarch64-pc-windows-msvc` standalone Python build, so
Windows-on-ARM has a managed Node and no managed Python. Anywhere the maps do
not reach — an unlisted platform, an unlisted architecture — the download
returns nothing and the caller degrades to its existing install-skipped path
rather than failing.

A resolving Windows asset is **not** Windows support: it is the same code the row
above describes, with the same absence of coverage behind it. And musl is not a
distinction these maps can draw at all — `process.platform` reads `linux` on
Alpine, so the glibc asset is what gets selected there, and nothing detects the
difference.

---

## Project stacks

Traffic One derives your project's surfaces (web-ui, native-ui, api, cli,
worker, data) from evidence on disk rather than asking you to declare them.
The release harness (`npm run test:env -- --strict`) drives complete runs for
every project shape it models, and needs `go`, `pytest`, `ruff` and a Playwright
Chromium to do it; a missing toolchain is reported as INCONCLUSIVE rather than
passing.

One stack is worth naming because its absence is easy to miss: **Rust is not
exercised by the release harness.** `rustfmt.toml` scaffolding and Rust-aware
skip directories (`target/`, `Cargo.lock`) exist in the runtime, but no case in
`src/test-environment/config/cases/**` drives a Rust project end to end. Treat
Rust support as untested. See `KNOWN-ISSUES.md`.

---

## Changing any of this

Every table above is derived from a single place in the source, deliberately, so
prose cannot drift from behaviour:

- host tiers and certification → `src/shared/host/capability-schema.ts`
- headless-subagent support → `src/test-environment/config/hosts.ts`
- the Node floor → `package.json` `engines` and `src/shared/node-floor.ts`
- the OS matrix → `.github/workflows/generate-check.yml`
- managed-runtime asset coverage → `src/config/managed-runtimes.ts`
