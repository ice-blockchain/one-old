#!/usr/bin/env node
'use strict';

// Cursor's hook API uses camelCase event names and flat JSON output
// (`additional_context`, `permission`, `user_message`). The shared Traffic One
// hook runtime speaks the Claude/Codex nested shape, so this adapter keeps the
// core policy logic in one place and translates only the host boundary.

const path = require('path');
const runtime = require('./hook-runtime.cjs');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
process.env.CURSOR_PLUGIN_ROOT = process.env.CURSOR_PLUGIN_ROOT || PLUGIN_ROOT;
process.env.TRAFFIC_ONE_PLUGIN_ROOT = process.env.TRAFFIC_ONE_PLUGIN_ROOT || PLUGIN_ROOT;

function readStdinRaw() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

function parseJsonText(text, fallback = {}) {
  try {
    const parsed = JSON.parse(String(text || '').trim() || '{}');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function nestedObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function cursorCommand(data) {
  const input = nestedObject(data.input || data.tool_input || data.toolInput);
  return firstString(
    data.command,
    data.cmd,
    data.shell_command,
    data.shellCommand,
    input.command,
    input.cmd,
  );
}

function cursorFilePath(data) {
  const input = nestedObject(data.input || data.tool_input || data.toolInput);
  const document = nestedObject(data.document);
  return firstString(
    data.file_path,
    data.filePath,
    data.path,
    data.uri,
    input.file_path,
    input.filePath,
    input.path,
    input.uri,
    document.path,
    document.uri,
  );
}

function cursorContent(data) {
  const input = nestedObject(data.input || data.tool_input || data.toolInput);
  return firstString(
    data.content,
    data.new_content,
    data.newContent,
    data.text,
    input.content,
    input.new_content,
    input.newContent,
    input.text,
  );
}

function cursorPromptPayload(data) {
  const prompt = firstString(
    data.prompt,
    data.user_prompt,
    data.userPrompt,
    data.message,
    data.text,
  );
  return JSON.stringify({ ...data, prompt, userPrompt: prompt, text: prompt });
}

function toolPayload(toolName, toolInput) {
  return JSON.stringify({
    tool_name: toolName,
    toolName,
    tool_input: toolInput,
    toolInput,
  });
}

function normalizeRuntimeResult(result) {
  if (!result) return { stdout: '', exitCode: 0 };
  if (typeof result === 'string' || Buffer.isBuffer(result)) {
    return { stdout: String(result), exitCode: 0 };
  }
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 0,
  };
}

function cursorOutputFromRuntime(result) {
  const normalized = normalizeRuntimeResult(result);
  if (!normalized.stdout.trim()) return {};

  const payload = parseJsonText(normalized.stdout, null);
  if (!payload) {
    return { additional_context: normalized.stdout.trim() };
  }

  const hookOutput = nestedObject(payload.hookSpecificOutput);
  const contexts = [
    payload.additional_context,
    payload.additionalContext,
    hookOutput.additionalContext,
  ].filter((value) => typeof value === 'string' && value.trim());

  const output = {};
  if (contexts.length > 0) {
    output.additional_context = contexts.join('\n\n');
  }

  if (hookOutput.permissionDecision === 'deny') {
    const reason = hookOutput.permissionDecisionReason || 'Traffic One blocked this action.';
    output.permission = 'deny';
    output.user_message = reason;
    output.agent_message = reason;
  }

  if (!output.user_message && typeof payload.systemMessage === 'string' && payload.systemMessage.trim()) {
    output.user_message = payload.systemMessage;
  }

  return output;
}

function mergeCursorOutputs(outputs) {
  const merged = {};
  const contexts = [];

  for (const output of outputs) {
    if (!output || typeof output !== 'object') continue;
    if (typeof output.additional_context === 'string' && output.additional_context.trim()) {
      contexts.push(output.additional_context.trim());
    }
    if (output.permission === 'deny') {
      merged.permission = 'deny';
      merged.user_message = output.user_message || merged.user_message;
      merged.agent_message = output.agent_message || merged.agent_message;
    } else if (!merged.user_message && output.user_message) {
      merged.user_message = output.user_message;
    }
  }

  if (contexts.length > 0) {
    merged.additional_context = contexts.join('\n\n');
  }
  return merged;
}

function runBeforeShell(data) {
  const raw = toolPayload('Bash', { command: cursorCommand(data) });
  const onboarding = cursorOutputFromRuntime(runtime.runCheckOnboardingGate(raw));
  if (onboarding.permission === 'deny') return onboarding;
  const allowlist = cursorOutputFromRuntime(runtime.runCheckLibraryAllowlist(raw));
  return mergeCursorOutputs([onboarding, allowlist]);
}

function runAfterShell(data) {
  const raw = toolPayload('Bash', { command: cursorCommand(data) });
  return mergeCursorOutputs([
    cursorOutputFromRuntime(runtime.runPostBuildPageSpeed(raw)),
    cursorOutputFromRuntime(runtime.runPostBuildGraphifyHint(raw)),
    cursorOutputFromRuntime(runtime.runPostStackSetup(raw)),
  ]);
}

function runBeforeReadFile(data) {
  const raw = toolPayload('Read', { file_path: cursorFilePath(data) });
  return cursorOutputFromRuntime(runtime.runCheckOnboardingGate(raw));
}

function runAfterFileEdit(data) {
  const raw = toolPayload('Edit', {
    file_path: cursorFilePath(data),
    content: cursorContent(data),
  });
  return mergeCursorOutputs([
    cursorOutputFromRuntime(runtime.runCheckArchitectureWrite(raw)),
    cursorOutputFromRuntime(runtime.runPostStackSetup(raw)),
  ]);
}

function runSubcommand(subcommand, rawInput) {
  const data = parseJsonText(rawInput, {});
  switch (subcommand) {
    case 'session-start':
      return cursorOutputFromRuntime(runtime.runSessionStart(rawInput));
    case 'user-prompt-submit':
      return cursorOutputFromRuntime(runtime.runUserPromptSubmit(cursorPromptPayload(data)));
    case 'before-shell-execution':
      return runBeforeShell(data);
    case 'after-shell-execution':
      return runAfterShell(data);
    case 'before-read-file':
      return runBeforeReadFile(data);
    case 'after-file-edit':
      return runAfterFileEdit(data);
    default:
      return {};
  }
}

async function main() {
  const subcommand = process.argv[2];
  const rawInput = await readStdinRaw();
  const output = runSubcommand(subcommand, rawInput);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[traffic-one cursor hook] ${error.message}\n`);
    process.stdout.write('{}\n');
    process.exitCode = 0;
  });
}

module.exports = {
  cursorOutputFromRuntime,
  runSubcommand,
};
