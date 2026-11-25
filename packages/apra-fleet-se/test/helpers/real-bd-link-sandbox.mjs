// Shared pieces of the real-bd link-guard tests (dolt-push-verify-links-real-bd
// and dolt-pull-bracket-verify-real-bd): a hermetic sandbox with a bare git
// remote and real bd clones A and B, the conflict scenario, and the engine's
// command seam wired to a beads scope the way runner.js wires it.
//
// Hermetic: HOME, USERPROFILE, GIT_CONFIG_GLOBAL and TMPDIR point into the
// sandbox root (the caller removes it). ASCII only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

import { createBeadsScope } from '../../fleet-sprint/beads-scope.mjs';
import { parseBdJson } from '../../fleet-sprint/runner.js';
import { bdChildEnv } from './bd-replay.mjs';

export function bdAvailable() {
    // A PATH lookup, not `bd version`: any bd invocation records an event
    // under the invoking HOME (and its background writer can outlive a
    // cleanup), and this test must leave nothing outside its sandbox.
    const names = process.platform === 'win32' ? ['bd.exe', 'bd.cmd', 'bd'] : ['bd'];
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        for (const name of names) {
            try {
                if (fs.statSync(path.join(dir, name)).isFile()) return true;
            } catch { /* not here */ }
        }
    }
    return false;
}

/** One sandbox: HOME/USERPROFILE/GIT_CONFIG_GLOBAL/TMPDIR inside it, a bare git remote, clones A and B. */
export function createSandbox() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linkguard-realbd-')));
    const home = path.join(root, 'home');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(home);
    fs.mkdirSync(tmp);
    const env = {
        ...bdChildEnv(),
        HOME: home,
        USERPROFILE: home,
        GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        BD_NON_INTERACTIVE: '1',
        GIT_TERMINAL_PROMPT: '0',
    };
    delete env.BEADS_ACTOR;
    const dirs = { A: path.join(root, 'A'), B: path.join(root, 'B') };
    return { root, env, dirs, remote: path.join(root, 'remote.git') };
}

/** Run `cmd` for real in `cwd`; resolves { ok, stdout, stderr } (never rejects). */
export function run(cmd, cwd, env) {
    return new Promise((resolve) => {
        exec(cmd, { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
        });
    });
}

export async function runOrThrow(sb, cmd, cwd) {
    const r = await run(cmd, cwd, sb.env);
    if (!r.ok) throw new Error(`sandbox setup: '${cmd}' failed in ${cwd}:\n${r.stdout}${r.stderr}`);
    return r.stdout.trim();
}

/** The links of one clone, read with bd: { parentOf: Map, blocks: Set<'X>Y'> }. */
export async function linksOf(sb, dir) {
    const rows = JSON.parse(await runOrThrow(sb, 'bd list --all --limit 0 --json --brief', dir));
    const parentOf = new Map();
    const blocks = new Set();
    for (const b of rows) {
        if (b.parent) parentOf.set(b.id, b.parent);
        for (const d of b.dependencies || []) if (d.type === 'blocks') blocks.add(`${b.id}>${d.depends_on_id}`);
    }
    return { parentOf, blocks };
}

/**
 * Build the scenario up to the point where B is about to run the engine push:
 * seeded P, C, X, Y on A and pushed; B bootstrapped; A linked C -> P,
 * X blocked-by Y, edited Y and pushed; B edited Y (a later write) so B's
 * reconcile pull conflicts and auto-merges.
 */
export async function buildScenario() {
    const sb = createSandbox();
    const { A, B } = sb.dirs;
    await runOrThrow(sb, 'git config --global user.name "Link Guard"', sb.root);
    await runOrThrow(sb, 'git config --global user.email link-guard@test.local', sb.root);
    await runOrThrow(sb, 'git config --global commit.gpgsign false', sb.root);
    await runOrThrow(sb, `git init -q --bare -b main "${sb.remote}"`, sb.root);
    const url = `file://${sb.remote}`;
    fs.mkdirSync(A);
    await runOrThrow(sb, 'git init -q -b main', A);
    await runOrThrow(sb, `git remote add origin "${url}"`, A);
    await runOrThrow(sb, 'git commit -q --allow-empty -m init', A);
    await runOrThrow(sb, 'git push -q origin main', A);
    await runOrThrow(sb, 'bd init --prefix lg', A);
    const ids = {};
    ids.P = (await runOrThrow(sb, 'bd create "P" -t feature --silent', A)).split(/\s+/).pop();
    ids.C = (await runOrThrow(sb, 'bd create "C" -t task --silent', A)).split(/\s+/).pop();
    // X and Y sit under P from the start, so their blocks edge is in the sprint scope.
    ids.X = (await runOrThrow(sb, `bd create "X" -t task --parent ${ids.P} --silent`, A)).split(/\s+/).pop();
    ids.Y = (await runOrThrow(sb, `bd create "Y" -t task --parent ${ids.P} --silent`, A)).split(/\s+/).pop();
    // Z blocked by X: a link every clone holds from the start (cases 2 and 3
    // drop it, with X -> P, in B's reconcile pull).
    ids.Z = (await runOrThrow(sb, `bd create "Z" -t task --parent ${ids.P} --silent`, A)).split(/\s+/).pop();
    await runOrThrow(sb, `bd dep add ${ids.Z} ${ids.X}`, A);
    await runOrThrow(sb, 'bd dolt push', A);
    fs.mkdirSync(B);
    await runOrThrow(sb, `git clone -q "${url}" .`, B);
    await runOrThrow(sb, 'bd bootstrap --yes', B);

    await runOrThrow(sb, `bd update ${ids.C} --parent ${ids.P}`, A);
    await runOrThrow(sb, `bd dep add ${ids.X} ${ids.Y}`, A);
    await runOrThrow(sb, `bd update ${ids.Y} --title "Y edited on A"`, A);
    await runOrThrow(sb, 'bd dolt push', A);
    // A later write on B: the conflicting row then settles last-write-wins
    // (an edit in the same second can abort the merge instead).
    await new Promise((r) => setTimeout(r, 1200));
    await runOrThrow(sb, `bd update ${ids.Y} --title "Y edited on B"`, B);
    return { sb, ids };
}

/**
 * The engine's command seam for this sandbox, plus a beads scope wired the
 * way runner.js wires it. The scope's ledger is fed by one snapshot read on
 * the backlog member (clone A, which holds both links).
 *
 * @param {object} opts
 * @param {(cmd: string, member: string) => boolean} [opts.failCommand] - answer this command with a failure instead of running it
 * @param {(member: string) => Promise<void>} [opts.afterPull] - runs after each real `bd dolt pull`
 */
export async function engineFor(sb, ids, { failCommand = () => false, afterPull = async () => {}, backlog = 'A' } = {}) {
    const calls = [];
    const logs = [];
    const rawCommand = async (cmd, opts = {}) => {
        const member = opts.member_name;
        const cwd = sb.dirs[member];
        assert.ok(cwd, `command for an unknown member '${member}': ${cmd}`);
        calls.push({ cmd, member });
        let res;
        if (failCommand(cmd, member)) {
            res = { ok: false, stdout: '', stderr: 'Error: injected restore failure (database is locked)' };
        } else {
            res = await run(cmd, cwd, sb.env);
            if (res.ok && /\bbd dolt pull\b/.test(cmd)) await afterPull(member);
        }
        const output = `${res.stdout}${res.ok ? '' : res.stderr}`;
        if (opts.failSoft) return { ok: res.ok, output, error: res.ok ? null : (res.stderr || res.stdout || 'command failed').trim() };
        if (!res.ok) throw new Error(`[Command Failed] ${cmd}: ${res.stderr || res.stdout}`);
        return res.stdout;
    };
    const scope = createBeadsScope({
        targetIssues: [ids.P],
        parseBdJson,
        getBacklogMember: () => backlog,
        log: (line) => logs.push(line),
    });
    const command = scope.wrapCommand(rawCommand);
    return { calls, logs, scope, command };
}

export const pushOptsFor = (eng) => ({
    command: eng.command,
    log: (m) => eng.logs.push(m),
    sleep: async () => {},
    // Wired exactly as runner.js -> createGitSync({ verifyLinks }) does.
    verifyLinks: (member) => eng.scope.verifyLinksBeforePush(member),
});

/** The links of a FRESH clone of the remote (what every other clone will pull). */
export async function remoteLinks(sb, name) {
    const dir = path.join(sb.root, name);
    fs.mkdirSync(dir);
    await runOrThrow(sb, `git clone -q "file://${sb.remote}" .`, dir);
    await runOrThrow(sb, 'bd bootstrap --yes', dir);
    return linksOf(sb, dir);
}

export const pullOptsFor = (eng) => ({
    command: eng.command,
    log: (m) => eng.logs.push(m),
    sleep: async () => {},
    remoteTipFingerprint: false,
});
