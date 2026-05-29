"use strict";
// src/shared/state/web.ts
// Web/native stack predicates. Ported 1:1 from isWebState/isNativeState in
// scripts/hook-runtime/handlers/_helpers.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isNativeState = isNativeState;
exports.isWebState = isWebState;
const obj_1 = require("../obj");
const config_1 = require("../config");
function isNativeState(state) {
    const s = (0, obj_1.obj)(state);
    if (!s)
        return false;
    const mobile = (0, obj_1.obj)(s.mobile);
    return Boolean((mobile && mobile.framework === 'react-native-expo')
        || (typeof s.stack === 'string' && config_1.RN_STACKS.has(s.stack)));
}
function isWebState(state) {
    const s = (0, obj_1.obj)(state);
    if (!s)
        return false;
    const mobile = (0, obj_1.obj)(s.mobile);
    if (typeof s.stack === 'string' && config_1.WEB_STACKS.has(s.stack) && (!mobile || mobile.framework !== 'react-native-expo')) {
        return true;
    }
    return Boolean(s.frontend && s.frontend !== 'none');
}
