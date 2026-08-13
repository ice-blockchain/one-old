// src/shared/host/wrapper-records.ts
// Owner/activation record machinery shared by the kilo-host and opencode-host
// runners. The persisted disk formats differ by exactly one field name
// (`targetKilo` vs `targetOpenCode`), which existing installs already carry —
// so the builders/readers are parametrized by that field and each runner keeps
// a thin typed wrapper. runtimePluginRoot stays in the runners: its __dirname
// walk assumes the compiled scripts/runners/<host>/ depth.

import * as os from 'os';
import * as path from 'path';
import { readRegularFileOrThrow } from '../bounded-read';

export interface RunnerOutput { code: number; stdout: string; stderr?: string; }

const WRAPPER_OWNER_NAME = 'traffic-one';
const WRAPPER_OWNER_RE = /TRAFFIC_ONE_WRAPPER_OWNER\s*=\s*(\{[^\n]+});/;

export function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** The host-independent core of both owner-record shapes. */
interface WrapperRecordBase {
  owner: string;
  version: 1;
  pluginRoot: string;
  packageName: string;
  installedAt?: string;
  enabled?: boolean;
  enabledAt?: string;
  disabledAt?: string;
}

export interface WrapperRecordSpec {
  /** The persisted per-host target field: 'targetKilo' | 'targetOpenCode'. */
  targetField: string;
  targetVersion: string;
  packageName: string;
  /**
   * Wrapper API generation stamped into the owner record. Absent on installs
   * written before the field existed — readers treat that as generation 1.
   * Older readers validate only owner/version/pluginRoot, so adding this is
   * backward-compatible.
   */
  wrapperApi?: number;
}

export function buildOwnerRecord(spec: WrapperRecordSpec, pluginRoot: string): WrapperRecordBase & Record<string, unknown> {
  return {
    owner: WRAPPER_OWNER_NAME,
    version: 1,
    pluginRoot,
    [spec.targetField]: spec.targetVersion,
    packageName: spec.packageName,
    ...(spec.wrapperApi !== undefined ? { wrapperApi: spec.wrapperApi } : {}),
    installedAt: new Date().toISOString(),
  };
}

export function buildActivationRecord(
  spec: WrapperRecordSpec,
  pluginRoot: string,
  enabled: boolean,
): WrapperRecordBase & Record<string, unknown> {
  return {
    owner: WRAPPER_OWNER_NAME,
    version: 1,
    pluginRoot,
    [spec.targetField]: spec.targetVersion,
    packageName: spec.packageName,
    enabled,
    ...(enabled ? { enabledAt: new Date().toISOString() } : { disabledAt: new Date().toISOString() }),
  };
}

function parsedRecord(spec: WrapperRecordSpec, parsed: unknown): (WrapperRecordBase & Record<string, unknown>) | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.owner !== WRAPPER_OWNER_NAME || rec.version !== 1 || typeof rec.pluginRoot !== 'string') return null;
  return {
    owner: WRAPPER_OWNER_NAME,
    version: 1,
    pluginRoot: rec.pluginRoot,
    [spec.targetField]: typeof rec[spec.targetField] === 'string' ? rec[spec.targetField] as string : '',
    packageName: typeof rec.packageName === 'string' ? rec.packageName : '',
    ...(typeof rec.wrapperApi === 'number' ? { wrapperApi: rec.wrapperApi } : {}),
    ...(typeof rec.installedAt === 'string' ? { installedAt: rec.installedAt } : {}),
    ...(typeof rec.enabled === 'boolean' ? { enabled: rec.enabled } : {}),
    ...(typeof rec.enabledAt === 'string' ? { enabledAt: rec.enabledAt } : {}),
    ...(typeof rec.disabledAt === 'string' ? { disabledAt: rec.disabledAt } : {}),
  };
}

/** Read the owner stamp embedded in a generated wrapper file. */
export function readOwnerRecord(spec: WrapperRecordSpec, filePath: string): (WrapperRecordBase & Record<string, unknown>) | null {
  try {
    const body = readRegularFileOrThrow(filePath);
    const match = body.match(WRAPPER_OWNER_RE);
    if (!match || !match[1]) return null;
    const rec = parsedRecord(spec, JSON.parse(match[1]) as unknown);
    if (!rec) return null;
    const { enabled, enabledAt, disabledAt, ...owner } = rec;
    return owner as WrapperRecordBase & Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read a JSON project-activation record. */
export function readActivationRecord(spec: WrapperRecordSpec, filePath: string): (WrapperRecordBase & Record<string, unknown>) | null {
  try {
    const rec = parsedRecord(spec, JSON.parse(readRegularFileOrThrow(filePath)) as unknown);
    if (!rec) return null;
    const { installedAt, ...activation } = rec;
    return activation as WrapperRecordBase & Record<string, unknown>;
  } catch {
    return null;
  }
}

export function explicitCwdArg(args: readonly string[]): string | null {
  const eq = args.find((arg) => arg.startsWith('--cwd='));
  if (eq) return eq.slice('--cwd='.length);
  const index = args.indexOf('--cwd');
  if (index >= 0 && typeof args[index + 1] === 'string') return args[index + 1] as string;
  return null;
}

export function projectRootFromArgs(env: NodeJS.ProcessEnv, args: readonly string[]): string {
  return path.resolve(explicitCwdArg(args) || env.PWD || process.cwd());
}

export function jsString(value: string): string {
  return JSON.stringify(value);
}
