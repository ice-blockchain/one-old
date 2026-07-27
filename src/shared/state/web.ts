// src/shared/state/web.ts
// Web/native stack predicates. Ported 1:1 from isWebState/isNativeState in
// scripts/hook-runtime/handlers/_helpers.cjs.

import { obj, type Rec } from '../obj';
import { RN_STACKS } from '../../config/stacks';

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
  if (mobile && ['react-native-expo', 'swift-native', 'kotlin-android', 'flutter'].includes(String(mobile.framework))) {
    return false;
  }
  // Stack labels describe composition, not UI presence. In particular
  // custom-backend is backend-only unless a frontend is explicitly detected.
  return typeof s.frontend === 'string' && s.frontend !== '' && s.frontend !== 'none';
}
