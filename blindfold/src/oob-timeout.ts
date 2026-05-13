import { getConfig } from './config.js';

export function getOobTimeoutMs(): number {
  return getConfig().oobTimeoutMs ?? 5 * 60 * 1000;
}
