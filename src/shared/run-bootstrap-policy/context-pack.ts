// src/shared/run-bootstrap-policy/context-pack.ts
// Per-role compiled context pack + the read-receipt (rules-ack) contract.
//
// 8co measured the delivery problem this solves: every role batch-read its
// rules/skills through one big concatenated exec, and Codex truncates exec
// output middle-out at ~10K tokens — of 25 files the frontend requested, only
// 7 survived; frontend/services.md, ui-quality.md, and the create-* skills
// vanished silently, and the implementer shipped fixtures instead of live
// services. The pack pre-buckets the SAME role-scoped materials the bootstrap
// envelope already hashes into parts that each fit safely under the
// truncation ceiling, and the rules-ack runner both PRINTS a part and RECORDS
// that it was served — delivery and proof of ingestion are one command.

import * as fs from 'fs';
import * as path from 'path';

import { sha256 } from '../text';
import { writeJson } from '../fsjson';
import { roleAgentBody } from '../skill-filters';

import { ruleContent, skillContent } from './materials';
import { roleBootstrapDir, runBootstrapDir } from './types';

// ~6K tokens per part: safely below the ~10K-token middle-out truncation
// observed on Codex exec output, with headroom for the runner's own footer.
export const CONTEXT_PACK_PART_MAX_CHARS = 24_000;
export const CONTEXT_PACK_SCHEMA_VERSION = 1 as const;

export interface ContextPackPartV1 {
  file: string;
  ids: string[];
  chars: number;
  sha256: string;
  /**
   * When true, `file` lives in the RUN-level shared store rather than this role's
   * own directory. Always-on rules are identical for every role, so a
   * deterministic packer produced byte-identical parts per role — ~890 KB per run
   * where ~450 KB was unique, with `part-02` triplicated across three roles.
   *
   * Only a boolean is persisted, never a path fragment: the reader computes both
   * candidate directories itself, so a manifest can never point a hook at an
   * arbitrary location. Absent on pre-existing manifests, which keep resolving
   * against the role directory.
   */
  shared?: boolean;
}

export interface ContextPackManifestV1 {
  schemaVersion: typeof CONTEXT_PACK_SCHEMA_VERSION;
  runId: string;
  role: string;
  parts: ContextPackPartV1[];
  packHash: string;
}

export interface RulesAckV1 {
  schemaVersion: typeof CONTEXT_PACK_SCHEMA_VERSION;
  runId: string;
  role: string;
  packHash: string;
  servedParts: number[];
  completedAt?: string;
}

export function contextPackDir(cwd: string, runId: string, role: string): string {
  return path.join(roleBootstrapDir(cwd, runId, role), 'context-pack');
}

/** Run-level content-addressed store for part bodies shared between roles. */
export function sharedContextPackDir(cwd: string, runId: string): string {
  return path.join(runBootstrapDir(cwd, runId), 'context-pack');
}

/** Directory a manifest part's `file` resolves against. Never manifest-supplied. */
export function contextPackPartDir(
  cwd: string,
  runId: string,
  role: string,
  part: ContextPackPartV1,
): string {
  return part.shared ? sharedContextPackDir(cwd, runId) : contextPackDir(cwd, runId, role);
}

export function contextPackManifestPath(cwd: string, runId: string, role: string): string {
  return path.join(contextPackDir(cwd, runId, role), 'manifest.json');
}

export function rulesAckPath(cwd: string, runId: string, role: string): string {
  return path.join(roleBootstrapDir(cwd, runId, role), 'rules-ack.json');
}

export function readContextPackManifest(
  cwd: string,
  runId: string,
  role: string,
): ContextPackManifestV1 | null {
  try {
    const raw = JSON.parse(fs.readFileSync(contextPackManifestPath(cwd, runId, role), 'utf8')) as ContextPackManifestV1;
    if (raw.schemaVersion !== CONTEXT_PACK_SCHEMA_VERSION
      || raw.runId !== runId
      || raw.role !== role
      || !Array.isArray(raw.parts)
      || typeof raw.packHash !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

export function readRulesAck(cwd: string, runId: string, role: string): RulesAckV1 | null {
  try {
    const raw = JSON.parse(fs.readFileSync(rulesAckPath(cwd, runId, role), 'utf8')) as RulesAckV1;
    if (raw.schemaVersion !== CONTEXT_PACK_SCHEMA_VERSION
      || raw.runId !== runId
      || raw.role !== role
      || typeof raw.packHash !== 'string'
      || !Array.isArray(raw.servedParts)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Complete = every numbered part served under the CURRENT pack hash. */
export function rulesAckComplete(cwd: string, runId: string, role: string): boolean {
  const manifest = readContextPackManifest(cwd, runId, role);
  if (!manifest) return true; // no pack compiled — nothing to acknowledge
  const ack = readRulesAck(cwd, runId, role);
  if (!ack || ack.packHash !== manifest.packHash) return false;
  const served = new Set(ack.servedParts);
  return manifest.parts.every((_, index) => served.has(index + 1));
}

interface PackItem {
  id: string;
  body: string;
}

// Split one oversized body into continuation chunks that each fit a part.
function itemChunks(item: PackItem): Array<{ id: string; text: string }> {
  const header = `## ${item.id}\n\n`;
  const budget = CONTEXT_PACK_PART_MAX_CHARS - header.length - 64;
  if (item.body.length <= budget) {
    return [{ id: item.id, text: `${header}${item.body.trimEnd()}\n` }];
  }
  const chunks: Array<{ id: string; text: string }> = [];
  const lines = item.body.split('\n');
  let buffer: string[] = [];
  let size = 0;
  let sequence = 0;
  const flush = (): void => {
    if (!buffer.length) return;
    sequence += 1;
    const label = sequence === 1 ? item.id : `${item.id} (continued ${sequence})`;
    chunks.push({ id: label, text: `## ${label}\n\n${buffer.join('\n').trimEnd()}\n` });
    buffer = [];
    size = 0;
  };
  for (const line of lines) {
    if (size + line.length + 1 > budget) flush();
    buffer.push(line);
    size += line.length + 1;
  }
  flush();
  return chunks;
}

function packParts(items: PackItem[]): Array<{ ids: string[]; text: string }> {
  const parts: Array<{ ids: string[]; text: string }> = [];
  let ids: string[] = [];
  let body = '';
  const flush = (): void => {
    if (!ids.length) return;
    parts.push({ ids, text: body });
    ids = [];
    body = '';
  };
  for (const item of items) {
    for (const chunk of itemChunks(item)) {
      if (body.length > 0 && body.length + chunk.text.length > CONTEXT_PACK_PART_MAX_CHARS) flush();
      ids.push(chunk.id);
      body += (body ? '\n' : '') + chunk.text;
    }
  }
  flush();
  return parts;
}

/**
 * Compile the role's context pack next to its bootstrap envelope. Content is
 * the SAME role-scoped material set the envelope hashes (role doc, scoped
 * rules, declared skills) plus the compiled integration requirements. Best
 * effort by design: a pack failure must never fail the bootstrap publish —
 * the completion gate keys on the manifest's existence.
 */
export function compileRoleContextPack(
  cwd: string,
  runId: string,
  role: string,
  ruleIds: readonly string[],
  skillIds: readonly string[],
  integrationRequirements: readonly string[],
): ContextPackManifestV1 | null {
  try {
    const items: PackItem[] = [];
    const roleBody = roleAgentBody(role);
    if (roleBody) items.push({ id: `role: ${role}`, body: roleBody });
    for (const id of ruleIds) {
      const body = ruleContent(id);
      if (body) items.push({ id: `rule: ${id}`, body });
    }
    for (const id of skillIds) {
      const body = skillContent(id);
      if (body) items.push({ id: `skill: ${id}`, body });
    }
    if (!items.length) return null;
    const parts = packParts(items);
    const dir = contextPackDir(cwd, runId, role);
    fs.mkdirSync(dir, { recursive: true });
    // Content-addressed and shared across roles: the always-on rules are the same
    // for every role, so a deterministic packer emitted identical bodies per role.
    const manifestParts: ContextPackPartV1[] = parts.map((part) => {
      const hash = sha256(part.text);
      return {
        file: `${hash}.md`,
        ids: part.ids,
        chars: part.text.length,
        sha256: hash,
        shared: true,
      };
    });
    const packHash = sha256(manifestParts.map((part) => part.sha256).join('\n'));
    // This runs on EVERY envelope publish, and the pack only changes when the
    // role's rule/skill set does. Rewriting all parts each time churned for
    // identical bytes — and the receipts protocol already keys on `packHash`, so
    // an unchanged hash means the served parts are still valid.
    const existing = readContextPackManifest(cwd, runId, role);
    const sharedDir = sharedContextPackDir(cwd, runId);
    fs.mkdirSync(sharedDir, { recursive: true });
    for (const [index, part] of parts.entries()) {
      const target = path.join(sharedDir, manifestParts[index]!.file);
      // Content-addressed: identical bytes are already there, from this role's
      // previous publish or from another role's pack.
      if (!fs.existsSync(target)) fs.writeFileSync(target, part.text);
    }
    if (existing?.packHash === packHash) return existing;
    const requirements = integrationRequirements.length
      ? ['', '## Integration requirements (deterministic gates verify these)', '', ...integrationRequirements.map((line) => `- ${line}`)]
      : [];
    const index = [
      `# Context pack — ${role}, run ${runId}`,
      '',
      'Read EVERY part below before implementation work, ONE part per command:',
      '',
      `    node ~/.traffic-one/bin/rules-ack.cjs --run-id ${runId} --role ${role} --part <n>`,
      '',
      'ONE part per command, in separate turns. Do NOT wrap these calls in a',
      'loop or `Promise.all` and do NOT lower `max_output_tokens`: batching them',
      'truncates the combined output and you lose the parts you just "read"',
      '(measured 9co: all parts served, 11k-28k tokens still truncated). The',
      'same applies to reading rule/skill files directly — never concatenate',
      'them into one command (observed 8co: 7 of 25 files survived).',
      '',
      '| part | contents |',
      '| --- | --- |',
      ...manifestParts.map((part, partIndex) => (
        `| ${partIndex + 1} | ${part.ids.join('; ').slice(0, 160)} |`
      )),
      ...requirements,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'part-00.md'), index);
    const manifest: ContextPackManifestV1 = {
      schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
      runId,
      role,
      parts: manifestParts,
      packHash,
    };
    writeJson(contextPackManifestPath(cwd, runId, role), manifest);
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Integration requirements compiled from the role's work-unit outputs and the
 * capability surfaces — the "definition of done" the reviewer kept
 * re-discovering in 8co, delivered at spawn instead.
 */
/**
 * The public site-URL variable for the compiled stack. Each framework only exposes
 * env vars with its own prefix, so naming `VITE_SITE_URL` at a Nuxt or Next project
 * asked the role for a variable its bundler would never read.
 */
function siteUrlEnvVar(outputs: readonly string[]): string {
  const has = (re: RegExp): boolean => outputs.some((output) => re.test(output));
  if (has(/(?:^|\/)nuxt\.config\.[cm]?[jt]s$/)) return 'NUXT_PUBLIC_SITE_URL';
  if (has(/(?:^|\/)next\.config\.[cm]?[jt]s$/) || has(/(?:^|\/)app\/layout\.tsx$/)) return 'NEXT_PUBLIC_SITE_URL';
  if (has(/(?:^|\/)svelte\.config\.[cm]?[jt]s$/)) return 'PUBLIC_SITE_URL';
  if (has(/(?:^|\/)artisan$/) || has(/(?:^|\/)resources\/views\//)) return 'APP_URL';
  if (has(/(?:^|\/)angular\.json$/)) return 'SITE_URL';
  return 'VITE_SITE_URL';
}

export function compileIntegrationRequirements(
  role: string,
  surfaces: readonly string[],
  outputs: readonly string[],
): string[] {
  const requirements: string[] = [];
  if (role === 'senior-frontend') {
    const apiPackage = outputs.find((output) => /^packages\/[^/]*(?:api|client|sdk)[^/]*\//i.test(output));
    if (apiPackage || surfaces.includes('api')) {
      requirements.push('Every learner-facing page consumes the planned typed API package (live-or-demo with explicit loading/error/degraded states) — an app that renders only static fixtures fails STRUCT_API_CLIENT_UNUSED.');
    }
    requirements.push('Every planned component/feature module must have a real call site (imported by a page or a used barrel) — dead deliverables fail STRUCT_ORPHAN_MODULE.');
    requirements.push("Style with the project's ACTUAL styling system: Tailwind utility classes without a tailwindcss dependency/config fail STRUCT_TAILWIND_NO_TOOLCHAIN.");
    requirements.push('Route user-facing copy through the i18n catalog when the project ships one (STRUCT_HARDCODED_COPY is advisory).');
    if (outputs.includes('eslint.config.js')) {
      requirements.push('The seeded `eslint.config.js` and `.prettierrc` are the project quality bar: install `eslint` and `prettier`, expose `lint`/`format`/`format:check` scripts that run them, and keep them green. A config with no installed tool and no script is inert — and raising a limit in it to pass your own change is a config-tamper violation, not a fix.');
    }
    if (outputs.some((output) => /public\/(?:sitemap\.xml|robots\.txt)$/.test(output))) {
      requirements.push(`Generate crawl assets (sitemap.xml, robots.txt) from \`${siteUrlEnvVar(outputs)}\` (seeded in .env.example) and fail generation when it is unset — invented or relative origins fail the crawl-origin gate.`);
    }
  }
  if (role === 'senior-backend') {
    const apiPackage = outputs.find((output) => /^packages\/[^/]*(?:api|client|sdk)[^/]*\//i.test(output));
    if (apiPackage) {
      requirements.push(`The typed client package under \`${apiPackage.split('/').slice(0, 2).join('/')}\` is the frontend's ONLY data contract — export real functions for every planned flow and keep identifiers/slugs consistent with seed data.`);
    }
    requirements.push('Keep seed data and schema identifiers consistent with the frontend fixtures the plan names — mismatched slugs strand live mode (observed 8co: 3 of 4 seed slugs diverged).');
  }
  return requirements;
}
