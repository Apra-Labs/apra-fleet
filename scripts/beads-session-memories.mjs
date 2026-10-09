#!/usr/bin/env node
// =============================================================================
// beads-session-memories.mjs -- print the role-scoped beads memories for an
// interactive/orchestrator session, in full, as plain markdown.
//
// Used by .claude/settings.json SessionStart/PreCompact hooks next to
// `bd prime --no-memories`: hook stdout is added to session context, so this
// is how the main session gets its `+all+` and `+orchestrator+` rules once
// `bd prime` no longer injects every memory.
//
//   node scripts/beads-session-memories.mjs +all+ +orchestrator+
//
// Why not plain `bd memories +all+` in the hook: its text output truncates each
// value to a short preview, and its --json output would be parsed by the hook
// host as hook-control JSON instead of injected as text. This reads
// `bd memories --json` once and prints every matching key with its full value.
//
// Never blocks a session: always exits 0. A failure is printed to stdout (so it
// reaches the session) instead of being swallowed.
// =============================================================================

import { execBdSync } from './lib/exec-bd.mjs';
import { ROLE_TOKEN_RE, selectScopedMemories } from '../packages/apra-fleet-se/scripts/lib/beads-memory-keys.mjs';

function main() {
    const tokens = process.argv.slice(2);
    const bad = tokens.filter((t) => !ROLE_TOKEN_RE.test(t.toLowerCase()));
    if (!tokens.length || bad.length) {
        console.log(`[beads-session-memories] usage: node scripts/beads-session-memories.mjs +all+ +<role>+ ... (bad args: ${bad.join(' ') || 'none given'})`);
        return;
    }
    let parsed;
    try {
        const raw = execBdSync(['memories', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        parsed = JSON.parse(String(raw || '{}'));
    } catch (err) {
        // Prefer bd's own stderr reason (e.g. "no beads database found") over Node's "Command failed: ..." line.
        const reason = String((err && err.stderr) || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        const msg = reason || String(err && err.message ? err.message : err).split(/\r?\n/)[0];
        // Text-mode `bd memories` truncates values, so point at --json.
        console.log(`[beads-session-memories] could not load beads memories (${msg}). Run \`bd memories --json ${tokens.join('` and `bd memories --json ')}\` by hand and apply only entries whose key matches.`);
        return;
    }
    const rows = selectScopedMemories(parsed && typeof parsed === 'object' ? parsed : {}, tokens);
    console.log(`## Beads operational memories (${tokens.join(', ')}) - ${rows.length}`);
    console.log('');
    if (!rows.length) {
        console.log('None stored for these scopes.');
        return;
    }
    for (const [key, value] of rows) {
        console.log(`### ${key}`);
        console.log(value);
        console.log('');
    }
}

try { main(); } catch (err) {
    console.log(`[beads-session-memories] unexpected error: ${err && err.message ? err.message : err}`);
}
process.exitCode = 0;
