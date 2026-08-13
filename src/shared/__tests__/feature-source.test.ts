import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPatchTargetPaths,
  commandAppearsToWriteBuildArtifact,
  commandAppearsToWriteFeatureSource,
  FEATURE_SOURCE_RE,
  isTestInfraConfigPath,
  isTestScopePath,
  roleCanWriteFeatureSource,
  shellAssetImportDest,
  shellCommandHasWritePrimitive,
  shellStrayDeleteTarget,
  shellTrafficOneWriteTargets,
  shellWriteTargetsStateDir,
  subagentMayWriteFeatureSource,
} from '../feature-source';

test('FEATURE_SOURCE_RE matches monorepo + flat feature-source layouts', () => {
  assert.equal(FEATURE_SOURCE_RE.test('apps/web/src/main.ts'), true);
  assert.equal(FEATURE_SOURCE_RE.test('apps/mobile/app/index.tsx'), true);
  assert.equal(FEATURE_SOURCE_RE.test('packages/ui/src/button.tsx'), true);
  assert.equal(FEATURE_SOURCE_RE.test('services/api/src/server.ts'), true);
  assert.equal(FEATURE_SOURCE_RE.test('src/app.ts'), true);
  assert.equal(FEATURE_SOURCE_RE.test('README.md'), false);
  assert.equal(FEATURE_SOURCE_RE.test('.traffic-one/plan.md'), false);
});

test('roleCanWriteFeatureSource enforces per-role owned path patterns', () => {
  // senior-frontend owns app UI + flat root UI/SEO/i18n + ui/i18n/utils packages
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'apps/web/src/x.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/app/(public)/news/page.tsx'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/app/sitemap.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/features/news/news-page.tsx'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/i18n/resources.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/lib/seo.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'packages/ui/src/btn.tsx'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'services/api/src/s.ts'), false);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/app/api/join/route.ts'), false);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/services/http.ts'), false);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/lib/db.ts'), false);
  // senior-backend owns services + api/ws/utils packages + apps/root services/store/API
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'services/api/src/s.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'packages/api-client/src/c.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'apps/web/src/services/x.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'src/app/api/join/route.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'src/services/http.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'src/lib/db.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'packages/ui/src/btn.tsx'), false);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'src/app/(public)/news/page.tsx'), false);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'src/lib/seo.ts'), false);
  // quick-fix (maintenance worker) owns the union of frontend + backend paths
  assert.equal(roleCanWriteFeatureSource('quick-fix', 'src/app/(public)/news/page.tsx'), true);
  assert.equal(roleCanWriteFeatureSource('quick-fix', 'packages/ui/src/btn.tsx'), true);
  assert.equal(roleCanWriteFeatureSource('quick-fix', 'src/app/api/join/route.ts'), true);
  assert.equal(roleCanWriteFeatureSource('quick-fix', 'services/api/src/s.ts'), true);
  assert.equal(roleCanWriteFeatureSource('quick-fix', 'README.md'), false);
  // unknown role owns nothing
  assert.equal(roleCanWriteFeatureSource('senior-architect', 'apps/web/src/x.ts'), false);
});

test('subagentMayWriteFeatureSource prefers run-claim role, falls back to session role', () => {
  // explicit agent context: only its role's paths
  assert.equal(
    subagentMayWriteFeatureSource({}, 'apps/web/src/x.ts', { source: 's', runId: 'r', role: 'senior-frontend', spawnIndex: 1, sessionId: null, claimId: null }),
    true,
  );
  assert.equal(
    subagentMayWriteFeatureSource({}, 'services/api/src/s.ts', { source: 's', runId: 'r', role: 'senior-frontend', spawnIndex: 1, sessionId: null, claimId: null }),
    false,
  );
  // no context + not a subagent session → denied
  assert.equal(subagentMayWriteFeatureSource({ team: { mode: 'subagents' } }, 'apps/web/src/x.ts', null), false);
  // no context + a valid subagent session (currentRunId + materializedStack === fingerprint)
  // with a top-level activeAgentRole → allowed for any owned role's paths.
  const subState = {
    stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' },
    materializedStack: 'default|react-vite|supabase|none',
    currentRunId: 'run-1', activeAgentRole: 'senior-backend',
  };
  assert.equal(subagentMayWriteFeatureSource(subState, 'services/api/src/s.ts', null), true);
  assert.equal(subagentMayWriteFeatureSource(subState, 'apps/web/src/x.ts', null), true); // frontend fallback
});

test('commandAppearsToWriteFeatureSource needs both a write primitive and a feature path', () => {
  assert.equal(commandAppearsToWriteFeatureSource('echo hi > apps/web/src/x.ts'), true);
  assert.equal(commandAppearsToWriteFeatureSource('cat <<EOF > src/app.ts'), true);
  assert.equal(commandAppearsToWriteFeatureSource('sed -i s/a/b/ packages/ui/src/x.ts'), true);
  assert.equal(commandAppearsToWriteFeatureSource("find /tmp/project/apps/web/src -name '*.js' -delete"), true);
  assert.equal(commandAppearsToWriteFeatureSource('rm -f apps/web/src/stale.js'), true);
  assert.equal(commandAppearsToWriteFeatureSource('ln -s /tmp/payload apps/web/src/linked'), true);
  assert.equal(commandAppearsToWriteFeatureSource('/bin/ln -s /tmp/payload apps/web/src/linked'), true);
  assert.equal(commandAppearsToWriteFeatureSource('ln /tmp/payload src/linked.ts'), true);
  assert.equal(commandAppearsToWriteFeatureSource('mkdir -p packages/ui/src'), false);
  assert.equal(commandAppearsToWriteFeatureSource('cat apps/web/src/x.ts 2>&1'), false);
  // write primitive but no feature path
  assert.equal(commandAppearsToWriteFeatureSource('echo hi > README.md'), false);
  // feature path but no write primitive
  assert.equal(commandAppearsToWriteFeatureSource('cat apps/web/src/x.ts'), false);
  assert.equal(commandAppearsToWriteFeatureSource(''), false);
  assert.equal(commandAppearsToWriteFeatureSource(undefined), false);
});

test('quoted text is data: comparison/prose ">" and quoted rm/tee never count as write primitives', () => {
  // 5cl-claude regression: the frontend's own collapse self-check was denied —
  // the awk comparison "length > m" read as an output redirect.
  assert.equal(commandAppearsToWriteFeatureSource(
    'for f in $(find src -name "*.tsx"); do awk \'{ if (length > m) m = length } END { print m }\' "$f"; done'), false);
  assert.equal(commandAppearsToWriteFeatureSource('echo "usage: gen > src/out.ts" && ls src/'), false);
  assert.equal(commandAppearsToWriteFeatureSource('grep -n "tee" src/app.ts'), false);
  assert.equal(commandAppearsToWriteFeatureSource('echo "rm -rf src/" && ls src/'), false);
  // stderr silencing is not a write
  assert.equal(commandAppearsToWriteFeatureSource('pkill -f "next start" 2>/dev/null; wc -L src/app.ts'), false);
  // real operators outside quotes stay gated, including quoted TARGETS
  assert.equal(commandAppearsToWriteFeatureSource('echo hi > "src/x file.ts"'), true);
  assert.equal(commandAppearsToWriteFeatureSource('printf x | tee src/x.ts'), true);
  // a nested shell body is real code — quotes there keep scanning raw
  assert.equal(commandAppearsToWriteFeatureSource("bash -c 'echo hi > src/x.ts'"), true);
  assert.equal(commandAppearsToWriteFeatureSource("sh -lc 'echo x > src/x.ts'"), true);
});

test('bare interpreter reads are not writes; eval writes still are (B5)', () => {
  // read-only inspection commands that previously false-positived
  assert.equal(commandAppearsToWriteFeatureSource(
    'python3 -c "import json;print(sorted(json.load(open(\'apps/web/src/locales/en.json\'))))"'), false);
  assert.equal(commandAppearsToWriteFeatureSource(
    'echo "=== en/common.json ===" && cat packages/i18n/src/locales/en/common.json'), false);
  assert.equal(commandAppearsToWriteFeatureSource('node --version && ls src/'), false);
  assert.equal(commandAppearsToWriteFeatureSource('node -e "console.log(require(\'./src/config.ts\'))"'), false);
  // interpreter eval writes remain gated
  assert.equal(commandAppearsToWriteFeatureSource(
    'python3 -c "open(\'src/x.ts\',\'w\').write(\'x\')"'), true);
  assert.equal(commandAppearsToWriteFeatureSource(
    'node -e "require(\'fs\').writeFileSync(\'src/x.ts\',\'x\')"'), true);
  assert.equal(commandAppearsToWriteFeatureSource(
    'perl -e "open(FH,\'>\',\'src/x.ts\')"'), true);
  // redirected interpreter output still gated via the redirect primitive
  assert.equal(commandAppearsToWriteFeatureSource('python3 gen.py > src/out.ts'), true);
});

// `shellCommandHasWritePrimitive` is the write fence for every shell channel —
// it arms the plan-write target scan, the compiled-feature check, the run-id
// guard and the state-dir carve-out — and until this test it had NO direct
// coverage at all. It was exercised only through the two
// `commandAppearsToWrite*` wrappers above, whose interpreter corpus contained
// just the three spellings the pattern was authored for (`writeFileSync`,
// `open(…,'w')`, `perl open(FH,'>')`). A corpus that shares an author with the
// pattern proves the pattern matches itself, which is why six record-erasing
// spellings sat open: measured through this very export, `unlinkSync`, `rmSync`
// and BOTH spellings of `truncateSync` were invisible, and erasing
// `.traffic-one/runs/.resets.json` that way flipped a model-exhaustion deny into
// an admit.
const RESETS = '.traffic-one/runs/.resets.json';

test('interpreter eval writes are found by the destructive VERB, not the fs handle spelling', () => {
  // Every row below returned FALSE before the verb-callee vocabulary landed.
  // The handle is what varies; the verb is what the rule reads.
  for (const command of [
    `node -e "require('fs').unlinkSync('${RESETS}')"`,
    `node -e "require('fs').rmSync('${RESETS}')"`,
    `node -e "require('fs').truncateSync('${RESETS}',0)"`,
    `node -e "require('node:fs').unlinkSync('${RESETS}')"`,
    `node -e "import('fs').then(m=>m.unlinkSync('${RESETS}'))"`,
    `node -e "const fs=require('fs'); fs.truncateSync('${RESETS}',0)"`,
    // the spellings the next reviewer would have reached for
    `node -e "const {unlinkSync}=require('fs'); unlinkSync('${RESETS}')"`,
    `node -e "globalThis.require('fs').rmSync('${RESETS}')"`,
    `node -e "require('fs').promises.truncate('${RESETS}',0)"`,
    `node -e "import('node:fs/promises').then(m=>m.rm('${RESETS}'))"`,
    `node -e "require('fs').renameSync('${RESETS}','/dev/null')"`,
    `node -e "require('fs').copyFileSync('/dev/null','${RESETS}')"`,
    `node -e "require('fs').symlinkSync('/dev/null','${RESETS}')"`,
    `python3 -c "import pathlib;pathlib.Path('${RESETS}').unlink()"`,
    `python3 -c "import os;os.truncate('${RESETS}',0)"`,
    `perl -e "truncate('${RESETS}',0)"`,
    // an eval body that spawns a process is opaque to every path check here
    `node -e "require('child_process').execSync('rm -f ${RESETS}')"`,
    `python3 -c "import os;os.system('rm -f ${RESETS}')"`,
    // the eval flag need not be space-separated, and an unquoted body reaches
    // the shell with its call parens escaped
    `node -e"require('fs').unlinkSync('${RESETS}')"`,
    `node --eval='require("fs").unlinkSync("${RESETS}")'`,
    String.raw`node -e require\('fs'\).unlinkSync\('` + RESETS + String.raw`'\)`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
});

test('the widened interpreter vocabulary still permits read-only eval bodies', () => {
  // The over-refusal direction. A hook that refuses a read wedges the agent,
  // and every consumer of this predicate moves conservatively when it widens —
  // so this corpus, not the write corpus, is what protects the next widening.
  for (const command of [
    // B5: reads through a real fs handle
    `node -e "console.log(require('fs').readFileSync('src/x.ts','utf8'))"`,
    `node -e "console.log(require('fs').existsSync('${RESETS}'))"`,
    `node -e "console.log(require('fs').readdirSync('.traffic-one/runs'))"`,
    `node -e "console.log(require('fs').statSync('${RESETS}').size)"`,
    'python3 -c "print(open(\'src/x.ts\').read()[:200])"',
    'python3 -c "import os;print(os.path.exists(\'src/x.ts\'))"',
    // in-memory verbs that merely LOOK destructive — the reason `remove`,
    // `replace` and `pop` are not in the bare-verb family
    `node -e "const s=require('fs').readFileSync('a','utf8');console.log(s.replace(/x/g,'y').length)"`,
    'python3 -c "l=[3,1,2];l.remove(1);print(sorted(l))"',
    `node -e "console.log('a'.link('b'))"`,
    // an interpreter read followed by a code SEARCH for a destructive verb: the
    // free-span match this replaces read the trailing `rg`/`grep` as the write
    `node -e "console.log(1)" && rg -n "unlinkSync\\(" src/shared/feature-source.ts`,
    `node -e "console.log(1)" && grep -rn "truncateSync(" src/`,
    'python3 -c "print(1)" && grep -rn "os.remove" src/',
    // …and a foreign `-c`/`-e` flag on a LATER command is not an eval body
    `node --version && grep -c "unlinkSync(" src/shared/feature-source.ts`,
    'python3 --version && grep -c "os.remove" src/x.py',
    // toolchain and smoke probes: read-only bodies with no read-only vocabulary,
    // which is why an allowlist-inversion design was rejected — it refuses these
    'python3 -c "import ruff"',
    'python3 -c "import sys;sys.exit(0)"',
    `node -e "console.error('probe')"`,
    `node -e "require('assert').ok(process.version)"`,
    'perl -e "exit 0"',
  ]) assert.equal(shellCommandHasWritePrimitive(command), false, command);
});

test('interpreter erasures are visible to the pre-write gate as named targets', () => {
  // The product consequence, not just the predicate: `shellTrafficOneWriteTargets`
  // returns [] unless the command has a write primitive, so every fail-open
  // spelling above made the path INVISIBLE to the same gate that judges
  // Write/Edit — the mechanism by which the reset record could be erased with a
  // null verdict while `rm -f` on the same path was refused.
  for (const command of [
    `node -e "require('fs').unlinkSync('${RESETS}')"`,
    `node -e "require('fs').truncateSync('${RESETS}',0)"`,
    `node -e "const {unlinkSync}=require('fs');unlinkSync('${RESETS}')"`,
    `node -e "require('child_process').execSync('rm -f ${RESETS}')"`,
  ]) assert.deepEqual(shellTrafficOneWriteTargets(command), [RESETS], command);
  // A read of the same record names no write target.
  assert.deepEqual(
    shellTrafficOneWriteTargets(`node -e "console.log(require('fs').readFileSync('${RESETS}','utf8'))"`),
    [],
  );
});

test('interpreter spellings this rule cannot see are a documented residue', () => {
  // Stated so no reader mistakes the fence for total. These are NOT a contract
  // to preserve: closing any of them should flip the assertion. What is left is
  // a verb whose NAME does not appear in the command text (assembled at runtime),
  // a BODY that does not appear in it (piped, substituted, base64) — both out of
  // reach of any static command scan, which is a different statement from the one
  // this test used to make — and a body in a language this file does not read.
  // `perl -pi -e` was on this list on the theory that an in-place flag is not a
  // verb "and the sed arm does not chase it either"; the sed arm IS
  // `inPlaceEditFlag`, it always chased sed's, and the row now belongs to the
  // closed set below.
  //
  // The last two rows are the reason ruby/php/deno could be closed as VOCABULARY
  // and these cannot: `File.delete(p)` is the same call syntax the eval-body scan
  // already parses, so it cost one alternation each, while `do shell script "…"`
  // and `%d|x` are other grammars — closing them means a new body reader, not a
  // new verb, and the shipped SKILL.md discloses them as a third residue shape
  // rather than claiming they are covered.
  //
  // ROUND 4 MOVED ONE ROW OUT OF THIS LIST, and the shape of the move is the
  // point. A verb assembled at runtime (`f['un'+'link'+'Sync'](p)`) is
  // unreachable to any vocabulary by construction — there is no verb literal to
  // match. It is now REFUSED anyway when the path it names is Traffic One's,
  // because that judgement stopped asking about the verb: an eval body that
  // spells a `.traffic-one` path anywhere other than a read call is a write, and
  // an assembled verb is not a read call. The residue survives exactly where the
  // anchor does not — see the `src/` row below, which is still permitted and
  // must stay that way, since `shellCommandHasWritePrimitive` has nothing to
  // invert against a path Traffic One does not own.
  for (const command of [
    `node -e "const f=require('fs');f['un'+'link'+'Sync']('src/app.ts')"`,
    `echo "require('fs').unlinkSync('${RESETS}')" | node`,
    `node -e "$(cat wipe.js)"`,
    `osascript -e 'do shell script "rm -f ${RESETS}"'`,
    `ex -sc '%d|x' ${RESETS}`,
    // NOT a residue — measured, not assumed. Traffic One writes `.traffic-one/runs/`
    // into the project's own `.gitignore` (scaffold-content.ts's run-state
    // entries), so this path is never in the index and git refuses the pathspec:
    // `error: pathspec … did not match any file(s) known to git`, exit 1, file
    // intact. `git restore` behaves identically. `git clean -fdx` DOES erase it,
    // which is why that one is a write primitive and this one is not.
    `git checkout -- ${RESETS}`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), false, command);
  // A computed member is caught when the verb literal is SPELLED, whatever
  // punctuation follows it. The earlier claim — "a computed member whose verb
  // LITERAL survives is still caught" — was false as written: it held for
  // `['unlink'+'Sync']` (a word boundary follows the bare verb) and failed for
  // the plainest spelling of all, `['unlinkSync']`, where the closing quote sat
  // between the verb and its call parens.
  for (const command of [
    // The assembled verb, at a path Traffic One owns. No verb literal exists in
    // this command at all; it is refused because the path is not read.
    `node -e "const f=require('fs');f['un'+'link'+'Sync']('${RESETS}')"`,
    `node -e "require('fs')['unlink'+'Sync']('${RESETS}')"`,
    `node -e "require('fs')['unlinkSync']('${RESETS}')"`,
    `node -e "require('fs')[\\\`unlinkSync\\\`]('${RESETS}')"`,
    `node -e "require('fs')[\\"unlinkSync\\"]('${RESETS}')"`,
    `node -e "require('fs').rmSync?.('${RESETS}')"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
});

test('a receiver of stdout/stderr is a print, not a write', () => {
  // The pre-existing over-refusal this round removed. `sys.stdout.write(…)` is
  // `cat` with extra steps; a REDIRECTED stdout is caught by the redirect arm,
  // and every genuine write keeps its own alternative. It stayed pinned for one
  // round because plan-write.test.ts's 3co regression row reached the
  // architecture-input validator through this false positive alone — that row now
  // names a command that genuinely writes, so the two moved together.
  for (const command of [
    'python3 -c "import sys;sys.stdout.write(open(\'src/x.ts\').read())"',
    `node -e "process.stdout.write('hi')"`,
    'python3 -c "import sys;sys.stderr.write(\'x\')"',
    // fd 1 spelled as a number: the same print through a different API
    `node -e "require('fs').writevSync(1,[Buffer.from('hi')])"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), false, command);
  // The write half is untouched, including a redirected print.
  for (const command of [
    `node -e "require('fs').writeFileSync('${RESETS}','')"`,
    `python3 -c "import pathlib;pathlib.Path('${RESETS}').write_text('')"`,
    `node -e "process.stdout.write('x')" > ${RESETS}`,
    `node -e "require('fs').writevSync(require('fs').openSync('${RESETS}','w'),[])"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
});

test('every spelling of "here is the code" reaches the eval body', () => {
  // The flag set used to be a literal alternation of five long-ish spellings,
  // and each row below is a flag a shell accepts that the alternation did not.
  // `node -p` is the expensive one: it evaluates exactly like `-e` and defeated
  // BOTH write detectors, so a `-p` erasure of a runtime-owned sidecar was a
  // noop end to end. Short options BUNDLE, which is why the set is now a
  // character class rather than a list: `python3 -uc` and `perl -pe` are the
  // same request as `-c` and `-e`.
  for (const command of [
    `node -p "require('fs').unlinkSync('${RESETS}')"`,
    `node --print "require('fs').unlinkSync('${RESETS}')"`,
    `python3 -uc "import os;os.unlink('${RESETS}')"`,
    `python3 -Ic "import os;os.unlink('${RESETS}')"`,
    `perl -pe 'BEGIN{unlink "${RESETS}"}' /dev/null`,
    `nodejs -e "require('fs').unlinkSync('${RESETS}')"`,
    `ts-node -e "require('fs').unlinkSync('${RESETS}')"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
  // The same widening must not read an option's ARGUMENT as code. `-MList::Util`
  // matches a naive `-[a-zA-Z]*i`-style test, and `node -p` on a read is the
  // single commonest probe there is.
  for (const command of [
    `perl -MList::Util -e 'print 1'`,
    `perl -MFile::Path -e 'print 1'`,
    `node -p "require('./package.json').version"`,
    `node --print "require('fs').readdirSync('src').length"`,
    `python3 -uc "import sys;print(sys.version)"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), false, command);
});

test('destruction that comes from a MODE argument or an in-place FLAG', () => {
  // The "destructive verb" premise fails wherever the name is innocent and the
  // ARGUMENT does the damage: `openSync(p,'w')` truncates as completely as
  // `unlinkSync`, `fileinput.input(p,inplace=True)` rewrites the file it reads,
  // and `perl -i` is a flag on a command whose verb is a substitution.
  for (const command of [
    `node -e "require('fs').openSync('${RESETS}','w')"`,
    `node -e "require('fs').openSync('${RESETS}','w+')"`,
    `python3 -c "open('${RESETS}','wb').close()"`,
    `ruby -e "File.open('${RESETS}','w').close"`,
    `python3 -c "import fileinput;[print() for l in fileinput.input('${RESETS}',inplace=True)]"`,
    `perl -i -pe 's/.*//' ${RESETS}`,
    `perl -pi -e 's/.*//' ${RESETS}`,
    `perl -i.bak -pe 's/.*//' ${RESETS}`,
    // GNU sed installed beside the system one: `\bsed\b` cannot see `gsed`
    `gsed -i 's/.*//' ${RESETS}`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
  // A read-open is a read, and a perl/sed with no in-place flag is a filter.
  for (const command of [
    `node -e "require('fs').openSync('${RESETS}','r')"`,
    `python3 -c "print(open('${RESETS}').read())"`,
    `ruby -e "File.open('${RESETS}','r').read"`,
    `perl -ne 'print if /x/' ${RESETS}`,
    `sed -n '1,80p' ${RESETS}`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), false, command);
});

test('a destructive verb spelled without parens is still a call', () => {
  // perl's idiom takes no parens, and the vocabulary had this asymmetry INSIDE
  // it: `unlink` had a bare alternative, `truncate` did not, so one of two
  // equally ordinary perl one-liners was refused and the other was a noop.
  for (const command of [
    `perl -e 'truncate "${RESETS}", 0'`,
    `perl -e 'truncate FH, 0'`,
    `perl -e 'rename "${RESETS}", "x"'`,
    `perl -MFile::Path -e 'rmtree "${RESETS}"'`,
    `perl -e "unlink '${RESETS}'"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
  // The bare form needs an argument that opens a path or a filehandle, so the
  // verb as a WORD in prose or in a string stays a read.
  for (const command of [
    `python3 -c "print('truncate the log line')"`,
    `node -e "console.log('rename the file first')"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), false, command);
});

test('a simple command may span lines with a backslash', () => {
  // `[^\n;|&]*?` bounded the interpreter-to-flag span to one LINE, and a
  // backslash-newline between a command and its flag is ordinary multi-line
  // Bash — so the whole eval-body scan could be stepped around with a line
  // break, which is not an evasion technique, it is a formatting habit.
  for (const command of [
    `node \\\n  -e "require('fs').unlinkSync('${RESETS}')"`,
    `python3 \\\n  -c "import os;os.unlink('${RESETS}')"`,
    `node \\\n  --eval \\\n  "require('fs').unlinkSync('${RESETS}')"`,
    `bash \\\n  -c "rm -f ${RESETS}"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
  // A BARE newline still ends the simple command, which is the property that
  // keeps a read followed by a code search from reading as a write.
  for (const command of [
    `node \\\n  -e "console.log(1)"`,
    `node -e "console.log(1)"\nrg "unlinkSync\\(" src/`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), false, command);
});

test('a heredoc read by an interpreter is code, and its target is visible', () => {
  // Two failures in one: `python3 - <<PY … os.unlink(p) … PY` was not a write at
  // all, and `bash <<SH … node -e "…unlinkSync(p)" … SH` was a write with NO
  // target — the write question ran on the raw command and the target scan ran on
  // the heredoc-stripped copy, so the gate had a primitive it could not attach to
  // a path. Both now answer from the same text.
  for (const command of [
    `python3 - <<'PY'\nimport os\nos.unlink('${RESETS}')\nPY`,
    `python3 <<'PY'\nimport pathlib\npathlib.Path('${RESETS}').unlink()\nPY`,
    `bash <<'SH'\nnode -e "require('fs').unlinkSync('${RESETS}')"\nSH`,
    `sh <<'SH'\nrm -f ${RESETS}\nSH`,
    `node --input-type=commonjs <<'JS'\nrequire('fs').unlinkSync('${RESETS}')\nJS`,
  ]) {
    assert.equal(shellCommandHasWritePrimitive(command), true, command);
    assert.deepEqual(shellTrafficOneWriteTargets(command), [RESETS], command);
  }
  // And the reason every body was dropped in the first place still holds: a
  // reviewer digest is DATA even when its findings quote an interpreter heredoc,
  // because the reader on the left is `cat`. The distinction is per-heredoc, not
  // per-command.
  const digest = `cat > .traffic-one/digests/R/reviewer.md <<'EOF'\n`
    + `finding: the record is erased by python3 <<'PY' / os.unlink('${RESETS}') / PY\nEOF`;
  assert.equal(shellWriteTargetsStateDir(digest), true);
  assert.deepEqual(shellTrafficOneWriteTargets(digest), ['.traffic-one/digests/R/reviewer.md']);
});

test('a quote before the verb, an escaped verb, and fish are all still verbs', () => {
  // The nested-shell body puts its opening quote directly against the verb, so a
  // whitespace-only anchor made the most ordinary deletion there is invisible
  // while the same deletion with a no-op in front of it was refused. `\rm` is the
  // idiom for bypassing an `rm -i` alias; `fish` was missing from the shell list,
  // so its body was stripped as data.
  for (const command of [
    `bash -c "rm -f ${RESETS}"`,
    `sh -c 'rm -f ${RESETS}'`,
    `bash -lc "truncate -s 0 ${RESETS}"`,
    `zsh -c 'rm ${RESETS}'`,
    `fish -c 'rm ${RESETS}'`,
    `bash -o pipefail -c "rm -f ${RESETS}"`,
    `bash -c "bash -c 'rm -f ${RESETS}'"`,
    String.raw`\rm -f ` + RESETS,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
  // Reads inside a nested shell stay reads.
  for (const command of [
    `bash -c 'ls -la src/'`,
    `/bin/sh -c 'command -v npm'`,
    `sh -c "cat ${RESETS}"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), false, command);
});

test("other runtimes' file APIs are the same verbs", () => {
  // ruby and php ship with macOS, deno and bun are one `brew install` away, and
  // all four were outside the interpreter alternation — `php -r` and `deno eval`
  // additionally supply no flag the old set recognised.
  for (const command of [
    `ruby -e "File.delete('${RESETS}')"`,
    `ruby -e "File.write('${RESETS}','')"`,
    `php -r "unlink('${RESETS}');"`,
    `php -r "file_put_contents('${RESETS}','');"`,
    `deno eval "Deno.removeSync('${RESETS}')"`,
    `deno eval "Deno.writeTextFileSync('${RESETS}','')"`,
    `bun -e "require('fs').unlinkSync('${RESETS}')"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
  for (const command of [
    `ruby -e "puts File.read('${RESETS}')"`,
    `php -r "echo file_get_contents('${RESETS}');"`,
    `deno eval "console.log(Deno.readTextFileSync('${RESETS}'))"`,
    `bun -e "console.log(1)"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), false, command);
});

test('tools that overwrite a destination they name unusually', () => {
  // `dd` names it with `of=`, `install`/`rsync` with their LAST operand, `tar`
  // with `-C`, and `unlink`/`shred` are coreutils' own single-file erasers. None
  // was in the verb set.
  for (const command of [
    `dd if=/dev/null of=${RESETS}`,
    `install -m 644 /dev/null ${RESETS}`,
    `rsync /dev/null ${RESETS}`,
    `tar -x -C .traffic-one/runs -f payload.tar`,
    `unlink ${RESETS}`,
    `shred -u ${RESETS}`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
  // `install` as an ARGUMENT is every package manager on earth, which is why
  // these tools must be the command rather than merely present. `dd` to
  // /dev/null and `tar -c` write nothing that matters.
  for (const command of [
    'npm install',
    'npm ci',
    'npm install --save-dev vitest',
    'pip install -r requirements.txt',
    'brew install go',
    'go install ./cmd/api',
    'cargo install cargo-nextest',
    'npx playwright install chromium',
    'dd if=bundle.iso of=/dev/null bs=1m',
    'tar -tzf bundle.tgz',
    'tar -czf artifacts.tgz dist/',
  ]) assert.equal(shellCommandHasWritePrimitive(command), false, command);
});

test('the toolchain probe an allowlist-inversion design was rejected for refusing', () => {
  // `\bshutil\b` was the whole arm, so `python3 -c "import shutil;print(
  // shutil.which('go'))"` — a toolchain probe, the exact class the design
  // argument cites against inverting to an allowlist of reads — was refused as a
  // write by the shipped design too. Named members instead; `os.remove` likewise
  // needs its call parens, because `os.rename.__doc__` is a read.
  for (const command of [
    `python3 -c "import shutil;print(shutil.which('go'))"`,
    `python3 -c "import shutil;print(shutil.which('pytest'), shutil.which('ruff'))"`,
    `python3 -c "import os;print(os.rename.__doc__[:20])"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), false, command);
  for (const command of [
    `python3 -c "import shutil;shutil.rmtree('.traffic-one/runs')"`,
    `python3 -c "import shutil;shutil.move('a','${RESETS}')"`,
    `python3 -c "import os;os.remove('${RESETS}')"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
});

test('over-refusals kept deliberately, with the reason recorded', () => {
  // Not a contract to preserve — a contract to DECIDE, each time this vocabulary
  // widens. Both rows are library verbs that share a name with a file verb and
  // are called exactly like one; the discriminator would have to be the
  // RECEIVER, which is the half no static scan can see. Narrowing them by
  // excluding a keyword-argument first parameter was measured and rejected: it
  // would admit `os.replace(src=…, dst=…)`, trading a fail-open for a cosmetic
  // gain. Neither reaches a gate deny today (the run-team deny needs run state
  // these commands have no reason to name).
  for (const command of [
    `node -e "console.log(require('lodash').truncate('a long string',{length:8}))"`,
    `python3 -c "import pandas as pd;print(pd.read_csv('f.csv').rename(columns={'a':'b'}).shape)"`,
  ]) assert.equal(shellCommandHasWritePrimitive(command), true, command);
});

test('shellWriteTargetsStateDir carves out run-state heredocs only', () => {
  // reviewer digest heredoc whose body cites feature paths
  assert.equal(shellWriteTargetsStateDir(
    "mkdir -p .traffic-one/digests/123 && cat > .traffic-one/digests/123/reviewer.md <<'EOF'\n## Touched\n- apps/web/src/features/courses/catalog.tsx\nEOF"), true);
  // orchestrator fix-cycle note
  assert.equal(shellWriteTargetsStateDir(
    "cat > .traffic-one/fix-cycles/123/senior-frontend-fix-1.md <<'EOF'\nfix src/app.ts\nEOF"), true);
  assert.equal(shellWriteTargetsStateDir('echo done >> ./.traffic-one/runs/123/log.txt'), true);
  // feature-source targets are never carved out
  assert.equal(shellWriteTargetsStateDir('cat > apps/web/src/x.ts <<EOF\nx\nEOF'), false);
  // mixed state-dir + feature target -> no carve-out
  assert.equal(shellWriteTargetsStateDir(
    'cat > .traffic-one/digests/123/r.md <<EOF\nx\nEOF\ncat > src/x.ts <<EOF\ny\nEOF'), false);
  // other write primitive classes disable the carve-out entirely
  assert.equal(shellWriteTargetsStateDir(
    'rm apps/web/src/x.ts && cat > .traffic-one/digests/123/r.md <<EOF\nx\nEOF'), false);
  assert.equal(shellWriteTargetsStateDir(
    'ln -s /tmp/payload apps/web/src/linked && cat > .traffic-one/digests/123/r.md <<EOF\nx\nEOF'), false);
  assert.equal(shellWriteTargetsStateDir(
    'sed -i s/a/b/ src/x.ts > .traffic-one/runs/123/log.txt'), false);
  // plan.md is intentionally not carved out
  assert.equal(shellWriteTargetsStateDir('cat > .traffic-one/plan.md <<EOF\nplan\nEOF'), false);
  // no write target at all
  assert.equal(shellWriteTargetsStateDir('cat .traffic-one/digests/123/reviewer.md'), false);
  assert.equal(shellWriteTargetsStateDir(''), false);
  assert.equal(shellWriteTargetsStateDir(undefined), false);
});

test('shellTrafficOneWriteTargets extracts real state targets but ignores heredoc prose', () => {
  assert.deepEqual(shellTrafficOneWriteTargets(
    "cat > .traffic-one/runs/R/architecture-v1.json <<'EOF'\n"
    + 'Mention .traffic-one/runs/R/claims.json only as prose.\nEOF',
  ), ['.traffic-one/runs/R/architecture-v1.json']);
  assert.deepEqual(shellTrafficOneWriteTargets(
    'python3 -c "open(\'.traffic-one/reports/qa/R/report-v2.json\',\'w\').write(\'{}\')"',
  ), ['.traffic-one/reports/qa/R/report-v2.json']);
  assert.deepEqual(shellTrafficOneWriteTargets(
    'cat .traffic-one/runs/R/architecture-v1.json',
  ), []);
});

test('sed -i detection anchors on sed option tokens, not any later "-i" text', () => {
  // the live 8c-codex tester denials: pure read chains where "-i" only appears
  // inside the filename `known-issues.md`
  assert.equal(commandAppearsToWriteBuildArtifact(
    "sed -n '1,240p' package.json && sed -n '1,240p' apps/web/package.json && sed -n '1,220p' vitest.config.ts"
    + " && sed -n '1,220p' playwright.config.ts && sed -n '1,180p' .traffic-one/.one.json && sed -n '1,180p' .traffic-one/known-issues.md",
  ), false);
  assert.equal(commandAppearsToWriteFeatureSource(
    "sed -n '1,50p' apps/web/src/App.tsx && sed -n '1,20p' .traffic-one/known-issues.md",
  ), false);
  // stdout-only sed whose SCRIPT merely contains "-i" stays a read
  assert.equal(commandAppearsToWriteFeatureSource("sed -e 's/-i/x/' src/a.ts"), false);
  // real in-place flag spellings stay writes
  assert.equal(commandAppearsToWriteFeatureSource("sed -i.bak 's/a/b/' src/x.ts"), true);
  assert.equal(commandAppearsToWriteFeatureSource("sed --in-place 's/a/b/' src/x.ts"), true);
  assert.equal(commandAppearsToWriteFeatureSource("sed -ni 's/a/b/p' src/x.ts"), true);
});

test('digests heredoc carve-out ignores write-primitive lookalikes inside the body', () => {
  // the live 8c-codex reviewer digest: body cites `sed -i`, `rm`, touch targets…
  const digestHeredoc = [
    'mkdir -p .traffic-one/digests/123',
    "cat > .traffic-one/digests/123/reviewer.md <<'EOF'",
    '# reviewer digest — run 123',
    '',
    'verdict: CHANGES_REQUESTED',
    '1. `apps/web/src/App.tsx` — replace the `sed -i` hack and the `rm -rf` cleanup step.',
    '2. touch targets under 44px on mobile.',
    'EOF',
  ].join('\n');
  assert.equal(shellWriteTargetsStateDir(digestHeredoc), true);
  // a redirect inside the body is quoted data, not a second write target
  assert.equal(shellWriteTargetsStateDir(
    "cat > .traffic-one/digests/123/tester.md <<'EOF'\nReproduce with: pnpm lint > lint.log\nEOF"), true);
  // real write primitives OUTSIDE the body still disable the carve-out
  assert.equal(shellWriteTargetsStateDir(`${digestHeredoc}\nrm -rf apps/web/src`), false);
});

test('shellAssetImportDest accepts only single outside→inside cp/mv imports', () => {
  const root = '/proj';
  const wd = '/proj';
  // the observed 10c shape: generated raster into an owned public path
  assert.equal(
    shellAssetImportDest('cp /Users/u/.codex/generated_images/s1/exec-abc.png apps/web/public/og-default.png', wd, root),
    'apps/web/public/og-default.png',
  );
  assert.equal(shellAssetImportDest('mv -f /outside/a.png public/a.png', wd, root), 'public/a.png');
  assert.equal(shellAssetImportDest("cp '/outside/with space.png' apps/web/public/a.png", wd, root), 'apps/web/public/a.png');
  assert.equal(shellAssetImportDest('cp /outside/a.png /proj/apps/web/public/a.png', wd, root), 'apps/web/public/a.png');
  // subdir workdir resolves the relative dest correctly
  assert.equal(shellAssetImportDest('cp /outside/a.png public/a.png', '/proj/apps/web', root), 'apps/web/public/a.png');
  // A QUOTED PROJECT ROOT IS STILL AN IN-REPO SOURCE. The tokenizer ends a
  // token at the closing quote, so `"/proj"/src/a.ts` arrives as the two
  // sources `/proj` and `/src/a.ts` — and `/proj`, the root itself, used to
  // answer "outside the project" and buy this destructive in-repo `mv` a
  // read-only-import carve-out that judges only the DEST. Measured at the gate:
  // `mv "<root>"/apps/web/src/pages/Home.tsx dist/b.ts` was granted (noop)
  // where the unquoted spelling denied.
  assert.equal(shellAssetImportDest('mv "/proj"/src/a.ts dist/b.ts', wd, root), null);
  assert.equal(shellAssetImportDest('cp "/proj"/src/a.ts public/b.ts', wd, root), null);
  // and the same hole without any quoting: the whole project root as the source
  assert.equal(shellAssetImportDest('mv /proj public/x', wd, root), null);
  // rejections: in-repo source, relative source, dest outside, dot-dirs, compounds, globs, redirects
  assert.equal(shellAssetImportDest('cp /proj/public/a.png public/b.png', wd, root), null);
  assert.equal(shellAssetImportDest('cp local.png public/a.png', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/a.png /elsewhere/a.png', wd, root), null);
  // the root is a member of its own project but is not a file dest either
  assert.equal(shellAssetImportDest('cp /outside/a.png /proj', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/a.png .traffic-one/a.png', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/a.png public/a.png && rm -rf src', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/*.png public/', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/a.png public/a.png > log.txt', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/../etc/passwd public/a.png', wd, root), null);
  assert.equal(shellAssetImportDest('scp /outside/a.png public/a.png', wd, root), null);
  assert.equal(shellAssetImportDest('cp public/a.png', wd, root), null);
  assert.equal(shellAssetImportDest('', wd, root), null);
  assert.equal(shellAssetImportDest(undefined, wd, root), null);
});

test('shellStrayDeleteTarget accepts only an exact single-file rm inside the project', () => {
  const root = '/proj';
  const wd = '/proj';
  // The observed 6co shape: a stray raster the frontend produced beside its
  // owned icons, which neither the child nor the parent could remove.
  assert.equal(
    shellStrayDeleteTarget('rm apps/web/public/icons/favicon.svg.png', wd, root),
    'apps/web/public/icons/favicon.svg.png',
  );
  assert.equal(shellStrayDeleteTarget('rm -f public/stray.png', wd, root), 'public/stray.png');
  assert.equal(shellStrayDeleteTarget('rm -- public/stray.png', wd, root), 'public/stray.png');
  assert.equal(shellStrayDeleteTarget("rm 'public/with space.png'", wd, root), 'public/with space.png');
  assert.equal(shellStrayDeleteTarget('rm /proj/public/stray.png', wd, root), 'public/stray.png');
  // subdir workdir resolves the relative operand correctly
  assert.equal(shellStrayDeleteTarget('rm public/stray.png', '/proj/apps/web', root), 'apps/web/public/stray.png');

  // Rejections: recursion, globs, multiple operands, escapes, dot-dirs,
  // compounds, redirects, other commands.
  assert.equal(shellStrayDeleteTarget('rm -rf public/icons', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm -r public/icons', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm -R public/icons', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm --recursive public/icons', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm public/*.png', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm public/a.png public/b.png', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm ../outside.png', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm /elsewhere/a.png', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm .traffic-one/runs/x.json', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm .git/index', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm public/a.png && rm -rf src', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm public/a.png > log.txt', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm $(cat list.txt)', wd, root), null);
  assert.equal(shellStrayDeleteTarget('rm', wd, root), null);
  assert.equal(shellStrayDeleteTarget('unlink public/a.png', wd, root), null);
  assert.equal(shellStrayDeleteTarget('', wd, root), null);
  assert.equal(shellStrayDeleteTarget(undefined, wd, root), null);
});

test('isTestScopePath classifies test files and conventional test dirs', () => {
  assert.equal(isTestScopePath('apps/web/src/services/courses.test.ts'), true);
  assert.equal(isTestScopePath('src/components/Button.spec.tsx'), true);
  assert.equal(isTestScopePath('packages/ui/src/__tests__/btn.ts'), true);
  assert.equal(isTestScopePath('tests/i18n-integration.test.ts'), true);
  assert.equal(isTestScopePath('e2e/checkout.ts'), true);
  assert.equal(isTestScopePath('src/test/java/FooTest.java'), true);
  assert.equal(isTestScopePath('./tests/setup.ts'), true);
  assert.equal(isTestScopePath('apps/web/src/services/courses.ts'), false);
  assert.equal(isTestScopePath('src/latest/x.ts'), false);
  assert.equal(isTestScopePath('src/test-utils/render.tsx'), false);
  assert.equal(isTestScopePath(''), false);
  assert.equal(isTestScopePath(undefined), false);
  // Go side-by-side tests (13c: tester denied on a backend-owned _test.go)
  assert.equal(isTestScopePath('services/api/internal/middleware/middleware_test.go'), true);
  assert.equal(isTestScopePath('cmd/server/main.go'), false);
  assert.equal(isTestScopePath('internal/contest.go'), false); // no underscore — not a test
  // pytest side-by-side conventions
  assert.equal(isTestScopePath('app/models/test_user.py'), true);
  assert.equal(isTestScopePath('app/models/user_test.py'), true);
  assert.equal(isTestScopePath('app/models/latest.py'), false);
  assert.equal(isTestScopePath('app/models/protest.py'), false);
});

test('isTestInfraConfigPath classifies test-runner configs, not app bundler configs', () => {
  // the observed 8c/11c/12c tester denials
  assert.equal(isTestInfraConfigPath('apps/web/jest.config.js'), true);
  assert.equal(isTestInfraConfigPath('playwright.config.ts'), true);
  assert.equal(isTestInfraConfigPath('vitest.setup.ts'), true);
  // flavours
  assert.equal(isTestInfraConfigPath('vitest.config.mts'), true);
  assert.equal(isTestInfraConfigPath('vitest.workspace.ts'), true);
  assert.equal(isTestInfraConfigPath('cypress.config.cjs'), true);
  assert.equal(isTestInfraConfigPath('./jest.setup.js'), true);
  // app configs stay implementer-owned
  assert.equal(isTestInfraConfigPath('next.config.js'), false);
  assert.equal(isTestInfraConfigPath('vite.config.ts'), false);
  assert.equal(isTestInfraConfigPath('tailwind.config.ts'), false);
  // near-misses
  assert.equal(isTestInfraConfigPath('src/vitest.config.helper.ts'), false);
  assert.equal(isTestInfraConfigPath('myvitest.config.ts'), false);
  assert.equal(isTestInfraConfigPath(''), false);
  assert.equal(isTestInfraConfigPath(undefined), false);
});

test('applyPatchTargetPaths extracts Add/Update/Delete/Move targets, normalized', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: ./apps/web/src/new.ts',
    '+const x = 1;',
    '*** Update File: packages\\ui\\src\\btn.tsx',
    '@@',
    '-old',
    '+new',
    '*** Update File: src/move-source.ts',
    '*** Move to: src/moved.ts',
    '*** Delete File: src/old.ts',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(applyPatchTargetPaths(patch), [
    'apps/web/src/new.ts',
    'packages/ui/src/btn.tsx',
    'src/move-source.ts',
    'src/moved.ts',
    'src/old.ts',
  ]);
  assert.deepEqual(applyPatchTargetPaths(''), []);
  assert.deepEqual(applyPatchTargetPaths(undefined), []);
});
