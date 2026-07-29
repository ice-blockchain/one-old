// src/runners/opencode/gateway-probe.ts
// The bounded egress probe for the OpenCode gateway (child process running
// the inline script; NO_PROXY/HTTPS_PROXY aware).

import * as fs from 'fs';
import { spawnTool } from '../../shared/spawn-tool';

import {
  which,
} from './types';

const OPENCODE_GATEWAY_HOST = 'api.opencode.ai';
// Preflight ceiling. A reachable gateway answers the TLS/CONNECT handshake in well
// under 100ms (measured 75ms); a DENIED one answers just as fast (proxy 403 /
// connection reset). This only needs to outlast a slow DNS lookup.
const GATEWAY_PROBE_MS = 4000;

/**
 * Fast reachability preflight for the OpenCode gateway.
 *
 * WHY: an egress policy that DENIES the gateway does not make the CLI fail — it
 * makes it HANG, so each model burns the full unit timeout and a delegation
 * costs ~3.5min before falling back to the paid implementer (measured live in
 * cursor 14c: `startedAt 08:50:32 → finishedAt 08:54:05`, two 90s ETIMEDOUTs,
 * `delegated=0`). Cursor 3.12.30 ships exactly such a policy for tool execution
 * (`networkPolicy.default: "deny"` with a 101-domain package-registry allowlist
 * that does not include api.opencode.ai), so on that host EVERY delegation paid
 * the full stall. A ~4s probe turns that into an instant, actionable failure.
 *
 * Must be PROXY-AWARE: a sandbox typically blocks direct DNS and exports
 * HTTPS_PROXY (verified: Cursor exports `HTTPS_PROXY=http://127.0.0.1:<port>`),
 * so a direct socket probe reports ENOTFOUND for allowed and denied hosts alike
 * and would false-positive on a perfectly healthy gateway. Through the proxy the
 * CONNECT status separates them: 200 = allowed, anything else = denied.
 *
 * FAILS OPEN: anything inconclusive (no node, spawn error, unparseable output)
 * returns reachable, so a probe defect can never disable working delegation.
 */
export function opencodeGatewayReachable(): { reachable: boolean; detail: string } {
  // Runs in a child because delegate() is synchronous end-to-end (spawnSync).
  const script = `
const net = require('net'), tls = require('tls'), url = require('url'), fs = require('fs');
export const host = ${JSON.stringify(OPENCODE_GATEWAY_HOST)}, timeoutMs = ${GATEWAY_PROBE_MS};
export const e = process.env;
const noProxy = String(e.NO_PROXY || e.no_proxy || '').split(',').map(s => s.trim()).filter(Boolean);
export const raw = noProxy.includes(host) ? '' : (e.HTTPS_PROXY || e.https_proxy || e.ALL_PROXY || e.all_proxy || '');
// fs.writeSync, NOT process.stdout.write: stdout is a PIPE here, and an async
// write followed immediately by process.exit() truncates — the verdict was lost
// and the caller then failed OPEN, which would silently restore the full stall
// this probe exists to avoid.
function done(msg, code) { try { fs.writeSync(1, msg); } catch {} process.exit(code); }
export let proxy = null;
if (raw) { try { const u = new url.URL(raw); if (u.protocol === 'http:' || u.protocol === 'https:') proxy = u; } catch {} }
if (proxy) {
  const s = net.connect(Number(proxy.port || 80), proxy.hostname, () => {
    s.write('CONNECT ' + host + ':443 HTTP/1.1\\r\\nHost: ' + host + ':443\\r\\n\\r\\n');
  });
  let buf = '';
  s.setTimeout(timeoutMs, () => { s.destroy(); done('inconclusive proxy-timeout', 4); });
  s.on('data', (d) => {
    buf += d.toString('utf8');
    if (buf.indexOf('\\r\\n') < 0 && buf.length < 4096) return;
    const line = buf.split('\\r\\n')[0];
    s.destroy();
    if (/\\s2\\d\\d\\s/.test(line + ' ')) done('ok', 0);
    // 407 is "authenticate", not "denied" — we deliberately send no Proxy-Authorization,
    // so it says nothing about the gateway and must not disable delegation.
    if (/\\s407\\s/.test(line + ' ')) done('inconclusive proxy-auth-required', 4);
    done('blocked proxy-status:' + line.trim().slice(0, 120), 3);
  });
  s.on('error', (err) => done('inconclusive proxy-error:' + (err.code || err.message), 4));
  // A proxy that closes without ever answering leaves no verdict; without this the
  // process would exit silently with an empty stdout, which the caller reads as
  // "inconclusive" only by accident. Say so explicitly (and still fail open).
  s.on('close', () => done('inconclusive proxy-closed', 4));
} else {
  const s = tls.connect({ host, port: 443, servername: host }, () => { s.destroy(); done('ok', 0); });
  s.setTimeout(timeoutMs, () => { s.destroy(); done('inconclusive direct-timeout', 4); });
  // No proxy configured: a failure here is NOT proof of an egress policy. A sandbox that
  // blocks direct DNS returns ENOTFOUND for ALLOWLISTED hosts too (verified), and a
  // TLS-intercepting proxy returns a self-signed-cert error while the host is reachable.
  // Both must fail OPEN; only an affirmative proxy CONNECT denial blocks.
  s.on('error', (err) => done('inconclusive direct-error:' + (err.code || err.message), 4));
}
`;
  const r = spawnTool(process.execPath, ['-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GATEWAY_PROBE_MS + 2000,
  });
  const out = String(r.stdout || '').trim();
  if (r.error || !out || out.startsWith('inconclusive')) {
    return { reachable: true, detail: out || 'probe unavailable' };
  }
  if (out.startsWith('ok')) return { reachable: true, detail: 'ok' };
  return { reachable: false, detail: out };
}

// Actionable remediation for a denied gateway. Names the cause and the exact
// hosts, because the user cannot infer "egress allowlist" from a timeout.
export function gatewayUnreachableError(detail: string): string {
  return 'OpenCode gateway ' + OPENCODE_GATEWAY_HOST + ' is UNREACHABLE from this process '
    + `(${detail}) — skipped the free-model walk and fell back to the paid implementer immediately `
    + 'instead of burning the per-model timeout. This is an egress/network policy on the HOST, not an '
    + 'OpenCode or Traffic One fault: sandboxed tool execution (e.g. Cursor\'s `networkPolicy` '
    + '`default: deny` allowlist) blocks it. To restore free delegation, allowlist '
    + `${OPENCODE_GATEWAY_HOST}, opencode.ai and models.dev for tool/terminal execution, or disable the `
    + 'egress sandbox for this workspace. Verify with: curl -sS -o /dev/null -w \'%{http_code}\' '
    + `https://${OPENCODE_GATEWAY_HOST}/`;
}
