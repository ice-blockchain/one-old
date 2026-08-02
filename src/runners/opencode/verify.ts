// src/runners/opencode/verify.ts
// Post-apply verification: nearest package/tsconfig resolution, bounded
// typecheck, and the collapsed-source quality check.

import * as fs from 'fs';
import * as path from 'path';
import {
  BLOCKING_MODULE_LOC,
  collapsedLineNumber,
  isCollapseCandidate,
  lexicalMask,
  logicalLoc,
} from '../../shared/collapsed-source';
import {
  tailwindPinnedByContract,
  tailwindToolchainPresent,
  tailwindUtilityEvidence,
} from '../../shared/tailwind-evidence';
import {
  capabilityProfileForProject,
} from '../../shared/capabilities';
import {
  readCompiledArchitecture,
  uiAstLintLayer,
} from '../../shared/architecture-contract';
import {
  analyzeI18nSourceText,
  detectExistingI18nContract,
  projectDeclaresI18nRuntime,
  validateI18nCatalogs,
  type I18nReference,
} from '../../shared/i18n-enforcement';
import { seedI18nCatalogKeys } from '../../shared/i18n-seed';
import {
  formatFileWithPrettier,
  resolveProjectPrettier,
} from '../../shared/prettier-fix';
import {
  normalizeOpenCodeRole,
} from '../../shared/opencode-queue';
import { spawnTool } from '../../shared/spawn-tool';
import {  readEffectiveState } from '../../shared/state';

import {
  type Rec,
} from './types';
import {
  git,
} from './git-sandbox';

type VerifyCommand = {
  label: string;
  command: string;
  args: string[];
  cwd: string;
};

function readJsonObject(file: string): Rec | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Rec : null;
  } catch {
    return null;
  }
}

function parseCommandLine(value: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of value.trim()) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    if (';&|<>'.includes(ch)) return [];
    cur += ch;
  }
  if (escaped || quote) return [];
  if (cur) tokens.push(cur);
  return tokens;
}

function rootPackageManager(cwd: string): string {
  const pkg = readJsonObject(path.join(cwd, 'package.json'));
  const raw = typeof pkg?.packageManager === 'string' ? pkg.packageManager : '';
  const pm = raw.split('@')[0];
  return pm === 'pnpm' || pm === 'yarn' || pm === 'bun' || pm === 'npm' ? pm : 'npm';
}

function scriptArgs(pm: string, script: string): string[] {
  if (pm === 'npm') return ['run', script];
  if (pm === 'bun') return ['run', script];
  return [script];
}

function packageScriptCommand(cwd: string, packageDir: string, pkg: Rec, pm: string): VerifyCommand | null {
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts as Rec : null;
  if (typeof scripts?.typecheck !== 'string') return null;
  const name = typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : '';
  if (pm === 'pnpm' && name && packageDir !== cwd) {
    return {
      label: `pnpm --filter ${name} typecheck`,
      command: 'pnpm',
      args: ['--filter', name, 'typecheck'],
      cwd,
    };
  }
  return {
    label: `${pm} ${scriptArgs(pm, 'typecheck').join(' ')}${packageDir === cwd ? '' : ` (${path.relative(cwd, packageDir)})`}`,
    command: pm,
    args: scriptArgs(pm, 'typecheck'),
    cwd: packageDir,
  };
}

function findNearestPackageDirs(cwd: string, touched: string[]): string[] {
  const root = path.resolve(cwd);
  const dirs: string[] = [];
  for (const rel of touched) {
    let dir = path.dirname(path.resolve(cwd, rel));
    while (dir.startsWith(root)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        if (!dirs.includes(dir)) dirs.push(dir);
        break;
      }
      if (dir === root) break;
      dir = path.dirname(dir);
    }
  }
  return dirs;
}

function findNearestTsconfigFiles(cwd: string, touched: string[]): string[] {
  const root = path.resolve(cwd);
  const files: string[] = [];
  for (const rel of touched) {
    let dir = path.dirname(path.resolve(cwd, rel));
    while (dir.startsWith(root)) {
      const typecheck = path.join(dir, 'tsconfig.typecheck.json');
      const standard = path.join(dir, 'tsconfig.json');
      const file = fs.existsSync(typecheck) ? typecheck : (fs.existsSync(standard) ? standard : '');
      if (file) {
        if (!files.includes(file)) files.push(file);
        break;
      }
      if (dir === root) break;
      dir = path.dirname(dir);
    }
  }
  return files;
}

function verificationCommands(cwd: string, tsTouched: string[]): VerifyCommand[] {
  const commands: VerifyCommand[] = [];
  const state = readEffectiveState(cwd) as Rec;
  const openCode = state.openCode && typeof state.openCode === 'object' ? state.openCode as Rec : null;
  const configured = typeof openCode?.verifyCommand === 'string' ? openCode.verifyCommand.trim() : '';
  if (configured) {
    const argv = parseCommandLine(configured);
    if (argv.length > 0) {
      commands.push({ label: 'openCode.verifyCommand', command: argv[0] as string, args: argv.slice(1), cwd });
    }
  }

  const pm = rootPackageManager(cwd);
  for (const dir of findNearestPackageDirs(cwd, tsTouched)) {
    const pkg = readJsonObject(path.join(dir, 'package.json'));
    if (!pkg) continue;
    const command = packageScriptCommand(cwd, dir, pkg, pm);
    if (command) commands.push(command);
  }

  const rootPkg = readJsonObject(path.join(cwd, 'package.json'));
  const rootCommand = rootPkg ? packageScriptCommand(cwd, cwd, rootPkg, pm) : null;
  if (rootCommand && !commands.some((c) => c.label === rootCommand.label && c.cwd === rootCommand.cwd)) {
    commands.push(rootCommand);
  }

  const tsc = path.join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (fs.existsSync(tsc)) {
    for (const config of findNearestTsconfigFiles(cwd, tsTouched).slice(0, 3)) {
      commands.push({
        label: `tsc -p ${path.relative(cwd, config) || '.'}`,
        command: tsc,
        args: ['--noEmit', '-p', config],
        cwd,
      });
    }
  }

  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = `${command.cwd}\0${command.command}\0${command.args.join('\0')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function outputMentionsTouched(out: string, cwd: string, tsTouched: string[]): boolean {
  const normalized = out.replace(/\\/g, '/');
  return tsTouched.some((f) => {
    const rel = f.replace(/\\/g, '/');
    const abs = path.resolve(cwd, f).replace(/\\/g, '/');
    return normalized.includes(rel) || normalized.includes(abs) || normalized.includes(path.basename(f));
  });
}

// Best-effort post-apply verification: a delegated diff that APPLIED but broke
// the build is worse than a declined unit (the paid roles inherit silent
// breakage). Prefer the project's own verification contract: configured
// `openCode.verifyCommand`, nearest package/root `typecheck` scripts, then a
// tsconfig fallback. Pre-existing breakage elsewhere, missing tooling, and
// verifier crashes/timeouts all SKIP verification; absence of verification is
// the status quo, never a reason to reject good work. Exported for tests.
export function postApplyTypecheck(cwd: string, touched: string[]): string | null {
  const tsTouched = touched.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !/\.d\.ts$/.test(f));
  if (tsTouched.length === 0) return null;
  for (const command of verificationCommands(cwd, tsTouched)) {
    const r = spawnTool(command.command, command.args, { cwd: command.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    if (r.status === 0) return null;
    if (r.error || r.status === null) continue;
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (!outputMentionsTouched(out, cwd, tsTouched)) continue; // pre-existing breakage elsewhere — not this unit's fault
    const firstLines = out.trim().split('\n').filter(Boolean).slice(0, 4).join(' | ').slice(0, 400);
    return `${command.label}: ${firstLines}`;
  }
  return null;
}

/**
 * Quality twin of postApplyTypecheck: reject a delegated unit whose landed
 * source is collapsed onto one line. OpenCode writes by applying a git diff, so
 * its output never passes through the structural write gate — observed 7co, the
 * free model returned a `CourseCard.tsx` packing four JSX elements per line,
 * `DELEGATED_OK` was recorded, and the paid frontend then integrated against it.
 * Typecheck alone cannot see this (collapsed code compiles), and the owning
 * role's completion gate only runs much later, at its digest.
 *
 * Returns an error string so the caller rolls the apply back exactly the way a
 * failed typecheck does and falls back to the paid implementer with a clean tree.
 */
export function postApplyQuality(cwd: string, touched: string[]): string | null {
  for (const rel of touched) {
    if (!isCollapseCandidate(rel)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      continue; // deleted or unreadable — not this check's concern
    }
    let line = collapsedLineNumber(rel, text);
    if (line === null) continue;
    // Deterministic auto-fix before the rollback: the diff has already been
    // applied, so when the project's own prettier is reachable from this
    // file's package scope, format the landed file in place and re-scan.
    // Rollback remains for files no formatter can reach (pre-install) or fix.
    const bin = resolveProjectPrettier(cwd, rel);
    if (bin && formatFileWithPrettier(bin, cwd, rel)) {
      try {
        text = fs.readFileSync(path.join(cwd, rel), 'utf8');
        line = collapsedLineNumber(rel, text);
      } catch {
        continue;
      }
      if (line === null) continue;
    }
    return `${rel}:${line} packs an entire function/component onto one line`;
  }
  return null;
}

/**
 * Styling-system gate for delegated output: Tailwind utility classes in a
 * project with no reachable `tailwindcss` dependency or config are inert —
 * the component compiles, typechecks, and renders as unstyled text. Observed
 * 8co: a free model produced CourseCard/LessonOutline styled entirely with
 * Tailwind utilities in a plain-CSS project; DELEGATED_OK was recorded and
 * the breakage only surfaced in QA screenshots. Same rollback contract as
 * postApplyQuality: an error string reverts the apply and the unit falls
 * back to the paid implementer.
 */
export function postApplyStyling(cwd: string, touched: string[], runId = ''): string | null {
  // Contract before tree: when the run's pinned stack scaffolds a Tailwind home,
  // Tailwind IS the project's styling system even before the manifest lands, and
  // a Step-0 unit could never make it land. Only projects with no pinned Tailwind
  // are judged by what is reachable on disk.
  if (tailwindPinnedByContract(cwd, runId)) return null;
  for (const rel of touched) {
    if (!/\.(?:tsx|jsx|vue|svelte)$/i.test(rel)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      continue; // deleted or unreadable — not this check's concern
    }
    const utilities = tailwindUtilityEvidence(text);
    if (utilities.count >= 3 && !tailwindToolchainPresent(cwd, rel)) {
      return `${rel} styles with ${utilities.count} distinct Tailwind utilities (${utilities.sample.join(', ')}) but the project has no tailwindcss dependency or config — the classes are inert`;
    }
  }
  return null;
}

/**
 * Reject delegated UI that bypasses the same i18n contract enforced at normal
 * write/completion gates. This runs after the atomic apply so source and every
 * auto-added locale catalog can be judged together; the caller restores all
 * targets on any finding.
 */
export function postApplyI18n(
  cwd: string,
  touched: string[],
  runId = '',
  role = 'frontend',
): string | null {
  if (normalizeOpenCodeRole(role) !== 'frontend') return null;
  const contract = runId ? readCompiledArchitecture(cwd, runId) : null;
  if (!contract?.i18n && !projectDeclaresI18nRuntime(cwd, contract || undefined)) return null;
  const profile = contract?.profile || capabilityProfileForProject(cwd, readEffectiveState(cwd));
  const i18n = contract?.i18n || detectExistingI18nContract(cwd);
  const references: I18nReference[] = [];
  const findings = [];
  for (const rel of touched) {
    if (!/\.(?:tsx?|jsx?|vue|svelte|astro|html|blade\.php|swift|kt|dart)$/i.test(rel)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      continue;
    }
    const source = analyzeI18nSourceText(rel, text, profile, i18n);
    references.push(...source.references);
    // Same demotion as the write/completion gates: where the compiled eslint
    // config carries a real AST i18n rule (React-family, Vue), lexical copy
    // findings advise instead of triggering the apply rollback — the project's
    // own `lint` run owns that verdict. Catalog findings always block.
    findings.push(...source.findings.filter((finding) => (
      !uiAstLintLayer(profile)
      || (finding.id !== 'STRUCT_HARDCODED_COPY' && finding.id !== 'STRUCT_I18N_REACT_TRANS')
    )));
  }
  // Deterministic catalog seeding, mirroring the write gate: a missing key
  // that a `<Trans ns i18nKey>fallback</Trans>` in this delegated diff
  // references is auto-fixed from its own fallback before validation. When
  // findings remain anyway, the seeds are restored so the rollback leaves the
  // tree exactly as the failed apply's own rollback expects it.
  const seeded = i18n && references.some((reference) => reference.fallback)
    ? seedI18nCatalogKeys(cwd, i18n, references)
    : null;
  if (i18n) {
    const namespaces = new Set(references.map((reference) => reference.namespace));
    for (const catalog of i18n.catalogs) {
      if (touched.includes(catalog.path)) {
        for (const namespace of catalog.namespaces) namespaces.add(namespace);
      }
    }
    if (namespaces.size > 0) {
      findings.push(...validateI18nCatalogs(cwd, i18n, {
        references,
        namespaces: [...namespaces],
        requireAllCatalogs: true,
      }));
    }
  } else {
    findings.push({
      id: 'STRUCT_I18N_CATALOG' as const,
      file: '<catalog>',
      message: 'i18n runtime is present but no existing catalog contract can be detected safely.',
    });
  }
  if (findings.length === 0) return null;
  seeded?.restore();
  return findings.slice(0, 4).map((finding) => (
    `${finding.file}${finding.line ? `:${finding.line}` : ''} ${finding.id}: ${finding.message}`
  )).join(' | ');
}

/**
 * Module-size gate for delegated output, sharing `BLOCKING_MODULE_LOC` with the
 * compiled eslint `max-lines` rule that owns module size in the project itself.
 * (`STRUCT_MODULE_LOC` is retired — it has no emit site; the budget moved into
 * the scaffolded lint layer. This gate is the DELEGATION-side enforcement of
 * the same number, because a delegated diff lands before any lint run.)
 *
 * Without it the two paths applied opposite standards to the same file: Step-0
 * had NO size rule, so it accepted a 1233-logical-line module, and the write gate
 * then refused every edit to it — leaving the owning role holding a file it could
 * not legally touch. Observed 9co, where the role worked around the deadlock by
 * disabling `noUncheckedIndexedAccess` for the whole monorepo.
 */
export function postApplySize(cwd: string, touched: string[]): string | null {
  for (const rel of touched) {
    if (!isCollapseCandidate(rel)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      continue;
    }
    const loc = logicalLoc(lexicalMask(text, true));
    if (loc > BLOCKING_MODULE_LOC) {
      // The authority named here is THIS gate, unconditionally true. Claiming
      // the project's lint enforces it was false whenever the scaffolded
      // max-lines rule had been deleted (16co) or never existed (a pre-existing
      // project) — a deny whose justification the reader can disprove teaches
      // them to argue with the gate instead of fixing the file.
      return `${rel} is approximately ${loc} logical lines, over the ${BLOCKING_MODULE_LOC} limit this delegation gate enforces (the same budget the scaffolded eslint max-lines rule carries). Split it across the unit's other allowed files, or narrow the content to fit`;
    }
  }
  return null;
}
