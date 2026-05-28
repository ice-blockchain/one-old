"use strict";
// src/shared/state/index.ts
// Aggregating entry for the state machine (mirrors the legacy state.cjs surface).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./constants"), exports);
__exportStar(require("./io"), exports);
__exportStar(require("./toolchain"), exports);
__exportStar(require("./validate"), exports);
__exportStar(require("./canonicalize"), exports);
__exportStar(require("./local-prefs"), exports);
__exportStar(require("./normalize"), exports);
__exportStar(require("./materialization"), exports);
__exportStar(require("./run-agent"), exports);
__exportStar(require("./web"), exports);
