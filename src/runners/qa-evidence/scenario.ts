// src/runners/qa-evidence/scenario.ts
// Scenario parsing: routePattern identity vs concrete startPath probes,
// catch-all exclusivity, and required-route coverage.

import * as fs from 'fs';
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
    if (!(steps as ScenarioStep[]).some((step) => (
      ['click', 'fill', 'press', 'check', 'select'].includes(step.type)
    ))) return null;
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
      raw = fs.readFileSync(path.join(args.projectRoot, rel), 'utf8');
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
