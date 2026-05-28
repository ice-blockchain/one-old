"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeLogger = makeLogger;
function makeLogger(opts = {}) {
    return {
        debug(msg) {
            if (opts.debug)
                process.stderr.write(`[traffic-one] ${msg}\n`);
        },
        warn(msg) {
            process.stderr.write(`[traffic-one] ${msg}\n`);
        },
    };
}
