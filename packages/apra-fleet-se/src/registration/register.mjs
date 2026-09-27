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

/** Default capped-exponential schedule for the OUTER convergence loop -- the
 *  one that waits for fleet.key and a reachable HTTP server to EXIST at all.
 *  Starts tighter than DEFAULT_BACKOFF (a fresh machine usually converges in
 *  seconds, and the acceptance budget is 60s) but caps lower too, so a machine
 *  that never converges logs roughly twice a minute instead of spamming. */
export const DEFAULT_CONVERGE_BACKOFF = Object.freeze({
    initialMs: 1000,
    maxMs: 15000,
    factor: 2,
});

/**
 * Keep re-resolving the preconditions for workflow-package registration until
 * they are all satisfied, then register. (apra-fleet-i9ag.12.2)
 *
 * WHY THIS EXISTS. bin/serve.mjs used to have THREE one-shot `else` branches
 * that each logged "skipping workflow-package registration" and gave up for the
 * life of the process:
 *   (a) the service token did not come from fleet.key;
 *   (b) resolving the apra-fleet server connection threw;
 *   (c) the connection resolved, but not to a usable http url.
 * On a fresh machine those are not error states, they are STAGES: the machine
 * passes through (a) then (c) and then becomes registerable. Skipping once left
 * Sprints permanently missing from the console until someone restarted the
 * supervisor by hand.
 *
 * WHY EVERYTHING IS RE-RESOLVED EACH PASS, not re-checked:
 *   - The token must be RE-RESOLVED. readLocalToken() (apra-fleet-client
 *     auth/local-token.mjs) never mints fleet.key -- its createIfMissing only
 *     mints the private/token fallback -- so an absent fleet.key pins the
 *     resolved source to 'private-token' in the value captured at startup.
 *     Re-reading that cached value can never observe the key appearing.
 *   - The CONNECTION must be re-resolved too, not just the token: serve.mjs
 *     only resolves the connection at all when the token source is already
 *     'fleet-key', so on the (a) path there is no connection value to reuse.
 *   - consoleOrigin must be RECOMPUTED from each fresh resolution. It is null
 *     whenever the connection is not mode 'http' with a non-empty url, which is
 *     exactly the fresh-machine case: with APRA_FLEET_TRANSPORT unset and no
 *     server running, resolveFleetServerConnection() does NOT throw -- it falls
 *     through to its stdio self-spawn fallback and returns { mode: 'stdio' }.
 *     Reusing a startup-captured null would pin the loop to an unusable
 *     serverUrl forever.
 *
 * A registration is CONSTRUCTED fresh once all three are available, never
 * reused across passes: createRegistration() takes the token as a fixed string
 * at construction (and throws TypeError on an empty one), so an instance built
 * during an earlier pass would hold a stale credential.
 *
 * Registration is only ever attempted with a 'fleet-key'-sourced token. The
 * apra-fleet server's console guard (src/console/server.ts requiresConsoleGuard)
 * checks the bearer against the raw fleet key and does not accept the
 * private/token fallback, so attempting with that credential could never
 * succeed. No token value is ever logged -- only its SOURCE.
 *
 * @param {{
 *   resolveToken: () => { token?: string, source?: string } | null,
 *   resolveConnection: () => Promise<{ mode?: string, url?: string } | null>,
 *   buildManifest: () => { id: string, [key: string]: unknown },
 *   shutdownRequested?: Promise<unknown>,
 *   createRegistrationImpl?: typeof createRegistration,
 *   registrationDeps?: object,
 *   logger?: { log?: Function, warn?: Function, error?: Function },
 *   backoff?: { initialMs: number, maxMs: number, factor: number },
 *   sleepImpl?: (ms: number) => Promise<void>,
 * }} deps
 * @returns {{
 *   done: Promise<{ registered: boolean, reason?: string }>,
 *   currentRegistration: () => { register: Function, unregister: Function } | null,
 *   stop: () => void,
 * }}
 */
export function startRegistrationConvergence(deps = {}) {
    const {
        resolveToken,
        resolveConnection,
        buildManifest,
        shutdownRequested,
        registrationDeps = {},
    } = deps;
    const createRegistrationImpl = deps.createRegistrationImpl ?? createRegistration;
    const logger = deps.logger ?? console;
    const log = (...a) => logger.log?.(...a);
    const warn = (...a) => (logger.warn ?? logger.log)?.(...a);
    const backoff = { ...DEFAULT_CONVERGE_BACKOFF, ...(deps.backoff ?? {}) };
    const sleep = deps.sleepImpl ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));

    let stopped = false;
    let registration = null;

    /** Set once shutdown is observed, so a pending backoff sleep can never hold
     *  shutdown open: the loop races sleep() against shutdownRequested. */
    let shutdownSeen = false;
    if (shutdownRequested && typeof shutdownRequested.then === 'function') {
        shutdownRequested.then(() => { shutdownSeen = true; }, () => { shutdownSeen = true; });
    }

    function stop() {
        stopped = true;
    }

    /**
     * One convergence pass. Returns either a ready-to-use registration input or
     * the human-readable reason the machine is not registerable YET.
     */
    async function resolveOnce() {
        const resolved = resolveToken();
        const source = resolved && typeof resolved.source === 'string' ? resolved.source : 'none';
        const token = resolved && typeof resolved.token === 'string' ? resolved.token : '';
        if (source !== 'fleet-key' || token === '') {
            // Former skip branch (a).
            return {
                waiting: `fleet.key is not available yet (service token source '${source}') -- `
                    + 'it is minted by "apra-fleet install" and by the apra-fleet server itself',
            };
        }

        let connection = null;
        try {
            connection = await resolveConnection();
        } catch (err) {
            // Former skip branch (b).
            return {
                waiting: 'could not resolve the apra-fleet server connection: '
                    + `${err && err.message ? err.message : err}`,
            };
        }

        const url = connection && typeof connection.url === 'string' ? connection.url : '';
        if (!connection || connection.mode !== 'http' || url === '') {
            // Former skip branch (c) -- the DEFAULT fresh-machine case, because
            // with APRA_FLEET_TRANSPORT unset resolveFleetServerConnection()
            // returns { mode: 'stdio' } rather than throwing.
            return {
                waiting: 'no apra-fleet HTTP server URL yet (connection mode '
                    + `'${connection && connection.mode ? connection.mode : 'unresolved'}') -- `
                    + 'waiting for the apra-fleet server to be up and reachable over HTTP',
            };
        }

        // `url` is the MCP endpoint ('http://127.0.0.1:<port>/mcp'); the
        // registry REST surface hangs off the server's ORIGIN. POSTing the
        // registry path onto the MCP endpoint 404s, and register() treats 404
        // as retryable, so it would retry forever (apra-fleet-i9ag.3.4).
        return { consoleOrigin: new URL(url).origin, token };
    }

    async function run() {
        let delay = backoff.initialMs;
        let lastWaiting = null;
        while (!stopped && !shutdownSeen) {
            const pass = await resolveOnce();
            if (stopped || shutdownSeen) break;

            if (pass.waiting === undefined) {
                log(
                    '[registration] preconditions satisfied (fleet.key present, apra-fleet server at '
                    + `${pass.consoleOrigin}); registering workflow package now.`,
                );
                registration = createRegistrationImpl({
                    ...registrationDeps,
                    serverUrl: pass.consoleOrigin,
                    token: pass.token,
                    manifest: buildManifest(),
                });
                // register() owns its OWN capped-backoff retry for an
                // unreachable/5xx server and never rejects; it returns once
                // registered or permanently refused (400/409). Either way this
                // outer convergence loop is finished.
                await registration.register();
                return { registered: true };
            }

            // Say RETRYING, never "skipping", and say what is being waited for.
            // Repeat the reason only when it CHANGES; otherwise just note the
            // next delay, so a machine that never converges does not spam an
            // identical paragraph at every interval.
            if (pass.waiting !== lastWaiting) {
                warn(
                    `[registration] workflow-package registration not possible yet: ${pass.waiting}. `
                    + `RETRYING in ${delay}ms (this supervisor converges on its own -- no restart needed).`,
                );
                lastWaiting = pass.waiting;
            } else {
                warn(`[registration] still waiting to register; RETRYING in ${delay}ms.`);
            }

            // Race the backoff against shutdown so a pending sleep can never
            // hold shutdown open for the rest of the interval.
            const waiters = [sleep(delay)];
            if (shutdownRequested && typeof shutdownRequested.then === 'function') {
                waiters.push(shutdownRequested);
            }
            await Promise.race(waiters);
            if (stopped || shutdownSeen) break;
            delay = Math.min(delay * backoff.factor, backoff.maxMs);
        }
        return { registered: false, reason: 'stopped before the preconditions were satisfied' };
    }

    return {
        done: run(),
        currentRegistration: () => registration,
        stop,
    };
}
