// src/adapters/coerce.ts
// Tiny shared coercion helpers for host adapters parsing untyped wire JSON.

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function firstString(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}
