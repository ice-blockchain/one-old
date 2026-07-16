// Shared model-start/runtime failure classifier. Keep this deliberately narrow:
// model selection policy may condemn or downgrade a model based on the result,
// so generic API, auth, network, context, and user-cancel failures must not be
// upgraded into either an API-budget failure or a "model disabled" diagnosis.

export type ModelFailureKind = 'api-limit' | 'model-unavailable' | 'generic';

const API_LIMIT_CODES_RE = /\b(?:api_limit_exceeded|rate_limit_exceeded|resource_exhausted|error_rate_limited_changeable)\b/i;
const HTTP_RATE_LIMIT_RE = /\b(?:http(?:\s+status)?\s*[:=]?\s*429|status(?:\s+code)?\s*[:=]?\s*429|429\s*[-:]?\s*too\s+many\s+requests|too\s+many\s+requests)\b/i;
const NAMED_LIMIT_RE = new RegExp(
  String.raw`\bapi(?:\s+usage)?\s*[- ]?limit\b`
  + '|'
  + String.raw`\b(?:api(?:\s+usage)?|usage|rate)\s*[- ]?limit(?:s)?\s+(?:has\s+|have\s+|was\s+|were\s+|is\s+|been\s+)?(?:exceeded|reached|hit)\b`
  + '|'
  + String.raw`\b(?:hit|exceeded|reached|reaching)\s+(?:the\s+|an\s+|your\s+|our\s+)?(?:api(?:\s+usage)?|usage|rate)\s*[- ]?limit(?:s)?\b`
  + '|'
  + String.raw`\brate[- ]limited\b`
  + '|'
  + String.raw`\busage\s+cap\s+(?:has\s+|was\s+|is\s+)?(?:exceeded|reached|hit)\b`,
  'i',
);
const QUOTA_LIMIT_RE = new RegExp(
  String.raw`\bquota(?:[_ -]+limit)?(?:[_ -]+has|[_ -]+was|[_ -]+is)?(?:[_ -]+been)?[_ -]+(?:exceeded|reached|hit)\b`
  + '|'
  + String.raw`\b(?:hit|exceeded|reached)[_ -]+(?:the[_ -]+|your[_ -]+|our[_ -]+)?quota(?:[_ -]+limit)?\b`,
  'i',
);

// Remove explicit negative claims before testing the positive vocabulary. The
// broad positive matcher intentionally accepts terse incident labels such as
// "API limit", but those same words also occur in successful reports ("No API
// limit was reached"). Stripping only grammatically-negated clauses keeps a
// later, independent positive error in the same text detectable.
const NEGATED_API_LIMIT_CLAIM_RE = new RegExp(
  String.raw`\bno\s+(?:api(?:\s+usage)?|usage|rate)\s*[- ]?limit(?:s)?(?:\s+(?:was|were|is|has\s+been))?(?:\s+(?:reached|hit|exceeded))?\b`
  + '|'
  + String.raw`\b(?:api(?:\s+usage)?|usage|rate)\s*[- ]?limit(?:s)?\s+(?:was|were|is|has\s+been)\s+not\s+(?:reached|hit|exceeded)\b`
  + '|'
  + String.raw`\b(?:did|does|do|has|have)\s+not\s+(?:reach|hit|exceed)\s+(?:the\s+|an\s+|your\s+|our\s+)?(?:api(?:\s+usage)?|usage|rate)\s*[- ]?limit(?:s)?\b`
  + '|'
  + String.raw`\bnot\s+rate[- ]limited\b`
  + '|'
  + String.raw`\bwithout\s+(?:reaching|hitting|exceeding)\s+(?:the\s+|an\s+|your\s+|our\s+)?(?:api(?:\s+usage)?|usage|rate)\s*[- ]?limit(?:s)?\b`
  + '|'
  + String.raw`\bno\s+quota(?:\s+limit)?(?:\s+(?:was|were|is|has\s+been))?(?:\s+(?:reached|hit|exceeded))?\b`
  + '|'
  + String.raw`\bquota(?:\s+limit)?\s+(?:was|were|is|has\s+been)\s+not\s+(?:reached|hit|exceeded)\b`,
  'gi',
);

// Positive model-availability vocabulary must be grammatically attached to
// "model". Merely seeing "unavailable" near a model-loading/network error is
// not enough to tell the user to change Cursor Settings.
const MODEL_UNAVAILABLE_AFTER_RE = new RegExp(
  String.raw`\b(?:requested\s+|selected\s+|chosen\s+)?model\b`
  + String.raw`(?:\s+(?:id|name)\s*[:=])?`
  + String.raw`(?:\s+[\"'\x60]?[a-z0-9][a-z0-9._:-]*[\"'\x60]?)?`
  + String.raw`\s*(?:(?:is|was|has\s+been|appears|seems)(?:\s+currently)?\s+)?`
  + String.raw`(?:not\s+enabled|disabled|unavailable|invalid|unsupported|unknown|not\s+found)\b`,
  'i',
);
const MODEL_UNAVAILABLE_BEFORE_RE = new RegExp(
  String.raw`\b(?:not\s+enabled|disabled|unavailable|invalid|unsupported|unknown|not\s+found)\b`
  + String.raw`\s+(?:for\s+)?(?:the\s+|this\s+|that\s+|requested\s+|selected\s+|chosen\s+)?model\b`,
  'i',
);

export function isApiUsageLimitText(text: unknown): boolean {
  if (typeof text !== 'string' || !text.trim()) return false;
  const positiveEvidence = text.replace(NEGATED_API_LIMIT_CLAIM_RE, ' ');
  return API_LIMIT_CODES_RE.test(positiveEvidence)
    || HTTP_RATE_LIMIT_RE.test(positiveEvidence)
    || NAMED_LIMIT_RE.test(positiveEvidence)
    || QUOTA_LIMIT_RE.test(positiveEvidence);
}

export function isModelUnavailableText(text: unknown): boolean {
  if (typeof text !== 'string' || !text.trim()) return false;
  // Error constants commonly use underscores. Preserve hyphens because they
  // are part of Cursor model slugs (gpt-5.6-terra-medium).
  const normalized = text.replace(/_+/g, ' ');
  return MODEL_UNAVAILABLE_AFTER_RE.test(normalized)
    || MODEL_UNAVAILABLE_BEFORE_RE.test(normalized);
}

export function classifyModelFailureText(text: unknown): ModelFailureKind {
  if (isApiUsageLimitText(text)) return 'api-limit';
  if (isModelUnavailableText(text)) return 'model-unavailable';
  return 'generic';
}
