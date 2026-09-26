// =============================================================================
// Workflow-package register/unregister lifecycle (apra-fleet-g6ap.2.1)
// =============================================================================
//
// createRegistration({serverUrl, token, manifest, ...}) owns the HTTP calls
// against the apra-fleet server's registry (src/console/routes/workflow-packages.ts):
//   register()   -- POST <serverUrl>/api/workflow-packages/register, retried
//                    with capped exponential backoff while the server is
//                    unreachable or answers 5xx. A 400/409 is a permanent
//                    refusal (bad manifest / apraFleetApi incompatible) and is
//                    NOT retried -- it is logged loudly with the server's own
//                    error text so an operator sees exactly why registration
//                    never succeeded, rather than the supervisor retrying
//                    forever against a request that can never succeed.
//   unregister() -- DELETE <serverUrl>/api/workflow-packages/<id>, best
//                    effort and time-bounded so a wedged/unreachable server
//                    can never block shutdown. Also stops any in-flight
//                    register() backoff loop.
//
// Both calls authenticate with `Authorization: Bearer <token>` -- the SAME
// local token bin/serve.mjs resolves via supervisor/auth.mjs's
// resolveServiceToken() (the shared fleet.key), because the apra-fleet
// server's /api/ surface (src/console/server.ts's requiresConsoleGuard)
// checks the bearer path against the raw fleet key, not a derived value.
// =============================================================================

/** Default capped-exponential backoff schedule for register()'s retry loop. */
export const DEFAULT_BACKOFF = Object.freeze({
    initialMs: 1000,
    maxMs: 30000,
    factor: 2,
});

/** Bounded wait for unregister()'s DELETE -- never blocks shutdown longer
 *  than this even against a fully wedged/unreachable server. */
export const UNREGISTER_TIMEOUT_MS = 3000;

/**
 * @param {{
 *   serverUrl: string,
 *   token: string,
 *   manifest: { id: string, [key: string]: unknown },
 *   fetchImpl?: typeof fetch,
 *   logger?: { log?: Function, warn?: Function, error?: Function },
 *   backoff?: { initialMs: number, maxMs: number, factor: number },
 *   sleepImpl?: (ms: number) => Promise<void>,
 * }} deps
 * @returns {{ register: () => Promise<void>, unregister: () => Promise<void> }}
 */
export function createRegistration(deps = {}) {
    const { serverUrl, token, manifest } = deps;
    if (typeof serverUrl !== 'string' || serverUrl === '') {
        throw new TypeError('createRegistration: serverUrl must be a non-empty string');
    }
    if (typeof token !== 'string' || token === '') {
        throw new TypeError('createRegistration: token must be a non-empty string');
    }
    if (!manifest || typeof manifest !== 'object' || typeof manifest.id !== 'string' || manifest.id === '') {
        throw new TypeError('createRegistration: manifest must be an object with a non-empty id');
    }
    const fetchImpl = deps.fetchImpl ?? fetch;
    const logger = deps.logger ?? console;
    const log = (...a) => logger.log?.(...a);
    const warn = (...a) => (logger.warn ?? logger.log)?.(...a);
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    const backoff = { ...DEFAULT_BACKOFF, ...(deps.backoff ?? {}) };
    const sleep = deps.sleepImpl ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));

    const base = serverUrl.replace(/\/+$/, '');
    const registerUrl = `${base}/api/workflow-packages/register`;
    const unregisterUrl = `${base}/api/workflow-packages/${encodeURIComponent(manifest.id)}`;

    // Flips true once unregister() is called, so an in-flight register()
    // retry loop stops on its next iteration instead of racing shutdown.
    let stopped = false;

    async function readResponseText(res) {
        try {
            return await res.text();
        } catch {
            return '';
        }
    }

    /** One register attempt. Never throws -- every failure mode (network
     *  error, non-2xx) resolves to a result the caller interprets. */
    async function attemptRegister() {
        let res;
        try {
            res = await fetchImpl(registerUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify(manifest),
            });
        } catch (err) {
            return { ok: false, retry: true, detail: err && err.message ? err.message : String(err) };
        }
        if (res.ok) return { ok: true };
        const text = await readResponseText(res);
        if (res.status === 400 || res.status === 409) {
            return { ok: false, retry: false, status: res.status, detail: text };
        }
        return { ok: false, retry: true, status: res.status, detail: text };
    }

    /**
     * Register this package, retrying with capped exponential backoff while
     * the server is unreachable or answers 5xx. Resolves once registered, the
     * server permanently refuses (400/409, logged and given up on), or
     * unregister() stops the loop. Never rejects -- callers run this
     * unawaited in the background (see bin/serve.mjs).
     */
    async function register() {
        let delay = backoff.initialMs;
        while (!stopped) {
            const result = await attemptRegister();
            if (result.ok) {
                log(`[registration] registered workflow package '${manifest.id}' at ${serverUrl}`);
                return;
            }
            if (!result.retry) {
                logError(
                    `[registration] workflow package '${manifest.id}' registration REFUSED by ${serverUrl} `
                    + `(HTTP ${result.status}): ${result.detail || '(no error text)'}. Not retrying -- `
                    + 'fix the manifest or the declared apraFleetApi range and restart the supervisor.',
                );
                return;
            }
            warn(
                `[registration] workflow package '${manifest.id}' registration attempt failed `
                + `(${result.status !== undefined ? `HTTP ${result.status}` : result.detail}); retrying in ${delay}ms.`,
            );
            await sleep(delay);
            if (stopped) return;
            delay = Math.min(delay * backoff.factor, backoff.maxMs);
        }
    }

    /**
     * Best-effort, time-bounded unregister. Never throws and never blocks
     * shutdown longer than UNREGISTER_TIMEOUT_MS. Also stops any in-flight
     * register() retry loop.
     */
    async function unregister() {
        stopped = true;
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), UNREGISTER_TIMEOUT_MS) : null;
        try {
            await fetchImpl(unregisterUrl, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
                ...(controller ? { signal: controller.signal } : {}),
            });
        } catch (err) {
            warn(
                `[registration] unregister of workflow package '${manifest.id}' failed (best effort, ignored): `
                + `${err && err.message ? err.message : err}`,
            );
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    return { register, unregister };
}
