// src/test-environment/reporting/verdict.ts
// Optional final step: spawn ONE plugin-tester agent on the selected host to read
// the run artifacts and PRODUCE a verdict. Selectable via --verdict-host; 'none'
// skips it. The agent returns the verdict as its final message (it must not write
// files — the traffic-one gate denies writes in the un-onboarded run dir); the
// harness extracts that text and writes verdict.md itself.

import * as fs from 'fs';
import * as path from 'path';

import type { HostId, RootTestConfig } from '../core/types';
import { DRIVERS } from '../drivers';
import { verdictPrompt } from './verdict-prompt';

export interface VerdictResult {
  ran: boolean;
  host: HostId | 'none';
  status?: string;
  verdictPath?: string;
  note?: string;
}

// Pull the agent's final text out of the captured host output. Handles Claude's
// stream-json (JSONL: a `result` event + `assistant` text blocks) and plain-text
// output (cursor); falls back to the raw file.
function extractFinalText(stdoutPath: string): string | null {
  let raw: string;
  try { raw = fs.readFileSync(stdoutPath, 'utf8'); } catch { return null; }
  let resultText: string | null = null;
  const assistant: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (o.type === 'result' && typeof o.result === 'string') resultText = o.result;
      if (o.type === 'assistant') {
        const msg = o.message as { content?: unknown } | undefined;
        const content = Array.isArray(msg?.content) ? msg!.content : [];
        for (const c of content) {
          const block = c as { type?: unknown; text?: unknown };
          if (block.type === 'text' && typeof block.text === 'string') assistant.push(block.text);
        }
      }
    } catch { /* not a JSON line */ }
  }
  if (resultText && resultText.trim()) return resultText.trim();
  if (assistant.length) return assistant.join('\n\n').trim();
  return raw.trim() || null; // plain-text output format
}

export async function runVerdict(config: RootTestConfig, distRoot: string, runDir: string): Promise<VerdictResult> {
  if (config.verdictHost === 'none') return { ran: false, host: 'none', note: 'verdict host = none' };

  const host = config.verdictHost;
  const cfg = config.hosts[host];
  const driver = DRIVERS[host];
  if (!driver.isAvailable(cfg)) {
    return { ran: false, host, note: `${cfg.bin} not found on PATH — skipped verdict` };
  }

  const runFolder = path.join(runDir, '_verdict');
  fs.mkdirSync(runFolder, { recursive: true });

  const env: Record<string, string> = { TRAFFIC_ONE_ONBOARDING_NO_SPAWN: '1' };
  if (distRoot) env.TRAFFIC_ONE_PLUGIN_ROOT = distRoot;

  const result = await driver.run(cfg, {
    cwd: runDir,
    prompt: verdictPrompt(runDir),
    env,
    timeoutMs: config.defaultTimeoutMs,
    model: cfg.testModel ?? cfg.defaultModelByTier?.highest,
    distRoot,
    runFolder,
  });

  const verdictPath = path.join(runDir, 'verdict.md');
  const text = result.stdoutPath ? extractFinalText(result.stdoutPath) : null;
  if (text) {
    fs.writeFileSync(verdictPath, text + '\n', 'utf8');
    return { ran: true, host, status: result.status, verdictPath };
  }
  return { ran: true, host, status: result.status, note: `no verdict text captured (host ${result.status}; see _verdict/stdout.log)` };
}
