// src/runners/one-mcp-report/uuidV7.ts
// UUID v7 (time-ordered) for the one-mcp report id. Ported 1:1 from
// one-mcp-report/uuidV7.cjs.

import * as crypto from 'crypto';

export function uuidV7(date = new Date()): string {
  const millis = BigInt(date.getTime()).toString(16).padStart(12, '0').slice(-12);
  const random = crypto.randomBytes(10);
  const r0 = random[0] as number;
  const r1 = random[1] as number;
  const r2 = random[2] as number;
  const r3 = random[3] as number;
  const randA = (((r0 << 8) | r1) & 0x0fff).toString(16).padStart(3, '0');
  const variant = ((r2 & 0x3f) | 0x80).toString(16).padStart(2, '0');
  const tail = Buffer.from(random.subarray(4, 10)).toString('hex');
  return `${millis.slice(0, 8)}-${millis.slice(8)}-7${randA}-${variant}${r3.toString(16).padStart(2, '0')}-${tail}`;
}
