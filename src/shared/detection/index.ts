// src/shared/detection/index.ts
// Stack reconciliation and mode detection over the artifact probes.

import * as path from 'path';
import { readJson } from '../fsjson';
import { effectiveLegacyRunStatus } from '../run-settlement';
import { frontendArtifactsPresent } from '../capabilities';

import {
  detectBackendFromText,
  detectFrontendFromText,
  detectGoBackendArtifacts,
  detectMobileFromText,
  includesAny,
} from './artifacts';

type Rec = Record<string, unknown>;

export function reconcileStackFromArtifacts(cwd: string, state: unknown): boolean {
  const s = state && typeof state === 'object' ? (state as Rec) : null;
  if (!s) return false;
  const hasGo = detectGoBackendArtifacts(cwd);
  const legacyImplicitFrontend = s.stack === 'custom-backend' && s.frontend === 'react-vite'
    && !frontendArtifactsPresent(cwd);
  const runId = typeof s.currentRunId === 'string' ? s.currentRunId.trim() : '';
  const runLedger = runId
    ? readJson<Rec>(path.join(cwd, '.traffic-one', 'runs', runId, 'run.json'), {})
    : {};
  const effectiveRunStatus = effectiveLegacyRunStatus(runLedger);
  const activeRun = runId && (effectiveRunStatus === 'planned' || effectiveRunStatus === 'active');
  if (!hasGo && (!legacyImplicitFrontend || activeRun)) return false;

  if (hasGo) {
    const staleSupabase = s.stack === 'default' || s.backend === 'supabase';
    if (!staleSupabase && s.backend === 'go' && s.stack === 'custom-backend' && !legacyImplicitFrontend) return false;
    s.backend = 'go';
    s.stack = frontendArtifactsPresent(cwd) ? 'custom-stack' : 'custom-backend';
  }
  if (legacyImplicitFrontend && !activeRun) s.frontend = 'none';

  const evidence = Array.isArray(s.evidence) ? s.evidence.filter((item): item is string => typeof item === 'string') : [];
  const notes = [...evidence];
  if (hasGo) {
    const note = `Go backend artifacts detected after scaffold → reconciled state to ${String(s.stack)}/go`;
    if (!notes.includes(note)) notes.push(note);
  }
  if (legacyImplicitFrontend && !activeRun) {
    const note = 'Legacy custom-backend React fallback removed because no frontend artifacts exist';
    if (!notes.includes(note)) notes.push(note);
  }
  s.evidence = notes;
  return true;
}

interface PromptClassification {
  stack: string;
  frontend: string;
  backend: string;
  mobile: { enabled: boolean; framework: string; source: string };
  shouldAskMobile: boolean;
  evidence: {
    frontend: string | null;
    backend: string | null;
    mobileIntentDetected: boolean;
    backendNeed: boolean;
    wantsMinimal: boolean;
  };
}

export function classifyPromptForStack(prompt: unknown): PromptClassification {
  const text = String(prompt || '').toLowerCase();
  const frontend = detectFrontendFromText(text);
  const backend = detectBackendFromText(text);
  const mobile = detectMobileFromText(text);
  const wantsMinimal = includesAny(text, [
    /\blanding page\b/, /\bpresentation\b/, /\bbrochure\b/, /\bportfolio\b/,
    /\bone[- ]page\b/, /\bstatic\b/, /\bsimple website\b/,
  ]);
  const backendNeed = includesAny(text, [
    /\bauth\b/, /\blogin\b/, /\bsign ?up\b/, /\busers?\b/, /\bprofiles?\b/,
    /\bcrud\b/, /\bdatabase\b/, /\bdb\b/, /\bbackend\b/, /\bapi\b/,
    /\buploads?\b/, /\bfiles?\b/, /\brealtime\b/, /\breal[- ]time\b/,
    /\bdashboard\b/, /\badmin\b/, /\bpayments?\b/, /\bmarketplace\b/,
    /\bsaas\b/, /\bmvp\b/, /\bplatform\b/,
  ]);
  const explicitCustomFrontend = Boolean(frontend && frontend !== 'react-vite');
  const explicitCustomBackend = Boolean(backend && backend !== 'supabase' && backend !== 'none');
  const noBackend = backend === 'none';
  // API-only: an explicit custom backend + API-service vocabulary + ZERO
  // frontend/UI signals proposes `frontend: none`, not the react-vite fallback.
  // Observed 13c: "create a golang api project…" scaffolded a full React app +
  // pnpm monorepo nobody asked for, because `frontend || 'react-vite'` had no
  // API-only concept and the wizard preselected the fallback. Deliberately
  // scoped to explicit custom backends (go/rust/java/php/…): ambiguous
  // supabase-tier prompts keep the web default, and the wizard still lets the
  // user add a frontend.
  const apiOnlyBackend = !frontend && !mobile.enabled && explicitCustomBackend
    && includesAny(text, [
      /\bapis?\b/, /\bmicroservices?\b/, /\bgrpc\b/, /\brest(?:ful)?\b/,
      /\bendpoints?\b/, /\bbackend\b/, /\bserver\b/, /\bworkers?\b/, /\bcli\b/,
    ])
    && !includesAny(text, [
      /\bfront[- ]?end\b/, /\bui\b/, /\bux\b/, /\bwebsites?\b/, /\bweb ?app\b/,
      /\bsite\b/, /\bpages?\b/, /\bdashboards?\b/, /\binterface\b/,
      /\bscreens?\b/, /\bresponsive\b/, /\bdesign\b/, /\bcomponents?\b/,
    ]);

  let resolvedFrontend = frontend
    || (apiOnlyBackend ? 'none' : (backend === 'laravel' ? 'other' : 'react-vite'));
  let resolvedBackend = backend || (backendNeed ? 'supabase' : 'none');
  let stack: string;

  if (wantsMinimal && !backendNeed && !frontend && !mobile.enabled) {
    stack = 'minimal';
    resolvedFrontend = 'none';
    resolvedBackend = 'none';
  } else if (mobile.enabled && !frontend) {
    stack = explicitCustomBackend ? 'custom-stack' : 'custom-frontend';
    resolvedFrontend = mobile.framework === 'ionic-capacitor' ? 'react-vite' : 'none';
  } else if (explicitCustomFrontend && explicitCustomBackend) {
    stack = 'custom-stack';
  } else if (explicitCustomFrontend) {
    stack = 'custom-frontend';
  } else if (explicitCustomBackend) {
    stack = resolvedFrontend === 'none' ? 'custom-backend' : 'custom-stack';
  } else if (noBackend) {
    stack = resolvedFrontend === 'none' ? 'minimal' : 'custom-frontend';
  } else if (backendNeed) {
    stack = 'default';
  } else if (frontend === 'react-vite') {
    stack = resolvedBackend === 'none' ? 'custom-frontend' : 'default';
  } else {
    stack = 'minimal';
    resolvedFrontend = 'none';
    resolvedBackend = 'none';
  }

  return {
    stack,
    frontend: resolvedFrontend,
    backend: resolvedBackend,
    mobile: { enabled: mobile.enabled, framework: mobile.framework, source: mobile.source },
    shouldAskMobile: stack !== 'minimal',
    evidence: {
      frontend: frontend || null,
      backend: backend || null,
      mobileIntentDetected: mobile.intentDetected,
      backendNeed,
      wantsMinimal,
    },
  };
}

// Deterministic coding-intent heuristic. Used only to suppress PREMATURE Traffic
// One activation: on a brand-new project with no active wizard, a clearly
// non-coding prompt (greeting, question, chit-chat) should not kick off setup.
// Biased toward `true` (false positives merely activate a beat early); the moment
// state exists, a wizard is running, or a tool is attempted, the normal path runs
// regardless — so an active project is never mis-skipped.
const CODING_INTENT_PATTERNS: RegExp[] = [
  /\b(build|create|make|add|implement|scaffold|generate|set ?up|develop|write|wire|integrate|configure|deploy|ship|fix|refactor|debug|optimi[sz]e|migrate|test|lint|typecheck|install|update|upgrade|rename|delete|remove|extract|split)\b/,
  /\b(app|application|web ?app|website|site|landing page|page|route|screen|view|component|feature|module|api|endpoint|backend|frontend|server|client|database|db|schema|table|migration|query|auth|login|signup|dashboard|form|button|modal|chart|service|function|hook|store|repo|repository|codebase|project|monorepo|package|library|dependency|bug|error|stack ?trace|test|ci|pipeline)\b/,
  /\b(react|vite|next\.?js|vue|svelte|angular|astro|solid|remix|supabase|postgres|mysql|mongo|firebase|tailwind|typescript|javascript|node|python|django|express|stripe|expo|capacitor|ionic|playwright|vitest|jest|docker|kubernetes|graphql|rest)\b/,
  /[`{}();]|=>|\bnpm\b|\bpnpm\b|\byarn\b|\bgit\b|\.(ts|tsx|js|jsx|py|go|rs|sql|json|md)\b/,
];

export function isLikelyCodingPrompt(prompt: unknown): boolean {
  const text = String(prompt || '').toLowerCase().trim();
  if (!text) return false;
  return CODING_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

// Narrow operational classifier for an already-running local project. This is NOT
// a general coding-intent signal: it is consumed only by maintenance/unresolved-run
// routing so a parent can handle local runtime control without creating a worker run.
// Whole-prompt anchors are deliberate. A request that also asks to fix code/config,
// change startup behavior, or add an endpoint must continue through normal routing.
const RUNTIME_IMPLEMENTATION_WORDS = /\b(?:add|build|chang\w*|configur\w*|creat\w*|debug|edit\w*|fix\w*|implement\w*|install\w*|modif\w*|patch\w*|refactor\w*|resolv\w*|rewrit\w*|updat\w*)\b/;

function isSingleRuntimeControlClause(text: string): boolean {
  const polite = '(?:(?:please|just|now)\\s+)*(?:(?:can|could|would|will)\\s+you\\s+)?(?:please\\s+)?';
  const tail = '(?:\\s+(?:please|now|again|for\\s+me))?';
  const server = '(?:the\\s+)?(?:local\\s+)?(?:vite\\s+)?(?:(?:dev(?:elopment)?|preview)\\s+)?server';
  const action = '(?:start|stop|restart|re-start|relaunch|launch|run|kill|shut\\s+down|bring\\s+up)';
  const portSuffix = '(?:\\s+(?:on|at)\\s+port\\s+\\d{2,5})?';
  const patterns = [
    new RegExp(`^${polite}${action}\\s+${server}${portSuffix}${tail}$`),
    new RegExp(`^${polite}(?:stop|shut\\s+down)\\s+(?:and\\s+(?:then\\s+)?)(?:restart|start)\\s+${server}${portSuffix}${tail}$`),
    // Direct package-manager runtime commands, optionally introduced by "run".
    new RegExp(`^${polite}(?:run\\s+)?(?:npm(?:\\s+run)?|pnpm|yarn|bun(?:\\s+run)?)\\s+(?:dev|start|preview)(?:\\s+--(?:host|port)(?:[=\\s]+[\\w.:-]+)?)?${tail}$`),
    // Server/process status checks.
    new RegExp(`^${polite}(?:check|see)(?:\\s+(?:whether|if))?\\s+(?:the\\s+)?(?:process|pid)\\s+\\d+\\s+is\\s+(?:running|alive|up|down)${tail}$`),
    new RegExp(`^${polite}is\\s+(?:the\\s+)?(?:process|pid)\\s+\\d+\\s+(?:running|alive|up|down)${tail}$`),
    new RegExp(`^${polite}(?:check|inspect|show|list|find)(?:\\s+me)?(?:\\s+the)?\\s+(?:local\\s+)?(?:vite\\s+)?(?:(?:dev(?:elopment)?|preview)\\s+)?(?:server\\s+)?(?:(?:process|pid)(?:\\s+\\d+)?|port(?:\\s+\\d{2,5})?)(?:\\s+(?:status|usage))?${tail}$`),
    new RegExp(`^${polite}(?:check|see)(?:\\s+(?:whether|if))?\\s+(?:the\\s+)?(?:(?:local\\s+)?(?:(?:dev(?:elopment)?|preview)\\s+)?server|port\\s+\\d{2,5})\\s+is\\s+(?:running|listening|open|free|available|in\\s+use|up|down)${tail}$`),
    new RegExp(`^${polite}is\\s+(?:the\\s+)?(?:(?:local\\s+)?(?:(?:dev(?:elopment)?|preview)\\s+)?server\\s+(?:running|up|down)|port\\s+\\d{2,5}\\s+(?:open|free|available|in\\s+use|listening))${tail}$`),
    new RegExp(`^${polite}(?:what|which)\\s+(?:process|pid)\\s+is\\s+(?:using|on|listening\\s+on)\\s+port\\s+\\d{2,5}${tail}$`),
    new RegExp(`^${polite}(?:what(?:'s|\\s+is)|show(?:\\s+me)?)\\s+(?:running|listening)\\s+on\\s+port\\s+\\d{2,5}${tail}$`),
    new RegExp(`^${polite}(?:stop|kill|terminate)\\s+(?:the\\s+)?(?:process|pid)(?:\\s+\\d+)?\\s+(?:(?:that\\s+is|currently)\\s+)?(?:using|on|listening\\s+on)\\s+port\\s+\\d{2,5}${tail}$`),
    // Local server log display/tailing (read-only runtime observation).
    new RegExp(`^${polite}(?:show|view|get|display|print|read|check|tail|stream|watch)(?:\\s+me)?\\s+(?:the\\s+)?(?:local\\s+)?(?:(?:dev(?:elopment)?|preview)\\s+)?server\\s+logs${tail}$`),
    new RegExp(`^${polite}(?:show|view|get|display|print|read|check|tail|stream|watch)(?:\\s+me)?\\s+(?:the\\s+)?logs\\s+(?:for|from)\\s+${server}${tail}$`),
    // In a multi-clause request the first server-control clause supplies the
    // context, so an exactly anchored "show/view/get the logs" clause is safe.
    new RegExp(`^${polite}(?:show|view|get|display|print|read|check|tail|stream|watch)(?:\\s+me)?\\s+(?:the\\s+)?logs${tail}$`),
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export function isRuntimeControlPrompt(prompt: unknown): boolean {
  const text = String(prompt || '')
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!text || text.length > 240 || RUNTIME_IMPLEMENTATION_WORDS.test(text)) return false;
  if (isSingleRuntimeControlClause(text)) return true;
  // Multiple requests are operational only when EVERY clause is independently a
  // runtime-control command. "restart the server and fix startup" therefore routes.
  const clauses = text.split(/\s+(?:and\s+then|then|and)\s+/);
  return clauses.length > 1 && clauses.every((clause) => isSingleRuntimeControlClause(clause));
}

// True when the prompt carries an explicit STACK signal — i.e. it reads as a real
// project description even without an imperative coding verb. Derived from
// classifyPromptForStack so there is ONE keyword source of truth (its backendNeed /
// frontend / backend / mobile / wantsMinimal evidence) rather than a parallel list
// that drifts out of sync with isLikelyCodingPrompt. The coding-intent gate uses
// this to AVOID dropping a verb-less first prompt like "a marketplace for
// freelancers": dropping it loses the genuine project description, and a later thin
// "ok build it" then becomes the seeded originalPrompt and derives `minimal`. A pure
// greeting/question ("hi there") has no stack signal, so the gate still suppresses it.
export function promptHasStackSignal(prompt: unknown): boolean {
  const text = String(prompt || '').toLowerCase().trim();
  if (!text) return false;
  const { evidence } = classifyPromptForStack(text);
  return Boolean(
    evidence.backendNeed
    || evidence.frontend
    || evidence.backend
    || evidence.mobileIntentDetected
    || evidence.wantsMinimal,
  );
}

// Broader edit-intent patterns for POST-BUILD MAINTENANCE: once the app exists, the
// bar for "this is an edit request" is lower than the onboarding coding-intent bar.
// Copy tweaks ("change the hero headline"), restyles ("shorten the title", "move the
// footer"), and other imperative edits use verbs/nouns the coding-intent heuristic
// omits, so they would otherwise skip post-build triage entirely.
const EDIT_INTENT_PATTERNS: RegExp[] = [
  /\b(chang\w+|tweak|adjust|reword|rewrit\w+|replac\w+|swap|shorten|lengthen|expand|moves?|moving|relocat\w+|hide|hidden|show|reveal|increas\w+|decreas\w+|bump|drop|switch|toggl\w+|reorder|re-?order|align|cent(er|re)\w*|resiz\w+|restyl\w+|re-?colou?r|recolou?r|tighten|loosen|capitali[sz]\w+|bold|italici[sz]\w+|underlin\w+|uppercase|lowercase|shrink|enlarge|nudge|polish|simplif\w+|trim|truncat\w+|tidy|cleanup|clean up)\b/,
  /\b(headlines?|hero|sub[- ]?headlines?|sub[- ]?titles?|taglines?|titles?|headings?|copy|wording|labels?|captions?|placeholders?|colou?rs?|fonts?|font[- ]?sizes?|spacing|paddings?|margins?|banners?|footers?|headers?|nav(bar|igation)?|menus?|tooltips?|paragraphs?|sentences?|texts?|wordings?|icons?|logos?|images?|spinners?|badges?|tabs?)\b/,
];

// True when a maintenance-phase prompt looks like an edit/work request (a superset
// of isLikelyCodingPrompt). Used to gate post-build triage so trivial copy/UI edits
// route through it; biased toward firing (a stray directive on a read prompt is
// cheap, a missed directive on an edit is the bug this guards against).
export function isLikelyEditRequest(prompt: unknown): boolean {
  const text = String(prompt || '').toLowerCase().trim();
  if (!text) return false;
  if (isLikelyCodingPrompt(text)) return true;
  return EDIT_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}
export {
  SOURCE_EXTS,
  countSourceFiles,
  dependenciesFromPackage,
  detectBackendFromText,
  detectFrontendFromText,
  detectGoBackendArtifacts,
  detectMode,
  detectStackFromCodebase,
  hasWorkspaces,
  loadPackageJson,
} from './artifacts';
