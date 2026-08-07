// src/adapters/cursor.ts
// Cursor is the flat-JSON outlier: camelCase event names, output keys
// additional_context / permission / user_message / agent_message, and coarse
// events. This adapter translates ONLY the I/O boundary — the coarse-event
// fan-out (one Cursor event → several gates) is handled by the pipeline running
// every handler that matches the canonical (event, tool class), driven by the
// generated dispatch table. Field extraction mirrors the legacy cursor runtime.

import * as path from 'path';

import type { CanonicalEvent, ToolClass, ToolInput } from '../core/types';
import { toolClassForRawName } from '../core/events';
import { parseJson } from '../shared/fsjson';
import { patchTextFromToolInput } from '../shared/apply-patch';
import { asRecord, firstString } from './coerce';
import type { HostAdapter, RawInvocation } from './types';
import { activeWorkspaceRoot, workspaceScopedCwd } from './workspace-root';
import { canonicalOneMcpServerHint } from '../shared/one-mcp/agent-tools';

// Cursor subcommand (argv) → canonical event (+ fixed tool class for the
// specific events). Two families:
//   1. FIXED-class events — Cursor's per-tool hooks (shell/read/edit). The class is
//      known from the subcommand.
//   2. GENERIC events — Cursor's `preToolUse`/`postToolUse` fire for ALL tools
//      (Shell/Read/Write/Edit/Task/Grep/MCP); parse() derives the class from the
//      payload `tool_name`. These close the pre-WRITE deny, the pre-search graphify
//      hint, and the spawn-agent model-tier gate that the 6 fixed events can't.
//      To avoid DOUBLE-firing a gate, the generic path EXCLUDES classes a fixed
//      event already owns (shell, file-read for pre; shell, file-edit for post) —
//      see GENERIC_PRE_ADMIT/GENERIC_POST_ADMIT. `subagentStart` is the role-claim
//      bind only (tier gating rides preToolUse(Task), never both — the claim
//      counter isn't idempotent).
const SUB_TO_EVENT: Readonly<Record<string, { event: CanonicalEvent; tool?: ToolClass }>> = {
  'session-start': { event: 'SessionStart' },
  'user-prompt-submit': { event: 'UserPromptSubmit' },
  'before-shell-execution': { event: 'PreToolUse', tool: 'shell' },
  'after-shell-execution': { event: 'PostToolUse', tool: 'shell' },
  'before-read-file': { event: 'PreToolUse', tool: 'file-read' },
  'after-file-edit': { event: 'PostToolUse', tool: 'file-edit' },
  'before-mcp-execution': { event: 'PreToolUse' },
  // Generic: no fixed tool — parse() derives the class from tool_name.
  'before-tool-use': { event: 'PreToolUse' },
  'after-tool-use': { event: 'PostToolUse' },
  'subagent-start': { event: 'SubagentStart' },
  'cursor-subagent-stop': { event: 'SubagentStop' },
  'cursor-stop': { event: 'Stop' },
};

// Classes the GENERIC preToolUse/postToolUse path may emit. The rest are owned by a
// fixed event (shell→before/after-shell-execution; file-read→before-read-file;
// file-edit POST→after-file-edit) and MUST be dropped to 'other' to avoid a second
// run of the same gate. 'other' matches no tool-scoped gate and keeps the
// tool-PRESENT (so the no-tools materialize-project gate stays a no-op).
const GENERIC_PRE_ADMIT: ReadonlySet<ToolClass> = new Set(['file-write', 'file-edit', 'search', 'spawn-agent']);
const GENERIC_POST_ADMIT: ReadonlySet<ToolClass> = new Set(['file-write', 'spawn-agent']);

function subcommandOf(argv: readonly string[]): string {
  const known = argv.filter((arg) => Object.prototype.hasOwnProperty.call(SUB_TO_EVENT, arg));
  return known.length > 0 ? (known[known.length - 1] as string) : '';
}

export function makeCursorAdapter(): HostAdapter {
  return {
    id: 'cursor',
    parse(raw: RawInvocation) {
      const sub = subcommandOf(raw.argv);
      const mapping = SUB_TO_EVENT[sub] ?? { event: 'PreToolUse' as CanonicalEvent };
      const data = asRecord(parseJson<Record<string, unknown>>(raw.stdin, {}));
      const input = asRecord(data.input ?? data.tool_input ?? data.toolInput);
      const document = asRecord(data.document);

      // Field extraction — shared by the fixed-class events AND the generic
      // preToolUse/postToolUse path (both read the same flat data + nested tool_input).
      const command = firstString(
        data.command, data.cmd, data.shell_command, data.shellCommand, input.command, input.cmd,
      );
      const workdir = firstString(
        data.workdir, data.working_dir, data.workingDir, data.working_directory,
        input.workdir, input.cwd, input.working_dir, input.workingDir, input.working_directory,
      );
      const filePath = firstString(
        data.file_path, data.filePath, data.path, data.uri,
        input.file_path, input.filePath, input.path, input.uri, document.path, document.uri,
      );
      // Cursor's afterFileEdit (and a generic Write/Edit preToolUse) deliver new text
      // as new_string / new_str or an edits:[{new_string}] array — synthesize content
      // from those so the generated-marker / static content checks have something to
      // inspect. (Field names are best-effort vs. a captured payload; extra keys are harmless.)
      const editsArr = Array.isArray(data.edits) ? data.edits : (Array.isArray(input.edits) ? input.edits : []);
      const editsContent = editsArr
        .map((e) => (e && typeof e === 'object' ? firstString((e as Record<string, unknown>).new_string, (e as Record<string, unknown>).newString, (e as Record<string, unknown>).new_str) : ''))
        .filter(Boolean)
        .join('\n');
      const content = firstString(
        data.content, data.new_content, data.newContent, data.text,
        data.new_string, data.newString, data.new_str,
        input.content, input.new_content, input.newContent, input.text,
        input.new_string, input.newString, input.new_str,
      ) || editsContent;
      const withFields = (cls: ToolClass, rawName: string): ToolInput => {
        const patchText = /^(?:apply_patch|patch)$/i.test(rawName.split('.').pop() || '')
          ? patchTextFromToolInput(input, data)
          : '';
        return {
          class: cls,
          rawName,
          ...(command ? { command } : {}),
          ...(workdir ? { workdir } : {}),
          ...(filePath ? { filePath } : {}),
          ...(content ? { content } : {}),
          ...(patchText ? { patchText } : {}),
        };
      };

      let tool: ToolInput | undefined;
      if (mapping.tool) {
        // Fixed-class event: class known from the subcommand; rawName = subcommand.
        tool = withFields(mapping.tool, sub);
      } else if (sub === 'before-mcp-execution') {
        // Cursor's current beforeMCPExecution payload identifies the MCP config
        // entry in `command` and carries the bare MCP tool in `tool_name`.
        // Prefer explicit server fields so this remains correct if Cursor fixes
        // `command` to carry the transport URL in a later release.
        const serverName = canonicalOneMcpServerHint(firstString(
          data.mcp_server_name, data.mcpServerName, data.server_name, data.serverName,
          data.server, data.command, data.url,
        ));
        const toolName = firstString(data.mcp_tool_name, data.mcpToolName, data.tool_name, data.toolName, data.name);
        const rawName = serverName && toolName ? `${serverName}.${toolName}` : (toolName || sub);
        tool = withFields('other', rawName);
      } else if (sub === 'before-tool-use' || sub === 'after-tool-use') {
        // Generic event: derive the class from the payload tool_name. Classes a fixed
        // event already owns are dropped to 'other' (inert — matches no tool gate, and
        // keeps the tool present so the no-tools materialize-project gate no-ops).
        // Unknown tool_name → 'other' too, so we FAIL CLOSED (no double-fire, the new
        // coverage simply doesn't fire) rather than mis-gating.
        const rawName = firstString(data.tool_name, data.toolName, data.tool, data.name);
        const cls = rawName ? toolClassForRawName(rawName) : 'other';
        const admit = sub === 'before-tool-use' ? GENERIC_PRE_ADMIT : GENERIC_POST_ADMIT;
        tool = withFields(admit.has(cls) ? cls : 'other', rawName || sub);
      }

      // Cursor's beforeSubmitPrompt field name is doc-unconfirmed; read the known
      // top-level forms AND the nested input.prompt (some payloads nest it like a tool
      // input). If none match, promptText is empty → the prompt is never seeded and the
      // stack would collapse to an undescribed shell — the finalize no-signal floor
      // (flow.ts) is the guarantee; this widening just recovers the real prompt text
      // where it IS present.
      const prompt = firstString(data.prompt, data.user_prompt, data.userPrompt, data.message, data.text, input.prompt, input.user_prompt);
      // The opened workspace is the authoritative project boundary; surface it RAW
      // (not the cwd fold below, which a deeper shell `cwd` could override) so the
      // project-root resolver can use it as a ceiling and never re-root above it.
      const wsRoot = activeWorkspaceRoot(data);
      // Only an ABSOLUTE workspace root is a usable ceiling: a relative value would
      // path.resolve() against Cursor's event-dependent hook process.cwd(), yielding
      // a bogus boundary. Cursor always sends absolute paths, so this just
      // keeps the ceiling unset (→ safe unbounded fallback) rather than wrong if a
      // future/edge payload ever sends a relative root.
      const wsCeiling = wsRoot && path.isAbsolute(wsRoot) ? wsRoot : undefined;
      const hostHookPoint = sub === 'before-tool-use'
        ? 'preToolUse'
        : sub === 'before-shell-execution'
          ? 'beforeShellExecution'
          : sub === 'before-read-file'
            ? 'beforeReadFile'
            : sub === 'before-mcp-execution'
              ? 'beforeMCPExecution'
          : sub === 'after-file-edit'
            ? 'afterFileEdit'
            : undefined;
      return {
        event: mapping.event,
        host: 'cursor',
        ...(hostHookPoint ? { hostHookPoint } : {}),
        // Cursor provides `workspace_roots`, not `cwd`; consult it before falling
        // back to its event-dependent process.cwd() (plugin dir for most plugin
        // hooks, workspace for Stop/SubagentStop).
        // If Cursor reports a tool cwd OUTSIDE workspace_roots (for example its
        // internal terminal metadata dir), keep Traffic One anchored at the workspace.
        cwd: workspaceScopedCwd(data, wsRoot),
        ...(wsCeiling ? { workspaceRoot: wsCeiling } : {}),
        raw: data,
        ...(tool ? { tool } : {}),
        ...(prompt ? { prompt } : {}),
      };
    },

    serialize(result, input) {
      // stop/subagentStop are the only Cursor events that consume followup_message.
      // Keep the wire output exact: additional context/user messages are not valid
      // continuation fields here and could prevent Cursor from enqueueing the turn.
      if (result.kind === 'context'
        && (input?.event === 'Stop' || input?.event === 'SubagentStop')
        && result.followupMessage !== undefined) {
        return JSON.stringify({ followup_message: result.followupMessage });
      }

      // Cursor has no promptRequest equivalent — drop it; map systemMessage → user_message.
      // followupMessage is deliberately ignored on every non-stop event.
      if (result.kind === 'noop') return '{}';
      if (result.kind === 'context') {
        return JSON.stringify({
          ...(result.context && result.context.trim() ? { additional_context: result.context } : {}),
          ...(result.systemMessage !== undefined ? { user_message: result.systemMessage } : {}),
        });
      }
      // deny. Cursor can only BLOCK a PreToolUse; on a POST event (afterShellExecution
      // / afterFileEdit) the action already ran, so a `permission:'deny'` is a no-op
      // that misrepresents the outcome — downgrade to a warning (omit permission,
      // surface the reason as user/agent message). Matches core/types.ts's documented
      // "a Cursor afterFileEdit downgrades deny to a warning". PreToolUse still denies.
      const isPre = input?.event === 'PreToolUse';
      const message = result.reason || (result.systemMessage !== undefined ? String(result.systemMessage) : '');
      // askUser → a user APPROVE/REJECT dialog instead of a hard block (beforeShellExecution only;
      // Cursor's only hook-driven user prompt). The question rides user_message; agent_message
      // carries the per-branch instructions. Falls back to a plain deny on a POST event.
      if (result.askUser && isPre) {
        return JSON.stringify({
          ...(result.context && result.context.trim() ? { additional_context: result.context } : {}),
          permission: 'ask',
          ...(message ? { user_message: message } : {}),
          agent_message: result.agentMessage || message,
        });
      }
      return JSON.stringify({
        ...(result.context && result.context.trim() ? { additional_context: result.context } : {}),
        ...(isPre ? { permission: 'deny' } : {}),
        ...(message ? { user_message: message, agent_message: message } : {}),
      });
    },
  };
}

