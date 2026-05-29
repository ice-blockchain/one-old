"use strict";
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
// src/shared/materialize/index.ts
// Materialization: generated-marker helpers + presence checks. The full
// materializeProjectAssets writer + AGENTS.md renderer land here next.
__exportStar(require("./generated"), exports);
__exportStar(require("./has-assets"), exports);
__exportStar(require("./render-agents"), exports);
__exportStar(require("./cleanup"), exports);
__exportStar(require("./materialize"), exports);
__exportStar(require("./converge"), exports);
__exportStar(require("./graph-preview"), exports);
__exportStar(require("./plan-migration"), exports);
