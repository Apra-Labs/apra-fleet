/**
 * Streamable-HTTP transport that survives the shared fleet server going away
 * mid-run (GitHub #585 recovery) -- for long-lived clients such as a
 * fleet-sprint run.
 *
 * Rules:
 *  - A request is re-sent at most ONCE, and only when it provably never
 *    reached a server that could act on it: the connection was refused
 *    before anything was sent, or the server answered 404 "session not
 *    found" (its router rejects an unknown session before any tool runs).
 *    Everything else -- including an execute_prompt/execute_command whose
 *    response stream died mid-flight -- fails as before; it is never
 *    blindly re-sent.
 *  - Before that retry, and before the first send after the connection
 *    dropped, the transport re-probes the server: running -> open a new
 *    session there; gone -> auto-start it (when allowed); unresponsive ->
 *    fail with the probe's error.
 *  - In-flight requests on a dead connection are rejected through the usual
 *    'error'/'close' events (McpClient rejects its pending map).
 */
import { EventEmitter } from 'node:events';
import { StreamableHttpTransport } from './transport.mjs';

/**
 * True when a send() failure proves the request never reached the server's
 * tool layer.
 * @param {any} err
 */
export function isNeverDeliveredError(err) {
    if (!err) return false;
    if (err.status === 404) return true; // unknown session: rejected by the router
    const codes = [];
    const cause = err.cause;
    if (cause) {
        if (cause.code) codes.push(cause.code);
        if (Array.isArray(cause.errors)) for (const e of cause.errors) if (e && e.code) codes.push(e.code);
    }
    if (err.code) codes.push(err.code);
    return codes.length > 0 && codes.every((c) => c === 'ECONNREFUSED');
}

export class ReconnectingHttpTransport extends EventEmitter {
    /**
     * @param {string} url
     * @param {{ options?: object,
     *           relocate: () => Promise<string>,
     *           createTransport?: (url: string, options: object) => any }} cfg
     *   relocate: re-probe the server (auto-starting it if gone and allowed)
     *   and return the URL to reconnect to; throws when there is none.
     */
    constructor(url, cfg) {
        super();
        this.url = url;
        this.options = cfg.options || {};
        this.relocate = cfg.relocate;
        this.createTransport = cfg.createTransport || ((u, o) => new StreamableHttpTransport(u, o));
        this.inner = null;
        this.stale = false;
        this.stopped = false;
        this.reconnecting = null;
        this.reconnects = 0;
    }

    get sessionId() {
        return this.inner ? this.inner.sessionId : null;
    }

    async start() {
        await this._open(this.url);
        this.emit('ready');
    }

    async _open(url) {
        const t = this.createTransport(url, this.options);
        let initError = null;
        const onInitError = (e) => { initError = e; };
        t.on('error', onInitError);
        await t.start();
        t.off('error', onInitError);
        if (initError || !t.sessionId) {
            try { t.stop(); } catch { /* ignore */ }
            throw initError || new Error(`Could not open an MCP session at ${url}`);
        }
        const old = this.inner;
        this.inner = t;
        this.url = url;
        this.stale = false;
        t.on('message', (m) => { if (this.inner === t) this.emit('message', m); });
        t.on('error', (e) => {
            if (this.inner !== t) return;
            this.stale = true;
            this.emit('error', e);
        });
        t.on('close', () => {
            if (this.inner !== t || this.stopped) return;
            this.stale = true;
            this.emit('close');
        });
        if (old) { try { old.stop(); } catch { /* ignore */ } }
    }

    /** Serialised: concurrent senders share one re-probe/reconnect. */
    _reconnect() {
        if (!this.reconnecting) {
            this.reconnecting = (async () => {
                const url = await this.relocate();
                this.reconnects += 1;
                await this._open(url);
            })().finally(() => { this.reconnecting = null; });
        }
        return this.reconnecting;
    }

    async send(message) {
        if (this.stopped) throw new Error('Transport stopped');
        if (this.reconnecting) await this.reconnecting;
        if (this.stale) await this._reconnect();
        try {
            return await this.inner.send(message);
        } catch (err) {
            if (!isNeverDeliveredError(err)) throw err;
            // Provably never delivered: re-probe/auto-start, then ONE retry.
            await this._reconnect();
            return await this.inner.send(message);
        }
    }

    stop() {
        this.stopped = true;
        if (this.inner) {
            const t = this.inner;
            // Deliberate stop: surface 'close' exactly like the plain transport.
            t.once('close', () => this.emit('close'));
            t.stop();
        }
    }
}
