// src/runners/token-report/lib.ts
// Core token-usage stats: the per-model pricing table + the message→stats
// accumulator. Ported 1:1 from token-report/_helpers.cjs (PRICING, addToStats,
// numberValue). Codex parsing, session discovery, and markdown rendering land
// in follow-up files.

type Rec = Record<string, unknown>;

export interface Pricing { input: number; cacheWrite: number; cacheRead: number; output: number }
export interface ModelStats {
  messages: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}
export interface LargestMessage { tokens: number; timestamp: string | null; role: unknown }
export interface Stats {
  messages: number;
  toolUses: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  firstAt: string | null;
  lastAt: string | null;
  byTool: Record<string, number>;
  byModel: Record<string, ModelStats>;
  largestMessage: LargestMessage | null;
  modelContextWindow: number | null;
}

export const PRICING: Record<string, Pricing> = {
  'claude-opus-4-7': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  'claude-opus-4-6': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  'claude-sonnet-4-6': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-sonnet-4-5': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  // Fallback when model is unrecognized — assume sonnet-class pricing.
  _default: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
};

export function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// Accumulate one parsed Claude assistant JSONL record into `stats`.
export function addToStats(stats: Stats, msg: unknown): void {
  const m0 = msg && typeof msg === 'object' ? (msg as Rec) : null;
  const message = m0 && m0.message && typeof m0.message === 'object' ? (m0.message as Rec) : null;
  const usage = message && message.usage && typeof message.usage === 'object' ? (message.usage as Rec) : null;
  if (!usage) return;
  stats.messages += 1;
  const ts = (m0 && typeof m0.timestamp === 'string' ? m0.timestamp : null);
  if (ts) {
    if (!stats.firstAt || ts < stats.firstAt) stats.firstAt = ts;
    if (!stats.lastAt || ts > stats.lastAt) stats.lastAt = ts;
  }
  const ip = numberValue(usage.input_tokens);
  const ccr = numberValue(usage.cache_creation_input_tokens);
  const cr = numberValue(usage.cache_read_input_tokens);
  const op = numberValue(usage.output_tokens);
  stats.inputTokens += ip;
  stats.cacheCreationInputTokens += ccr;
  stats.cacheReadInputTokens += cr;
  stats.outputTokens += op;
  const totalThisMsg = ip + ccr + cr + op;
  if (!stats.largestMessage || totalThisMsg > stats.largestMessage.tokens) {
    stats.largestMessage = { tokens: totalThisMsg, timestamp: ts, role: message ? message.role : undefined };
  }
  const model = message && typeof message.model === 'string' ? message.model : '';
  if (model) {
    let entry = stats.byModel[model];
    if (!entry) {
      entry = { messages: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
      stats.byModel[model] = entry;
    }
    entry.messages += 1;
    entry.inputTokens += ip;
    entry.cacheCreationInputTokens += ccr;
    entry.cacheReadInputTokens += cr;
    entry.outputTokens += op;
  }
  const content = message && Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    const b = block && typeof block === 'object' ? (block as Rec) : null;
    if (b && b.type === 'tool_use' && typeof b.name === 'string' && b.name) {
      stats.byTool[b.name] = (stats.byTool[b.name] || 0) + 1;
      stats.toolUses += 1;
    }
  }
}
