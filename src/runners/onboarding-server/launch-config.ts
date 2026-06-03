// src/runners/onboarding-server/launch-config.ts
// The launch.json registration logic now lives in shared/ so the synchronous gate
// can write it the moment it spawns the server (guaranteeing the entry exists
// before the agent calls preview_start). This module re-exports it for the
// standalone server's own self-registration + shutdown cleanup.

export { writeLaunchConfig, removeLaunchConfig, LAUNCH_ENTRY_NAME } from '../../shared/onboarding-server/launch-config';
