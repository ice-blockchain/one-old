"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlers = void 0;
const handler_1 = require("./handler");
exports.handlers = [
    {
        id: 'page-speed.build',
        event: 'PostToolUse',
        tools: ['shell'],
        subcommands: ['post-build-page-speed'],
        priority: 40,
        run: (ctx) => (0, handler_1.postBuildPageSpeed)(ctx),
    },
];
