// src/runners/qa-evidence/browser-steps.ts
// Scenario step primitives: the runtime probe init script, step execution,
// console/network event text, and route slugs for artifact names.

import type { PageLike, ScenarioStep } from './types';

export async function executeStep(page: PageLike, step: ScenarioStep, timeoutMs: number): Promise<void> {
  if (step.type === 'expect-url') {
    if (new URL(page.url()).pathname !== step.value) {
      throw new Error(`expected URL path ${step.value}, observed ${new URL(page.url()).pathname}`);
    }
    return;
  }
  const locator = page.locator(step.selector!).first();
  if (step.type === 'expect-visible') {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    if (!await locator.isVisible()) throw new Error(`selector is not visible: ${step.selector}`);
  } else if (step.type === 'expect-text') {
    const text = await locator.textContent();
    if (!text?.includes(step.value!)) throw new Error(`selector ${step.selector} did not contain expected text`);
  } else if (step.type === 'click') {
    await locator.click();
  } else if (step.type === 'fill') {
    await locator.fill(step.value!);
  } else if (step.type === 'press') {
    await locator.press(step.value!);
  } else if (step.type === 'check') {
    await locator.check();
  } else if (step.type === 'select') {
    await locator.selectOption(step.value!);
  }
}
export function eventText(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const text = (value as { text?: () => string }).text;
  if (typeof text === 'function') {
    try { return text.call(value).slice(0, 2_000); } catch { return '<unreadable>'; }
  }
  return String(value).slice(0, 2_000);
}
export const RUNTIME_PROBE_INIT_SCRIPT = `(() => {
  const probe = {
    documentToken: typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : String(Date.now()) + "-" + String(Math.random()),
    listenerRegistrations: 0
  };
  Object.defineProperty(globalThis, "__trafficOneQaRuntimeV1", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: probe
  });
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  Object.defineProperty(EventTarget.prototype, "addEventListener", {
    configurable: true,
    writable: true,
    value: function trafficOneObservedAddEventListener(...args) {
      probe.listenerRegistrations += 1;
      return Reflect.apply(originalAddEventListener, this, args);
    }
  });
})();`;
export function httpNetworkUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}
export function routeSlug(route: string): string {
  if (route === '/') return 'home';
  if (route === '*') return 'catch-all';
  return route.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'route';
}
