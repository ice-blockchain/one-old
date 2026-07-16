// src/test-environment/drivers/index.ts
import type { HostDriver, HostId } from '../core/types';
import { claudeDriver } from './claude-driver';
import { codexDriver } from './codex-driver';
import { cursorDriver } from './cursor-driver';
import { createDriver } from './host-driver';

export const DRIVERS: Record<HostId, HostDriver> = {
  claude: claudeDriver,
  codex: codexDriver,
  cursor: cursorDriver,
  opencode: createDriver('opencode'),
  copilot: createDriver('copilot'),
  windsurf: createDriver('windsurf'),
  kilo: createDriver('kilo'),
};
