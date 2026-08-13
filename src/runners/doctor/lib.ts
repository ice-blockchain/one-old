// src/runners/doctor/lib.ts
// Helpers for the traffic-one doctor (compiles into scripts/doctor.cjs).
// Ported 1:1 from scripts/doctor/_helpers.cjs. Pure reads + parsing only —
// doctor never writes to the project, never installs, never mutates state.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { STACK_IDS } from '../../config/stacks';
import { exec } from '../../shared/exec';
import { teamModeForLevel } from '../../shared/performance';
import {
  codeGraphProviderFromValue,
  hasValidPerformanceState,
  hasValidProjectContext,
  hasValidTeamState,
  isNewProjectMode,
  isTeamApproved,
  normalizeState,
} from '../../shared/state';
import { platformPathContains, resolvePlatformPath } from './path-identity';
import { openRegularFd, readRegularFileOrThrow } from '../../shared/bounded-read';

type Rec = Record<string, unknown>;
export const which = exec.which;

export function safeRead(filePath: string): string | null {
  try { return readRegularFileOrThrow(filePath); } catch { return null; }
}

export function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

export function safeJsonParse(text: string, fallback: Rec | null = null): Rec | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Rec) : fallback;
  } catch {
    return fallback;
  }
}

export interface DoctorArgs {
  session: string | null;
  /** `--run <id>`: diagnose one run (live agents, claims, ledger, top denies). */
  run: string | null;
  /** `--bundle`: emit a state-only bug report instead of the plain report. */
  bundle: boolean;
  /**
   * `--unblock <gateId>`: mint an operator override for that gate. The ONLY
   * write doctor can perform, it happens outside the project tree, and it is
   * DELIBERATELY absent from the gate-exemption argv grammar in
   * shared/tool-classify.ts — an agent's tool call carrying this flag is not
   * exempt from any gate, and the mint itself refuses a non-interactive stdin.
   * See runners/doctor/unblock.ts.
   */
  unblock: string | null;
  /** `--ttl 30m`: the override window. Parsed by shared/override (which owns
   *  the default and the ceiling); meaningless without `--unblock`. */
  ttl: string | null;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): DoctorArgs {
  const out: DoctorArgs = { session: null, run: null, bundle: false, unblock: null, ttl: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--session' && argv[index + 1]) {
      out.session = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--run' && argv[index + 1]) {
      out.run = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--unblock' && argv[index + 1]) {
      out.unblock = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--ttl' && argv[index + 1]) {
      out.ttl = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--bundle') {
      out.bundle = true;
    }
  }
  return out;
}

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const userHome = env.HOME || env.USERPROFILE || '';
  const codexHome = env.CODEX_HOME || (userHome ? path.join(userHome, '.codex') : '');
  return codexHome ? path.join(codexHome, 'config.toml') : null;
}

export function parseTomlScalar(value: unknown): boolean | string {
  const trimmed = String(value || '').trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const quoted = trimmed.match(/^"((?:\\"|[^"])*)"$/);
  if (quoted && quoted[1] !== undefined) return quoted[1].replace(/\\"/g, '"');
  return trimmed;
}

export function parseCodexConfigToml(text: unknown): Record<string, Rec> {
  const sections: Record<string, Rec> = {};
  let current = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch && sectionMatch[1] !== undefined) {
      current = sectionMatch[1];
      sections[current] = sections[current] || {};
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.+)$/);
    if (!keyMatch || keyMatch[1] === undefined || keyMatch[2] === undefined || !current) continue;
    const key = keyMatch[1].replace(/^"|"$/g, '');
    const section = sections[current] || (sections[current] = {});
    section[key] = parseTomlScalar(keyMatch[2]);
  }
  return sections;
}

export function trustedProjectForCwd(cwd: string, sections: Record<string, Rec>): string | null {
  let best: string | null = null;
  for (const [section, values] of Object.entries(sections || {})) {
    const match = section.match(/^projects\."(.+)"$/);
    if (!match || match[1] === undefined) continue;
    if (!values || values.trust_level !== 'trusted') continue;
    const projectRoot = resolvePlatformPath(match[1]);
    const covered = platformPathContains(projectRoot, cwd);
    if (!covered) continue;
    if (!best || projectRoot.length > best.length) best = projectRoot;
  }
  return best;
}

export function codexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, '.codex') : path.join(os.homedir(), '.codex'));
  return path.join(codexHome, 'sessions');
}

export function walkJsonlFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(fullPath);
    }
  }
  return out;
}

export function readFirstJsonlObject(filePath: string): Rec | null {
  let text = '';
  try {
    const fd = openRegularFd(filePath);
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytes).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return safeJsonParse(line, null);
}

export function sessionIdFromFile(filePath: string): string {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match && match[1] !== undefined
    ? match[1]
    : path.basename(filePath).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
}

export function getPayloadText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Rec;
  const pick = (v: unknown): string | undefined => {
    const obj = v && typeof v === 'object' ? (v as Rec) : null;
    return obj && typeof obj.text === 'string' ? obj.text : undefined;
  };
  return [pick(p.base_instructions), pick(p.instructions), pick(p.user_instructions)]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

export function commandLooksMutating(name: string, rawArgs: unknown): boolean {
  if (name === 'apply_patch') return true;
  if (name === 'request_plugin_install' || name === 'automation_update') return true;
  const rawText = typeof rawArgs === 'string' ? rawArgs : String(rawArgs || '');
  // Codex Desktop records the public orchestration wrapper as a custom `exec`
  // call. Inspect only actual nested tool invocations, never arbitrary text in
  // function outputs, so current transcripts retain the same diagnostics as
  // older direct `exec_command` / `apply_patch` envelopes.
  if (name === 'exec') {
    if (/\btools\.(?:apply_patch|request_plugin_install|automation_update)\s*\(/.test(rawText)) return true;
    if (!/\btools\.exec_command\s*\(/.test(rawText)) return false;
  } else if (name !== 'exec_command') {
    return false;
  }
  const args = name === 'exec_command' ? (safeJsonParse(rawText, {}) ?? {}) : {};
  const command = typeof args.cmd === 'string' ? args.cmd : rawText;
  return /\b(apply_patch|npm\s+install|pnpm\s+(install|add|approve-builds|rebuild)|yarn\s+(install|add)|bun\s+(install|add)|npx\s+create-|mkdir\b|touch\b|rm\b|mv\b|cp\b|rsync\b|git\s+(init|checkout|reset|clean)|tee\b|cat\s*>|>\s*[^&])/.test(command);
}

export function normalizedProjectState(project: Rec): Rec | null {
  if (project.normalizedState && typeof project.normalizedState === 'object') {
    return project.normalizedState as Rec;
  }
  if (!project.state || typeof project.state !== 'object') return null;
  const cloned = JSON.parse(JSON.stringify(project.state)) as Rec;
  normalizeState(cloned, (typeof cloned.mode === 'string' && cloned.mode)
    || (typeof cloned.projectMode === 'string' && cloned.projectMode)
    || 'new-project');
  return cloned;
}

export function rawStateHasLegacyShape(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  const s = state as Rec;
  return Boolean(
    Object.prototype.hasOwnProperty.call(s, 'projectMode')
    || Object.prototype.hasOwnProperty.call(s, 'subagentTeam')
    || Object.prototype.hasOwnProperty.call(s, 'codeGraph')
    || (s.stack && typeof s.stack === 'object' && !Array.isArray(s.stack)),
  );
}

export function onboardingStateIssues(rawState: Rec | null, state: Rec | null): string[] {
  const issues: string[] = [];
  if (!state || typeof state !== 'object') return ['state file is not a JSON object'];
  const mode = state.mode || rawState?.projectMode;
  // WHETHER these checks apply, asked through the predicate every other consumer
  // of the mode asks (state/lifecycle.ts): a hand-edited ` New-Project ` is a
  // scaffolded project to the gates, to materialization and to skill filtering,
  // and it must not be a project this report declines to inspect. The legacy
  // `projectMode` fallback is preserved by handing the resolved value to the
  // predicate rather than the record.
  if (!isNewProjectMode({ mode })) return issues;
  const persistedState = rawState && typeof rawState === 'object' ? rawState : state;

  // …and WHETHER THE PERSISTED SPELLING IS CANONICAL, which is a different
  // question and is deliberately still raw. The issue this pushes is literally
  // named `mode`, and the finding's advice is that the state file is
  // noncanonical — so routing it through the tolerant predicate would declare
  // ` New-Project ` canonical and take away the one report that names the drift.
  // normalizeState only fills a BLANK mode (state/normalize.ts), so a padded
  // spelling survives to here untouched, and the pair now reads correctly: the
  // checks apply, and the spelling is reported.
  if (state.mode !== 'new-project') issues.push('mode');
  if (typeof state.stack !== 'string' || !STACK_IDS.has(state.stack)) issues.push('stack');
  if (state.codeGraphProvider !== 'gitnexus' && state.codeGraphProvider !== 'graphify') {
    issues.push('codeGraphProvider');
  }
  if (!hasValidPerformanceState(state.performance)) issues.push('performance');
  if (!hasValidProjectContext(state.projectContext)) issues.push('projectContext');
  if (!hasValidTeamState(state.team)) {
    issues.push('team');
  } else if (hasValidPerformanceState(state.performance)) {
    const performance = state.performance as Rec;
    const team = state.team as Rec;
    const expectedTeamMode = teamModeForLevel(String(performance.level));
    if (team.mode !== expectedTeamMode) {
      issues.push('team.mode');
    }
    if (
      expectedTeamMode === 'subagents'
      && team.source !== 'unavailable'
      && !isTeamApproved(team)
    ) {
      issues.push('team.approved (Team Confirmation)');
    }
  }
  if (persistedState.confirmed !== true) issues.push('confirmed');
  if (persistedState.onboardingComplete !== true) issues.push('onboardingComplete');
  if (typeof persistedState.confirmedAt !== 'string' || persistedState.confirmedAt.trim() === '') issues.push('confirmedAt');
  return [...new Set(issues)];
}

export { codeGraphProviderFromValue };
