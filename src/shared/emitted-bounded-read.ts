// src/shared/emitted-bounded-read.ts
// THE BOUND, AS SOURCE — one copy of `bounded-read.ts`'s allowlist-of-regular-
// files for the launchers and host wrappers that CANNOT IMPORT THE LEAF.
//
// A LEAF THAT EMITS TEXT: no imports at all, because everything it produces runs
// in a process that has no plugin root, no module resolution into this tree and
// no npm dependencies. `src/runners/opencode-host/wrapper-source.ts`,
// `src/runners/kilo-host/wrapper-source.ts` and `src/config/opencode-mcp.ts`
// interpolate it; `__tests__/emitted-read-bound.test.ts` DRIVES the emitted text
// and both wrappers against a hostile shape, and
// `__tests__/bounded-read-census.test.ts`'s `EMITTED_READS` pins the set of files
// that emit a read at all.
//
// WHY THIS FILE EXISTS AT ALL — the sentence it replaces, recorded rather than
// deleted, because the shape of the mistake is the finding. `EMITTED_READS`
// enumerated the two host wrappers with "Same cost class as the shim — a
// foreground command that does not return", and the shim's row is about
// `<$HOME>/.traffic-one/windsurf-plugin-root`, a path no pull request can write.
// The wrappers' path is NOT that: `validTrafficOneRoot`/`readTrafficOneMarker`
// walk UPWARD from the host's cwd, so the file they read is
// `<project>/.traffic-one/.one.json` — and git stores a symlink as a mode-120000
// blob, so `.traffic-one/.one.json -> /dev/zero` arrives through an ordinary pull
// request and materialises on `git clone` with no local process. DRIVEN, both
// wrappers, one arm per child under a parent SIGKILL at 8 000 ms
// (.tmp/bounded6/p1-before*.json, node v26.5.0, load 2.94): symlink to /dev/zero
// SIGKILL at 8 068 ms (opencode) and 8 064 ms (kilo), FIFO SIGKILL at 8 017 ms
// both, against controls of 408 ms and 687 ms end to end (30 ms and 45 ms inside
// the child). That is a host plugin load that never returns, which is the outcome
// this whole class is ranked below failing closed.
//
// ONE EMITTED HELPER RATHER THAN FOUR HAND-WRITTEN GUARDS, and the reason is the
// lane's own history rather than tidiness: `bounded-read.ts` exists because the
// same three-line open/fstat argument was COPIED between two lock readers and the
// property that bounds the read did not travel with the copy. Four inline guards
// in two hosts' wrappers plus a `node -e` string is that same copy four times, in
// emitted text nobody type-checks, where a missing `O_NONBLOCK` in one of them
// looks exactly like the other three.
//
// SPELLED AS ONE COMMENT-FREE LINE because one of the three consumers is a `node
// -e` argument that `__tests__/launcher-state-root.test.ts` asserts is a single
// line with no `//` and no `/*` in it. The explanation therefore lives here, in
// the file that produces the text, and each emitter decorates the interpolation
// in whatever form its own output allows.
//
// SYMLINKS ARE FOLLOWED, deliberately, exactly as `readRegularFile` follows them
// and for the same reason: a config file an operator arranged as a link did
// nothing wrong, and the bound does not come from refusing the link. It comes
// from O_NONBLOCK (a FIFO with no writer opens instead of waiting) plus `fstat` ON
// THE DESCRIPTOR (so what is classified is the object actually opened, with no
// window between the check and the read). A link to /dev/zero is therefore
// refused at the fstat, not at the open, and a link to a regular file still
// reads.

/** The function name the emitted text declares, so a caller never spells it twice. */
export const EMITTED_BOUNDED_READ_FN = 'trafficOneReadRegularText';

/**
 * The emitted reader: `null` when something IS there and it is not a regular
 * file, the text when it is, and a THROW for a path that cannot be opened at all
 * — the same three answers `readRegular` gives, so every call site keeps the
 * `try/catch` it already had and gains one `?? 'null'` for the refusal.
 *
 * @param fsBinding the identifier that holds the `fs` module in the emitted
 * scope. A parameter rather than an emitted `require`/`import` of its own: the
 * `node -e` consumer must stay one line and already has `fs` in scope, and a
 * second binding of the same module in the wrappers would be a second thing to
 * keep in step.
 */
export function emittedBoundedReadSource(fsBinding: string): string {
  return `function ${EMITTED_BOUNDED_READ_FN}(f){`
    + `const d=${fsBinding}.openSync(f,${fsBinding}.constants.O_RDONLY|(${fsBinding}.constants.O_NONBLOCK||0));`
    + `try{return ${fsBinding}.fstatSync(d).isFile()?${fsBinding}.readFileSync(d,'utf8'):null;}`
    + `finally{${fsBinding}.closeSync(d);}}`;
}
