"use strict";
// src/runners/onboarding-server/html.ts
// Serve the single self-contained wizard page. The HTML is authored as a sibling
// wizard.html (copied next to the compiled runner via RUNNER_ASSETS), read once
// and cached. The per-session token is injected so the page's fetch() calls can
// authenticate even if the URL query is later lost.
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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.wizardHtml = wizardHtml;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
let template = null;
function load() {
    if (template == null) {
        template = fs.readFileSync(path.join(__dirname, 'wizard.html'), 'utf8');
    }
    return template;
}
function wizardHtml(token) {
    // Placeholder must NOT be a valid JS identifier substring — a global replace
    // would otherwise mangle `window.__T1_TOKEN__` into `window.<token>` (a syntax
    // error). `%%T1_TOKEN%%` only ever appears inside a string literal.
    return load().split('%%T1_TOKEN%%').join(token);
}
