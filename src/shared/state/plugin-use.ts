// src/shared/state/plugin-use.ts
// The durable per-project "use Traffic One here?" choice. Lives in the PER-USER
// project preferences (~/.traffic-one/projects/<hash>/preferences.json) — never
// inside the repo — so a declined project carries NO .traffic-one folder and no
// generated files. A decline silences every Traffic One hook for that project
// until the user explicitly asks for the plugin again (the prompt hook offers
// the reconsider command only when the prompt names Traffic One).

import * as fs from 'fs';
import * as path from 'path';

import { obj, type Rec } from '../obj';
import { stateTimestamp } from './io';
import { mergeProjectPrefs, prefsCapableRoot, readProjectPrefs } from './local-prefs';
import { askUsePluginFirst } from '../../config/onboarding';
import { STATE_DIR, STATE_FILE } from '../../config/paths';
import { readJson } from '../fsjson';
import { globalTrafficOneDir } from '../state-root';

interface PluginUseChoice {
  enabled: boolean;
  source: string;
  decidedAt: string;
}

// ── the choice, memoized for the life of the process ─────────────────────────
// Every hook entry gate and (since the write fence below) every write under a
// project's state dir asks for this, so an un-memoized read costs two JSON
// reads per question on the 150 ms pre-tool budget. Hooks are one process per
// event, and within one event the answer can only change if THIS process
// changes it — the only two mutators are in this file and both drop the memo.
// A sibling process recording consent mid-event leaves this process with a
// stale `false`, i.e. one hook writes nothing and the next process (a new one)
// sees the truth: the stale direction is the fail-closed one, which is the only
// reason memoizing a consent answer is safe at all.
//
// Keyed by everything the answer depends on — the project root plus the four
// env vars that select the prefs file — because the test suite drives many
// projects and many prefs roots through one process.
const choiceMemo = new Map<string, PluginUseChoice | null>();

function choiceMemoKey(cwd: string, env: NodeJS.ProcessEnv): string {
  return [
    path.resolve(cwd),
    env.TRAFFIC_ONE_PROJECT_PREFS_PATH ?? '',
    env.XDG_STATE_HOME ?? '',
    env.HOME ?? '',
    env.TRAFFIC_ONE_ASK_USE_PLUGIN ?? '',
  ].join('\u0000');
}

/** Drop the memoized consent answers. Called by both mutators; exported for
 *  tests, which reuse tmp paths and flip the ask-first override between cases. */
export function resetPluginUseCache(): void {
  choiceMemo.clear();
}

// Reads name the directory the store will ACCEPT (`prefsCapableRoot`), not the
// raw caller cwd. A marker-less child (pmax-images, mercury/strategies) has no
// bucket of its own: reading that cwd stays `null` forever even after the parent
// answered, which is the ask-first deadlock — hooks keep asking and the write
// fence stays closed. The memo is keyed by that subject so a parent read and a
// remapped child read share one answer. Writes stay on the caller path
// (`recordPluginUseChoice` / `clearPluginUseChoice` are not remapped) so a
// child `--decline` cannot flip the parent.
export function readPluginUseChoice(cwd: string, env: NodeJS.ProcessEnv = process.env): PluginUseChoice | null {
  const subject = prefsCapableRoot(cwd, env);
  const key = choiceMemoKey(subject, env); // key by SUBJECT, not the raw cwd
  const cached = choiceMemo.get(key);
  if (cached !== undefined) return cached;
  const raw = obj(obj(readProjectPrefs(subject, env))?.pluginUse);
  const choice = !raw || typeof raw.enabled !== 'boolean'
    ? null
    : {
      enabled: raw.enabled,
      source: typeof raw.source === 'string' ? raw.source : '',
      decidedAt: typeof raw.decidedAt === 'string' ? raw.decidedAt : '',
    };
  choiceMemo.set(key, choice);
  return choice;
}

// The decline sweep runs BEFORE the answer is written, and `env` is threaded to
// it rather than left to default: the sweep deletes under the project's state
// dir, and for a session rooted at $HOME that dir IS the per-user machine dir,
// which is where the answer itself lives. Recording first meant the sweep
// removed the record it had just written — so the user was asked again next
// session and could destroy the directory again. Recording LAST makes the answer
// the one write nothing afterwards can reclaim.
//
// Answers whether the choice is now ON DISK, because it is not always written
// and the caller could not tell. `updateProjectPrefs` DECLINES to create a prefs
// root for a directory that belongs to an enclosing project (prefs-store.ts, the
// `mercury/strategies` incident) and reports that decline by returning the
// prefs it just READ — a `Rec` shaped exactly like a successful merge. MEASURED
// on a plain sub-directory of a workspace: nothing is written, the answer reads
// back `null`, and this function used to return `void`, so the wizard recorded
// the user's answer, said nothing, and asked again next session.
//
// The decline path makes it worse than a lost preference:
// `removeDeclinedProjectArtifacts` has ALREADY run by then, so the artifacts are
// irreversibly gone AND the "no" is not recorded — the same shape the ordering
// comment above was written to prevent, arriving by a different route.
//
// The check is the merge RESULT rather than a re-read: on the decline path that
// result is the untouched on-disk prefs, so it carries our answer only when the
// answer really is recorded — including the legitimate case where it was already
// recorded with this value. Only `enabled` is checked; a refreshed `source` or
// `decidedAt` is not what any consumer reads.
export function recordPluginUseChoice(cwd: string, enabled: boolean, source: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!enabled) removeDeclinedProjectArtifacts(cwd, env);
  const next = mergeProjectPrefs(cwd, { pluginUse: { enabled, source, decidedAt: stateTimestamp() } }, env);
  resetPluginUseCache();
  const recorded = obj(next.pluginUse)?.enabled === enabled;
  // Fail-open, not fail-silent — state/decision-log.ts's rule. The boolean only
  // reaches a caller that consults it, and all three production callers live in
  // the onboarding wizard, which does not yet; until they do, this is the only
  // thing that makes a discarded consent answer visible at all.
  if (!recorded) {
    try {
      process.stderr.write(
        `[traffic-one] plugin-use: the "${enabled ? 'use' : 'decline'}" answer for ${path.resolve(cwd)} was NOT `
        + 'recorded — its preferences belong to an enclosing project, so nothing was written and the question '
        + 'will be asked again.\n',
      );
    } catch {
      // stderr itself can fail in exotic hosts; there is nowhere left to report this.
    }
  }
  return recorded;
}

// Forget the recorded choice entirely so the normal onboarding flow (and, when
// ASK_USE_PLUGIN_FIRST is active, the use-plugin question) runs again.
export function clearPluginUseChoice(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  mergeProjectPrefs(cwd, { pluginUse: null }, env);
  resetPluginUseCache();
}

// True when the user chose NOT to use Traffic One for this project. Every hook
// entry gate stands down on this — same posture as the plugin's own repo.
export function pluginUseDeclined(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readPluginUseChoice(cwd, env)?.enabled === false;
}

// Public Traffic One MCP work is strict opt-in. A missing choice is not consent
// and must never be treated as equivalent to "not declined".
export function pluginUseEnabled(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readPluginUseChoice(cwd, env)?.enabled === true;
}

// May Traffic One create files inside this project yet? The product contract has
// two halves and BOTH are write fences, not just the decline:
//   - declined      → the project stays untouched (removeDeclinedProjectArtifacts
//                     below exists precisely to undo writes that beat the answer);
//   - still pending → the project must remain byte-identical, `.traffic-one/`
//                     included, until the user actually answers.
// It lives here, next to the choice itself, because "did we ask yet" is not a
// per-feature concern: every surface that writes before the answer re-breaks the
// same contract (it has happened for the generated .gitignore, the uncertified-
// host banner's once-marker, and the decision log's hookSeq counter), and a
// named fence they can all share is the only thing that stops the next one.
// A recorded `false` for ASK_USE_PLUGIN_FIRST leaves the legacy wizard flow
// unchanged: with no ask-first question there is nothing to be pending on.
export function projectWritesPermitted(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const choice = readPluginUseChoice(cwd, env);
  if (choice) return choice.enabled;
  return !askUsePluginFirst(env);
}

// ── The write fence: one guarded primitive, addressed by PATH ────────────────
// projectWritesPermitted above is addressed by CALLER — every writer has to
// remember to ask. That is exactly the fence that has now been forgotten three
// times (the generated .gitignore, the uncertified-host once-marker, the
// decision log's hookSeq counter), and forgetting it is silent: the write
// simply lands. What is being protected is not an operation, it is a LOCATION —
// `<project>/.traffic-one/**` — so the fence belongs on the argument every
// writer already has to pass. shared/fsjson.ts (the declared single IO layer)
// and its text sibling shared/fs-text.ts call projectStateWriteAllowed on the
// target path, which makes refusing the DEFAULT: a new writer that uses the
// codebase's own IO helpers is fenced without knowing this file exists, and a
// writer that wants to bypass it has to reach past those helpers to raw `fs`
// and say so.

// The machine-wide dir (~/.traffic-one, or $XDG_STATE_HOME/traffic-one). Its
// MACHINE-OWNED entries are per-user state, not project state — one of them is
// where the consent answer itself is stored, so fencing those would make
// recording an answer impossible and deadlock the product (see
// MACHINE_OWNED_ENTRIES below; the rest of the dir is NOT exempt). Deliberately
// NOT memoized even though this is on the write path: it is two string joins, and
// a cached value would go stale the moment anything moved HOME/XDG_STATE_HOME —
// which would fence the prefs file and deadlock exactly the case the exemption
// exists to protect.
//
// path.resolve stays HERE rather than moving into the shared base: every path
// this dir is compared against (machineOwnedStatePath, pathWithin) is already
// resolved, so an unresolved machine dir would fail containment segment-wise —
// but resolving inside the base would change what every OTHER caller returns for
// a relative HOME.
function machineStateDir(env: NodeJS.ProcessEnv): string {
  return path.resolve(globalTrafficOneDir(env));
}

// Path comparison here is deliberately case-INSENSITIVE, everywhere. macOS's
// default filesystem and Windows are case-insensitive, so `<p>/.Traffic-One/x`
// and `<p>/.traffic-one/x` are the SAME FILE while a case-sensitive compare
// reported the first as "not project state" and let it through (measured:
// `root=null, allowed=true` for `.Traffic-One` and `.TRAFFIC-ONE`). No plugin
// code produces a non-canonical spelling, so this needs an externally-supplied
// path to matter — but on a genuinely case-sensitive filesystem the only cost is
// refusing a directory Traffic One never creates, which is the fail-closed side.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const STATE_DIR_RE = new RegExp(escapeRegExp(STATE_DIR), 'i');
// Indices from a case-insensitive REGEX, never from `toLowerCase().indexOf()`:
// lowercasing is not length-preserving for every Unicode code point (U+0130
// lowercases to two UTF-16 units), so an index taken from a folded copy can
// slice the original path in the wrong place.
const STATE_DIR_SEGMENT_RE = new RegExp(`${escapeRegExp(path.sep)}${escapeRegExp(STATE_DIR)}`, 'i');

function pathEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// `child` is `parent` or lives under it. Segment by segment, never a folded
// prefix plus a slice, for the same length reason as STATE_DIR_SEGMENT_RE above.
//
// Exported for fsjson.ts's symlink containment check, which has to decide the
// same question ("is this resolved path still inside the state dir?") about the
// same paths this fence governs. Sharing the comparison is the point: a
// containment rule that folded case differently from the fence would refuse a
// path the fence allowed, or the reverse.
export function pathWithin(parent: string, child: string): boolean {
  const parentSegments = parent.split(path.sep);
  const childSegments = child.split(path.sep);
  if (childSegments.length < parentSegments.length) return false;
  return parentSegments.every((segment, i) => pathEquals(childSegments[i] || '', segment));
}

// Entries the per-user machine dir OWNS. The complement of this list is
// STRAY_PROJECT_ARTIFACTS in traffic-one-paths.ts, which enumerates the same
// boundary from the project side; keep the two in step.
//
// An ALLOWLIST, replacing the blanket `startsWith(machineDir)` prefix that used
// to carve the whole tree out. With that prefix, a session rooted at $HOME (and
// XDG_STATE_HOME unset — the default) made EVERY path under
// `$HOME/.traffic-one/**` return null → allowed, so for that shape the
// default-closed guarantee this fence exists to provide simply did not hold
// (measured: `allowed (pending!) = true`, and both writeJson and writeTextFile
// landed on a project whose question was unanswered).
// Split by SHAPE, because only one of the two shapes needs the sidecar wildcard
// and granting it to the other is carve-out nobody asked for. `first` below is
// the whole first segment under the machine dir, so an exact match on a
// DIRECTORY entry already covers everything inside it (`projects/<hash>/
// preferences.json`, and the lock and temp files prefs-store.ts writes BESIDE
// that file — all of them still resolve `first` to `projects`). A directory
// therefore never needs `<entry>.<suffix>` to reach its own contents, and while
// it had one, `projects.anything`, `bin.anything`, `toolchains.anything` and
// `overrides.anything` were exempt from the fence (measured: `root=null,
// allowed=true` for `bin.evil` and `projects.evil` on a $HOME-rooted project
// whose question was PENDING). No writer produces those paths today, so this
// was latent rather than live — but this list is the whole reason the fence is
// default-CLOSED, and every path it hands out is a path the pending-project
// byte-identity contract does not cover.
const MACHINE_OWNED_ENTRIES = {
  // Files, whose own sidecars count as owned: `one.json.lock/` (and the
  // `one.json.lock.<token>.pending` it is renamed from, one-settings.ts), and
  // the `<file>.<pid>.tmp` / `<file>.<pid>.<time>.<rand>.tmp` temps every
  // atomic writer in this codebase places next to its destination. Fencing the
  // lock that guards the machine-wide settings file would deadlock writing it
  // for a session rooted at $HOME, which is the deadlock this carve-out exists
  // to prevent in the first place.
  //
  // `auth-revalidation.json` and `auth-updates.json` are one.json's own
  // sidecars (shared/auth/machine-sidecar.ts): the revalidation cadence and the
  // update-feed cursor for the credential stored INSIDE the exempt one.json.
  // They are split out of the envelope only because its `auth` record is
  // validated by an exact key set and because a cadence stamp does not belong
  // in the 0600 secret file — not because they belong to any project. Listed
  // here even though that module writes through raw `fs` and is unfenced today:
  // the exemption is a statement about who OWNS the path, and leaving it
  // undeclared means the next reader or writer that reaches for fsjson's
  // guarded helpers is silently refused on a $HOME-rooted session.
  files: [
    'one.json',
    'one-mcp.json',
    'secret.env',
    'windsurf-plugin-root',
    'auth-revalidation.json',
    'auth-updates.json',
  ],
  // Directories: exact match only.
  //
  // `overrides` is the operator-override store (shared/override/paths.ts): the
  // per-install HMAC key, the audit ledger and the pre-override snapshots.
  // Machine-owned for the same reason `projects` is — it is keyed BY project
  // but is not that project's state, and it must remain writable for a session
  // rooted at $HOME (where the machine dir and the project's state dir are the
  // same directory). Without this entry a home-rooted mint is refused by that
  // project's own pending use-plugin question.
  dirs: ['projects', 'bin', 'toolchains', 'overrides'],
} as const;

// True when `abs` is one of the machine-owned entries above, or lives under one.
// The machine dir ITSELF is deliberately excluded: `$HOME/.traffic-one` is both
// the machine dir and the $HOME project's state dir, and refusing to remove it
// while that project's question is unanswered is the second line of defence
// behind removeDeclinedProjectArtifacts.
function machineOwnedStatePath(abs: string, machineDir: string): boolean {
  if (!pathWithin(machineDir, abs)) return false;
  const first = (abs.split(path.sep)[machineDir.split(path.sep).length] || '').toLowerCase();
  if (MACHINE_OWNED_ENTRIES.dirs.some((entry) => first === entry)) return true;
  return MACHINE_OWNED_ENTRIES.files.some((entry) => first === entry || first.startsWith(`${entry}.`));
}

/**
 * The project root whose state dir contains `target`, or null when `target` is
 * not project state at all (an ordinary source file, a host config, a
 * machine-owned entry of the per-user dir). The first `.traffic-one` segment in
 * the path wins, so a state dir nested INSIDE another state dir is governed by
 * the outer project. A sibling package's own state dir is NOT: with consent on a
 * monorepo root, `<root>/packages/ui/.traffic-one/x.json` resolves to
 * `<root>/packages/ui` and is governed by that package's own answer (measured:
 * refused while the package's question is pending). That is the behaviour we
 * want — a nested package is its own project as far as consent goes — and the
 * comment used to claim the opposite.
 */
export function projectRootForStatePath(target: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // Fast reject, for the majority of calls: an ALREADY-absolute path with no
  // `.traffic-one` substring cannot be project state, because resolving an
  // absolute path only normalizes `.`/`..`/duplicate separators and can never
  // introduce a segment the string did not already contain. A RELATIVE path
  // gets no shortcut — resolve() prepends process.cwd(), which may itself be
  // inside a state dir.
  if (path.isAbsolute(target) && !STATE_DIR_RE.test(target)) return null;
  const abs = path.resolve(target);
  if (machineOwnedStatePath(abs, machineStateDir(env))) return null;
  const at = abs.search(STATE_DIR_SEGMENT_RE);
  if (at < 0) return null;
  const after = at + path.sep.length + STATE_DIR.length;
  // `.traffic-one-backup` is not the state dir.
  if (after !== abs.length && abs[after] !== path.sep) return null;
  return abs.slice(0, at) || path.sep;
}

// Re-entrancy is fail-CLOSED: evaluating the fence reads the per-user prefs,
// which is a pure read today, but a read path that ever grew a write would
// otherwise recurse until the hook's stack blew. Refusing instead costs at
// most one skipped diagnostic write.
let evaluating = false;

/**
 * May Traffic One write `target`? True for every path that is not inside some
 * project's `.traffic-one/`; for paths that are, this is projectWritesPermitted
 * for that project.
 */
export function projectStateWriteAllowed(target: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const root = projectRootForStatePath(target, env);
  if (root === null) return true;
  if (preConsentWriteRoots.some((permitted) => pathEquals(permitted, root))) return true;
  if (evaluating) return false;
  evaluating = true;
  try {
    return projectWritesPermitted(root, env);
  } finally {
    evaluating = false;
  }
}

/**
 * The ONE legitimate pre-consent writer, named so it cannot be an accident.
 *
 * `decline-cleanup`: a decline runs removeDeclinedProjectArtifacts, which has
 * to DELETE under `.traffic-one/` for a project whose answer is now `false` —
 * i.e. at the exact moment the fence refuses everything. Undoing writes that
 * beat the answer is the fence's purpose, not a violation of it.
 *
 * The reason is a closed union on purpose: adding an opt-out means editing
 * this file and naming it here, which is a reviewable diff rather than a
 * forgotten one.
 */
export type PreConsentWriteReason = 'decline-cleanup';

// Scoped to the ONE project root being declined, not to the process. The window
// used to be a bare counter checked before anything else, so for the duration of
// a decline on project A every OTHER pending project's state dir was writable
// too (measured: "while declining projA, writes to projC's PENDING state dir
// allowed = true"). Nothing reached that today, but this is the one construct
// that can flip a default-closed fence to default-open, and a process-global
// switch does it for every project at once.
//
// A stack rather than a single value: the window is re-entrant by contract, and
// popping the frame that was pushed is the only thing that keeps a nested call
// from widening the outer one.
const preConsentWriteRoots: string[] = [];

export function withPreConsentProjectWrites<T>(
  _reason: PreConsentWriteReason,
  root: string,
  body: () => T,
): T {
  preConsentWriteRoots.push(path.resolve(root));
  try {
    return body();
  } finally {
    preConsentWriteRoots.pop();
  }
}

// A decline must leave the project untouched: remove the runtime junk the
// pre-decline hooks may already have created (once-markers, runs/).
//
// A never-onboarded project loses the whole dir — unless that dir is the
// per-user machine dir, see below. An ONBOARDED one keeps its
// `.one.json` and `plan.md` — a mode-bearing state file is real work a user may
// want back if they change their mind — but that carve-out predates the
// decision log, which is a different category of thing: an append-only record
// of every tool call, file path and shell command, up to 2 MB per run
// (state/decision-log.ts), plus the deny/claim captures beside it. Keeping a
// project's answers is defensible; keeping a transcript of its activity after
// the user said "don't use this here" is not. So the debug/ trees go
// unconditionally, and so do the once-markers, which are pure runtime residue.
const DECLINE_ALWAYS_REMOVED = ['debug', path.join('runs', '.once'), '.once'] as const;

export function removeDeclinedProjectArtifacts(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const root = path.resolve(cwd);
  // The fence refuses writes under `.traffic-one/` while the answer is pending
  // and once it is `false` — including these deletes. Undoing pre-answer writes
  // is what the fence is FOR, so this is the one named opt-out, and it is scoped
  // to this project so the window cannot license a write anywhere else.
  withPreConsentProjectWrites('decline-cleanup', root, () => {
    try {
      const stateDir = path.join(root, STATE_DIR);
      const state = readJson<Rec>(path.join(root, STATE_FILE), {} as Rec);
      const onboarded = Boolean(state && typeof state.mode === 'string' && state.mode.trim());
      // `<$HOME>/.traffic-one` IS the per-user machine dir whenever
      // XDG_STATE_HOME is unset (the default), and a session rooted at $HOME is
      // an ordinary shape — Codex opens scratch dirs, users open their home
      // directory. Declining there ran the wholesale delete below against the
      // machine dir and took the authenticated API key in `one.json`, every
      // OTHER project's recorded consent and wizard preferences under
      // `projects/**`, the version-stable runner shims in `bin/` that host tool
      // approvals are pinned to, and every managed toolchain under
      // `toolchains/` — potentially gigabytes. Saying "no" is the single most
      // likely thing a cautious first-time user does. The machine dir therefore
      // NEVER gets the wholesale branch; it gets the surgical one, which touches
      // only runtime residue and nothing machine-owned. The project-shaped
      // leftovers a $HOME decline may have are reclaimed by
      // removeStrayProjectArtifactsFromGlobalDir at the next SessionStart, which
      // knows the same boundary by name.
      //
      // Containment, not equality: an XDG_STATE_HOME pointing INSIDE a project's
      // state dir puts the machine dir under the tree about to be removed, which
      // is the same incident by a different route. Nothing ships that layout, but
      // the guard costs one comparison and the failure it prevents is unbounded.
      if (!onboarded && !pathWithin(stateDir, machineStateDir(env))) {
        fs.rmSync(stateDir, { recursive: true, force: true });
        return;
      }
      for (const rel of DECLINE_ALWAYS_REMOVED) {
        fs.rmSync(path.join(stateDir, rel), { recursive: true, force: true });
      }
      // The same activity log, per run: runs/<id>/debug/.
      let runIds: string[] = [];
      try {
        runIds = fs.readdirSync(path.join(stateDir, 'runs'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        // no runs/ — nothing per-run to remove
      }
      for (const runId of runIds) {
        fs.rmSync(path.join(stateDir, 'runs', runId, 'debug'), { recursive: true, force: true });
      }
    } catch {
      // best-effort — a leftover runtime dir never blocks the decline
    }
  });
}
