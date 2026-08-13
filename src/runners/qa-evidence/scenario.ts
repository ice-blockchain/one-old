// src/runners/qa-evidence/scenario.ts
// Scenario parsing: routePattern identity vs concrete startPath probes,
// catch-all exclusivity, and required-route coverage.

import * as path from 'path';
import {
  type VerificationContractV2,
} from '../../shared/verification-contract';

import {
  type RouteScenario,
  type RunnerArgs,
  type ScenarioStep,
  type ScenarioV1,
} from './types';
import {
  isRecord,
} from './cli';
import {
  safeProjectRelative,
} from './run-context';
import { readRegularFileOrThrow } from '../../shared/bounded-read';

function parseStep(value: unknown): ScenarioStep | null {
  if (!isRecord(value)
    || !['click', 'fill', 'press', 'check', 'select', 'expect-visible', 'expect-text', 'expect-url']
      .includes(String(value.type))) return null;
  const type = value.type as ScenarioStep['type'];
  const needsSelector = type !== 'expect-url';
  const needsValue = ['fill', 'press', 'select', 'expect-text', 'expect-url'].includes(type);
  if (needsSelector && (typeof value.selector !== 'string' || !value.selector.trim() || value.selector.length > 1_000)) return null;
  if (needsValue && (typeof value.value !== 'string' || value.value.length > 4_000)) return null;
  if (Object.keys(value).some((key) => !['type', 'selector', 'value'].includes(key))) return null;
  return {
    type,
    ...(typeof value.selector === 'string' ? { selector: value.selector } : {}),
    ...(typeof value.value === 'string' ? { value: value.value } : {}),
  };
}

// A compiled route is an identity, not a URL. `*` is the router-idiomatic
// catch-all and `/courses/:courseSlug` names a family; neither can be fetched.
// The runner used to require every scenario route to start with `/` and then
// navigate to it verbatim, so a contract carrying `*` made QA unsatisfiable
// (observed 6co: the architect rewrote the product's catch-all to a literal
// `/404` just to get a passing sweep, and the app shipped with no reachable
// not-found route at all) while `:param` routes were "verified" by visiting the
// literal path `/courses/:courseSlug`. `startPath` carries the concrete probe.
export function isConcreteRoutePath(value: string): boolean {
  return value.startsWith('/')
    && !value.split('/').some((segment) => segment.startsWith(':') || segment === '*');
}

// Null when the pattern matches everything (`*`), which no regex needs to prove.
function routePatternToRegExp(pattern: string): RegExp | null {
  if (pattern === '*') return null;
  const source = pattern.split('/').map((segment) => {
    if (segment.startsWith(':')) return '[^/]+';
    if (segment === '*') return '.*';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
}

const ASSERTION_STEPS = ['expect-visible', 'expect-text', 'expect-url'];
const INTERACTIVE_STEPS = ['click', 'fill', 'press', 'check', 'select'];
const SUBMIT_STEPS = ['click', 'press'];

// A degraded-state affordance is what the app shows INSTEAD of working: a
// "configure this first" call to action, a placeholder, a coming-soon panel.
// Asserting one is the opposite of proving the feature.
// `[\s_-]` because these words reach the scenario as prose AND as test ids
// (`[data-testid="coming-soon"]`, `#setup_required`).
const DEGRADED_STATE_RE = new RegExp([
  'not[\\s_-]+configured',
  'configuration[\\s_-]+(?:is[\\s_-]+)?(?:required|missing)',
  'missing[\\s_-]+configuration',
  'needs?[\\s_-]+configuration',
  'set[\\s_-]?up[\\s_-]+required',
  'requires?[\\s_-]+set[\\s_-]?up',
  'coming[\\s_-]+soon',
  'placeholder',
  'unavailable',
].join('|'), 'i');
// A CSS attribute NAME is not content: `input[placeholder="Search courses"]`
// targets a field, it does not assert a placeholder state — and rejecting it
// threw out the whole scenario file over the most ordinary selector idiom
// there is. Blank the name, keep the value, so `[data-testid="coming-soon"]`
// and `[aria-label="Unavailable"]` still read as degraded.
const ATTRIBUTE_NAME_RE = /(\[\s*)([A-Za-z_:][\w:.-]*)(?=\s*[~^$*|]?=|\s*\])/g;
function selectorContent(selector: string): string {
  return selector.replace(ATTRIBUTE_NAME_RE, (_match, open: string, name: string) => (
    `${open}${' '.repeat(name.length)}`
  ));
}
// `a[href='https://vendor.example/']` — an off-site link can never be the
// success path of a form the app was supposed to handle.
const OFFSITE_LINK_SELECTOR_RE = /\bhref\s*[\^$*~|]?=\s*["']?\s*https?:\/\//i;

/**
 * Does this route's step list actually assert the thing it exercises?
 *
 * Observed 10co-e2e: the generated `scenario-v1.json` filled the contact form
 * and then asserted `expect-visible` on `a[href='https://traffic.io/']` — the
 * missing-configuration setup CTA a reviewer finding had flagged as wrongly
 * rendered. There was NO submit step and NO result assertion, so
 * `"actions: passed"` was fully compatible with the form being broken: the
 * scenario asserted the bug as its pass condition.
 *
 * Two rules, both narrow on purpose. A scenario that FILLS a form must submit
 * it and assert something afterwards, and that success assertion may not be a
 * degraded-state affordance. Routes with no `fill` keep the pre-existing
 * contract (one interactive step), so ordinary click-through sweeps are
 * untouched.
 */
export function scenarioStepsProveOutcome(steps: readonly ScenarioStep[]): boolean {
  if (!steps.some((step) => INTERACTIVE_STEPS.includes(step.type))) return false;
  const isDegraded = (step: ScenarioStep): boolean => (
    DEGRADED_STATE_RE.test(`${selectorContent(step.selector || '')} ${step.value || ''}`)
  );
  // Never a pass condition, anywhere in the scenario.
  if (steps.some((step) => ASSERTION_STEPS.includes(step.type) && isDegraded(step))) return false;
  let lastFill = -1;
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index]!.type === 'fill') lastFill = index;
  }
  if (lastFill < 0) return true;
  const submitAt = steps.findIndex((step, index) => (
    index > lastFill && SUBMIT_STEPS.includes(step.type)
  ));
  if (submitAt < 0) return false;
  const successPath = steps.slice(submitAt + 1)
    .filter((step) => ASSERTION_STEPS.includes(step.type));
  if (successPath.length === 0) return false;
  return !successPath.some((step) => OFFSITE_LINK_SELECTOR_RE.test(step.selector || ''));
}

function parseScenario(value: unknown, requiredRoutes: readonly string[]): ScenarioV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.routes)
    || Object.keys(value).some((key) => !['schemaVersion', 'routes'].includes(key))) return null;
  const routes: RouteScenario[] = [];
  for (const raw of value.routes) {
    if (!isRecord(raw)
      || typeof raw.route !== 'string'
      || !(raw.route === '*' || raw.route.startsWith('/'))
      || raw.route.length > 2_048
      || (raw.startPath !== undefined
        && (typeof raw.startPath !== 'string' || raw.startPath.length > 2_048))
      || typeof raw.stableSelector !== 'string'
      || !raw.stableSelector.trim()
      || raw.stableSelector.length > 1_000
      || (raw.finalPath !== undefined
        && (typeof raw.finalPath !== 'string' || !raw.finalPath.startsWith('/') || raw.finalPath.length > 2_048))
      || !Array.isArray(raw.steps)
      || raw.steps.length < 1
      || raw.steps.length > 100
      || Object.keys(raw).some((key) => (
        !['route', 'startPath', 'finalPath', 'stableSelector', 'steps'].includes(key)
      ))) return null;
    const pattern = raw.route;
    // A literal route is its own probe; a pattern must name one explicitly.
    const startPath = typeof raw.startPath === 'string'
      ? raw.startPath
      : (isConcreteRoutePath(pattern) ? pattern : '');
    if (!isConcreteRoutePath(startPath)) return null;
    const patternRe = routePatternToRegExp(pattern);
    if (patternRe && !patternRe.test(startPath)) return null;
    // The catch-all is only exercised by a URL no other declared route claims —
    // otherwise the sweep proves the sibling route, not the 404.
    if (pattern === '*' && requiredRoutes.some((other) => {
      if (other === '*') return false;
      const otherRe = routePatternToRegExp(other);
      return otherRe ? otherRe.test(startPath) : false;
    })) return null;
    const steps = raw.steps.map(parseStep);
    if (steps.some((step) => !step)) return null;
    if (!scenarioStepsProveOutcome(steps as ScenarioStep[])) return null;
    routes.push({
      route: pattern,
      startPath,
      finalPath: typeof raw.finalPath === 'string' ? raw.finalPath : startPath,
      stableSelector: raw.stableSelector,
      steps: steps as ScenarioStep[],
    });
  }
  if (new Set(routes.map((route) => route.route)).size !== routes.length) return null;
  const expected = [...new Set(requiredRoutes)].sort();
  const observed = routes.map((route) => route.route).sort();
  return JSON.stringify(expected) === JSON.stringify(observed)
    ? { schemaVersion: 1, routes }
    : null;
}

export function loadScenario(args: RunnerArgs, contract: VerificationContractV2): ScenarioV1 | null {
  let raw = args.scenarioJson || '';
  if (!raw && args.scenarioFile) {
    const rel = safeProjectRelative(args.projectRoot, args.scenarioFile);
    if (!rel) return null;
    try {
      raw = readRegularFileOrThrow(path.join(args.projectRoot, rel));
    } catch {
      return null;
    }
  }
  try {
    return parseScenario(JSON.parse(raw), contract.changedRoutes);
  } catch {
    return null;
  }
}
