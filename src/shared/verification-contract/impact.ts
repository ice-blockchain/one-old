// src/shared/verification-contract-impact.ts
// UI-impact derivation: the path/regex heuristics, JSX visual projection,
// planned floors, changed routes, and required checks.

import * as path from 'path';
import {
  moduleOutputVariants,
  stableContractJson,
  type ArchitectureBaselineV1,
  type CompiledArchitectureV1,
} from '../architecture-contract';
import {
  profileHasNativeUi,
  profileHasWebUi,
  type CapabilityProfileV1,
} from '../capabilities';
import { sha256 } from '../text';

import {
  type LighthouseThresholdsV1,
  type UiImpact,
} from './types';
import {
  changedHunkEvidence,
  gitTextAtBaseline,
  normalizeRel,
  safeRead,
  unique,
  type ChangedHunkEvidence,
} from './git';

const VISUAL_RE = /\.(?:css|scss|sass|less|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf)$/i;
const MARKUP_RE = /\.(?:tsx|jsx|vue|svelte|astro|html|blade\.php|php|erb|twig|hbs|handlebars|ejs|razor|cshtml|templ)$/i;
const VISUAL_PATH_RE = /(?:^|\/)(?:styles?|theme|tokens?|assets?|layout)(?:\/|[.-])/i;
const VISUAL_CONFIG_RE = /(?:^|\/)(?:tailwind|uno|windi)\.config\.(?:[cm]?[jt]s|ts)$/i;
const NONVISUAL_RE = /(?:^|\/)(?:types?|mappers?|schemas?|data|config|constants?|utils?|lib)(?:\/|[.-])|\.d\.ts$|(?:^|\/)[^/]+\.config\.[^.]+$/i;
const BEHAVIOR_RE = /(?:^|\/)(?:routes?|router|navigation|forms?|state|stores?|features?)(?:\/|[.-])|(?:route|router|navigation|handler|controller)\.[^.]+$/i;
// `768` on its own matched any unrelated literal — a port, a byte size, an id in
// backend code — and every match forced a third viewport through the whole sweep.
// Require it to look like a breakpoint.
const TABLET_RISK_RE = /(?:tablet|breakpoint|@media|\bmd:|min-width|max-width|\b768px\b|\bmd\b\s*:\s*['"]?768)/i;
export const IMPORTANT_VISUAL_PATH_RE =
  /(?:^|\/)(?:packages\/ui|design-system|theme|tokens?|layouts?)(?:\/|[.-])|(?:^|\/)(?:globals?|app|styles?)\.(?:css|scss|sass|less)$|(?:^|\/)(?:tailwind|uno|windi)\.config\.(?:[cm]?[jt]s|ts)$/i;

// Every framework's handler-attribute syntax, not only React's. When only these
// are recognized as behavior, a handler-only edit in a Vue SFC or a Blade
// template reads as VISUAL and pays for the full three-viewport screenshot sweep
// plus Lighthouse — pure token and wall-clock cost on every non-React run.
//   React     onClick={…}          Svelte   on:click={…}
//   Vue       @click="…"  v-on:…   Alpine   x-on:click="…"  @click="…"
//   Livewire  wire:click="…"       Angular  (click)="…"
const EVENT_ATTR_RE = new RegExp([
  '\\bon[A-Z][A-Za-z0-9_$]*\\s*=',
  '\\b(?:v-on|x-on|on|wire|hx):[A-Za-z][A-Za-z0-9_.:|-]*\\s*=',
  '@[A-Za-z][A-Za-z0-9_.:-]*\\s*=',
  '\\([A-Za-z][A-Za-z0-9_.]*\\)\\s*=',
].join('|'));

function stripEventHandlers(tag: string): string {
  let output = '';
  for (let cursor = 0; cursor < tag.length;) {
    const event = EVENT_ATTR_RE.exec(tag.slice(cursor));
    if (!event) {
      output += tag.slice(cursor);
      break;
    }
    const start = cursor + event.index;
    output += tag.slice(cursor, start);
    let valueStart = start + event[0].length;
    while (valueStart < tag.length && /\s/.test(tag[valueStart] || '')) valueStart += 1;
    const opener = tag[valueStart];
    // Quoted values are the norm outside JSX and may contain spaces
    // (`@click="save(a, b)"`). Skipping to the next whitespace left the tail of
    // the expression in the tag, where it read as visual content.
    if (opener === '"' || opener === '\'') {
      cursor = valueStart + 1;
      while (cursor < tag.length && tag[cursor] !== opener) cursor += 1;
      cursor += 1;
      continue;
    }
    if (opener !== '{') {
      cursor = valueStart;
      while (cursor < tag.length && !/[\s>]/.test(tag[cursor] || '')) cursor += 1;
      continue;
    }
    let depth = 0;
    cursor = valueStart;
    for (; cursor < tag.length; cursor += 1) {
      if (tag[cursor] === '{') depth += 1;
      else if (tag[cursor] === '}') {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      }
    }
  }
  return output;
}

function jsxTags(source: string): Array<{ start: number; end: number; value: string }> {
  const tags: Array<{ start: number; end: number; value: string }> = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '<' || !/(?:[A-Za-z]|\/[A-Za-z]|>|\/>)/.test(source.slice(start + 1, start + 3))) {
      continue;
    }
    let curly = 0;
    let quote: '\'' | '"' | '`' | null = null;
    let escaped = false;
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      const current = source[cursor]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === quote) quote = null;
        continue;
      }
      if (current === '\'' || current === '"' || current === '`') {
        quote = current;
        continue;
      }
      if (current === '{') curly += 1;
      else if (current === '}' && curly > 0) curly -= 1;
      else if (current === '>' && curly === 0) {
        tags.push({ start, end: cursor + 1, value: source.slice(start, cursor + 1) });
        start = cursor;
        break;
      }
    }
  }
  return tags;
}

function visualProjection(source: string): string {
  const parts: string[] = [];
  const tags = jsxTags(source);
  let depth = 0;
  let previousEnd = 0;
  for (const tag of tags) {
    if (depth > 0) {
      const childText = source.slice(previousEnd, tag.start).replace(/\s+/g, ' ').trim();
      if (childText) parts.push(`text:${childText}`);
    }
    parts.push(`tag:${stripEventHandlers(tag.value).replace(/\s+/g, ' ').trim()}`);
    const closing = /^<\//.test(tag.value);
    const selfClosing = /\/>$/.test(tag.value);
    if (closing) depth = Math.max(0, depth - 1);
    else if (!selfClosing) depth += 1;
    previousEnd = tag.end;
  }
  return parts.join('\n');
}

function changedCodeIsVisual(evidence: ChangedHunkEvidence): boolean {
  if (visualProjection(evidence.before) !== visualProjection(evidence.after)) return true;
  return /\b(?:className|style|css|theme|token|palette|color|background|font|spacing|gap|grid|flex|width|height|margin|padding|asset|icon|image|layout)\b/i
    .test(evidence.changedText);
}

function baseImpact(profile: CapabilityProfileV1): UiImpact {
  if (profile.architectureTarget === 'web-ui') return 'nonvisual';
  if (profile.architectureTarget === 'native-ui') return 'native-ui';
  if (profileHasNativeUi(profile)) return 'native-ui';
  if (!profileHasWebUi(profile)) return 'none';
  return 'nonvisual';
}

export function rank(impact: UiImpact): number {
  if (impact === 'none') return 0;
  if (impact === 'nonvisual') return 1;
  if (impact === 'behavioral') return 2;
  if (impact === 'visual') return 3;
  return 4;
}

export function raiseImpact(current: UiImpact, candidate: UiImpact): UiImpact {
  if (current === 'native-ui' || candidate === 'native-ui') return 'native-ui';
  return rank(candidate) > rank(current) ? candidate : current;
}

export function validateAgentRaisedImpact(
  profile: CapabilityProfileV1,
  candidate: UiImpact | undefined,
): void {
  if (!candidate) return;
  const domain = baseImpact(profile);
  if (domain === 'none' && candidate !== 'none') {
    throw new Error(`agentRaisedImpact ${candidate} is invalid for a project without a UI surface`);
  }
  if (domain === 'native-ui' && candidate !== 'native-ui') {
    throw new Error(`agentRaisedImpact ${candidate} is invalid for a native-ui profile`);
  }
  if (domain === 'nonvisual' && !['none', 'nonvisual', 'behavioral', 'visual'].includes(candidate)) {
    throw new Error(`agentRaisedImpact ${candidate} is invalid for a web-ui profile`);
  }
}

function baselineContainsPath(
  projectRoot: string,
  baseline: ArchitectureBaselineV1,
  relPath: string,
): boolean {
  if (baseline.kind === 'git-head' && baseline.identity.startsWith('git:')) {
    return gitTextAtBaseline(projectRoot, baseline.identity.slice(4), relPath).exists;
  }
  return (baseline.files || []).some((entry) => entry.path === relPath);
}

export function plannedUiImpactFloor(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
): UiImpact {
  if (!profileHasWebUi(architecture.profile)) return baseImpact(architecture.profile);
  let floor: UiImpact = 'nonvisual';
  for (const module of architecture.modules) {
    // Extension freedom: a module pre-existing at ANY allowed variant is not new.
    if (moduleOutputVariants(module).some((variant) => (
      baselineContainsPath(projectRoot, architecture.baseline, variant)
    ))) continue;
    if (['app-shell', 'page', 'component'].includes(module.kind)) return 'visual';
    if (module.kind === 'feature') floor = raiseImpact(floor, 'behavioral');
  }
  for (const output of architecture.scaffoldOutputs || []) {
    if (output.ownerRole === 'senior-tester'
      || baselineContainsPath(projectRoot, architecture.baseline, output.path)) continue;
    if (VISUAL_RE.test(output.path)
      || VISUAL_PATH_RE.test(output.path)
      || MARKUP_RE.test(output.path)) return 'visual';
    if (BEHAVIOR_RE.test(output.path)) floor = raiseImpact(floor, 'behavioral');
  }
  return floor;
}

export function plannedImportantVisualChange(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
): boolean {
  return architecture.modules.some((module) => (
    ['app-shell', 'page'].includes(module.kind)
    && !moduleOutputVariants(module).some((variant) => (
      baselineContainsPath(projectRoot, architecture.baseline, variant)
    ))
  )) || (architecture.scaffoldOutputs || []).some((output) => (
    output.ownerRole !== 'senior-tester'
    && IMPORTANT_VISUAL_PATH_RE.test(output.path)
    && !baselineContainsPath(projectRoot, architecture.baseline, output.path)
  ));
}

export function deriveUiImpact(
  projectRoot: string,
  profile: CapabilityProfileV1,
  changedPaths: readonly string[],
  baseline?: ArchitectureBaselineV1,
): { impact: UiImpact; tabletRisk: boolean; reason?: string } {
  let impact = baseImpact(profile);
  let tabletRisk = false;
  const fallbackReasons: string[] = [];
  if (impact === 'none' || impact === 'native-ui') return { impact, tabletRisk };
  for (const file of changedPaths) {
    const normalized = normalizeRel(file);
    if (!normalized) continue;
    const content = safeRead(projectRoot, normalized);
    let changedContent = content;
    if (VISUAL_RE.test(normalized) || VISUAL_PATH_RE.test(normalized) || VISUAL_CONFIG_RE.test(normalized)) {
      impact = raiseImpact(impact, 'visual');
    } else if (MARKUP_RE.test(normalized)) {
      const evidence = changedHunkEvidence(projectRoot, baseline, normalized);
      changedContent = evidence.changedText;
      if (!evidence.available) {
        impact = raiseImpact(impact, 'visual');
        fallbackReasons.push(`${normalized}: ${evidence.reason || 'changed-hunk evidence unavailable'}`);
      } else if (changedCodeIsVisual(evidence)) {
        impact = raiseImpact(impact, 'visual');
      } else if (evidence.changedText.trim()) {
        impact = raiseImpact(impact, 'behavioral');
      }
    } else if (BEHAVIOR_RE.test(normalized) || /\b(?:onClick|onSubmit|navigate|router|hydrateRoot|createBrowserRouter)\b/.test(content)) {
      impact = raiseImpact(impact, 'behavioral');
    } else if (NONVISUAL_RE.test(normalized)) {
      impact = raiseImpact(impact, 'nonvisual');
    } else if (/\.(?:tsx?|jsx?|mjs|cjs)$/i.test(normalized)) {
      impact = raiseImpact(impact, 'behavioral');
    }
    if (TABLET_RISK_RE.test(changedContent) || /(?:^|[-_.])tablet(?:[-_.]|$)/i.test(normalized)) tabletRisk = true;
  }
  return {
    impact,
    tabletRisk,
    ...(fallbackReasons.length > 0
      ? { reason: `Conservative visual classification because diff evidence was unavailable (${fallbackReasons.join('; ')}).` }
      : {}),
  };
}

export function changedRoutes(
  architecture: CompiledArchitectureV1,
  paths: readonly string[],
  impact: UiImpact,
): string[] {
  const changed = new Set(paths);
  const globalVisualChange = impact === 'visual' && paths.some((file) => (
    VISUAL_RE.test(file)
    || VISUAL_CONFIG_RE.test(file)
    || /(?:^|\/)(?:styles?|theme|tokens?|assets?|layouts?|components?|packages\/ui)(?:\/|[.-])/i.test(file)
  ));
  if (globalVisualChange) {
    const allRoutes = architecture.routes
      .filter((route) => !route.redirect)
      .map((route) => route.path);
    if (allRoutes.length > 0) return unique(allRoutes);
  }
  const routes = architecture.routes
    .filter((route) => route.redirect || changed.has(route.moduleOutput))
    .map((route) => route.path);
  if (routes.length > 0) return unique(routes);
  return architecture.profile.surfaces.includes('web-ui') ? ['/'] : [];
}

export function requiredChecks(impact: UiImpact, stackPerformanceRisk = false): string[] {
  const withStackPerformance = (checks: string[]): string[] => (
    stackPerformanceRisk ? [...checks, 'stack-performance'] : checks
  );
  if (impact === 'none') return withStackPerformance(['stack-build', 'stack-test', 'stack-lint']);
  if (impact === 'nonvisual') return ['stack-build', 'unit-or-component-tests', 'axe-when-dom'];
  if (impact === 'behavioral') {
    return [
      'stack-build', 'playwright-local', 'dom-assertions', 'actions', 'routing',
      'hydration', 'console-errors', 'network-errors',
    ];
  }
  if (impact === 'visual') {
    return [
      'stack-build', 'playwright-local', 'dom-assertions', 'actions', 'routing',
      'hydration', 'console-errors', 'network-errors', 'responsive-screenshots',
    ];
  }
  return withStackPerformance(['stack-build', 'native-unit-tests', 'simulator-or-emulator']);
}

export function thresholdsValid(thresholds: LighthouseThresholdsV1 | undefined): boolean {
  if (!thresholds) return true;
  for (const [key, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || Number(value) < 0) return false;
    if (key.endsWith('Min') && Number(value) > 100) return false;
  }
  return true;
}

export function verificationHash(value: unknown): string {
  return sha256(stableContractJson(value));
}
