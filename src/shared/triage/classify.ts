// src/shared/triage/classify.ts
// Deterministic, keyword-based complexity hint for a post-build (maintenance-phase)
// prompt. Hooks cannot call an LLM, so this produces a *hint* only — the injected
// triage directive makes the main agent (which has full repo context) the
// authoritative classifier. The hint is a prior, not a verdict.
//
// Escalation bias: a false "complex" only wastes some tokens, but a false "trivial"
// ships an under-engineered feature. So the classifier picks the HIGHEST-complexity
// signal present, and an ambiguous prompt (no signal) resolves to `small`, NEVER
// `trivial`. `confidence` tells the agent how much to trust the hint.

export type ComplexityTier = 'trivial' | 'small' | 'complex';

export interface TriageHint {
  tier: ComplexityTier;
  confidence: 'low' | 'high';
  signals: string[];
}

interface Signal { re: RegExp; tag: string; }

// Strong domain signals → cross-cutting work that warrants the full orchestrator.
const STRONG_COMPLEX: Signal[] = [
  { re: /\b(auth(entication|oriz\w+)?|login|log[\s-]?in|sign[\s-]?up|sign[\s-]?in|oauth|sso|jwt|rbac|permissions?|role[\s-]?based)\b/i, tag: 'auth' },
  { re: /\b(payments?|billing|checkout|stripe|subscri\w*|invoices?|paywall)\b/i, tag: 'payments' },
  { re: /\b(schema|migrations?|migrate|new table|data[\s-]?model|prisma model|\brls\b|row[\s-]?level security)\b/i, tag: 'data-model' },
  { re: /\b(integrat\w+|webhooks?|third[\s-]?party|external api|sync with)\b/i, tag: 'integration' },
  { re: /\b(real[\s-]?time|websockets?|live updates?)\b/i, tag: 'realtime' },
  { re: /\b(dashboards?|admin panel|multi[\s-]?step|wizard|end[\s-]?to[\s-]?end)\b/i, tag: 'large-surface' },
];

// Weaker signals → probably more than a quick fix, but uncertain (confidence: low).
const WEAK_COMPLEX: Signal[] = [
  { re: /\b(new|add(ing)?|build|implement|creat\w+|introduc\w+)\b[^.]{0,30}\bfeature\b/i, tag: 'feature' },
  { re: /\bacross\b[^.]{0,30}\b(app|codebase|pages?|files?|screens?|modules?|components?)\b/i, tag: 'cross-cutting' },
  { re: /\b(refactor\w*|restructur\w*|re[\s-]?architect\w*|rewrit\w*)\b/i, tag: 'refactor' },
  { re: /\bnew\b[^.]{0,20}\b(pages?|screens?|routes?|views?)\b/i, tag: 'new-page' },
];

// Concrete, low-risk edits.
const TRIVIAL: Signal[] = [
  { re: /\btypos?\b/i, tag: 'typo' },
  { re: /\b(colou?rs?|css|styl(e|es|ing)|paddings?|margins?|spacing|font([\s-]?size)?|borders?|background|align(ment)?)\b/i, tag: 'styling' },
  { re: /\brename\b/i, tag: 'rename' },
  { re: /\b(format(ting)?|prettier|lint(ing)?|indentation|whitespace)\b/i, tag: 'formatting' },
  // change-verb … text-noun within one clause. The window is generous (80) so a
  // headline sits between them — "change the <long hero headline> text" — without
  // needing the noun adjacent to the verb. Gated behind no strong/weak signal, so a
  // domain request ("change the auth flow text") is still complex, not trivial.
  { re: /\b(change|updat\w+|fix|edit|tweak|adjust|reword|rewrit\w*|replac\w*|swap|correct|set)\b[^.]{0,80}\b(text|copy|wording|labels?|captions?|placeholders?|headings?|headlines?|taglines?|titles?|messages?|strings?|cta)\b/i, tag: 'copy' },
  { re: /\b(text|copy|labels?|wording|headlines?|taglines?|titles?)\b[^.]{0,40}\b(change|updat\w+|fix|typo|wrong|incorrect|reword|replac\w*)\b/i, tag: 'copy' },
];

// "just/quick/small/…" — an explicit smallness modifier from the user.
const EXPLICIT_SMALL = /\b(just|simply|quick(ly)?|small|tiny|minor|one[\s-]?line|single[\s-]?line|trivial)\b/i;

function fired(signals: Signal[], text: string): string[] {
  const tags: string[] = [];
  for (const s of signals) if (s.re.test(text) && !tags.includes(s.tag)) tags.push(s.tag);
  return tags;
}

export function classifyPromptComplexity(prompt: unknown): TriageHint {
  const text = typeof prompt === 'string' ? prompt : '';
  const strong = fired(STRONG_COMPLEX, text);
  const weak = fired(WEAK_COMPLEX, text);
  const trivial = fired(TRIVIAL, text);
  const explicitSmall = EXPLICIT_SMALL.test(text);

  // Highest signal wins. Strong domain work is complex regardless of trivial-looking
  // words elsewhere in the sentence ("fix the login button color" → complex hint; the
  // agent, seeing it is just CSS, can still route it down — the hint only biases).
  // Mixed evidence is NOT high confidence: when a trivial signal also fired, or the
  // user said "just"/"quick", the domain word is often a page/column NAME ("the signup
  // page", "sort by signup date"), so surface ALL fired signals and let the agent — who
  // sees the actual repo — weigh them, instead of anchoring it with a confident label.
  if (strong.length > 0) {
    const mixed = trivial.length > 0 || explicitSmall;
    return { tier: 'complex', confidence: mixed ? 'low' : 'high', signals: [...strong, ...weak, ...trivial] };
  }

  // Weak complexity (a feature/refactor/cross-cut with no strong domain anchor):
  // probably complex, but uncertain. An explicit "just/quick/small" + a concrete
  // trivial signal downgrades it to trivial; otherwise escalate at low confidence.
  if (weak.length > 0) {
    if (explicitSmall && trivial.length > 0) {
      return { tier: 'trivial', confidence: 'low', signals: [...trivial, ...weak] };
    }
    return { tier: 'complex', confidence: 'low', signals: [...weak, ...trivial] };
  }

  if (trivial.length > 0) {
    return { tier: 'trivial', confidence: 'high', signals: trivial };
  }

  // Ambiguous — never trivial. `small` is the safe residual: a single role can take
  // it, and the agent escalates if it turns out to be more.
  return { tier: 'small', confidence: 'low', signals: [] };
}
