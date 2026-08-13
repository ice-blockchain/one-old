// src/runners/qa-evidence/bounded-argv.ts
// The bounded JSON argv every CONFIGURED command is parsed from: the dev
// server's `--server-command-json` and the native adapter's
// `--native-command-json`.
//
// A LEAF, for the reason process-group.ts is one, and it is the edge that file
// names. This lived in server.ts, so native-process.ts imported the DEV
// SERVER's module to parse its own command, and server.ts could not import
// `spawnPlan` back — the helper that keeps a Windows batch shim out of
// `spawn`'s file argument — without closing a require cycle around it. Moving
// the parser to a leaf removes that edge rather than routing around it a second
// time: nothing here imports anything from this runner, so both importers are
// safe and stay safe.

export function parseBoundedArgv(raw: string | undefined): string[] | null {
  if (!raw || raw.length > 16_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > 64
    || !value.every((entry) => typeof entry === 'string'
      && entry.length > 0
      && entry.length <= 4_096
      && !/[\u0000-\u001f\u007f]/.test(entry))) return null;
  return value as string[];
}
