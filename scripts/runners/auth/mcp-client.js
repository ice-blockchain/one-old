"use strict";
// src/runners/auth/mcp-client.ts
// Minimal MCP JSON-RPC client for the auth endpoint (tools/call over HTTP(S)).
// authEndpointUrl (shared/auth) enforces HTTPS for remote + loopback-only HTTP,
// so credentials never leave for a plaintext remote. Ported 1:1 from
// scripts/traffic-one-auth/{mcpRequest,buildMcpPayload}.cjs + extractToolText.
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
exports.buildMcpPayload = buildMcpPayload;
exports.extractToolText = extractToolText;
exports.mcpRequest = mcpRequest;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const auth_1 = require("../../shared/auth");
function buildMcpPayload(toolName, args = {}) {
    return {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
            name: toolName,
            arguments: args,
        },
    };
}
function extractToolText(responseBody) {
    const tryParse = (text) => {
        try {
            const parsed = JSON.parse(text);
            const result = parsed && typeof parsed.result === 'object' ? parsed.result : null;
            const content = result ? result.content : null;
            if (Array.isArray(content) && content[0] && typeof content[0].text === 'string') {
                return content[0].text;
            }
            return null;
        }
        catch {
            return null;
        }
    };
    const direct = tryParse(responseBody);
    if (direct !== null)
        return direct;
    for (const line of responseBody.split(/\r?\n/)) {
        if (!line.startsWith('data:'))
            continue;
        const parsed = tryParse(line.slice('data:'.length).trim());
        if (parsed !== null)
            return parsed;
    }
    return null;
}
function mcpRequest(endpoint, toolName, bearer, args = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const url = (0, auth_1.authEndpointUrl)(endpoint);
        const body = JSON.stringify(buildMcpPayload(toolName, args));
        const client = url.protocol === 'http:' ? http : https;
        const req = client.request({
            method: 'POST',
            hostname: url.hostname,
            path: `${url.pathname}${url.search}`,
            port: url.port || (url.protocol === 'http:' ? 80 : 443),
            headers: {
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${bearer}`,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
            },
            timeout: timeoutMs,
        }, (res) => {
            let responseBody = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                responseBody += chunk;
            });
            res.on('end', () => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    const error = new Error(`HTTP ${res.statusCode || 'unknown'}`);
                    error.statusCode = res.statusCode;
                    reject(error);
                    return;
                }
                if (/"error"\s*:/.test(responseBody)) {
                    reject(new Error('MCP error response'));
                    return;
                }
                const text = extractToolText(responseBody);
                if (text === null) {
                    reject(new Error('MCP response did not include tool text content'));
                    return;
                }
                try {
                    resolve(JSON.parse(text));
                }
                catch {
                    reject(new Error('MCP tool text content was not JSON'));
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        req.end(body);
    });
}
