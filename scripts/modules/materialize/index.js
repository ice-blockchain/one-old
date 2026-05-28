"use strict";
// src/modules/materialize/index.ts
// Materialize module: the PostToolUse `post-stack-setup` dispatcher (Handler)
// + the `materialize-project` manual command (exported action, routed by the
// host entry — not a gate).
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlers = exports.runPostStackSetup = exports.runMaterializeProject = void 0;
const post_stack_setup_1 = require("./post-stack-setup");
var materialize_project_1 = require("./materialize-project");
Object.defineProperty(exports, "runMaterializeProject", { enumerable: true, get: function () { return materialize_project_1.runMaterializeProject; } });
var post_stack_setup_2 = require("./post-stack-setup");
Object.defineProperty(exports, "runPostStackSetup", { enumerable: true, get: function () { return post_stack_setup_2.runPostStackSetup; } });
exports.handlers = [
    {
        id: 'materialize.post-stack-setup',
        event: 'PostToolUse',
        tools: ['file-write', 'file-edit', 'shell'],
        subcommands: ['post-stack-setup'],
        priority: 60,
        run: (ctx) => (0, post_stack_setup_1.runPostStackSetup)(ctx),
    },
];
