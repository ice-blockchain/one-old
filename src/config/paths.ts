// src/config/paths.ts
// State file locations + IO limits. THE knobs for where Traffic One persists its
// per-project state. pluginRoot / cache helpers are logic and live in shared/paths.ts.

import * as path from 'path';

export const MAX_STDIN = 1024 * 1024;
export const STATE_DIR = '.traffic-one';
export const STATE_BASENAME = '.one.json';
export const STATE_FILE = path.join(STATE_DIR, STATE_BASENAME);
export const LEGACY_STATE_FILE = STATE_FILE;
export const LEGACY_LOCK_FILE = '.claude-plugin-mode';
