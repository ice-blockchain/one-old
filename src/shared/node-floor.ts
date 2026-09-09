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

// RE-EXEC WHEN A MANAGED NODE IS PRESENT, WARN ONLY WHEN NONE IS. Two failure
// surfaces make a bare refusal worse than the status quo. A hook handler that
// throws becomes a `pipeline-handler-crashed` deny that no operator override
// can lift (core/pipeline.ts), so an assertion that threw per event would turn
// "your node is old" into every tool call denied with no escape hatch. A
// launcher that exits early without handing off produces no stdout, which hosts
// read as "this gate had nothing to say" — fail-OPEN, with every gate silently
// off. Re-exec under the managed Node (ensureManagedRuntime / the cached
// `_runtimes/node` tree) keeps the process on a supported runtime. The warning
// is the fallback for a machine that has no managed Node to hand off to.
export const NODE_FLOOR_MAJOR = 22;

// Set on the child of a below-floor re-exec so a faked process.versions.node
// (or a wrapper that forgot to replace execPath) cannot loop.
export const NODE_FLOOR_REEXEC_ENV = 'TRAFFIC_ONE_NODE_REEXEC';

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
 *
 * Below the floor the guard first probes the cached managed-Node tree (same
 * layout ensureManagedRuntime writes). A hit re-execs this argv under that
 * binary. A miss writes the warning and continues — never throws.
 */
export function nodeFloorWarningText(): string {
  return 'traffic-one: this process is running Node ' + process.versions.node
    + ', below the supported floor of Node ' + NODE_FLOOR_MAJOR + ' (package.json "engines").'
    + ' Traffic One hooks and runners may fail in ways that do not name this cause.'
    + ' If your terminal has Node ' + NODE_FLOOR_MAJOR + '+ but this does not, the host application was started from the desktop'
    + ' and never inherited your shell PATH, so an nvm-managed Node is invisible to it: quit the host and relaunch it from a terminal,'
    + ' or install Node ' + NODE_FLOOR_MAJOR + '+ somewhere on the system PATH.'
    + ' Diagnose with: ' + DOCTOR_HINT + '. Continuing anyway.\n';
}

export function writeNodeFloorWarning(): void {
  try {
    process.stderr.write(nodeFloorWarningText());
  } catch {
    /* a closed or redirected stderr must never break the launcher */
  }
}

export function nodeFloorGuardSource(): string {
  return [
    '// Node floor guard (GENERATED from src/shared/node-floor.ts). ES5 on purpose:',
    '// it must PARSE on the runtime it judges, and it must run before any require()',
    '// of the compiled tree. Re-execs under a cached managed Node when one is',
    '// present; warns and continues only when none is available. Never throws.',
    `var __t1NodeFloor = ${NODE_FLOOR_MAJOR};`,
    "var __t1NodeMajor = parseInt(String(process.versions.node).split('.')[0], 10);",
    `if (__t1NodeMajor < __t1NodeFloor && process.env.${NODE_FLOOR_REEXEC_ENV} !== '1') {`,
    '  var __t1Managed = (function () {',
    '    var fs, pathMod, os, spawnSync, base, root, names, i, j, sub, list, n, cand, bin, ran, ver;',
    "    try { fs = require('fs'); pathMod = require('path'); os = require('os'); spawnSync = require('child_process').spawnSync; } catch (__t1Req) { return ''; }",
    '    bin = process.platform === "win32" ? "node.exe" : "node";',
    '    if (process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT) {',
    '      base = process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;',
    '    } else if (process.env.XDG_STATE_HOME) {',
    "      base = pathMod.join(process.env.XDG_STATE_HOME, 'traffic-one', 'toolchains');",
    '    } else {',
    "      base = pathMod.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.traffic-one', 'toolchains');",
    '    }',
    "    root = pathMod.join(base, '_runtimes', 'node');",
    '    try { names = fs.readdirSync(root); } catch (__t1Dir) { return \'\'; }',
    '    for (i = 0; i < names.length; i++) {',
    '      list = [];',
    '      n = pathMod.join(root, names[i]);',
    '      list.push(pathMod.join(n, bin));',
    "      list.push(pathMod.join(n, 'bin', bin));",
    '      try {',
    '        sub = fs.readdirSync(n);',
    '        for (j = 0; j < sub.length; j++) {',
    '          list.push(pathMod.join(n, sub[j], bin));',
    "          list.push(pathMod.join(n, sub[j], 'bin', bin));",
    '        }',
    '      } catch (__t1Sub) { /* pin layout only, or a file */ }',
    '      for (j = 0; j < list.length; j++) {',
    '        cand = list[j];',
    '        try { if (!fs.existsSync(cand)) continue; } catch (__t1Ex) { continue; }',
    '        try {',
    "          ran = spawnSync(cand, ['--version'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });",
    '        } catch (__t1Ver) { continue; }',
    '        if (!ran || ran.status !== 0) continue;',
    "        ver = parseInt(String(ran.stdout || '').replace(/^v/, '').split('.')[0], 10);",
    '        if (ver >= __t1NodeFloor) return cand;',
    '      }',
    '    }',
    "    return '';",
    '  })();',
    '  if (__t1Managed && __t1Managed !== process.execPath) {',
    '    try {',
    "      var __t1Cp = require('child_process');",
    '      var __t1Env = {};',
    '      var __t1K;',
    '      for (__t1K in process.env) {',
    '        if (Object.prototype.hasOwnProperty.call(process.env, __t1K)) __t1Env[__t1K] = process.env[__t1K];',
    '      }',
    `      __t1Env.${NODE_FLOOR_REEXEC_ENV} = '1';`,
    "      var __t1Ran = __t1Cp.spawnSync(__t1Managed, process.argv.slice(1), { stdio: 'inherit', env: __t1Env });",
    '      process.exit(typeof __t1Ran.status === \'number\' ? __t1Ran.status : 1);',
    '    } catch (__t1Re) { /* fall through to the warning */ }',
    '  }',
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
