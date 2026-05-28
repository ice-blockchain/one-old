"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlers = exports.__resetCodeGraphBootstraps = exports.__setCodeGraphBootstraps = exports.postBuildCodeGraphHint = void 0;
const handler_1 = require("./handler");
const post_build_1 = require("./post-build");
var post_build_2 = require("./post-build");
Object.defineProperty(exports, "postBuildCodeGraphHint", { enumerable: true, get: function () { return post_build_2.postBuildCodeGraphHint; } });
Object.defineProperty(exports, "__setCodeGraphBootstraps", { enumerable: true, get: function () { return post_build_2.__setCodeGraphBootstraps; } });
Object.defineProperty(exports, "__resetCodeGraphBootstraps", { enumerable: true, get: function () { return post_build_2.__resetCodeGraphBootstraps; } });
exports.handlers = [
    {
        id: 'graphify.hint',
        event: 'PreToolUse',
        tools: ['search'],
        subcommands: ['pre-graphify-hint'],
        priority: 50, // context-only, runs after the gates
        run: (ctx) => (0, handler_1.preGraphifyHint)(ctx),
    },
    {
        id: 'graphify.post-build',
        event: 'PostToolUse',
        tools: ['shell'],
        subcommands: ['post-build-graphify'],
        priority: 50, // after page-speed (40); context-only
        run: (ctx) => (0, post_build_1.postBuildCodeGraphHint)(ctx),
    },
];
