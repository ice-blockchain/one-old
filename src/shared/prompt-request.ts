// src/shared/prompt-request.ts
// Host modal/popup-input request specs used by the agent-model gate. Onboarding
// and API-key intake live exclusively in the local wizard.

export interface PromptOption {
  id: string;
  label: string;
}

export interface PromptRequest {
  id: string;
  kind: string;
  title: string;
  question: string;
  blocking: boolean;
  options?: PromptOption[];
  fallbackText?: string;
}

export function singleSelectPromptRequest(args: {
  id: string;
  title: string;
  question: string;
  options: PromptOption[];
  fallbackText?: string;
}): PromptRequest {
  return {
    id: args.id,
    kind: 'single_select',
    title: args.title,
    question: args.question,
    options: args.options,
    blocking: true,
    ...(args.fallbackText ? { fallbackText: args.fallbackText } : {}),
  };
}

// The recommended-model-unavailable spawn choice (Cursor). Surfaces as a modal on
// hosts that render promptRequest (Claude); on Cursor/Codex the question rides the
// deny `reason` prose instead (those hosts drop promptRequest), so the gate always
// passes the same text as `fallbackText`. Cause-agnostic labels: the recommended
// model can be unavailable because the API budget is exhausted OR because it's
// disabled in Settings → Models — Cursor exposes no signal to tell which.
export function modelUnavailablePromptRequest(expected: string, fallback: string, fallbackText?: string): PromptRequest {
  return singleSelectPromptRequest({
    id: 'traffic-one.agent-model.model-unavailable-choice',
    title: 'Traffic One — recommended model unavailable',
    question: `"${expected}" can't be used for this subagent (likely API budget exhausted, or it's disabled in Settings → Models). Fix the cause and retry, or use the fallback "${fallback}"?`,
    options: [
      { id: 'enable-retry', label: `Restore budget / enable ${expected}, then retry (Recommended)` },
      { id: 'use-fallback', label: `Use ${fallback} now` },
    ],
    ...(fallbackText ? { fallbackText } : {}),
  });
}
