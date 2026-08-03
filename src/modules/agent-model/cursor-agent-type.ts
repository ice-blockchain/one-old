// Verbatim TS fallback for the `cursor-agent-type-required` gate block. Keep it
// in sync with the matching T1BLOCK in agent-model/skill/SKILL.md so a missing or
// unreadable skill file can never disable the enforcement.

export function cursorAgentTypeReason(
  role: string,
  agentType: string,
  expectedAgent: string,
  fallbackAgent: string,
  agentPath: string,
): string {
  return [
    `Cursor agent gate: \`${role}\` was spawned with subagent_type \`${agentType || 'missing'}\`, which is neither the role's own Cursor agent nor the supported built-in fallback.`,
    '',
    `Re-issue the same \`Task\` spawn with \`subagent_type: "${expectedAgent}"\` — Traffic One materialized that role contract at \`${agentPath}\`.`,
    '',
    `If Cursor REJECTS that value (invalid enum / unknown subagent type), the agent files were written after this session captured its type list. That is NOT a broken spawn tool and NOT a reason to build the role inline: retry once with \`subagent_type: "${fallbackAgent}"\`, keep \`[t1-role: ${role}]\` as the FIRST line of the prompt, and immediately tell the child to read \`${agentPath}\` before acting. The role marker is what binds the child to its role and its frozen per-role model.`,
    '',
    'Keep the exact per-role `model` from the spawn map either way. Never send a Traffic One role to a generic worker WITHOUT the role marker, and never simulate the role in the parent thread.',
  ].join('\n');
}
