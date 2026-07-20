// Short-lived public MCP configuration worker. SessionStart invokes this child
// because hook dispatch is synchronous while Streamable HTTP is asynchronous.
// Every failure is advisory and exits successfully with a compact diagnostic.

import { syncOneMcpHostForProject } from '../../shared/one-mcp-sync';

export async function main(): Promise<void> {
  const host = process.argv[2] || process.env.TRAFFIC_ONE_HOST || 'claude';
  const cwd = process.argv[3] || process.cwd();
  try {
    const result = await syncOneMcpHostForProject(cwd, host);
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
    // Public model configuration is advisory. Never fail SessionStart.
  });
}
