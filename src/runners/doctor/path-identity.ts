import * as path from 'path';

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function resolvePlatformPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathApi(platform).resolve(value);
}

function comparisonKey(value: string, platform: NodeJS.Platform): string {
  const resolved = resolvePlatformPath(value, platform);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function samePlatformPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return comparisonKey(left, platform) === comparisonKey(right, platform);
}

export function platformPathContains(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const rootKey = comparisonKey(root, platform);
  const candidateKey = comparisonKey(candidate, platform);
  if (rootKey === candidateKey) return true;
  const separator = pathApi(platform).sep;
  return candidateKey.startsWith(rootKey.endsWith(separator) ? rootKey : `${rootKey}${separator}`);
}
