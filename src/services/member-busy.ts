import { writeStatusline } from './statusline.js';

/** Ends a busy period. `status` defaults to 'idle'; only the first call writes. */
export type ReleaseBusy = (status?: string) => void;

/**
 * Mark a member busy in the statusline and return its release. Call the
 * release on every exit path -- typically `release(errStatus)` in catch and
 * a bare `release()` in finally: the first call wins, so an error path's
 * 'offline' is never clobbered by the finally's 'idle'. Kept out of
 * statusline.ts so modules that mock statusline.js still get a working
 * helper (its writes go through their mocked writeStatusline).
 */
export function markBusy(memberId: string): ReleaseBusy {
  writeStatusline(new Map([[memberId, 'busy']]));
  let released = false;
  return (status = 'idle') => {
    if (released) return;
    released = true;
    writeStatusline(new Map([[memberId, status]]));
  };
}
