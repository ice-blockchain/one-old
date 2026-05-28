"use strict";
// src/runners/gitnexus/nvm.ts
// nvm-aware Node-22 binary discovery + the version-mismatch messaging the
// GitNexus bootstrap, the post-build banner, and doctor all share. Ported 1:1
// from scripts/gitnexus-runner/{currentNodeMajor,findNvmNode22,nvmPresent,
// nvmInstallCommand,nodeVersionMismatchMessage}.cjs.
//
// Claude Code's hook process inherits the PATH it was launched with. Once the
// user runs `nvm alias default 22`, only NEW shells see Node 22 — the running
// session still resolves `node`/`npm`/`gitnexus` against the older nvm folder.
// Workaround: don't trust PATH. Glob `~/.nvm/versions/node/v22.*` directly,
// pick the highest installed v22.x.y, and use ABSOLUTE paths.
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
exports.GITNEXUS_MIN_NODE_MAJOR = void 0;
exports.currentNodeMajor = currentNodeMajor;
exports.findNvmNode22 = findNvmNode22;
exports.nvmPresent = nvmPresent;
exports.nvmInstallCommand = nvmInstallCommand;
exports.nodeVersionMismatchMessage = nodeVersionMismatchMessage;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// GitNexus's package.json declares `engines.node: ">=22"`. Running
// `npm install -g gitnexus` on a lower Node prints a noisy EBADENGINE error
// that beginners can't decode. We pre-flight and refuse with a clean,
// actionable banner BEFORE wasting ~3 minutes on a doomed npm install.
exports.GITNEXUS_MIN_NODE_MAJOR = 22;
// Returns the current Node major (e.g. 20 for v20.18.3). Pure read; never
// throws. Used by both bootstrap() and the post-stack-setup hook so we surface
// the upgrade hint at the earliest possible moment.
function currentNodeMajor() {
    const raw = process.versions && process.versions.node;
    if (typeof raw !== 'string')
        return null;
    const major = Number(raw.split('.')[0]);
    return Number.isFinite(major) ? major : null;
}
// Returns `{ root, node, npm, gitnexus, version }` where every binary value is
// an absolute path OR null when the binary doesn't exist. Returns `null` when
// no v22.* nvm install exists at all.
function findNvmNode22() {
    const home = process.env.HOME || '';
    if (!home)
        return null;
    const nodesRoot = path.join(home, '.nvm', 'versions', 'node');
    if (!fs.existsSync(nodesRoot))
        return null;
    let candidates;
    try {
        candidates = fs.readdirSync(nodesRoot);
    }
    catch {
        return null;
    }
    // Match v22.x.y; pick the highest by semantic minor/patch sort.
    const v22s = candidates
        .filter((name) => /^v22\.\d+\.\d+$/.test(name))
        .sort((a, b) => {
        const [, am, ap] = a.match(/^v22\.(\d+)\.(\d+)$/) || [];
        const [, bm, bp] = b.match(/^v22\.(\d+)\.(\d+)$/) || [];
        if (Number(am) !== Number(bm))
            return Number(bm) - Number(am);
        return Number(bp) - Number(ap);
    });
    const version = v22s[0];
    if (version === undefined)
        return null;
    const root = path.join(nodesRoot, version);
    const bin = path.join(root, 'bin');
    const exists = (p) => { try {
        return fs.existsSync(p);
    }
    catch {
        return false;
    } };
    return {
        root,
        version,
        node: exists(path.join(bin, 'node')) ? path.join(bin, 'node') : null,
        npm: exists(path.join(bin, 'npm')) ? path.join(bin, 'npm') : null,
        gitnexus: exists(path.join(bin, 'gitnexus')) ? path.join(bin, 'gitnexus') : null,
    };
}
// Detect whether nvm is installed at all (looks for `~/.nvm/nvm.sh` — the
// canonical nvm script). nvm is a shell function, not a binary, so we can't
// `which` it; the script's presence is the reliable signal.
function nvmPresent() {
    const home = process.env.HOME || '';
    if (!home)
        return false;
    return fs.existsSync(path.join(home, '.nvm', 'nvm.sh'));
}
// Single-line bash command the agent can hand to the Bash tool. Sources the
// nvm script first because nvm is a shell function, then installs + sets
// default. Bash tool permission prompt is the user's consent — the runner
// itself never executes this.
function nvmInstallCommand() {
    return (`bash -lc '. "$HOME/.nvm/nvm.sh" `
        + `&& nvm install ${exports.GITNEXUS_MIN_NODE_MAJOR} `
        + `&& nvm alias default ${exports.GITNEXUS_MIN_NODE_MAJOR} `
        + `&& nvm use default `
        + `&& npm install -g gitnexus'`);
}
// Beginner-friendly upgrade message. Single source of truth so the runner, the
// post-build banner, and the post-stack-setup warning all use the same wording.
function nodeVersionMismatchMessage(major) {
    const have = major === null ? 'an unknown Node version' : `Node ${major}`;
    return (`GitNexus requires Node >=${exports.GITNEXUS_MIN_NODE_MAJOR} (you have ${have}). `
        + 'Upgrade once, then relaunch Claude Code:\n'
        + `  nvm install ${exports.GITNEXUS_MIN_NODE_MAJOR}\n`
        + `  nvm alias default ${exports.GITNEXUS_MIN_NODE_MAJOR}\n`
        + '  nvm use default\n'
        + 'Or pick the `graphify` provider instead (Python; works on any Node) '
        + 'by updating local Traffic One preferences -> `codeGraphProvider: "graphify"`.');
}
