// =============================================================================
// memberCall / listTools -- the ONE engine helper for calling a fleet tool AS a
// member (a MEMBER-scoped session: the member allowlist applies, and kb_* etc.
// resolve to that member's own work folder).
//
// Adapters, chosen by the member's type:
//   - local             -> direct in-process MCP session to the orchestrator's
//                          own server with ?member=<uuid> (client's
//                          connectFleetMember). No process is spawned.
//   - remote | relay    -> send_files delivers a JSON args file into the
//                          member's work folder, then execute_command runs
//                          `apra-fleet call --member <uuid> <tool> --args-file
//                          <path>` (or --list-tools) ON the member; its output
//                          is parsed back into a typed result or error.
//
// The remote command string is built here in JavaScript for the member's
// {os, shell} (resolveMemberTarget + getSeCommands); it contains NO shell
// expansion ($VAR, ~/, backticks) and no POSIX-only quoting: every interpolated
// token is validated against a strict charset and the args file is addressed by
// a work-folder-relative path (execute_command runs in the member's work
// folder), so the same string is valid in bash and PowerShell.
//
// ENGINE-OWNED ARGS-FILE CLEANUP (remote | relay): the member-side verb deletes
// the delivered file itself (--rm-args-file), but that only happens if the verb
// actually runs -- a member without apra-fleet, a released binary without the
// `call` verb ("unknown option 'call'"), a timeout or a crash would otherwise
// leave the JSON untracked in the member's git checkout. So the engine also:
//   1. before the FIRST send_files to a member (per createMemberCall instance),
//      runs getSeCommands(target).ensureGitExcluded('.apra-call/') so the args
//      dir is in the member repo's git exclude file (failure is logged loudly
//      but does not break the call; retried on the next call);
//   2. in a finally around send_files + the call, runs
//      getSeCommands(target).removeFile(argsPath) regardless of outcome --
//      success, isError, unparseable output, or a thrown executeCommand
//      (a client-side timeout throws; a server-side one returns isError --
//      both reach the finally). A failed delete is logged and swallowed so it
//      never masks the call's own result or typed error.
// --list-tools delivers no file and issues neither command.
//
// The engine's own orchestrator work keeps its FULL session -- the injected
// callTool used elsewhere is untouched by this module.
//
// All transports/clients are injected so tests use fakes.
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveMemberTarget } from './member-target.mjs';
import { getSeCommands } from './se-os-commands.mjs';
import { resultText } from './mcp-result.mjs';

/** Work-folder-relative directory (forward slashes: valid in bash, PowerShell, node) for delivered args files. */
export const MEMBER_CALL_ARGS_DIR = '.apra-call';

/** Typed failure from a member call. `code` is the apra-fleet call error code when one was reported. */
export class MemberCallError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'MemberCallError';
        this.code = code;
        this.details = details;
    }
}

const UUID_RE = /^[0-9a-fA-F-]{8,64}$/;
const TOOL_RE = /^[A-Za-z0-9_]+$/;

/**
 * Build the command run ON a remote/relay member. Pure; exported for tests.
 * @param {{ os: string, shell: string }} target
 * @param {{ memberId: string, tool?: string, argsPath?: string, listTools?: boolean }} spec
 * @returns {string}
 */
export function buildRemoteCallCommand(target, { memberId, tool, argsPath, listTools = false }) {
    if (!UUID_RE.test(String(memberId))) throw new MemberCallError('E-USAGE', `unsafe member id '${memberId}'`);
    let script = `apra-fleet call --member ${memberId}`;
    if (listTools) {
        script += ' --list-tools';
    } else {
        if (!TOOL_RE.test(String(tool))) throw new MemberCallError('E-USAGE', `unsafe tool name '${tool}'`);
        if (!/^[A-Za-z0-9._\/-]+$/.test(String(argsPath))) throw new MemberCallError('E-USAGE', `unsafe args path '${argsPath}'`);
        // --rm-args-file: the verb deletes the delivered file itself (shell-independent), so the member's work tree stays clean.
        script += ` ${tool} --args-file ${argsPath} --rm-args-file`;
    }
    return getSeCommands(target).wrapForMember(script);
}

function memberIdOf(member) {
    return member && (member.id || member.member_id);
}

function isLocal(member) {
    return String(member && (member.type || member.agentType) || '').toLowerCase() === 'local';
}

/** Throw a typed error for an isError tool result, else return the result. */
function unwrapToolResult(result, tool) {
    if (result && result.isError) {
        throw new MemberCallError('E-TOOL', resultText(result) || 'tool returned an error', { tool });
    }
    return result;
}

/** Find the last parseable JSON object line in command output. */
function lastJsonObject(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].startsWith('{')) continue;
        try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
    }
    return null;
}

/**
 * Parse `apra-fleet call` output back into a typed result or throw a typed error.
 * Success prints the tool result JSON; failure prints {"error":{code,message}}.
 */
function parseRemoteOutput(res, what) {
    const text = resultText(res);
    const parsed = lastJsonObject(text);
    if (parsed && parsed.error && typeof parsed.error === 'object') {
        throw new MemberCallError(parsed.error.code || 'E-REMOTE', parsed.error.message || text, { what });
    }
    if (res && res.isError) {
        throw new MemberCallError('E-REMOTE', text || `remote ${what} failed`, { what });
    }
    if (!parsed) throw new MemberCallError('E-REMOTE-PARSE', `could not parse apra-fleet call output for ${what}: ${text}`, { what });
    return parsed;
}

/**
 * Create the helper. Dependencies (all injectable):
 *   fleetApi        sendFiles / executeCommand / memberDetail (remote adapter + OS resolution)
 *   connectLocal    (memberId) => Promise<{ mcpClient: {callTool, listTools}, transport?: {stop} }>
 *                   defaults to the client's connectFleetMember
 *   resolveTarget   ({ fleetApi, member, log }) => Promise<{os, shell}>; defaults to resolveMemberTarget
 *   fsImpl          { mkdtempSync, writeFileSync, rmSync } for the local args temp file
 *   tmpdir          local temp root
 *   log
 *
 * @returns {{ memberCall(member, tool, args): Promise<object>, listTools(member): Promise<object> }}
 */
export function createMemberCall(deps = {}) {
    const { fleetApi, log = () => {} } = deps;
    const fsImpl = deps.fsImpl || fs;
    const tmpdir = deps.tmpdir || os.tmpdir();
    const resolveTarget = deps.resolveTarget || resolveMemberTarget;
    const connectLocal = deps.connectLocal || (async (memberId) => {
        const m = await import('@apralabs/apra-fleet-client/server-resolution');
        return m.connectFleetMember(memberId);
    });

    async function withLocalSession(member, fn) {
        let session;
        try {
            session = await connectLocal(memberIdOf(member));
        } catch (err) {
            if (err && err.status === 403) {
                throw new MemberCallError('E-MEMBER-FORBIDDEN', `server refused member ${memberIdOf(member)}: not a registered member (HTTP 403)`, { status: 403 });
            }
            throw new MemberCallError(err && err.code || 'E-CONNECT', err && err.message || String(err));
        }
        try {
            return await fn(session.mcpClient);
        } finally {
            try {
                if (typeof session.close === 'function') await session.close();
                else if (session.transport && session.transport.stop) session.transport.stop();
            } catch { /* ignore */ }
        }
    }

    /** Member ids whose repo already lists the args dir in its git exclude file (this instance only). */
    const excludedMembers = new Set();

    /** Short description of an executeCommand failure (isError result) for logs; null when it succeeded. */
    function commandFailure(res) {
        return res && res.isError ? (resultText(res) || 'isError result') : null;
    }

    async function ensureArgsDirExcluded(member, cmds) {
        const memberId = memberIdOf(member);
        if (excludedMembers.has(memberId)) return;
        try {
            const res = await fleetApi.executeCommand({ member_id: memberId, command: cmds.ensureGitExcluded(`${MEMBER_CALL_ARGS_DIR}/`) });
            const failure = commandFailure(res);
            if (failure) throw new Error(failure);
            excludedMembers.add(memberId);
        } catch (err) {
            log(`[member-call] WARNING: could not add ${MEMBER_CALL_ARGS_DIR}/ to the git exclude file on member '${member.name || memberId}' (continuing; the args file is still deleted engine-side): ${err && err.message || err}`);
        }
    }

    async function deleteRemoteArgsFile(member, cmds, argsPath) {
        const memberId = memberIdOf(member);
        try {
            const res = await fleetApi.executeCommand({ member_id: memberId, command: cmds.removeFile(argsPath) });
            const failure = commandFailure(res);
            if (failure) throw new Error(failure);
        } catch (err) {
            log(`[member-call] WARNING: could not delete args file ${argsPath} on member '${member.name || memberId}': ${err && err.message || err}`);
        }
    }

    async function runRemote(member, spec, what) {
        const target = await resolveTarget({ fleetApi, member: member.name, log });
        const memberId = memberIdOf(member);
        if (spec.listTools) {
            const command = buildRemoteCallCommand(target, { memberId, listTools: true });
            const res = await fleetApi.executeCommand({ member_id: memberId, command });
            return parseRemoteOutput(res, what);
        }
        const cmds = getSeCommands(target);
        await ensureArgsDirExcluded(member, cmds);
        const localDir = fsImpl.mkdtempSync(path.join(tmpdir, 'member-call-'));
        const fileName = `call-${crypto.randomBytes(6).toString('hex')}.json`;
        const localFile = path.join(localDir, fileName);
        const argsPath = `${MEMBER_CALL_ARGS_DIR}/${fileName}`;
        try {
            try {
                fsImpl.writeFileSync(localFile, JSON.stringify(spec.args ?? {}));
                const sent = await fleetApi.sendFiles({
                    member_id: memberId,
                    local_paths: [localFile],
                    dest_subdir: MEMBER_CALL_ARGS_DIR,
                });
                if (sent && sent.isError) {
                    throw new MemberCallError('E-SEND-FILES', resultText(sent) || 'send_files failed', { what });
                }
            } finally {
                try { fsImpl.rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
            }
            const command = buildRemoteCallCommand(target, { memberId, tool: spec.tool, argsPath });
            const res = await fleetApi.executeCommand({ member_id: memberId, command });
            return parseRemoteOutput(res, what);
        } finally {
            // Even after a failed send_files: a partial delivery may have landed.
            await deleteRemoteArgsFile(member, cmds, argsPath);
        }
    }

    return {
        async memberCall(member, tool, args = {}) {
            if (!memberIdOf(member)) throw new MemberCallError('E-USAGE', 'memberCall requires a member with an id');
            if (!TOOL_RE.test(String(tool))) throw new MemberCallError('E-USAGE', `unsafe tool name '${tool}'`);
            if (isLocal(member)) {
                return withLocalSession(member, async (client) => unwrapToolResult(await client.callTool(tool, args), tool));
            }
            return runRemote(member, { tool, args }, tool);
        },
        async listTools(member) {
            if (!memberIdOf(member)) throw new MemberCallError('E-USAGE', 'listTools requires a member with an id');
            if (isLocal(member)) {
                return withLocalSession(member, (client) => client.listTools());
            }
            return runRemote(member, { listTools: true }, 'list-tools');
        },
    };
}
