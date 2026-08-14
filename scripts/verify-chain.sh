#!/bin/bash
# The AGENTS.md command chain, run so that its result can be trusted. Every guard
# here is a lesson someone already paid for, and each one silently reported a
# GREEN chain over a red tree, or the reverse, until it was added:
#
#   - NOTHING is piped. A verification run piped into head/tail reports the
#     PIPE's exit code, which produced a false green in this project. Each step
#     redirects to its own log and its own `$?` is captured immediately.
#   - Steps run SERIALLY. Two concurrent suite runs fail each other on
#     same-prefix temp directories, and the latency rows misread I/O contention
#     as a real breach.
#   - PLAYWRIGHT_BROWSERS_PATH is corrected. An agent shell may export it to a
#     sandbox cache that does not exist, and `test:env` then reports ~48 false
#     failures that look exactly like an uninstalled browser.
#   - The suite log is CHECKED FOR ITS TAP MARKER before any count is read off
#     it. Node's reporter is `spec` on a TTY and `tap` when redirected; a grep
#     for `# pass` against a spec log matches nothing and looks like a clean
#     pass. If the marker is absent this script reports UNDETERMINED rather than
#     a number.
#
# Usage:  npm run verify:chain                       # full chain
#         bash scripts/verify-chain.sh               # the same
#         STOP_AFTER=test bash scripts/verify-chain.sh
#
# STOP_AFTER accepts any step name below (typecheck, test, gen, build, golden,
# plugin-check, smoke).
#
# The tree MUST be quiet: no lane editing src/. Both `gen` and `build` stamp a
# build-provenance.json whose sourceHash covers every file under src/**, so an
# edit landing mid-chain reports drift that is not drift, at two independent
# places. See the AGENTS.md section this script automates.

set -u
cd "$(dirname "$0")/.." || exit 1

# Under /.tmp/ because these logs are scratch, and AGENTS.md puts authored
# scratch there and nowhere else. Gitignored, so a run never dirties the tree
# it is about to judge.
LOGS=.tmp/verify-chain
mkdir -p "$LOGS"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH_OVERRIDE:-$HOME/Library/Caches/ms-playwright}"

SUMMARY="$LOGS/SUMMARY.txt"
: > "$SUMMARY"

say() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }

say "chain started $(date '+%Y-%m-%d %H:%M:%S')  load=$(sysctl -n vm.loadavg 2>/dev/null || uptime)"
say "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH"
say ""

step() {
  local name="$1"; shift
  local log="$LOGS/$name.log"
  local t0 t1
  t0=$(date +%s)
  "$@" > "$log" 2>&1
  local code=$?
  t1=$(date +%s)
  say "$(printf '%-14s EXIT=%-3s %4ss  %s' "$name" "$code" "$((t1 - t0))" "$log")"
  return $code
}

fail() { say ""; say "CHAIN STOPPED at $1 — read $LOGS/$1.log"; exit 1; }

# ── 1. typecheck ────────────────────────────────────────────────────────────
step typecheck npm run typecheck || fail typecheck
[ "${STOP_AFTER:-}" = typecheck ] && exit 0

# ── 2. the suite ────────────────────────────────────────────────────────────
# NOT `npm test`, and the deviation is deliberate and measured. On node v26.5.0
# the default reporter is `spec` EVEN WHEN STDOUT IS REDIRECTED TO A FILE (a
# redirected run produced `✔ …` lines and ZERO `# tests` markers), so the bar —
# zero `not ok` lines, a pass count — cannot be read off `npm test > log` at
# all. Appending the flag as `npm test -- --test-reporter=tap` does not select
# it either; the flag has to come BEFORE `--test`. Everything else is
# byte-identical to package.json's `test` script, globs quoted so node does its
# own expansion.
#
# Not `|| fail`: a red suite still needs its counts read and attributed, which
# is the whole point of this step.
step test node --import ./src/build/test-preload.mjs --import tsx \
  --test-reporter=tap --test "src/**/*.test.ts" "tests/**/*.test.ts"
TEST_EXIT=$?

TESTLOG="$LOGS/test.log"
if ! grep -q '^# tests ' "$TESTLOG"; then
  say ""
  say "UNDETERMINED: '$TESTLOG' carries no '# tests' line, so it is NOT a tap log"
  say "  and no pass/fail count can be read off it. Do not report a figure from"
  say "  this run. (Node's reporter is spec on a TTY, tap when redirected.)"
else
  tests=$(grep -m1 '^# tests '  "$TESTLOG" | awk '{print $3}')
  pass=$( grep -m1 '^# pass '   "$TESTLOG" | awk '{print $3}')
  fail_=$(grep -m1 '^# fail '   "$TESTLOG" | awk '{print $3}')
  skip=$( grep -m1 '^# skipped ' "$TESTLOG" | awk '{print $3}')
  notok=$(grep -c '^not ok ' "$TESTLOG")
  say ""
  say "  tests=$tests pass=$pass fail=$fail_ skipped=$skip 'not ok' lines=$notok"
  say "  bar: EXIT=0, fail = 0, 'not ok' lines = 0"
  # Every failing test NAMED, so attribution is possible without re-running.
  grep '^not ok ' "$TESTLOG" > "$LOGS/failures.txt" 2>/dev/null
  if [ -s "$LOGS/failures.txt" ]; then
    say "  failures named in $LOGS/failures.txt:"
    sed 's/^/    /' "$LOGS/failures.txt" | tee -a "$SUMMARY"
    say ""
    say "  Before calling any of these a regression: a handful of rows in this"
    say "  suite enforce FIXED REAL-TIME deadlines (lock timeouts, latency"
    say "  budgets, process-reap ceilings) and go red under full-suite load while"
    say "  passing alone. Re-run the named file BY ITSELF first."
  fi
  # A skip is NAMED, never counted: a stood-down suite reports a clean LOWER
  # number and a bare count cannot tell that from a pass.
  if [ "${skip:-0}" != "0" ]; then
    say "  skipped tests NAMED (a count alone hides a stand-down):"
    grep -B1 'SKIP' "$TESTLOG" | grep '^ok ' | sed 's/^/    /' | tee -a "$SUMMARY"
  fi
fi
[ "${STOP_AFTER:-}" = test ] && exit 0

# A red suite no longer STOPS the chain, and the reason is worth stating: the
# steps after this one are the only way to learn whether a failure is a source
# defect or a stale generated layer, and stopping here forces that question to be
# answered by a second full run. The verdict is not softened — SUITE_RED is
# carried to the end and reported there — only deferred.
SUITE_RED=0
[ "$TEST_EXIT" -ne 0 ] && SUITE_RED=1

# ── 3-8. generated artifacts, then the composition run ──────────────────────
step gen          npm run gen          || fail gen
[ "${STOP_AFTER:-}" = gen ] && exit 0
step build        npm run build        || fail build
[ "${STOP_AFTER:-}" = build ] && exit 0
step golden       npm run golden:update || fail golden
[ "${STOP_AFTER:-}" = golden ] && exit 0
step plugin-check npm run plugin:check || fail plugin-check
[ "${STOP_AFTER:-}" = plugin-check ] && exit 0
step smoke        npm run smoke        || fail smoke
[ "${STOP_AFTER:-}" = smoke ] && exit 0
step test-env     npm run test:env -- --strict
ENV_EXIT=$?
say ""

# THE EXIT CODE OF THIS STEP IS NOT THE VERDICT, and treating it as one stops the
# chain on a green tree every single time. `--strict` with no `--host=` selects
# defaultConfig().enabledHosts = [claude, codex, cursor]; `cursor` is
# `contract+manual-e2e`, so with no `--manual-cert-dir` its record loads MISSING,
# manualUncertified = 1, and releaseResultFailed() exits 1 WITH EVERY ASSERTION
# PASS. That is not a discovery of this script's —
# src/test-environment/ci-strict-invocation.test.ts exists to keep the same trap
# out of the workflows, in its own words: "A job that is red on a green tree is
# worse than no job." The workflow therefore runs `--strict --host=claude,codex`.
#
# So the verdict is read from the assertion tally. A missing toolchain reports
# INCONCLUSIVE rather than PASS, which is why INCONCLUSIVE is fatal here and not
# merely noted: this step needs go, pytest, ruff and a Playwright Chromium at the
# runs root, and silence about an absent one would read as a pass.
TALLY=$(grep -o 'assertions: PASS [0-9]* · FAIL [0-9]* · SKIP [0-9]* · INCONCLUSIVE [0-9]*' "$LOGS/test-env.log" | tail -1)
ENV_FAIL=$(printf '%s' "$TALLY" | sed -n 's/.*FAIL \([0-9]*\).*/\1/p')
ENV_INCONC=$(printf '%s' "$TALLY" | sed -n 's/.*INCONCLUSIVE \([0-9]*\).*/\1/p')
say "  ${TALLY:-NO ASSERTION TALLY FOUND}"
if [ -z "$TALLY" ]; then
  say "  no tally to read, so this proves nothing either way — treat as UNDETERMINED"
  fail test-env
fi
if [ "$ENV_FAIL" != 0 ] || [ "$ENV_INCONC" != 0 ]; then
  say "  bar: FAIL = 0 and INCONCLUSIVE = 0. Read $LOGS/test-env.log and the run's"
  say "  own results.md, which names every failing assertion per scenario."
  fail test-env
fi
if [ "$ENV_EXIT" -ne 0 ]; then
  say "  EXIT=$ENV_EXIT with a CLEAN tally: this is the manual-certification gap"
  say "  described above (expect 'manual certifications: 0/1 certified' and"
  say "  'cursor' listed as never driven automatically), NOT a regression."
  grep -E 'manual certifications:|never driven automatically' "$LOGS/test-env.log" | sed 's/^/  /' >> "$SUMMARY"
fi

say ""
if [ "${SUITE_RED:-0}" -ne 0 ]; then
  say "CHAIN INCOMPLETE $(date '+%H:%M:%S') — every later step ran, but the SUITE was"
  say "  red (see the named failures above). The bar is fail = 0; this run does"
  say "  not meet it."
  exit 1
fi
say "CHAIN COMPLETE $(date '+%H:%M:%S')"
