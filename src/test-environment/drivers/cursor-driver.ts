// src/test-environment/drivers/cursor-driver.ts
// DEFAULTS-TO-VERIFY: confirm cursor-agent headless flags in config/hosts.ts.
import { createDriver } from './host-driver';

export const cursorDriver = createDriver('cursor');
