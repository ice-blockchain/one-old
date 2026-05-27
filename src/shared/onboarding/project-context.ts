// src/shared/onboarding/project-context.ts
// Project-context onboarding helpers: the canonical answer-key list, the
// original-prompt extractor, and the keyword-driven dynamic domain-question
// generator. Pure logic/data (no IO, no static directive prose). Ported 1:1
// from _helpers.cjs (PROJECT_CONTEXT_ANSWER_KEYS:1044, projectContextOriginalPrompt,
// projectContextDomainQuestionLines).

type Rec = Record<string, unknown>;

export const PROJECT_CONTEXT_ANSWER_KEYS = [
  'audience',
  'coreFlows',
  'v1Features',
  'rolesAuth',
  'businessModel',
  'payments',
  'admin',
  'dataModel',
  'contentSource',
  'integrations',
  'engagement',
  'successMetrics',
  'constraints',
  'domainSpecific',
] as const;

function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

// The user's first request, used to tailor onboarding questions. Checks the
// persisted projectContext.originalPrompt first, then loose top-level aliases.
export function projectContextOriginalPrompt(state: unknown): string {
  const s = obj(state);
  const pc = s && obj(s.projectContext);
  const candidates: unknown[] = [
    pc && pc.originalPrompt,
    s && s.originalPrompt,
    s && s.initialPrompt,
    s && s.firstPrompt,
    s && s.userPrompt,
    s && s.prompt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function promptMatches(prompt: string, pattern: RegExp): boolean {
  return pattern.test(String(prompt || '').toLowerCase());
}

// Domain-specific follow-up questions chosen by keyword-matching the original
// prompt. Always returns at least one line (a generic fallback).
export function projectContextDomainQuestionLines(originalPrompt = ''): string[] {
  const lines: string[] = [];
  const prompt = String(originalPrompt || '').toLowerCase();
  const isLearning = promptMatches(prompt, /\b(course|courses|lesson|lessons|learn|learning|academy|education|student|students|instructor|teacher|lms|curriculum|cohort|cohorts)\b/);
  const isMarketplace = promptMatches(prompt, /\b(marketplace|buyer|seller|vendor|provider|providers|freelancer|freelancers|employer|employers|candidate|candidates|job|jobs|listing|listings|commission|payout|payouts)\b/);
  const isEcommerce = promptMatches(prompt, /\b(ecommerce|e-commerce|shop|store|cart|checkout|product|products|order|orders|inventory|sku|subscription|subscriptions|billing|pricing|paid|payment|payments)\b/);
  const isBooking = promptMatches(prompt, /\b(booking|bookings|reservation|reservations|appointment|appointments|calendar|availability|schedule|scheduling|slot|slots)\b/);
  const isSaasAdmin = promptMatches(prompt, /\b(saas|dashboard|crm|erp|admin|administrator|manage|management|analytics|reporting|workflow|workflows|approval|approvals)\b/);
  const isCommunity = promptMatches(prompt, /\b(community|social|forum|forums|chat|message|messages|member|members|group|groups|moderation|moderator|comments)\b/);
  const isContent = promptMatches(prompt, /\b(content|cms|blog|article|articles|media|video|videos|audio|podcast|gallery|upload|uploads|asset|assets|newsletter)\b/);
  const isPortfolio = promptMatches(prompt, /\b(portfolio|personal site|case study|case studies|resume|cv|showcase|gallery|testimonials?)\b/);
  const isInternal = promptMatches(prompt, /\b(internal|backoffice|back office|operations|ops|employee|employees|staff|team tool|admin tool|intranet)\b/);
  const mightCharge = isMarketplace
    || isEcommerce
    || promptMatches(prompt, /\b(paid|payment|payments|stripe|checkout|subscription|subscriptions|billing|pricing|plan|plans|invoice|invoices|refund|refunds|coupon|coupons|commission|payout|payouts|membership|memberships)\b/);

  if (isLearning) {
    lines.push('Learning platform specifics: course/module/lesson structure, lesson types, progress/completion rules, enrollment model, free vs paid courses, learner/instructor/admin roles, admin CRUD scope, seeded demo content, analytics, and whether payments are in or out for v1.');
  }
  if (isMarketplace) {
    lines.push('Marketplace specifics: supply/demand sides, listing workflow, matching/search filters, applications/bookings/orders, messaging, reviews, moderation, commission/payout model, disputes, and admin controls.');
  }
  if (isEcommerce) {
    lines.push('Ecommerce specifics: product/catalog structure, inventory, cart/checkout, order statuses, fulfillment, coupons, taxes, refunds, customer accounts, and admin order/product management.');
  }
  if (isBooking) {
    lines.push('Booking specifics: bookable resources, availability rules, calendar sync, deposits/cancellations, reminders, rescheduling, provider/customer roles, and admin scheduling overrides.');
  }
  if (isSaasAdmin) {
    lines.push('SaaS/admin specifics: tenants/workspaces, dashboards, reports, role permissions, audit trail, import/export, approvals, operational queues, and admin analytics.');
  }
  if (isCommunity) {
    lines.push('Community specifics: profiles, posting/commenting, groups, messaging, moderation queues, reporting, notifications, reputation, and admin safety tools.');
  }
  if (isContent) {
    lines.push('Content/media specifics: content types, editorial workflow, uploads/storage, publishing states, tags/search, SEO needs, moderation, and admin CMS controls.');
  }
  if (isPortfolio) {
    lines.push('Portfolio specifics: primary audience, featured work, case-study structure, contact/lead capture, testimonials, CMS needs, analytics, and launch content.');
  }
  if (isInternal) {
    lines.push('Internal-tool specifics: operator roles, approval workflows, data import/export, reporting, audit/history needs, permission boundaries, and admin/support workflows.');
  }
  if (mightCharge) {
    lines.push('Payment integration, if money is in scope: Stripe or other provider, subscriptions vs one-time checkout, webhooks, refunds, invoices, taxes, coupons, and marketplace payouts/commissions if relevant.');
  }
  if (lines.length === 0) {
    lines.push('Domain specifics: based on the product category, name the entities, workflows, admin surfaces, integrations, and edge cases that must exist for a complete MVP.');
  }
  return lines;
}
