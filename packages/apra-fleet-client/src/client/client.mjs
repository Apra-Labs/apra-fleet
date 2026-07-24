import { TimeoutError, AbortError, TransportClosedError } from './errors.mjs';

// Conservative fallback when no timeout hint is supplied by the caller and
// none can be derived from the request payload. Never infinite: a server
// that accepts a request and never replies (without closing the transport)
// must not hang the caller forever.
export const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export class McpClient {
    constructor(transport) {
        this.transport = transport;
        this.pendingRequests = new Map();
        this.nextId = 1;

        this.transport.on('message', (message) => {
            this.handleMessage(message);
        });

        this.transport.on('close', () => {
            for (const [id, pending] of this.pendingRequests.entries()) {
                pending.reject(new TransportClosedError('Transport closed', { details: { requestId: id } }));
            }
            this.pendingRequests.clear();
        });

        this.transport.on('error', (err) => {
            for (const [id, pending] of this.pendingRequests.entries()) {
                pending.reject(err);
            }
            this.pendingRequests.clear();
        });
    }

    handleMessage(message) {
        if (message.jsonrpc === '2.0' && 'id' in message) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                // A late reply (arriving after the request already timed out
                // or was aborted) has no pending entry left to resolve --
                // this is a silent no-op rather than a crash or corruption
                // of any other in-flight request.
                this.pendingRequests.delete(message.id);
                if ('error' in message) {
                    const errMsg = message.error?.message || JSON.stringify(message.error);
                    pending.reject(new Error(errMsg));
                } else {
                    pending.resolve(message.result);
                }
            }
        }
    }

    /**
     * @param {string} method
     * @param {object} [params]
     * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
     *   - timeoutMs: reject with a TimeoutError (.code === 'TIMEOUT') if no
     *     response arrives within this window. Defaults to
     *     DEFAULT_REQUEST_TIMEOUT_MS when omitted -- never infinite.
     *   - signal: an optional AbortSignal; aborting rejects the pending
     *     request with an AbortError (.code === 'ABORTED') and removes it
     *     from the pending map.
     *
     * NOTE: this is a *client-side* timeout/abort only. It stops the client
     * from waiting forever and frees local resources, but it cannot cancel
     * the remote job -- the fleet-server process keeps running the request
     * it already accepted. True remote cancellation (and idempotency keys
     * to make retries safe) require fleet-server changes, which are out of
     * scope here (external repo, apra-fleet.exe).
     */
    async request(method, params, opts = {}) {
        const id = this.nextId++;
        const message = {
            jsonrpc: "2.0",
            id: id,
            method: method,
            params: params
        };

        const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        const signal = opts.signal;

        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;

            const onAbort = () => {
                settleReject(new AbortError(`Request "${method}" (id=${id}) aborted before a response was received.`, {
                    details: { method, id }
                }));
            };

            const cleanup = () => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', onAbort);
            };

            const settleResolve = (value) => {
                if (settled) return;
                cleanup();
                resolve(value);
            };

            const settleReject = (err) => {
                if (settled) return;
                this.pendingRequests.delete(id);
                cleanup();
                reject(err);
            };

            if (signal) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort);
            }

            if (timeoutMs !== Infinity && timeoutMs != null) {
                // Intentionally not unref()'d: a caller awaiting this
                // request should keep the process alive until it settles
                // (resolve, reject, timeout, or abort) rather than letting
                // the process exit while the promise is still pending.
                timer = setTimeout(() => {
                    settleReject(new TimeoutError(
                        `Request "${method}" (id=${id}) timed out after ${timeoutMs}ms with no response.`,
                        { details: { method, id, timeoutMs } }
                    ));
                }, timeoutMs);
            }

            this.pendingRequests.set(id, { resolve: settleResolve, reject: settleReject });

            this.transport.send(message).catch(err => {
                this.pendingRequests.delete(id);
                settleReject(err);
            });
        });
    }

    async callTool(name, args, opts = {}) {
        return this.request("tools/call", { name: name, arguments: args }, opts);
    }
}
