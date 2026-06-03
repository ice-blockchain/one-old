"use strict";
// src/runners/onboarding-server/launch-config.ts
// The launch.json registration logic now lives in shared/ so the synchronous gate
// can write it the moment it spawns the server (guaranteeing the entry exists
// before the agent calls preview_start). This module re-exports it for the
// standalone server's own self-registration + shutdown cleanup.
Object.defineProperty(exports, "__esModule", { value: true });
exports.LAUNCH_ENTRY_NAME = exports.removeLaunchConfig = exports.writeLaunchConfig = void 0;
var launch_config_1 = require("../../shared/onboarding-server/launch-config");
Object.defineProperty(exports, "writeLaunchConfig", { enumerable: true, get: function () { return launch_config_1.writeLaunchConfig; } });
Object.defineProperty(exports, "removeLaunchConfig", { enumerable: true, get: function () { return launch_config_1.removeLaunchConfig; } });
Object.defineProperty(exports, "LAUNCH_ENTRY_NAME", { enumerable: true, get: function () { return launch_config_1.LAUNCH_ENTRY_NAME; } });
