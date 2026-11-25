// Simulated member work folder for the beads flatten-recovery tests: it
// interprets the member-bound command strings (POSIX and PowerShell) against an
// in-memory folder. Shared by beads-flatten-recovery.test.mjs and
// beads-launch-pull.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = fs.readFileSync(path.join(here, '..', 'fixtures', 'dolt-unrelated-history', 'unrelated-history.txt'), 'utf8')
    .split(/^---\r?\n/m).slice(1).join('---\n');
export const REMOTE = 'git+ssh://example.invalid/beads.git';


export function decodePs(cmd) {
    const m = /^powershell -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(cmd);
    return m ? Buffer.from(m[1], 'base64').toString('utf16le') : null;
}


// ---------------------------------------------------------------------------
// Simulated member work folder.
// entries: top-level name -> { db?: { records, unrelated }, files: Map }
// ---------------------------------------------------------------------------
export function makeMember({ local, remote, failOn = {}, entries, knownHistory } = {}) {
    const fsx = new Map();
    if (entries) {
        for (const [k, v] of Object.entries(entries)) fsx.set(k, v);
    } else {
        fsx.set('.beads', {
            db: { records: local, unrelated: true, original: true, history: new Set(knownHistory || (local || []).map((r) => r.id).filter(Boolean)) },
            files: new Map([['config.yaml', ''], ['config.local.yaml', `sync.remote: "${REMOTE}"\n`]]),
        });
    }
    const calls = [];
    const split = (p) => {
        const i = p.indexOf('/');
        return i < 0 ? [p, null] : [p.slice(0, i), p.slice(i + 1)];
    };
    const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const ok = (output = '') => ({ ok: true, output, error: null });
    const bad = (error) => ({ ok: false, output: '', error });

    const command = async (cmd, opts = {}) => {
        assert.ok(opts.member_name, `every command names its member: ${cmd}`);
        const text = decodePs(cmd) ?? cmd;
        const dialect = decodePs(cmd) ? 'ps' : 'posix';
        calls.push({ cmd, text, dialect });
        for (const [needle, error] of Object.entries(failOn)) {
            if (text.includes(needle)) return bad(error);
        }
        let m;
        if ((m = /^ls -1A -- '(.+)'$/.exec(text)) || (m = /Get-ChildItem -LiteralPath '(.+?)' -Force -Name/.exec(text))) {
            return ok([...fsx.keys()].join('\n'));
        }
        if ((m = /^\[ -e '(.+?)' \] && \[ ! -e '(.+?)' \] && mv -- '.+?' '.+?'$/.exec(text))
            || (m = /Move-Item -LiteralPath '(.+?)' -Destination '(.+?)'/.exec(text))) {
            const [from, to] = [m[1], m[2]];
            if (!fsx.has(from) || fsx.has(to)) return bad(`rename ${from} -> ${to} refused`);
            fsx.set(to, fsx.get(from));
            fsx.delete(from);
            return ok();
        }
        if ((m = /^mkdir -p -- '(.+?)' && \{ \[ -e '(.+?)' \]/.exec(text)) || (m = /New-Item -ItemType Directory -Force -Path '(.+?)'.*Test-Path -LiteralPath '(.+?)'/.exec(text))) {
            if (!fsx.has(m[1])) fsx.set(m[1], { files: new Map() });
            const [, f] = split(m[2]);
            if (!fsx.get(m[1]).files.has(f)) fsx.get(m[1]).files.set(f, '');
            return ok();
        }
        if ((m = /^if \[ -e '(.+?)' \]; then cp -p -- '.+?' '(.+?)'; fi$/.exec(text)) || (m = /Copy-Item -LiteralPath '(.+?)' -Destination '(.+?)'/.exec(text))) {
            const [sd, sf] = split(m[1]);
            const [dd, df] = split(m[2]);
            const src = fsx.get(sd);
            if (src && src.files.has(sf)) {
                if (!fsx.has(dd)) return bad('no destination dir');
                fsx.get(dd).files.set(df, src.files.get(sf));
            }
            return ok();
        }
        if ((m = /^cat -- '(.+)'$/.exec(text)) || (m = /Get-Content -LiteralPath '(.+?)' -Raw/.exec(text))) {
            const [d, f] = split(m[1]);
            const dir = fsx.get(d);
            if (!dir || !dir.files.has(f)) return bad(`no such file ${m[1]}`);
            return ok(dir.files.get(f));
        }
        if ((m = /^rm -rf -- '(.+)'$/.exec(text)) || (m = /Remove-Item -LiteralPath '(.+?)' -Recurse -Force/.exec(text))) {
            fsx.delete(m[1]);
            return ok();
        }
        if (/info\/exclude/.test(text)) return ok();
        if ((m = /^bd export --all -o (.+)$/.exec(text))) {
            const beads = fsx.get('.beads');
            if (!beads || !beads.db) return bad('no beads database');
            const [d, f] = split(m[1]);
            if (!fsx.has(d)) return bad(`no dir ${d}`);
            fsx.get(d).files.set(f, jsonl(beads.db.records));
            const issues = beads.db.records.filter((r) => r._type !== 'memory').length;
            const mems = beads.db.records.length - issues;
            return ok(`Exported ${issues} issues and ${mems} memories to ${m[1]}`);
        }
        if ((m = /^bd --db (\S+) --readonly --json history (\S+) --limit 1$/.exec(text))) {
            const dir = fsx.get(m[1]);
            if (!dir || !dir.db) return bad(`no beads database at ${m[1]}`);
            // Like the real bd: a lock file appears next to the --db directory.
            fsx.set(`${m[1]}.gate.lock`, { files: new Map() });
            const known = dir.db.history ? dir.db.history.has(m[2]) : dir.db.records.some((r) => r.id === m[2]);
            return ok(known ? JSON.stringify([{ CommitHash: 'c1', Issue: { id: m[2] } }], null, 2) : 'null');
        }
        if (text === 'bd bootstrap --dry-run --json') {
            const beads = fsx.get('.beads');
            const remoteSet = beads && beads.files.has('config.local.yaml');
            return ok(JSON.stringify(remoteSet ? { action: 'sync', sync_remote: REMOTE } : { action: 'init' }));
        }
        if (text === 'bd bootstrap --yes') {
            fsx.get('.beads').db = { records: remote, unrelated: false, original: false };
            return ok(`Synced database from ${REMOTE}`);
        }
        if (text === 'bd status --json') {
            const beads = fsx.get('.beads');
            return ok(JSON.stringify({ summary: { total_issues: beads.db.records.filter((r) => r._type !== 'memory').length } }));
        }
        if (/^bd dolt pull/.test(text)) {
            const beads = fsx.get('.beads');
            if (beads && beads.db && beads.db.unrelated) return bad(FIXTURE);
            return ok('Pull complete.');
        }
        return ok();
    };
    return { command, calls, fsx, texts: () => calls.map((c) => c.text) };
}

