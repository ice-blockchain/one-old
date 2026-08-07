// src/shared/node-floor.ts
// THE Node major this plugin declares support for, and the guard every emitted
// launcher stamps ahead of its first require() of plugin code.
//
// `package.json` "engines": { "node": ">=22" } was the only statement of the
// floor that any tooling could read, and nothing in the RUNTIME asserted it: a
// machine whose PATH `node` is older ran the hooks anyway and failed however it
// failed (a SyntaxError from the compiled tree, a missing global, or nothing at
// all — hooks that produce no stdout are indistinguishable from hooks that had
// nothing to say). NODE_FLOOR_MAJOR is that same declaration, reachable from
// code, and __tests__/node-floor.test.ts pins it to `engines` so the two cannot
// name different numbers. tests/readme-claims.test.ts already pins the README's
// prose to `engines` the same way.
//
// The floor is the DECLARED support contract, deliberately, and it is higher
// than what the shipped runtime measurably needs: the newest unguarded feature
// in dist/scripts is the global `fetch` in runners/qa-evidence/server.ts (Node
// 18), after fs.cpSync (16.7) and Array.prototype.at (16.6), while node:sqlite
// (22.5, shared/host/plan.ts) is probed inside try/catch and degrades. Enforcing
// 18 would bless a runtime nobody tests on, so this warns below what the package
// promises and says so — but it warns about the number package.json states,
// never a second number invented here.

// WARN, NEVER REFUSE. Two failure surfaces make refusal worse than the status
// quo. A hook handler that throws becomes a `pipeline-handler-crashed` deny that
// no operator override can lift (core/pipeline.ts), so an assertion that threw
// per event would turn "your node is old" into every tool call denied with no
// escape hatch. A launcher that exits early instead produces no stdout, which
// hosts read as "this gate had nothing to say" — fail-OPEN, with every gate
// silently off. Warning changes no behaviour at all: it only makes the cause
// visible before the confusing failure arrives.
export const NODE_FLOOR_MAJOR = 22;

// The documented shim dir spelling (shared/runner-shims.ts's documentedBinDir),
// hardcoded here for the same reason ~60 places in shipped prose hardcode it:
// this text is emitted into standalone launchers that cannot import anything.
const DOCTOR_HINT = 'node ~/.traffic-one/bin/doctor.cjs';

/**
 * The guard, as source text to place at the TOP of a generated launcher —
 * before it requires any plugin code.
 *
 * ES5 ONLY, and that is the load-bearing property: `var`, no `const`/`let`, no
 * arrow function, no template literal, no optional chaining, no spread. A file
 * is parsed in full before its first statement runs, so a version check written
 * in syntax newer than the runtime it judges never executes on the machine that
 * needs it — the module dies with a SyntaxError naming a line the user cannot
 * interpret. ES5 parses on every Node that has ever shipped, so the only thing
 * that can stop this guard from running is the syntax of the REST of the file it
 * is placed in; keep that low too, and always place it above the require() of
 * the compiled tree (which tsc emits at ES2022 — Node 16.11 to parse at all).
 *
 * NaN is silently fine: an unparseable process.versions.node makes the
 * comparison false and prints nothing, which is the right way to be wrong here.
 */
export function nodeFloorGuardSource(): string {
  return [
    '// Node floor guard (GENERATED from src/shared/node-floor.ts). ES5 on purpose:',
    '// it must PARSE on the runtime it judges, and it must run before any require()',
    '// of the compiled tree. Warns and continues: never refuses, never throws.',
    `var __t1NodeFloor = ${NODE_FLOOR_MAJOR};`,
    "var __t1NodeMajor = parseInt(String(process.versions.node).split('.')[0], 10);",
    'if (__t1NodeMajor < __t1NodeFloor) {',
    '  try {',
    "    process.stderr.write('traffic-one: this process is running Node ' + process.versions.node"
      + " + ', below the supported floor of Node ' + __t1NodeFloor + \" (package.json \\\"engines\\\").\""
      + " + ' Traffic One hooks and runners may fail in ways that do not name this cause.'"
      + " + ' If your terminal has Node ' + __t1NodeFloor + '+ but this does not, the host application was started from the desktop"
      + " and never inherited your shell PATH, so an nvm-managed Node is invisible to it: quit the host and relaunch it from a terminal,"
      + " or install Node ' + __t1NodeFloor + '+ somewhere on the system PATH.'"
      + ` + ' Diagnose with: ${DOCTOR_HINT}. Continuing anyway.\\n');`,
    '  } catch (__t1Err) {',
    '    /* a closed or redirected stderr must never break the launcher */',
    '  }',
    '}',
  ].join('\n');
}
