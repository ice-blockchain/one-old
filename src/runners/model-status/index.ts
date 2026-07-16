// Short-lived public model-catalog refresh runner. SessionStart invokes this in
// a child process because the hook surface is synchronous while HTTPS is async.
// Every failure is fail-open and exits successfully after reporting a compact
// diagnostic; the last valid local configuration remains authoritative.

import { refreshHostModelStatus } from '../../shared/model-status-refresh';

export async function main(): Promise<void> {
  const host = process.argv[2] || process.env.TRAFFIC_ONE_HOST || 'claude';
  try {
    const result = await refreshHostModelStatus(host);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      host,
      outcome: 'unavailable',
      changed: false,
      reason: error instanceof Error ? error.message : String(error),
    })}\n`);
  }
}

if (require.main === module) {
  main().catch(() => {
    // The model catalog is advisory state. Never fail SessionStart because the
    // network or local settings store is temporarily unavailable.
  });
}

