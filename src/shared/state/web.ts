// src/shared/state/web.ts
// Web/native stack predicates. Ported 1:1 from isWebState/isNativeState in
// scripts/hook-runtime/handlers/_helpers.cjs.

import { RN_STACKS, WEB_STACKS } from '../config';

type Rec = Record<string, unknown>;

function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

export function isNativeState(state: unknown): boolean {
  const s = obj(state);
  if (!s) return false;
  const mobile = obj(s.mobile);
  return Boolean(
    (mobile && mobile.framework === 'react-native-expo')
    || (typeof s.stack === 'string' && RN_STACKS.has(s.stack)),
  );
}

export function isWebState(state: unknown): boolean {
  const s = obj(state);
  if (!s) return false;
  const mobile = obj(s.mobile);
  if (typeof s.stack === 'string' && WEB_STACKS.has(s.stack) && (!mobile || mobile.framework !== 'react-native-expo')) {
    return true;
  }
  return Boolean(s.frontend && s.frontend !== 'none');
}
