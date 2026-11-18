/**
 * Member-side staging of VCS request bodies (file-based transport).
 *
 * Every body-carrying VCS builder (create/update pull request, PR comments --
 * see vcs-providers/shell-helpers.mjs jsonBodyFromFile) emits
 * `curl --data-binary @<path>` instead of an inline `-d '<json>'` argument,
 * because a JSON body on the command line hits the Windows command-line caps
 * (CreateProcess 32767 chars via powershell.exe, cmd.exe 8191 over SSH) long
 * before any provider's own body limit. This module owns the other half:
 *
 *   1. resolveVcsPayloadDir()  -- the member's ABSOLUTE work folder (from
 *      member_detail's `folder`) joined with the payload subdirectory, in the
 *      member OS's own path syntax, resolved here in JavaScript. Nothing in
 *      the dispatched command relies on shell-side expansion ($VAR, ~/), and a
 *      work folder that is not absolute is a loud failure, never a guess.
 *   2. memberPayloadPath()     -- a fresh, collision-free file path in it for
 *      one request (handed to the builder as `payload_path`).
 *   3. execVcsWithPayload()    -- stages `built.payload.content` at that path
 *      with send_files, runs the command through vcs_credential_exec, and
 *      ALWAYS deletes the staged file afterwards (even when staging or the
 *      call failed: a partial delivery may have landed). The subdirectory is
 *      also added to the member's git exclude file first, so a file left
 *      behind by a crash between staging and delete can never be committed.
 *
 * send_files writes only inside the member's work folder, so the file is
 * inside the working tree and is removed after the call (the same pattern
 * member-call.mjs uses for its remote args files, and the same subdirectory).
 *
 * A staging failure never throws: it is returned as a vcs_credential_exec-
 * shaped `dispatch_failed` result, which every caller already degrades as a
 * command failure (returned, not thrown) with the reason in stderr.
 *
 * ASCII only.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MEMBER_CALL_ARGS_DIR } from './member-call.mjs';
import { getSeCommands } from './se-os-commands.mjs';
import { resultText } from './mcp-result.mjs';

/** Work-folder-relative subdirectory request bodies are staged in. Shared
 *  with member-call.mjs's args files: one excluded, engine-owned scratch dir. */
export const VCS_PAYLOAD_SUBDIR = MEMBER_CALL_ARGS_DIR;

const WINDOWS_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** Whether `folder` is an absolute path for a member of OS `memberOs`. */
export function isAbsoluteMemberPath(folder, memberOs) {
    const f = String(folder ?? '');
    if (memberOs === 'windows' || memberOs === 'win32') return WINDOWS_ABSOLUTE_RE.test(f) || f.startsWith('/');
    return f.startsWith('/');
}

/**
 * Join an absolute member work folder with the payload subdirectory, in the
 * member's own path syntax: a Windows folder written with backslashes keeps
 * backslashes (curl.exe accepts either); everything else uses '/'. Pure.
 * Throws an ERROR for an empty or non-absolute folder.
 * @param {string} workFolder
 * @param {string} memberOs resolveMemberTarget()'s os
 * @returns {string}
 */
export function joinMemberPayloadDir(workFolder, memberOs) {
    const raw = String(workFolder ?? '').trim();
    if (!raw) throw new Error('ERROR: VCS payload staging: the member registry reports no work folder, so no member-side path can be resolved for the request body.');
    if (!isAbsoluteMemberPath(raw, memberOs)) {
        throw new Error(`ERROR: VCS payload staging: the member work folder "${raw}" is not an absolute path, so the request-body file path cannot be resolved without shell expansion. Re-register the member with a fully-qualified work_folder.`);
    }
    const windowsStyle = (memberOs === 'windows' || memberOs === 'win32') && raw.includes('\\') && !raw.includes('/');
    const sep = windowsStyle ? '\\' : '/';
    const trimmed = raw.replace(/[\\/]+$/, '') || sep;
    const sub = VCS_PAYLOAD_SUBDIR.split('/').join(sep);
    return trimmed.endsWith(sep) ? `${trimmed}${sub}` : `${trimmed}${sep}${sub}`;
}

/**
 * Resolve the member-side directory request bodies are staged in, from the
 * member registry (member_detail `folder`). Returns { dir } or { error }.
 * @param {{ fleetApi: object, member: string, memberOs: string }} opts
 */
export async function resolveVcsPayloadDir({ fleetApi, member, memberOs }) {
    try {
        if (!fleetApi || typeof fleetApi.memberDetail !== 'function') {
            return { error: `cannot resolve the work folder of member '${member}': this fleet client exposes no member_detail tool.` };
        }
        const res = await fleetApi.memberDetail({ member_name: member, format: 'json' });
        const text = typeof res === 'string' ? res : resultText(res);
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* reported below */ }
        if (!parsed || typeof parsed !== 'object') {
            return { error: `cannot resolve the work folder of member '${member}': member_detail returned no JSON (${String(text || '(empty)').slice(0, 200)}).` };
        }
        return { dir: joinMemberPayloadDir(parsed.folder, memberOs) };
    } catch (err) {
        return { error: `cannot resolve the work folder of member '${member}': ${err && err.message ? err.message : err}` };
    }
}

/**
 * A fresh request-body path inside `dir` (from resolveVcsPayloadDir), in the
 * same separator style as `dir`. Returns { path, fileName }.
 * @param {string} dir
 */
export function memberPayloadPath(dir) {
    const d = String(dir ?? '');
    const sep = d.includes('\\') && !d.includes('/') ? '\\' : '/';
    const fileName = `vcs-body-${crypto.randomBytes(8).toString('hex')}.json`;
    return { path: `${d}${sep}${fileName}`, fileName };
}

/** The file-name component of a staged payload path (either separator). */
function payloadFileName(p) {
    const parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1];
}

function stagingFailure(member, label, message) {
    const text = `[FAIL] Could not stage the request body on member '${member}': ${message}`;
    return {
        content: [{ text }],
        structuredContent: {
            ok: false,
            reason: 'dispatch_failed',
            exitCode: null,
            stdout: '',
            stderr: text,
            tokenRedactions: 0,
            credentialLabel: label ?? null,
            memberId: null,
            memberName: member,
        },
    };
}

/**
 * Run `built.command` through vcs_credential_exec, staging `built.payload`
 * (when the builder produced one) on the member first and deleting it after.
 * A built command with no payload is dispatched unchanged.
 *
 * @param {{
 *   fleetApi: object,          // sendFiles + vcsCredentialExec
 *   command: Function,         // the engine's member command runner: (cmd, opts) => { ok, output, error }
 *   member: string,
 *   label: string,             // vcs_credential_exec credential label
 *   built: { command: string, payload?: { path: string, content: string } },
 *   target: { os: string, shell: string },
 *   log?: Function,
 *   logPrefix?: string,
 *   tmpdir?: string,           // test seam
 * }} opts
 * @returns {Promise<object>} the vcs_credential_exec result (or a dispatch_failed-shaped staging failure)
 */
export async function execVcsWithPayload({ fleetApi, command, member, label, built, target, log = () => {}, logPrefix = '[vcs-payload]', tmpdir = os.tmpdir() }) {
    const payload = built && built.payload;
    if (!payload) {
        return fleetApi.vcsCredentialExec({ member_name: member, label, command: built.command });
    }
    if (!fleetApi || typeof fleetApi.sendFiles !== 'function') {
        return stagingFailure(member, label, 'this fleet client exposes no send_files tool, and request bodies are never sent inline on the command line. Upgrade the fleet server/client.');
    }
    const fileName = payloadFileName(payload.path);
    const relPath = `${VCS_PAYLOAD_SUBDIR}/${fileName}`;
    const cmds = getSeCommands(target);
    const runMember = async (cmd, what) => {
        if (typeof command !== 'function') return;
        try {
            const r = await command(cmd, { member_name: member, silent: true, failSoft: true, label: what });
            if (r && typeof r === 'object' && r.ok === false) {
                log(`${logPrefix}: WARNING: ${what} on member '${member}' failed (continuing): ${r.error || r.output || '(no detail)'}`);
            }
        } catch (err) {
            log(`${logPrefix}: WARNING: ${what} on member '${member}' failed (continuing): ${err && err.message ? err.message : err}`);
        }
    };
    await runMember(cmds.ensureGitExcluded(`${VCS_PAYLOAD_SUBDIR}/`), 'git-exclude the VCS request-body directory');
    try {
        let localDir = null;
        try {
            localDir = fs.mkdtempSync(path.join(tmpdir, 'vcs-body-'));
            const localFile = path.join(localDir, fileName);
            fs.writeFileSync(localFile, payload.content, 'utf8');
            const sent = await fleetApi.sendFiles({
                member_name: member,
                local_paths: [localFile],
                dest_subdir: VCS_PAYLOAD_SUBDIR,
            });
            if (sent && sent.isError) {
                return stagingFailure(member, label, `send_files failed: ${resultText(sent) || '(no detail)'}`);
            }
        } catch (err) {
            return stagingFailure(member, label, `send_files failed: ${err && err.message ? err.message : err}`);
        } finally {
            if (localDir) {
                try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
            }
        }
        return await fleetApi.vcsCredentialExec({ member_name: member, label, command: built.command });
    } finally {
        // Even after a failed send_files: a partial delivery may have landed.
        await runMember(cmds.removeFile(relPath), 'delete the staged VCS request body');
    }
}
