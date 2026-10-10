import path from 'node:path';

/**
 * Return `pathValue` with `nodeDir` appended as a PATH entry unless it is
 * already an exact entry. Appended (never prepended) so a node the login
 * profile already provides keeps precedence; an unchanged PATH is returned
 * byte-identical.
 */
export function ensureNodeDirOnPath(pathValue: string | undefined, nodeDir: string): string {
  if (!pathValue) return nodeDir;
  const entries = pathValue.split(':');
  if (entries.includes(nodeDir)) return pathValue;
  return `${pathValue}:${nodeDir}`;
}

/** Directory of the node binary running the fleet server. */
export function runningNodeDir(): string {
  return path.dirname(process.execPath);
}
