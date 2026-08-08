# Third-party notices

Traffic One itself is MIT licensed (see `LICENSE`). This file is the census of
everything else, and it separates three things that are easy to conflate and
legally different:

1. **What Traffic One ships.** Code inside the installed bundle.
2. **What Traffic One builds with.** Tools used to produce the bundle, which do
   not travel with it.
3. **What Traffic One installs on your machine.** Third-party programs the
   plugin downloads and runs on your computer, at your direction, none of which
   are bundled or relicensed by Traffic One.

Category 3 is the one with consequences, and it contains a program that is not
open source. Read it before using Traffic One commercially.

Every version and licence below was read out of this repository, not from
memory. Where a claim was measured, the measurement is named.

---

## 1. What Traffic One ships: nothing but its own code

**The installed bundle has no third-party runtime code in it.** The hook runtime
is dependency-free by design, and this is a measurement rather than an
aspiration:

- `package.json` declares **no `dependencies` block at all** — only
  `devDependencies`.
- The generated bundle contains **no `node_modules` directory**.
- Scanning every JavaScript file the build emits under `dist/scripts/`:
  **567 files, 3240 `require()` call sites, 0 of them naming a module that is
  neither a Node built-in nor a relative path.** Measured against the tree built
  from commit `3307e571`.

So there is nothing to attribute here. Everything under `dist/` is Traffic One's
own source compiled from `src/`, plus generated content (rules, skills, agent
docs, host manifests) authored in this repository.

The bundle also carries copies of this repository's own documents — `README.md`,
`ref.md`, `LICENSE`, this file, `PRIVACY.md`, `PLATFORMS.md`, `KNOWN-ISSUES.md`
and `SUPPORT.md` — all under the MIT licence above.

## 2. What Traffic One builds with: not shipped

These are `devDependencies`. They run on a maintainer's machine or in CI to
compile and test the plugin. **No part of them reaches an installed bundle.**

| Package | Declared range | Version installed in this checkout | Licence |
|---|---|---|---|
| `typescript` | `^5.7.2` | 5.9.3 | Apache-2.0 |
| `tsx` | `^4.19.2` | 4.22.4 | MIT |
| `@types/node` | `^22.10.2` | 22.19.19 | MIT |

`@types/node` is type declarations only and emits no runtime code at all.

Traffic One's own continuous integration additionally installs `go`, `python`,
`pytest`, `ruff`, `@playwright/test` and a Playwright Chromium on the CI runner
so the full-composition test can run. These are **CI prerequisites for
maintainers**. They are not installed on a Traffic One user's machine by
anything in the product, and they are not part of any release artifact.

## 3. What Traffic One installs on your machine

Traffic One installs a small set of third-party command-line programs so that
its code-graph and delegation features work. Every one of them:

- is downloaded from its own publisher, by your machine, at install time;
- is **not bundled** with Traffic One, **not redistributed** by Traffic One, and
  **not relicensed** by Traffic One;
- lands in a Traffic One-managed directory under
  `~/.traffic-one/toolchains/<tool>/` — never in your global `npm` prefix, never
  in your `pipx` home, never on your `PATH`;
- is governed by **its own licence**, between you and its publisher.

Your relationship with each of these programs is the same as if you had
installed it yourself. Traffic One's role is to run the installer.

### GitNexus — PolyForm Noncommercial 1.0.0 — NOT open source

**This is the item to read.** GitNexus is one of the two code-graph providers
Traffic One offers, and its licence permits **non-commercial use only**.

| | |
|---|---|
| Package | `gitnexus` (npm) |
| Licence | PolyForm Noncommercial |
| Home | <https://github.com/abhigyanpatwari/GitNexus> |
| Minimum accepted | 1.0.0 |
| Installed version | latest published at install time |
| Installed to | `~/.traffic-one/toolchains/gitnexus/npm-prefix/` |
| Install command | `npm install -g --prefix <that directory> gitnexus@latest` |

The `-g` flag is paired with an explicit `--prefix` and with Traffic One-managed
(deliberately absent) npm config files, so a `prefix=` in your own `.npmrc`
cannot redirect the install out of the managed directory. It is a *managed*
global install, not a *system* one: your global npm prefix is untouched.

**What this means for you.** If your project is commercial, PolyForm
Noncommercial does not permit you to use GitNexus on it. Traffic One does not
make that judgement for you, and it does not make the choice silently: the
code-graph provider is a required onboarding question with no default and no
skip, and the question states the trade-off in as many words — *"gitnexus is
PolyForm Noncommercial; graphify is MIT"*. Choosing `graphify` avoids GitNexus
entirely and nothing installs it. After a scan, the run summary repeats the
licence reminder.

To turn the whole code-graph path off after the fact, set
`"codeGraphAutoRun": false` in your local Traffic One preferences.

Traffic One reads GitNexus's output and never redistributes GitNexus itself.

### graphify — MIT

| | |
|---|---|
| Package | `graphifyy` (PyPI — the double `y` is the real published name) |
| Licence | MIT |
| Home | <https://github.com/edmondchuc/graphify> |
| Minimum accepted | 0.4.0 |
| Installed version | latest published at install time |
| Installed to | a Python virtual environment under `~/.traffic-one/toolchains/graphify/venv/` |

The MIT alternative to GitNexus. Requires Python 3.10 or newer.

### OpenCode — MIT

| | |
|---|---|
| Package | `opencode-ai` (npm) |
| Licence | MIT |
| Home | <https://opencode.ai> |
| Minimum accepted | 1.15.13 |
| Installed version | latest published at install time |
| Installed to | `~/.traffic-one/toolchains/opencode/npm-prefix/` |

Installed only when you opt into OpenCode delegation during onboarding; that
choice is the consent record. Requires Node 18 or newer.

### Managed language runtimes — only when your machine has none that will do

If Traffic One cannot find a Python or Node new enough for the tools above —
after looking on `PATH` and in Homebrew, `nvm`, `pyenv` and `volta`/`fnm`
locations — it downloads a self-contained interpreter rather than running
`brew install` or touching your version managers.

| Runtime | Pinned version | Source | Licence |
|---|---|---|---|
| Node.js | 22.11.0 | `https://nodejs.org/dist/` | MIT |
| CPython (python-build-standalone `install_only` build) | 3.12.7, release tag `20241016` | `https://github.com/astral-sh/python-build-standalone/releases` | Python Software Foundation License (CPython); the python-build-standalone distribution itself is under its own repository's terms |

Each download is verified against the **publisher's own checksum file** before
use (Node's `SHASUMS256.txt`; python-build-standalone's per-asset `.sha256`
sidecar). The runtime lands in
`~/.traffic-one/toolchains/_runtimes/<kind>/<version>/`, is never placed on
`PATH`, and never becomes your system or default interpreter. Published assets
exist for macOS and Linux on x64 and arm64; anywhere else the download is
skipped and the caller degrades rather than failing.

Set `TRAFFIC_ONE_MANAGED_RUNTIME_OFF=1` (or `TRAFFIC_ONE_RUNTIME_PROBE_OFF=1`)
to disable these downloads entirely.

### Security scanners — suggested, never installed automatically

Traffic One's pre-deploy security check runs these two if they are present, and
if they are not it **asks you first and explains why** rather than installing
them. Nothing in Traffic One runs `brew install` on your behalf.

| Tool | Licence | Version CI pins | Minimum accepted | Suggested install |
|---|---|---|---|---|
| gitleaks | MIT | 8.30.1 | 8.20.0 | `brew install gitleaks` |
| trufflehog | AGPL-3.0 | 3.94.3 | 3.80.0 | `brew install trufflehog` |

**trufflehog is AGPL-3.0.** Traffic One neither bundles nor links it: the
scanner is invoked as a separate process, if and only if you installed it, and
Traffic One reads its output. Running a program is not a distribution of it, so
the AGPL's source-offer obligations attach to whoever distributes trufflehog,
not to you for having run it. If your organisation's policy restricts AGPL
tooling anyway, simply do not install it; the security check reports the tool as
missing and names it.

## What Traffic One requires but never installs

These are dependencies **of your project**, which Traffic One invokes if your
project has them. Traffic One does not install them, does not add them to your
manifests behind your back, and reports a blocked environment when one is
missing.

| Tool | How Traffic One relates to it |
|---|---|
| Playwright (`@playwright/test` or `playwright`) and its browser binaries | Resolved from **your project's** `node_modules`, walking up from the project root. If it is absent, the browser QA runner reports `Project-local Playwright is unavailable. Install @playwright/test and its browser binary.` and refuses rather than installing anything. |
| Lighthouse | Resolved from your project. When absent, Traffic One prints the install line for you to run (`npm install -D lighthouse@13.2.0`) — it does not run it. |
| `ruff` | Invoked as your project's Python linter. Traffic One may scaffold a `ruff.toml` into a greenfield project; it never installs `ruff`. |
| `pytest` | Invoked as your project's Python test command. Never installed by Traffic One. |
| `git`, `npm`, `python3`, `go` | Used if present on your machine. |

## Reporting a problem with this notice

If anything here is wrong — a licence that changed upstream, a tool that was
added or removed, a claim that no longer matches the code — that is a defect and
we would rather hear about it than be right by accident. See `SUPPORT.md`.

The authoritative machine-readable source for the installable-toolchain rows is
`scripts/runners/toolchain/toolchain-versions.json` inside the installed bundle
(`src/runners/toolchain/toolchain-versions.json` in the source repository),
which carries a `license` field per tool.
