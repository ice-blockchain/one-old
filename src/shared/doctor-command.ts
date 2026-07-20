import * as path from 'path';

import { pluginRoot } from './paths';
import { shellQuote } from './shell-quote';

export function doctorScriptPath(): string {
  return path.join(pluginRoot(), 'scripts', 'doctor.cjs');
}

// The plugin-root runner remains available even when ~/.traffic-one itself is
// the malformed state being diagnosed and the stable ~/.traffic-one/bin shim
// therefore cannot be read or created.
export function doctorCommand(): string {
  return `node ${shellQuote(doctorScriptPath())}`;
}
