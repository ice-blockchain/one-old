'use strict';

// ── PostToolUse warning when `.traffic-one/.one.json` is written without a stack ──
// Returns the additionalContext block paired with a systemMessage when the
// model writes a partial state file. The PostToolUse hook silently ignored
// this case before, leaving the user's stack choice unpersisted.
function postWriteIncompleteWarning({
  stack,
  validStackIds,
  codeGraphProvider,
  validCodeGraphProviders,
  validationIssues = [],
}) {
  const header = '═══ traffic-one — `.traffic-one/.one.json` write incomplete ═══';
  const lines = [header, ''];
  const providers = Array.isArray(validCodeGraphProviders) && validCodeGraphProviders.length > 0
    ? validCodeGraphProviders
    : ['gitnexus', 'graphify'];

  const stackMissing = !stack;
  const stackUnknown = stack && (!validStackIds || !validStackIds.includes(stack));
  const cgProvided = typeof codeGraphProvider === 'string' && codeGraphProvider.length > 0;
  const cgUnknown = cgProvided && !providers.includes(codeGraphProvider);
  const cgMissing = !cgProvided;

  if (Array.isArray(validationIssues) && validationIssues.length > 0) {
    lines.push('State validation issues:');
    for (const issue of validationIssues) {
      lines.push(`- ${issue}`);
    }
  }

  if (stackMissing) {
    if (lines.length > 2) lines.push('');
    lines.push(
      'You wrote `.traffic-one/.one.json` without a `stack` field. The PostToolUse',
      'hook cannot auto-load any rule bundle until `stack` is set.',
    );
  } else if (stackUnknown) {
    if (lines.length > 2) lines.push('');
    lines.push(
      `Stack id \`${stack}\` is not a valid traffic-one stack. The PostToolUse`,
      'hook cannot auto-load any rule bundle until a known stack id is set.',
      '',
      `Valid stack ids: ${validStackIds.join(' · ')}.`,
    );
  }

  if (cgMissing) {
    if (lines.length > 2) lines.push('');
    lines.push(
      'You also did not set `codeGraphProvider`. This is a REQUIRED field —',
      'no skip, no default. Ask with the host popup tool (Codex `request_user_input`,',
      'Claude Code `AskUserQuestion`, or Cursor task-UI) when available:',
      'header "Code Graph"; question "Which provider should we use for the codebase graph?";',
      'if no popup tool is available, ask in chat with numbered options and stop for the typed reply;',
      `${providers.map((p) => `\`${p}\``).join(' or ')}. The graph reduces token`,
      'usage 50–70% on multi-file work. See `rules/common/codebase-graph.md`',
      'and the FIRST-RUN ONBOARDING directive for the license trade-off',
      '(gitnexus is PolyForm Noncommercial; graphify is MIT).',
    );
  } else if (cgUnknown) {
    if (lines.length > 2) lines.push('');
    lines.push(
      `\`codeGraphProvider: "${codeGraphProvider}"\` is not a known value.`,
      `Valid code-graph providers: ${providers.map((p) => `\`${p}\``).join(' · ')}.`,
    );
  }

  if (Array.isArray(validationIssues) && validationIssues.some((issue) => issue.includes('`team`'))) {
    if (lines.length > 2) lines.push('');
    lines.push(
      'You also did not persist a valid Team Confirmation state. This is',
      'required for new-project multi-layer builds so the architecture gate can',
      'enforce the chosen route: `team.mode="subagents"` for Balanced/High, or',
      '`team.mode="main-agent"` for Low. Balanced/High also require',
      '`team.approved: true` after the user approves Team Confirmation.',
    );
  }

  if (Array.isArray(validationIssues) && validationIssues.some((issue) => issue.includes('`projectContext`'))) {
    if (lines.length > 2) lines.push('');
    lines.push(
      'You also did not persist `projectContext`. After Agent Mode and any',
      'Team Confirmation are resolved, say "Traffic One was successfully set',
      'up. Let\'s collect the project details next.", ask a rich dynamic',
      'MVP questionnaire tailored to the original request, including audience,',
      'core flows, v1 features, roles/auth, data model, admin/ops, business',
      'model, payments when applicable, integrations, engagement, success',
      'metrics, constraints, and domain-specific needs. Save `source`,',
      '`originalPrompt`, `summary`, `answers`, and `collectedAt` before the',
      'Mobile App prompt.',
    );
  }

  lines.push(
    '',
      'Re-write the file with the Write tool using the full required schema:',
    '',
    '  {',
      '    "version": "<current-plugin-version>",',
      '    "mode": "new-project",',
      '    "stack": "<chosen-id>",',
      '    "frontend": "<chosen-frontend>",',
      '    "backend": "<chosen-backend>",',
      '    "projectContext": { "source": "prompted", "originalPrompt": "<user request>", "summary": "<summary>", "answers": {}, "collectedAt": "<ISO-8601 UTC>" },',
      '    "mobile": { "enabled": false, "framework": "none", "source": "<explicit|prompted|none>" },',
      '    "technologies": { "frontend": [], "backend": [], "mobile": [] },',
      '    "realtime": "<heavy|light|none>",',
      '    "codeGraphProvider": "<gitnexus|graphify>",',
      '    "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" },',
      '    "performance": { "level": "<low|balanced|high>", "source": "prompted" },',
      '    "team": { "mode": "<subagents|main-agent>", "source": "prompted", "approved": true },',
      '    "toolchain": { "gitnexus": { "installedVersion": null, "installedAt": null }, "graphify": { "installedVersion": null, "installedAt": null }, "gitleaks": { "installedVersion": null, "installedAt": null }, "trufflehog": { "installedVersion": null, "installedAt": null } },',
      '    "confirmed": true,',
    '    "onboardingComplete": true,',
    '    "confirmedAt": "<ISO-8601 UTC>"',
    '  }',
    '',
    'See the FIRST-RUN ONBOARDING directive for valid backend/realtime values',
    'and concrete examples for non-default backend branches.',
  );

  return lines.join('\n');
}

module.exports = { postWriteIncompleteWarning };
