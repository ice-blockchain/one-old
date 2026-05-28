"use strict";
// src/shared/state/io.ts
// State IO timestamp + version stamping. The JSON/file primitives now come from
// shared/fsjson (deduped — legacy state/io.cjs carried its own copies); only the
// state-specific bits live here.
Object.defineProperty(exports, "__esModule", { value: true });
exports.stateTimestamp = stateTimestamp;
exports.stateVersion = stateVersion;
const version_1 = require("../version");
// Legacy state writes drop milliseconds (2026-05-27T12:00:00Z, not .123Z) — keep
// that so stamped timestamps match the previous on-disk format.
function stateTimestamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
// Version stamped into .traffic-one/.one.json. Single source: package.json (the
// generator keeps the 5 manifests equal to it, so this matches the legacy
// manifest-derived value).
function stateVersion() {
    return (0, version_1.pluginVersion)();
}
