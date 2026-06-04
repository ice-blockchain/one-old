"use strict";
// src/runners/onboarding-server/routes.ts
// HTTP route dispatch for the onboarding wizard. Token + loopback checks happen in
// server.ts before this runs. The state/answer/task routes are thin glue over the
// shared flow brain (computeOnboarding / applyAnswer) + the async task runner; the
// completion route writes the sentinel and asks the server to shut down.
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendJson = sendJson;
exports.dispatch = dispatch;
const flow_1 = require("../../shared/onboarding-server/flow");
const registry_1 = require("../../shared/onboarding-server/registry");
const obj_1 = require("../../shared/obj");
const html_1 = require("./html");
const tasks_1 = require("./tasks");
const MAX_BODY_BYTES = 256 * 1024;
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}
function sendHtml(res, status, html) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
}
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (!text) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(text));
            }
            catch {
                reject(new Error('invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}
async function dispatch(req, res, url, ctx) {
    const method = req.method || 'GET';
    const pathname = url.pathname;
    if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
    }
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        sendHtml(res, 200, (0, html_1.wizardHtml)(ctx.token));
        return;
    }
    if (method === 'GET' && pathname === '/state') {
        sendJson(res, 200, (0, flow_1.computeOnboarding)(ctx.cwd));
        return;
    }
    if (method === 'POST' && pathname === '/answer') {
        const body = (0, obj_1.obj)(await readJsonBody(req)) || {};
        const step = typeof body.step === 'string' ? body.step : '';
        if (!step) {
            sendJson(res, 400, { ok: false, error: 'missing step' });
            return;
        }
        const outcome = (0, flow_1.applyAnswer)(ctx.cwd, step, body.value);
        if (!outcome.ok) {
            sendJson(res, 400, { ok: false, error: outcome.error || 'invalid answer' });
            return;
        }
        const view = (0, flow_1.computeOnboarding)(ctx.cwd);
        if (outcome.task) {
            const taskId = (0, tasks_1.startCodeGraphTask)(outcome.task.provider, ctx.cwd, ctx.env);
            sendJson(res, 200, { ok: true, taskId, view });
            return;
        }
        sendJson(res, 200, { ok: true, view });
        return;
    }
    if (method === 'GET' && pathname.startsWith('/task/')) {
        const id = decodeURIComponent(pathname.slice('/task/'.length));
        const task = (0, tasks_1.getTask)(id);
        if (!task) {
            sendJson(res, 404, { error: 'unknown task' });
            return;
        }
        sendJson(res, 200, task);
        return;
    }
    if (method === 'POST' && pathname === '/complete') {
        try {
            (0, registry_1.writeCompletionSentinel)(ctx.cwd, ctx.env);
        }
        catch {
            // best-effort — the gate's predicates remain the source of truth
        }
        sendJson(res, 200, { ok: true });
        ctx.requestShutdown();
        return;
    }
    sendJson(res, 404, { error: 'not found' });
}
