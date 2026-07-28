import { runStop } from './stop.js';
import { runStart } from './start.js';

export async function runRestart(args: string[]): Promise<void> {
  await runStop(args);
  await runStart(args);
}
