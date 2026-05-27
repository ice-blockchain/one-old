'use strict';

const fs = require('fs');

const {
  sessionIdFromFile,
  safeJsonParse,
  getPayloadText,
  commandLooksMutating,
  authProbeForSession,
} = require('./_helpers.cjs');

function analyzeCodexSessionFile(filePath, env = process.env) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  const diagnostics = {
    id: sessionIdFromFile(filePath),
    jsonl: filePath,
    cwd: null,
    startedAt: null,
    hookPayloadCount: 0,
    promptRequestCount: 0,
    permissionDecisionCount: 0,
    trafficOneAuthPromptCount: 0,
    trafficOneInstructionInjected: false,
    baseInstructionsMentionTrafficOne: false,
    toolCallCount: 0,
    mutatingToolCallCount: 0,
    firstAuthGateAt: null,
    firstMutatingToolAt: null,
    mutatingToolBeforeAuthGate: false,
    authState: null,
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = safeJsonParse(line, null);
    if (!parsed) continue;
    const timestamp = parsed.timestamp || null;
    const serialized = JSON.stringify(parsed);
    if (serialized.includes('hookSpecificOutput')) diagnostics.hookPayloadCount += 1;
    if (serialized.includes('promptRequest')) diagnostics.promptRequestCount += 1;
    if (serialized.includes('permissionDecision')) diagnostics.permissionDecisionCount += 1;
    if (serialized.includes('traffic-one.auth.choice')) {
      diagnostics.trafficOneAuthPromptCount += 1;
      if (!diagnostics.firstAuthGateAt) diagnostics.firstAuthGateAt = timestamp;
    }

    if (parsed.type === 'session_meta') {
      const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      diagnostics.id = typeof payload.id === 'string' ? payload.id : diagnostics.id;
      diagnostics.cwd = typeof payload.cwd === 'string' ? payload.cwd : diagnostics.cwd;
      diagnostics.startedAt = payload.timestamp || timestamp || diagnostics.startedAt;
      const instructionText = getPayloadText(payload);
      diagnostics.baseInstructionsMentionTrafficOne = /Traffic One|traffic-one|\.traffic-one/.test(instructionText);
      diagnostics.trafficOneInstructionInjected = /Traffic One Codex Instructions|\.traffic-one\/rules\/common\/auth-gate\.md|Authenticate with the `mcp-auth` server/.test(instructionText);
      continue;
    }

    if (parsed.type !== 'response_item') continue;
    const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
    if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') continue;
    const name = typeof payload.name === 'string' ? payload.name : '';
    diagnostics.toolCallCount += 1;
    const rawArgs = payload.arguments || payload.input || '';
    if (commandLooksMutating(name, rawArgs)) {
      diagnostics.mutatingToolCallCount += 1;
      if (!diagnostics.firstMutatingToolAt) diagnostics.firstMutatingToolAt = timestamp;
    }
  }

  diagnostics.authState = authProbeForSession(diagnostics.startedAt, env);
  diagnostics.mutatingToolBeforeAuthGate = Boolean(
    diagnostics.firstMutatingToolAt
    && (
      !diagnostics.firstAuthGateAt
      || diagnostics.firstMutatingToolAt < diagnostics.firstAuthGateAt
    )
  );
  return diagnostics;
}

module.exports = { analyzeCodexSessionFile };
