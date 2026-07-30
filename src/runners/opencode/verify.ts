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
    const line = collapsedLineNumber(rel, text);
    if (line !== null) {
      return `${rel}:${line} packs an entire function/component onto one line`;
    }
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
 * Module-size gate for delegated output, mirroring the write-time
 * `STRUCT_MODULE_LOC` limit.
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
      return `${rel} is approximately ${loc} logical lines, over the ${BLOCKING_MODULE_LOC} limit the structural write gate enforces — the owning role would be unable to edit it`;
    }
  }
  return null;
}
