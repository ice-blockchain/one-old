// src/shared/logger.ts
import type { Logger } from '../core/types';

export function makeLogger(opts: { debug?: boolean } = {}): Logger {
  return {
    debug(msg: string): void {
      if (opts.debug) process.stderr.write(`[traffic-one] ${msg}\n`);
    },
    warn(msg: string): void {
      process.stderr.write(`[traffic-one] ${msg}\n`);
    },
  };
}
