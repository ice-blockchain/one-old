// src/runners/doctor/bundle.ts
// `doctor --bundle`: a state-only bug report an operator can attach to an
// issue. "State-only" here is a PRIVACY constraint, not a shape hint — see the
// redaction policy below for exactly what that rules out and why.
//
// Read-only, like every other doctor probe: this module only ASSEMBLES and
// REDACTS data other probes already produced; it never writes anywhere.

import type { Finding } from './findings';
import type {
  CanonicalAuthProbe,
  CodexHooksProbe,
  GitnexusProbe,
  NodeProbe,
  NvmProbe,
  OneMcpProbe,
  OpenCodeMcpProbe,
  ProjectProbe,
  SessionDiagnosticsResult,
} from './probes';
import type { PluginIdentity } from './plugin-identity';
import type { PluginRootProbe } from './plugin-root-probe';
import type { RunDiagnosticProbe } from './run-diagnostic';
import type { DecisionRecord } from '../../shared/state/decision-log';

type Rec = Record<string, unknown>;

// ── Redaction policy ──────────────────────────────────────────────────────
//
// INCLUDES: structural state — mode/stack/frontend/backend/codeGraphProvider,
// performance/team settings, onboarding completion flags, run ids, the run
// ledger and live-agent/claim diagnostics, decision-log VERDICTS (event, host,
// decision, gateId, denyId, denyTarget, repeatCount, timestamps), toolchain/
// auth-presence/plugin-identity probes, and doctor's own findings. All of this
// is "is the machine in a healthy state", never "what did the user ask for".
//
// REDACTS, unconditionally, to the literal string "[redacted]":
//   1. `projectContext.originalPrompt` / `.summary` / `.answers` in the
//      project state (both raw `.one.json` and the normalized copy) — the
//      user's own request text and the onboarding Q&A answers derived from
//      it. This is free-text prompt content, not state, however it got
//      persisted into `.one.json` (see the work-item context: a separate,
//      later item gets `originalPrompt` OUT of committed state entirely; this
//      bundle cannot assume the state it is reading is already clean).
//   2. Every object key naming a credential — see SENSITIVE_KEY_PATTERN and
//      SENSITIVE_KEY_TOKENS below — wherever it appears in the project state
//      or local preferences, replacing only the leaf VALUE (not the key, so
//      the shape stays legible) and only when that value is a non-empty
//      STRING (a `private: true` flag stays readable). Two matchers, not one:
//      unambiguous words are matched as SUBSTRINGS so an unanticipated
//      compound (`refreshTokenCiphertext`, `sessionCookieJar`) is still
//      caught, while short words that are substrings of innocent ones
//      (`pat` in `path`/`patch`, `key` in `monkey`) are matched as whole
//      camelCase/snake_case TOKENS instead. `probeCanonicalAuth` already
//      never returns the key itself (see probes.ts), so this is defense in
//      depth there, not the only guard.
//   2b. Every remaining string value, whatever its key is called, matched
//      against the credential SHAPES in SECRET_VALUE_PATTERNS. A key-name pass
//      alone is only as good as the naming: measured against seeded state, it
//      caught apiKey/authToken/sessionCookie/privateKeyPem/awsSecretAccessKey/
//      github_pat and kept a live `postgres://admin:pass@host` under
//      `databaseUrl`, an `sk-` key inside `notes`, a `Bearer <jwt>` inside
//      `deployCommand`, and a bare JWT under `nested.deeper.innocent`. The
//      whole value is replaced, not just the matched span: a partially
//      redacted credential string is not a safe thing to reason about, and
//      these two passes then have one observable outcome ("[redacted]")
//      instead of two.
//   3. `DecisionRecord.inputs` and `.stateWrites` are DROPPED from every
//      decision-log entry, not merely redacted — decision-log.ts's own header
//      documents `inputs` as carrying `hostHookPoint`, `workspaceRoot`,
//      `tool`, and (for a prompt-submit decision) prompt text verbatim, and
//      `stateWrites` can echo file paths and small value fragments from an
//      arbitrary gate. Neither is needed to diagnose a wedge from the VERDICT
//      stream (event/decision/gateId/denyId/repeatCount already answer "why
//      is this stuck"); dropping instead of pattern-matching is the only
//      redaction strong enough for an unbounded, per-gate `inputs` shape.
//   4. `sessionDiagnostics.jsonl` (the Codex session transcript's absolute
//      file path) is kept — it is a path, not a secret or prompt text, and
//      every other probe already reports absolute paths (cwd, state file,
//      plugin root) — but `analyzeCodexSessionFile` itself (probes.ts) never
//      extracts message/instruction TEXT into the probe result in the first
//      place, only structural counts, so there is nothing further to redact
//      there.
//
// INCLUDES ABSOLUTE FILESYSTEM PATHS, and therefore the OS user's account name
// on any machine whose home directory contains it (`/Users/<name>/…`,
// `/home/<name>/…`): the plugin root, the resolved state/preferences/
// provenance/session-transcript paths and the project root are all reported
// verbatim, because "which copy of the plugin is running, from where" is the
// single most load-bearing fact in a Traffic One bug report and a
// home-relativized path answers it only halfway. This is called out in the
// emitted `redaction.policy` string too — a bundle is safe to paste with
// respect to CODE, PROMPTS and SECRETS, not with respect to identifying the
// machine it came from.
//
// NEVER attempts to redact free text INSIDE `Finding.message` or the report's
// other prose fields: every findings.ts message is a fixed template
// interpolating field NAMES, counts, paths, statuses and ids the bundle
// already reports in structured form elsewhere (`GHOST_CURRENT_RUN_ID`
// interpolates `currentRunId`, the run findings interpolate role names and
// deny ids) — never a user-authored VALUE such as prompt text, an answer, or a
// credential, so there is no user content there to catch.
const SENSITIVE_KEY_PATTERN = /token|api[_-]?key|secret|password|passwd|authori[sz]ation|credential|bearer|jwt|cookie|signature|hmac|private/i;
// Whole-token matches, for words that are substrings of innocent identifiers
// (`pat` ⊂ path/patch/compatible, `key` ⊂ monkey/keyboard, `sig` ⊂ signal).
const SENSITIVE_KEY_TOKENS = new Set(['key', 'keys', 'pat', 'pats', 'jwt', 'refresh', 'sig', 'salt', 'nonce']);
const REDACTED = '[redacted]' as const;

// camelCase/snake_case/kebab-case → lower-case word list.
function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

export function isSensitiveBundleKey(key: string): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key)) return true;
  return keyTokens(key).some((token) => SENSITIVE_KEY_TOKENS.has(token));
}

const SENSITIVE_KEY_RULE = `${SENSITIVE_KEY_PATTERN.source} (substring, case-insensitive)`
  + ` or whole word in {${[...SENSITIVE_KEY_TOKENS].join(', ')}}`;

// Credential SHAPES, applied to every string value regardless of what its key
// is called. Deliberately conservative in the FALSE-POSITIVE direction: the
// cost of over-redacting is one diagnostic field reading "[redacted]" in a bug
// report, the cost of under-redacting is a live credential in a public issue.
// Each entry carries the phrasing used in the emitted `redactsValuesMatching`,
// so a reader can tell what was and was not looked for.
const SECRET_VALUE_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: 'sk-… API key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: 'GitHub token (ghp_/gho_/ghu_/ghs_/ghr_…)', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'AWS access key id (AKIA…/ASIA…)', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'JWT (three base64url segments)', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  // Case-insensitive on purpose: a missed `bearer <token>` ends up in a public
  // issue, whereas the only cost of matching prose is a redacted config value.
  { label: 'Bearer <token>', pattern: /\bbearer\s+\S+/i },
  // `scheme://user:pass@host` only — the `:` before the `@` and the absence of
  // a `/` in between are what separate a credential pair from an ordinary URL
  // (`https://api.example.com/deploy`, `http://localhost:3000/x`).
  { label: 'credentials embedded in a URL (scheme://user:pass@host)', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { label: 'PEM private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const SECRET_VALUE_RULE = SECRET_VALUE_PATTERNS.map((entry) => entry.label).join('; ');

export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((entry) => entry.pattern.test(value));
}

function redact(value: unknown, keyHint: string | null): unknown {
  if (typeof value === 'string') {
    if (!value) return value;
    if (keyHint && isSensitiveBundleKey(keyHint)) return REDACTED;
    return looksLikeSecretValue(value) ? REDACTED : value;
  }
  // The key hint follows an array INTO its elements (`credentials: [a, b]`)
  // and, for an object, is replaced by each child's own key.
  if (Array.isArray(value)) return value.map((item) => redact(item, keyHint));
  if (value && typeof value === 'object') {
    const out: Rec = {};
    for (const [key, child] of Object.entries(value as Rec)) out[key] = redact(child, key);
    return out;
  }
  return value;
}

function redactProjectContext(state: Rec): Rec {
  const context = state.projectContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return state;
  const rec = context as Rec;
  const redactedContext: Rec = { ...rec };
  if ('originalPrompt' in rec) redactedContext.originalPrompt = REDACTED;
  if ('summary' in rec) redactedContext.summary = REDACTED;
  if ('answers' in rec) redactedContext.answers = REDACTED;
  return { ...state, projectContext: redactedContext };
}

function redactState(state: Rec | null): Rec | null {
  if (!state) return null;
  return redactProjectContext(redact(state, null) as Rec);
}

export interface RedactedProjectProbe extends Omit<ProjectProbe, 'state' | 'normalizedState' | 'localPreferences'> {
  readonly state: Rec | null;
  readonly normalizedState: Rec | null;
  readonly localPreferences: Rec;
}

// The redacted project probe, shared by `--bundle` and doctor's DEFAULT stdout.
// Both are read by an agent following the traffic-one-doctor skill and land in
// model context and host transcripts, so "state only, no prompts, no secrets"
// cannot be a property of one output shape and not the other.
export function redactProjectProbe(project: ProjectProbe): RedactedProjectProbe {
  return {
    ...project,
    state: redactState(project.state),
    normalizedState: redactState(project.normalizedState),
    localPreferences: (redact(project.localPreferences, null) as Rec) || {},
  };
}

export interface RedactedDecisionRecord {
  readonly ts: string;
  readonly correlationId: string;
  readonly runId: string | null;
  readonly hookSeq: number;
  readonly event: DecisionRecord['event'];
  readonly host: DecisionRecord['host'];
  readonly decision: DecisionRecord['decision'];
  readonly gateId: string | null | undefined;
  readonly denyId: string | null | undefined;
  readonly denyTarget: string | undefined;
  readonly repeatCount: number | undefined;
}

function redactDecision(record: DecisionRecord): RedactedDecisionRecord {
  return {
    ts: record.ts,
    correlationId: record.correlationId,
    runId: record.runId,
    hookSeq: record.hookSeq,
    event: record.event,
    host: record.host,
    decision: record.decision,
    gateId: record.gateId,
    denyId: record.denyId,
    denyTarget: record.denyTarget,
    repeatCount: record.repeatCount,
  };
}

const BUNDLE_DECISION_LIMIT = 300;

export interface DoctorBundle {
  readonly generatedAt: string;
  readonly plugin: PluginIdentity;
  readonly redaction: {
    readonly policy: string;
    readonly redactsKeysMatching: string;
    readonly redactsValuesMatching: string;
  };
  readonly probes: {
    readonly node: NodeProbe;
    readonly nvm: NvmProbe;
    readonly gitnexus: GitnexusProbe;
    readonly project: RedactedProjectProbe;
    readonly codexHooks: CodexHooksProbe | null;
    readonly auth: CanonicalAuthProbe | null;
    readonly oneMcp: OneMcpProbe | null;
    readonly openCodeMcp: OpenCodeMcpProbe | null;
    readonly pluginRoot: PluginRootProbe;
    readonly sessionDiagnostics: SessionDiagnosticsResult;
  };
  readonly findings: Finding[];
  readonly runId: string | null;
  readonly runDiagnostic: RunDiagnosticProbe | null;
  readonly decisions: {
    readonly totalCount: number;
    readonly includedCount: number;
    readonly records: RedactedDecisionRecord[];
  };
}

export interface BuildDoctorBundleInput {
  plugin: PluginIdentity;
  node: NodeProbe;
  nvm: NvmProbe;
  gitnexus: GitnexusProbe;
  project: ProjectProbe;
  codexHooks: CodexHooksProbe | null;
  auth: CanonicalAuthProbe | null;
  oneMcp: OneMcpProbe | null;
  openCodeMcp: OpenCodeMcpProbe | null;
  pluginRoot: PluginRootProbe;
  sessionDiagnostics: SessionDiagnosticsResult;
  findings: Finding[];
  runId: string | null;
  runDiagnostic: RunDiagnosticProbe | null;
  decisions: DecisionRecord[];
}

export function buildDoctorBundle(input: BuildDoctorBundleInput): DoctorBundle {
  const decisions = input.decisions.slice(-BUNDLE_DECISION_LIMIT);
  return {
    generatedAt: new Date().toISOString(),
    plugin: input.plugin,
    redaction: {
      policy: 'projectContext.{originalPrompt,summary,answers} are redacted; any credential-named key '
        + `(${SENSITIVE_KEY_RULE}) has its string value redacted; every other string value is matched `
        + `against known credential shapes (${SECRET_VALUE_RULE}) and redacted on a hit; decision-log `
        + 'inputs/stateWrites are dropped entirely. No user source code and no prompt text are included '
        + 'by design. SECRET REDACTION IS BEST-EFFORT, NOT A GUARANTEE: it recognises credential-named '
        + 'keys plus the credential shapes listed above, and no pattern set recognises every secret — a '
        + 'credential stored under an unanticipated key name in an unanticipated format can still be '
        + 'present, so READ THIS BUNDLE BEFORE SHARING IT. ABSOLUTE FILESYSTEM PATHS ARE INCLUDED '
        + '(plugin root, project root, state/preferences/provenance/transcript paths), so on most '
        + 'machines this bundle reveals the OS account name in a home-directory path — review before '
        + 'pasting it somewhere public.',
      redactsKeysMatching: SENSITIVE_KEY_RULE,
      redactsValuesMatching: SECRET_VALUE_RULE,
    },
    probes: {
      node: input.node,
      nvm: input.nvm,
      gitnexus: input.gitnexus,
      project: redactProjectProbe(input.project),
      codexHooks: input.codexHooks,
      auth: input.auth,
      oneMcp: input.oneMcp,
      openCodeMcp: input.openCodeMcp,
      pluginRoot: input.pluginRoot,
      sessionDiagnostics: input.sessionDiagnostics,
    },
    findings: input.findings,
    runId: input.runId,
    runDiagnostic: input.runDiagnostic,
    decisions: {
      totalCount: input.decisions.length,
      includedCount: decisions.length,
      records: decisions.map(redactDecision),
    },
  };
}
