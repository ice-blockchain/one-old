// src/config/opencode.ts
// OpenCode delegation config.
//
// `delegateRoles` is the configurable set of senior roles that MUST run on the
// free OpenCode agent (instead of a paid subagent) WHEN ELIGIBLE — i.e. when
// `openCode.enabled` is true. Users override it per project via
// `openCode.delegateRoles` in local preferences; this is the default.
export const DEFAULT_OPENCODE_DELEGATE_ROLES: readonly string[] = [
  'senior-shipper',
  'senior-tester',
  'senior-frontend',
];
