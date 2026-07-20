// POSIX/PowerShell-compatible literal quoting for generated one-command argv.
// JSON double quotes are not shell quoting: `$`, backticks, and command
// substitution still expand inside them.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
