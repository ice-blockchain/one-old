"use strict";
// src/core/context.ts
// The composition root: assembles the Ctx (DI container) once per hook
// invocation. Handlers receive this and read ctx.fsjson/exec/paths/skillBlock
// instead of require()-ing siblings — which is what removes the duplicated
// helpers and the circular "hoisted forwarder" requires.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildContext = buildContext;
const exec_1 = require("../shared/exec");
const fsjson_1 = require("../shared/fsjson");
const logger_1 = require("../shared/logger");
const paths_1 = require("../shared/paths");
const skill_block_1 = require("../shared/skill-block");
const text_1 = require("../shared/text");
const skillBlock = (0, skill_block_1.makeSkillBlock)(paths_1.pluginRoot);
function buildContext(input, opts = {}) {
    return {
        input,
        host: input.host,
        cwd: input.cwd,
        now: text_1.nowIso,
        log: (0, logger_1.makeLogger)({ debug: opts.debug ?? false }),
        fsjson: fsjson_1.fsjson,
        exec: exec_1.exec,
        paths: paths_1.paths,
        skillBlock,
    };
}
