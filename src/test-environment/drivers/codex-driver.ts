// src/test-environment/drivers/codex-driver.ts
// DEFAULTS-TO-VERIFY: confirm codex headless flags in config/hosts.ts.
import { createDriver } from './host-driver';

export const codexDriver = createDriver('codex');
