// Machine-readable verification intent embedded in `.traffic-one/plan.md`.
// The planner may request stricter verification, but this parser deliberately
// exposes only the compile options the runtime is prepared to accept.

import * as fs from 'fs';
import * as path from 'path';

import type {
  LighthouseThresholdsV1,
  VerificationCompileOptions,
} from './verification-contract';

export const VERIFICATION_PLAN_INTENT_START = '<!-- traffic-one-verification:start -->';
export const VERIFICATION_PLAN_INTENT_END = '<!-- traffic-one-verification:end -->';
export const VERIFICATION_PLAN_INTENT_SCHEMA_VERSION = 1 as const;

export type VerificationPlanCompileOptions = Pick<
  VerificationCompileOptions,
  'agentRaisedImpact' | 'redesign' | 'performanceRisk' | 'explicitLighthouse' | 'advisoryLighthouse'
>;

const ROOT_KEYS = new Set([
  'schemaVersion',
  'agentRaisedImpact',
  'redesign',
  'performanceRisk',
  'explicitLighthouse',
  'advisoryLighthouse',
]);

const SCORE_THRESHOLD_KEYS = new Set([
  'performanceMin',
  'accessibilityMin',
  'bestPracticesMin',
  'seoMin',
]);

const MAX_THRESHOLD_KEYS = new Set([
  'lcpMaxMs',
  'clsMax',
  'inpMaxMs',
]);

const THRESHOLD_KEYS = new Set([
  ...SCORE_THRESHOLD_KEYS,
  ...MAX_THRESHOLD_KEYS,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function occurrences(text: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(marker, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + marker.length;
  }
}

function parseThresholds(
  parentKey: 'explicitLighthouse' | 'advisoryLighthouse',
  value: unknown,
): LighthouseThresholdsV1 {
  if (!isRecord(value)) {
    throw new Error(`traffic-one verification intent ${parentKey} must be an object`);
  }

  const parsed: LighthouseThresholdsV1 = {};
  for (const [key, threshold] of Object.entries(value)) {
    if (!THRESHOLD_KEYS.has(key)) {
      throw new Error(`traffic-one verification intent has unknown ${parentKey} key: ${key}`);
    }
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) {
      throw new Error(`traffic-one verification intent ${parentKey}.${key} is outside its allowed range`);
    }
    if (SCORE_THRESHOLD_KEYS.has(key) && threshold > 100) {
      throw new Error(`traffic-one verification intent ${parentKey}.${key} is outside its allowed range`);
    }
    (parsed as Record<string, number>)[key] = threshold;
  }
  return parsed;
}

/**
 * Parse the optional verification-intent block from plan text.
 *
 * No marker means no planner-supplied compile options. Once the marker
 * namespace appears, malformed, duplicate, or unsupported blocks fail closed.
 */
export function parseVerificationPlanIntent(planText: string): VerificationPlanCompileOptions {
  const startCount = occurrences(planText, VERIFICATION_PLAN_INTENT_START);
  const endCount = occurrences(planText, VERIFICATION_PLAN_INTENT_END);
  const withoutKnownMarkers = planText
    .split(VERIFICATION_PLAN_INTENT_START).join('')
    .split(VERIFICATION_PLAN_INTENT_END).join('');

  if (withoutKnownMarkers.includes('traffic-one-verification:')) {
    throw new Error('traffic-one verification intent contains a malformed or unsupported marker');
  }
  if (startCount === 0 && endCount === 0) return {};
  if (startCount !== 1 || endCount !== 1) {
    throw new Error('traffic-one verification intent requires exactly one start marker and one end marker');
  }

  const start = planText.indexOf(VERIFICATION_PLAN_INTENT_START);
  const end = planText.indexOf(VERIFICATION_PLAN_INTENT_END);
  if (end < start + VERIFICATION_PLAN_INTENT_START.length) {
    throw new Error('traffic-one verification intent markers are out of order');
  }

  const raw = planText.slice(start + VERIFICATION_PLAN_INTENT_START.length, end).trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('traffic-one verification intent must contain valid JSON');
  }
  if (!isRecord(decoded)) {
    throw new Error('traffic-one verification intent JSON must be an object');
  }

  for (const key of Object.keys(decoded)) {
    if (!ROOT_KEYS.has(key)) {
      throw new Error(`traffic-one verification intent has unknown key: ${key}`);
    }
  }
  if (decoded.schemaVersion !== VERIFICATION_PLAN_INTENT_SCHEMA_VERSION) {
    throw new Error(
      `traffic-one verification intent schemaVersion must be ${VERIFICATION_PLAN_INTENT_SCHEMA_VERSION}`,
    );
  }
  if ('redesign' in decoded && typeof decoded.redesign !== 'boolean') {
    throw new Error('traffic-one verification intent redesign must be boolean');
  }
  if ('agentRaisedImpact' in decoded
    && !['none', 'nonvisual', 'behavioral', 'visual', 'native-ui'].includes(String(decoded.agentRaisedImpact))) {
    throw new Error('traffic-one verification intent agentRaisedImpact is invalid');
  }
  if ('performanceRisk' in decoded && typeof decoded.performanceRisk !== 'boolean') {
    throw new Error('traffic-one verification intent performanceRisk must be boolean');
  }

  const options: VerificationPlanCompileOptions = {};
  if (typeof decoded.agentRaisedImpact === 'string') {
    options.agentRaisedImpact = decoded.agentRaisedImpact as VerificationCompileOptions['agentRaisedImpact'];
  }
  if (typeof decoded.redesign === 'boolean') options.redesign = decoded.redesign;
  if (typeof decoded.performanceRisk === 'boolean') options.performanceRisk = decoded.performanceRisk;
  if ('explicitLighthouse' in decoded) {
    options.explicitLighthouse = parseThresholds('explicitLighthouse', decoded.explicitLighthouse);
  }
  if ('advisoryLighthouse' in decoded) {
    options.advisoryLighthouse = parseThresholds('advisoryLighthouse', decoded.advisoryLighthouse);
  }
  return options;
}

export function verificationPlanPath(projectRoot: string): string {
  return path.join(projectRoot, '.traffic-one', 'plan.md');
}

/** Read and parse verification intent from a project's canonical plan. */
export function readVerificationPlanIntent(projectRoot: string): VerificationPlanCompileOptions {
  const planPath = verificationPlanPath(projectRoot);
  try {
    return parseVerificationPlanIntent(fs.readFileSync(planPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
