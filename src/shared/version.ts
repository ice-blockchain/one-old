// src/shared/version.ts
// Single source of the plugin version: package.json. The generator stamps this
// into all 5 manifests; runtime reads the same value.

import * as path from 'path';

import { readJson } from './fsjson';
import { pluginRoot } from './paths';

export function pluginVersion(): string {
  const pkg = readJson<{ version?: string }>(path.join(pluginRoot(), 'package.json'), {});
  return pkg.version ?? '0.0.0';
}
