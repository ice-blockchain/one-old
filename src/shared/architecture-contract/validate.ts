// src/shared/architecture-contract/validate.ts
// ArchitectureInputV1 validation: exception requests, key allowlists, and
// the input validator.

import * as path from 'path';
import { obj, type Rec } from '../obj';

import {
  ARCHITECTURE_INPUT_SCHEMA_VERSION,
  type ArchitectureExceptionRequestV1,
  type ArchitectureValidationResult,
} from './types';
import {
  BLOCKED_EXCEPTION_RULES,
  EXCEPTION_RULES,
  MODULE_ID_RE,
  ROUTE_PATH_RE,
  SAFE_NAME_RE,
  normalizeRelative,
} from './core';
import {
  kebab,
} from './naming';

function validateExceptionRequest(request: ArchitectureExceptionRequestV1): string[] {
  const errors: string[] = [];
  const glob = normalizeRelative(request.glob);
  if (!EXCEPTION_RULES.has(request.ruleId) || BLOCKED_EXCEPTION_RULES.has(request.ruleId)) {
    errors.push(`exception ${request.ruleId || '<missing>'}: rule is not exception-eligible`);
  }
  if (!glob || glob === '**' || glob === '**/*' || !glob.includes('/')) {
    errors.push(`exception ${request.ruleId || '<missing>'}: glob must be narrow and project-relative`);
  } else {
    const uiPrimitive = glob.startsWith('packages/ui/')
      || glob.includes('/components/ui/')
      || /\/[A-Z][A-Za-z0-9]+(?:\*|\{[^}]+\})\.[A-Za-z]+$/.test(glob);
    if (!uiPrimitive) {
      errors.push(`exception ${request.ruleId}: only packages/ui, shadcn UI primitives, or a same-prefix compound family may be exempted`);
    }
  }
  if (String(request.reason || '').trim().length < 12) {
    errors.push(`exception ${request.ruleId || '<missing>'}: reason must be specific`);
  }
  return errors;
}

const ARCHITECTURE_INPUT_KEYS = new Set(['schemaVersion', 'routes', 'modules', 'exceptions']);
const ARCHITECTURE_MODULE_KEYS = new Set(['id', 'name', 'kind']);
const ARCHITECTURE_ROUTE_KEYS = new Set(['id', 'path', 'moduleId', 'redirect']);
const ARCHITECTURE_EXCEPTION_KEYS = new Set(['ruleId', 'glob', 'reason']);

function unsupportedArchitectureFields(
  value: Rec,
  allowed: ReadonlySet<string>,
  label: string,
): string[] {
  // Name the accepted keys in the error itself. The architect writes this file
  // from prose, so semantic-sounding extras get invented (observed 1cu-cursor:
  // `routes[].access` and `routes[].seo`); an error that only says which key is
  // wrong costs a whole re-read + retry cycle to find out which are right.
  const accepted = [...allowed].join(', ');
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort()
    .map((key) => `${label} has unsupported field ${key} (accepted: ${accepted})`);
}

export function validateArchitectureInput(input: unknown): ArchitectureValidationResult {
  const raw = obj(input);
  const errors: string[] = [];
  if (!raw || raw.schemaVersion !== ARCHITECTURE_INPUT_SCHEMA_VERSION) {
    return { ok: false, errors: ['schemaVersion must be 1'] };
  }
  errors.push(...unsupportedArchitectureFields(raw, ARCHITECTURE_INPUT_KEYS, 'input'));
  const routes = Array.isArray(raw.routes) ? raw.routes.map(obj) : [];
  const modules = Array.isArray(raw.modules) ? raw.modules.map(obj) : [];
  const exceptions = Array.isArray(raw.exceptions) ? raw.exceptions.map(obj) : [];
  if (!Array.isArray(raw.routes)) errors.push('routes must be an array');
  if (!Array.isArray(raw.modules) || modules.length === 0) errors.push('modules must be a non-empty array');
  if (raw.exceptions !== undefined && !Array.isArray(raw.exceptions)) {
    errors.push('exceptions must be an array when provided');
  }

  const moduleIds = new Set<string>();
  for (const [index, module] of modules.entries()) {
    if (module) {
      errors.push(...unsupportedArchitectureFields(
        module,
        ARCHITECTURE_MODULE_KEYS,
        `modules[${index}]`,
      ));
    }
    const id = typeof module?.id === 'string' ? module.id.trim() : '';
    const name = typeof module?.name === 'string' ? module.name.trim() : '';
    const kind = typeof module?.kind === 'string' ? module.kind : '';
    if (!MODULE_ID_RE.test(id)) errors.push(`modules[${index}].id is invalid (expected kebab-case: lowercase letter first, then lowercase letters/digits/hyphens, max 64 chars)`);
    if (moduleIds.has(id)) errors.push(`modules[${index}].id is duplicated`);
    moduleIds.add(id);
    if (!SAFE_NAME_RE.test(name)) errors.push(`modules[${index}].name is invalid (expected a letter first, then letters/digits/spaces and , . ( ) & + ' : - punctuation, max 80 chars — no slashes, quotes, or angle brackets)`);
    if (!['app-shell', 'page', 'component', 'feature', 'service', 'store', 'test'].includes(kind)) {
      errors.push(`modules[${index}].kind is invalid`);
    }
    if (
      'output' in (module || {})
      || 'root' in (module || {})
      || 'path' in (module || {})
      || 'ownerRole' in (module || {})
      || 'role' in (module || {})
    ) {
      errors.push(`modules[${index}] may not choose output paths, roots, or roles`);
    }
  }

  const routeIds = new Set<string>();
  for (const [index, route] of routes.entries()) {
    if (route) {
      errors.push(...unsupportedArchitectureFields(
        route,
        ARCHITECTURE_ROUTE_KEYS,
        `routes[${index}]`,
      ));
    }
    const id = typeof route?.id === 'string' ? route.id.trim() : '';
    const routePath = typeof route?.path === 'string' ? route.path.trim() : '';
    const moduleId = typeof route?.moduleId === 'string' ? route.moduleId.trim() : '';
    if (!MODULE_ID_RE.test(id)) errors.push(`routes[${index}].id is invalid (expected kebab-case: lowercase letter first, then lowercase letters/digits/hyphens, max 64 chars)`);
    if (routeIds.has(id)) errors.push(`routes[${index}].id is duplicated`);
    routeIds.add(id);
    if (!ROUTE_PATH_RE.test(routePath)) errors.push(`routes[${index}].path is invalid (expected a leading-slash path such as \`/\`, \`/courses\`, or \`/courses/:slug\`, or the catch-all \`*\`)`);
    if (route && 'redirect' in route && typeof route.redirect !== 'boolean') {
      errors.push(`routes[${index}].redirect must be a boolean when provided`);
    }
    if (route?.redirect !== true && !moduleIds.has(moduleId)) {
      errors.push(`routes[${index}].moduleId does not name a declared module`);
    }
    const target = modules.find((module) => module?.id === moduleId);
    if (route?.redirect !== true && target?.kind !== 'page') {
      errors.push(`routes[${index}] must target a page module`);
    }
  }

  for (const [index, exception] of exceptions.entries()) {
    if (!exception) {
      errors.push(`exceptions[${index}] must be an object`);
      continue;
    }
    errors.push(...unsupportedArchitectureFields(
      exception,
      ARCHITECTURE_EXCEPTION_KEYS,
      `exceptions[${index}]`,
    ));
    errors.push(...validateExceptionRequest({
      ruleId: typeof exception.ruleId === 'string' ? exception.ruleId : '',
      glob: typeof exception.glob === 'string' ? exception.glob : '',
      reason: typeof exception.reason === 'string' ? exception.reason : '',
    }));
  }
  return { ok: errors.length === 0, errors };
}
