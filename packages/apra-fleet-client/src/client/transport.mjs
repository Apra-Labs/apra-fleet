import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { fetch as undiciFetch, Agent as UndiciAgent } from 'undici';

// Node's built-in fetch enforces a default ~300s idle bodyTimeout on
// response bodies. MCP streamable-HTTP responses arrive over SSE streams
// that can legitimately sit silent for far longer than that (a long
// execute_prompt dispatch prints nothing until the member CLI finishes --
// observed live: a 675s planner run whose POST response stream was killed
// at ~300s, losing a 16k-token result and forcing a duplicate dispatch).
// Use undici's own fetch with an explicit dispatcher that disables the
// header/body idle timeouts. This does NOT create unbounded hangs: every
// JSON-RPC request still has McpClient's own per-request timeout, and the
// persistent GET stream has its own reconnect loop.
const sseDispatcher = new UndiciAgent({
    headersTimeout: 0,
    bodyTimeout: 0,
});

export class StdioTransport extends EventEmitter {
    constructor(command, args, options = {}) {
        super();
        this.command = command;
        this.args = args;
        this.options = options;
        this.process = null;
        this.buffer = '';
    }

    start() {
        this.process = spawn(this.command, this.args, this.options);
        
        this.process.stdout.on('data', (chunk) => {
            this.buffer += chunk.toString();
            this.processBuffer();
        });

        this.process.stderr.on('data', (chunk) => {
            // Simply log or emit stderr if needed
            // console.error(`[StdioTransport] stderr: ${chunk.toString()}`);
        });

        this.process.on('close', (code) => {
            this.emit('close', code);
        });
        
        this.process.on('error', (err) => {
            this.emit('error', err);
        });
    }

    processBuffer() {
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';
        
        for (const line of lines) {
            if (line.trim()) {
                try {
                    const message = JSON.parse(line);
                    this.emit('message', message);
                } catch (e) {
                    console.error('[StdioTransport] parse error', e, line);
                }
            }
        }
    }

    async send(message) {
        if (!this.process) {
            throw new Error('Transport not started');
        }
        const data = JSON.stringify(message) + '\n';
        this.process.stdin.write(data);
    }
    
    stop() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }
}

export class StreamableHttpTransport extends EventEmitter {
    constructor(url, options = {}) {
        super();
        this.url = url;
        this.options = options;
        this.controller = null;
        this.sessionId = null;
    }

    async start() {
        this.controller = new AbortController();
        try {
            // 1. Send the initialize request via POST to get session ID
            const initMsg = {
                jsonrpc: '2.0',
                id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'fleet-client', version: '1.0.0' }
                }
            };

            const postHeaders = {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...(this.options.headers || {})
            };

            const postResponse = await undiciFetch(this.url, {
                method: 'POST',
                headers: postHeaders,
                body: JSON.stringify(initMsg),
                signal: this.controller.signal,
                dispatcher: sseDispatcher
            });
            
            if (!postResponse.ok) {
                throw new Error(`Init POST error! status: ${postResponse.status}`);
            }

            this.sessionId = postResponse.headers.get('mcp-session-id');
            if (!this.sessionId) {
                throw new Error('No mcp-session-id returned by server during initialization');
            }

            // Read the init response body so fetch doesn't hold the connection
            const initResponseText = await postResponse.text();
            
            // 2. Open the persistent SSE stream via GET using the session ID.
            // Run it as a self-reconnecting background loop rather than a
            // single fetch: this stream is normally SILENT (JSON-RPC
            // responses arrive over each POST's own SSE response, not here),
            // and Node's built-in fetch (undici) enforces a default
            // ~300s idle bodyTimeout on response bodies -- so a single-shot
            // GET stream deterministically dies ~5 minutes into every
            // session, which used to emit 'close' and reject EVERY in-flight
            // request (observed live killing auto-sprint runs mid-dispatch,
            // always at start+~304s). An idle timeout on a keepalive channel
            // is an expected, recoverable event: quietly reopen the stream
            // and only surface 'close'/'error' on deliberate stop() or
            // persistent (5x consecutive) reconnect failure.
            this._runPersistentStream().catch(() => { /* loop handles its own errors */ });

            this.emit('ready');
        } catch (error) {
            this.emit('error', error);
        }
    }

    async _runPersistentStream() {
        let consecutiveFailures = 0;
        while (this.controller && !this.controller.signal.aborted) {
            try {
                const getResponse = await undiciFetch(this.url, {
                    method: 'GET',
                    headers: {
                        'Accept': 'text/event-stream',
                        'mcp-session-id': this.sessionId,
                        ...(this.options.headers || {})
                    },
                    signal: this.controller.signal,
                    dispatcher: sseDispatcher
                });
                if (!getResponse.ok) {
                    throw new Error(`Stream GET error! status: ${getResponse.status}`);
                }
                consecutiveFailures = 0;
                // Returns when the stream ends (server closed it, or undici's
                // idle bodyTimeout fired as a thrown error caught below).
                await this.readStream(getResponse.body);
            } catch (err) {
                if (err.name === 'AbortError' || (this.controller && this.controller.signal.aborted)) {
                    break;
                }
                consecutiveFailures += 1;
                if (consecutiveFailures >= 5) {
                    const giveUp = new Error(`Persistent SSE stream failed ${consecutiveFailures} consecutive reconnect attempts: ${err.message}`);
                    this.emit('error', giveUp);
                    this.emit('close');
                    return;
                }
            }
            // Small backoff before reopening (also on clean stream end --
            // an immediately-dying stream must not become a hot loop).
            await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** consecutiveFailures, 15000)));
        }
        // Deliberate stop(): reject in-flight requests exactly as before.
        this.emit('close');
    }

    async readStream(body, emitClose = false) {
        const decoder = new TextDecoder();
        let buffer = '';
        let eventType = 'message';
        let data = [];

        try {
            for await (const chunk of body) {
                const textChunk = decoder.decode(chunk, { stream: true });
                buffer += textChunk;
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (line.startsWith('event:')) {
                        eventType = line.slice(6).trim();
                    } else if (line.startsWith('data:')) {
                        const dataContent = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
                        data.push(dataContent);
                    } else if (line === '') {
                        if (data.length > 0) {
                            this.handleEvent(eventType, data.join('\n'));
                            data = [];
                        }
                        eventType = 'message';
                    }
                }
            }
        } catch (e) {
            throw e;
        } finally {
            if (emitClose) {
                this.emit('close');
            }
        }
    }

    handleEvent(eventType, eventData) {
        if (eventType === 'message') {
            try {
                const message = JSON.parse(eventData);
                this.emit('message', message);
            } catch (e) {
                console.error('[StreamableHttpTransport] parse error', e, eventData);
            }
        }
    }

    async send(message) {
        if (!this.sessionId) {
            throw new Error('Transport not ready (no session ID)');
        }
        
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'mcp-session-id': this.sessionId,
            'mcp-protocol-version': '2024-11-05',
            ...(this.options.headers || {})
        };
        // dispatcher disables undici's ~300s idle bodyTimeout: this POST's
        // SSE response stream stays silent for the full duration of a long
        // dispatch (e.g. an execute_prompt that thinks for 10+ minutes) and
        // must not be idle-killed -- that would emit 'error', reject every
        // pending request, and orphan the still-running remote session.
        const response = await undiciFetch(this.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(message),
            dispatcher: sseDispatcher
        });
        
        if (!response.ok) {
            throw new Error(`Failed to send message: HTTP ${response.status}`);
        }
        
        // The server sends the JSON-RPC response over an SSE stream in the POST response
        this.readStream(response.body).catch(err => {
            if (err.name !== 'AbortError') {
                this.emit('error', err);
            }
        });
    }
    
    stop() {
        if (this.controller) {
            this.controller.abort();
            this.controller = null;
        }
    }
}
