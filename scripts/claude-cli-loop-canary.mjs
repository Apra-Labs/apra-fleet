#!/usr/bin/env node
// Latest-Claude-CLI shell-loop canary (apra-fleet-xx7x.3.1).
//
// Installs the LATEST unpinned Claude Code CLI into a throwaway npm prefix
// under a fresh temp dir, prints its version, runs ONE headless dispatch whose
// task needs a shell for-loop, and feeds the CLI's result through the
// fleet-sprint engine's own permission handling:
//   - ClaudeProvider.parseResponse (dist/providers/claude.js) -- the server's
//     detection of permission_denials, with the session's permission mode;
//   - dispatchRole (packages/apra-fleet-se/fleet-sprint/dispatch-role.mjs) --
//     impact judgment of a complete reply and the run-separately nudge;
//   - createPermissionDenialHeal (fleet-sprint/member-provisioning.mjs) --
//     the shell split and policy check that decide nudge vs stop.
// None of that logic is re-implemented here. The canary asserts the engine
// would CONTINUE (complete reply, or no refusal) or NUDGE (resume the same
// session asking for separate commands), never ABORT the sprint.
//
// Bounded: install 45s + version 10s + dispatch 60s timeouts (< 2 minutes).
//
// Usage: node scripts/claude-cli-loop-canary.mjs [--model <name>] [--keep]
//   --model <name>  pass --model to the dispatch (default: the CLI default)
//   --keep          keep the temp dir and print its path (debugging)
//
// Prerequisite: `npm run build` (the canary imports dist/providers/claude.js).
//
// Exit codes:
//   0  PASS     the engine would continue or nudge
//   1  FAIL     the engine would abort the sprint (MemberPermissionDeniedError),
//               would grant a loop/compound prefix, or the dispatch produced
//               no usable result event (crash, timeout, unparseable output)
//   2  NOT RUN  no usable LLM credential is already present for the current
//               user, or the CLI could not be installed (npm unreachable or
//               install failure). NEVER a pass: report it loudly.
//   3  ERROR    canary misuse or missing prerequisite (bad arguments, repo
//               not built)
//
// Isolation (checkable by inspection): the only directory written is the
// mkdtemp dir under os.tmpdir(). npm installs with --prefix and --cache inside
// it (no global install, no ~/.npm writes); the CLI runs with CLAUDE_CONFIG_DIR
// inside it and its cwd inside it, so no operator HOME config, transcript or
// keychain entry is written. An existing credential is only READ (env var,
// <config dir>/.credentials.json, or the macOS keychain) and handed to the
// child as CLAUDE_CODE_OAUTH_TOKEN in its environment -- an access token the
// CLI cannot refresh, so the operator's refresh token is never rotated. No
// credential is ever provisioned. Every command is an argv array spawned
// without a shell: no shell variable expansion anywhere.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';
import { dispatchRole, PERMISSION_NUDGE_CAP } from '../packages/apra-fleet-se/fleet-sprint/dispatch-role.mjs';
import { MemberPermissionDeniedError } from '../packages/apra-fleet-se/fleet-sprint/errors.mjs';
import { createPermissionDenialHeal } from '../packages/apra-fleet-se/fleet-sprint/member-provisioning.mjs';
import { isCompoundShellGrant } from '../packages/apra-fleet-se/fleet-sprint/shell-commands.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export const VERDICT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', NOT_RUN: 'NOT RUN' });
export const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, 'NOT RUN': 2, ERROR: 3 });

export const CLI_PACKAGE = '@anthropic-ai/claude-code';
const INSTALL_TIMEOUT_MS = 45_000;
const DISPATCH_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 10_000;
// Expired-soon OAuth access tokens are not used: the CLI would refresh them,
// and a refresh rotates the operator's stored refresh token.
const TOKEN_MIN_REMAINING_MS = 5 * 60_000;

/** The member's allowlist: simple commands only, like a composed policy.
 *  Every command inside the canary's loop (echo) is allowed on its own. */
export const CANARY_ALLOW = Object.freeze(['Read', 'Glob', 'Grep', 'Bash(echo:*)', 'Bash(ls:*)']);

export const CANARY_LOOP = 'for f in alpha beta gamma; do echo "canary-$f"; done';

export const CANARY_PROMPT = [
    'This is an automated compatibility check.',
    'Use the Bash tool exactly once to run this exact command as a single tool call, unchanged:',
    '',
    CANARY_LOOP,
    '',
    'Then reply with one line: CANARY-REPLY followed by the words it printed,',
    'or CANARY-REPLY refused if the command was refused.',
].join('\n');

const CANARY_MEMBER = 'canary-member';

// ---------------------------------------------------------------------------
// Engine decision (exported for the paired test)
// ---------------------------------------------------------------------------

/**
 * Runs a parsed Claude dispatch result through the fleet-sprint engine's own
 * permission handling and reports what the engine would do.
 *
 * The only glue here is transport: execute_prompt's completeness verdict
 * (src/tools/execute-prompt.ts: clean exit, no error result, non-empty text)
 * and the workflow's AgentDispatchError details for a permission_denied
 * reply (packages/apra-fleet-workflow refusedReplyDetails; the planner row has
 * no schema, so no parsedResponse). Every decision is the engine's.
 *
 * @param {{ parsed: object, exitCode: number, allow?: string[] }} input
 * @returns {Promise<{ decision: 'continue'|'nudge'|'abort', reason: string, grants: string[], loopGrants: string[], warnings: object[], logs: string[], refused: boolean }>}
 */
export async function engineDecision({ parsed, exitCode, allow = CANARY_ALLOW }) {
    const denial = parsed && parsed.permissionDenial;
    const base = { grants: [], loopGrants: [], warnings: [], logs: [], refused: !!denial };
    if (!denial) {
        return { ...base, decision: 'continue', reason: 'the dispatch refused no tool call' };
    }
    const reply = typeof parsed.result === 'string' ? parsed.result.trim() : '';
    const replyComplete = exitCode === 0 && !parsed.isError && reply !== '';
    if (replyComplete && denial.healable === false) {
        // execute_prompt returns this as a success carrying a warning.
        return { ...base, decision: 'continue', reason: 'complete reply; the non-healable refusal is only a warning' };
    }
    const refusal = new AgentDispatchError('[Workflow Error] Agent dispatch failed (permission_denied): permission denied', {
        details: {
            reason: 'permission_denied',
            member: CANARY_MEMBER,
            permissionDenied: denial,
            ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
            ...(reply !== '' ? { response: reply, replyComplete } : {}),
        },
    });

    const grants = [];
    const logs = [];
    const dispatches = [];
    const callTool = async (_name, args) => {
        if (args.dry_run) {
            return { content: [{ type: 'text', text: JSON.stringify({ dry_run: true, mode: args.role, stacks: [], allow: [...allow] }) }] };
        }
        if (Array.isArray(args.grant)) grants.push(...args.grant);
        return { content: [{ type: 'text', text: args.grant ? `[OK] Granted ${args.grant.length} permissions` : '[OK] Permissions composed' }] };
    };
    const ctx = {
        agent: async (prompt, options) => {
            dispatches.push({ prompt, options: { ...options } });
            if (dispatches.length === 1) throw refusal;
            // A nudged/re-run attempt: the canary does not re-run the CLI; the
            // engine's decision is already made by the time it asks.
            return reply || 'CANARY-REPLY (nudged)';
        },
        withGitSync: async (_member, _pushCode, fn) => fn(),
        withDispatchWatchdog: (promise) => promise,
        log: (message) => logs.push(String(message)),
        getMemberForRole: () => CANARY_MEMBER,
        memberSessionGuard: { killIfAlive: async () => {} },
        onLlmAuthFailure: async () => false,
        fixedRoleTier: { planner: 'premium' },
        budgets: { DISPATCH_TIMEOUT_S: 900, DISPATCH_INACTIVITY_TIMEOUT_S: 900 },
        schemas: {},
        isNoMutationDispatchFailure: () => false,
        invalidateAllBeadsCache: () => {},
        steps: {},
    };
    ctx.onPermissionDenied = createPermissionDenialHeal({ callTool, memberRoles: () => ['planner'], log: (m) => logs.push(String(m)) });

    const opts = {
        prompt: CANARY_PROMPT,
        resumePrompt: 'Continue the compatibility check exactly where you left off.',
        roleLabel: 'Canary',
        resumeArg: false,
        bindings: { maxTurns: 50 },
    };
    const loopGrants = () => grants.filter((g) => isCompoundShellGrant(g));
    let outcome;
    try {
        outcome = await dispatchRole(ctx, 'planner', opts);
    } catch (err) {
        const reason = err instanceof MemberPermissionDeniedError
            ? `the engine would abort the sprint: MemberPermissionDeniedError (step ${err.step}): ${err.message}`
            : `the engine would abort the sprint: ${err && err.name ? err.name : 'Error'}: ${err && err.message ? err.message : err}`;
        return { ...base, decision: 'abort', reason, grants, loopGrants: loopGrants(), logs };
    }
    const warnings = outcome.permissionWarnings || [];
    const nudged = dispatches.slice(1).some((d) => parsed.sessionId && d.options.resume === parsed.sessionId);
    if (nudged) {
        return { ...base, decision: 'nudge', reason: `the engine resumed session ${parsed.sessionId} with the run-separately nudge (cap ${PERMISSION_NUDGE_CAP})`, grants, loopGrants: loopGrants(), warnings, logs };
    }
    return {
        ...base,
        decision: 'continue',
        reason: dispatches.length === 1
            ? 'the engine accepted the complete reply with a recorded permission warning'
            : `the engine re-ran the dispatch after granting ${grants.join(', ') || 'nothing'}`,
        grants,
        loopGrants: loopGrants(),
        warnings,
        logs,
    };
}

/**
 * The canary verdict for one run. Pure apart from the engine call; no
 * network, no CLI.
 *
 * @param {{ notRun?: string, dispatch?: { stdout: string, stderr?: string, code: number|null, timedOut?: boolean } }} run
 * @param {{ provider: { parseResponse: Function, classifyError: Function }, allow?: string[] }} deps
 * @returns {Promise<{ verdict: 'PASS'|'FAIL'|'NOT RUN', reason: string, decision?: string, refused?: boolean, grants?: string[], logs?: string[] }>}
 */
export async function canaryVerdict(run, deps) {
    if (run && run.notRun) return { verdict: VERDICT.NOT_RUN, reason: run.notRun };
    const dispatch = run && run.dispatch;
    if (!dispatch) return { verdict: VERDICT.NOT_RUN, reason: 'no dispatch was run' };
    const { provider } = deps;
    const stdout = dispatch.stdout || '';
    const stderr = dispatch.stderr || '';
    const code = typeof dispatch.code === 'number' ? dispatch.code : 1;
    if (dispatch.timedOut) {
        return { verdict: VERDICT.FAIL, reason: `the dispatch did not finish within ${DISPATCH_TIMEOUT_MS / 1000}s` };
    }
    const parsed = provider.parseResponse({ stdout, stderr, code }, { unattended: false });
    if ((code !== 0 || parsed.isError) && provider.classifyError(`${stderr}\n${stdout}`) === 'auth') {
        return { verdict: VERDICT.NOT_RUN, reason: `the CLI rejected the credential: ${tail(parsed.result || stderr || stdout)}` };
    }
    if (parsed.result === undefined && !parsed.permissionDenial) {
        return { verdict: VERDICT.FAIL, reason: `the dispatch produced no result event (exit ${code}): ${tail(stderr || stdout)}` };
    }
    const engine = await engineDecision({ parsed, exitCode: code, allow: deps.allow });
    const extra = { decision: engine.decision, refused: engine.refused, grants: engine.grants, logs: engine.logs };
    if (engine.loopGrants.length) {
        return { verdict: VERDICT.FAIL, reason: `the engine granted a loop/compound prefix: ${engine.loopGrants.join(', ')}`, ...extra };
    }
    if (engine.decision === 'abort') return { verdict: VERDICT.FAIL, reason: engine.reason, ...extra };
    return { verdict: VERDICT.PASS, reason: `${engine.decision}: ${engine.reason}`, ...extra };
}

function tail(text, n = 400) {
    const t = String(text || '').trim().replace(/\s+/g, ' ');
    return t.length > n ? `...${t.slice(-n)}` : t || '(no output)';
}

// ---------------------------------------------------------------------------
// Live run (not exercised by the unit test)
// ---------------------------------------------------------------------------

/** argv to run npm without a shell: node + npm-cli.js when found, else `npm`. */
function npmInvocation() {
    const candidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter((p) => p && /npm-cli\.js$/.test(p) && fs.existsSync(p));
    if (candidates.length) return { cmd: process.execPath, pre: [candidates[0]] };
    if (process.platform === 'win32') return null;
    return { cmd: 'npm', pre: [] };
}

function installLatestCli(tmp) {
    const npm = npmInvocation();
    if (!npm) return { error: 'npm-cli.js not found next to this node, and npm.cmd cannot be spawned without a shell' };
    const prefix = path.join(tmp, 'npm-prefix');
    fs.mkdirSync(prefix, { recursive: true });
    const args = [
        ...npm.pre, 'install', `${CLI_PACKAGE}@latest`,
        '--prefix', prefix,
        '--cache', path.join(tmp, 'npm-cache'),
        '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error',
    ];
    const res = spawnSync(npm.cmd, args, { cwd: prefix, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    if (res.error || res.status !== 0) {
        const why = res.error ? res.error.message : `npm exited ${res.status}`;
        return { error: `npm install ${CLI_PACKAGE}@latest failed (${why}): ${tail(res.stderr || res.stdout)}` };
    }
    const pkgDir = path.join(prefix, 'node_modules', ...CLI_PACKAGE.split('/'));
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    } catch (err) {
        return { error: `installed package has no readable package.json: ${err.message}` };
    }
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.claude;
    if (!binRel) return { error: `${CLI_PACKAGE}@${pkg.version} declares no claude bin` };
    const bin = path.join(pkgDir, binRel);
    if (!fs.existsSync(bin)) return { error: `${CLI_PACKAGE}@${pkg.version} bin ${binRel} is missing after install` };
    const argv0 = /\.(c|m)?js$/.test(bin) ? { cmd: process.execPath, pre: [bin] } : { cmd: bin, pre: [] };
    return { cli: argv0, version: pkg.version };
}

/** An access token from a stored Claude login JSON, or a reason it is unusable. */
function tokenFromCredentialJson(text, where) {
    let data;
    try { data = JSON.parse(text); } catch { return { why: `${where} is not valid JSON` }; }
    const oauth = data && data.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return { why: `${where} holds no OAuth access token` };
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt - Date.now() < TOKEN_MIN_REMAINING_MS) {
        return { why: `the OAuth access token in ${where} is expired or about to expire (run claude once to refresh it, or set CLAUDE_CODE_OAUTH_TOKEN)` };
    }
    return { token: oauth.accessToken };
}

/** Finds a credential the current user already has. Read-only. */
function findCredential() {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }, source: 'CLAUDE_CODE_OAUTH_TOKEN' };
    if (process.env.ANTHROPIC_API_KEY) return { env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }, source: 'ANTHROPIC_API_KEY' };
    const reasons = [];
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const file = path.join(configDir, '.credentials.json');
    if (fs.existsSync(file)) {
        const got = tokenFromCredentialJson(fs.readFileSync(file, 'utf8'), file);
        if (got.token) return { env: { CLAUDE_CODE_OAUTH_TOKEN: got.token }, source: file };
        reasons.push(got.why);
    }
    if (process.platform === 'darwin') {
        const res = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 10_000 });
        if (res.status === 0 && res.stdout.trim()) {
            const got = tokenFromCredentialJson(res.stdout.trim(), 'the macOS keychain entry "Claude Code-credentials"');
            if (got.token) return { env: { CLAUDE_CODE_OAUTH_TOKEN: got.token }, source: 'macOS keychain' };
            reasons.push(got.why);
        }
    }
    return { why: reasons.length ? reasons.join('; ') : 'no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in the environment and no stored Claude login for the current user' };
}

function childEnv(tmp, credentialEnv) {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    // Nested-session markers from a parent Claude Code process must not leak in.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return {
        ...env,
        ...credentialEnv,
        CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
        DISABLE_AUTOUPDATER: '1',
    };
}

async function loadProvider() {
    const distFile = path.join(REPO_ROOT, 'dist', 'providers', 'claude.js');
    if (!fs.existsSync(distFile)) return null;
    const mod = await import(pathToFileURL(distFile).href);
    return new mod.ClaudeProvider();
}

function parseArgs(argv) {
    const out = { model: undefined, keep: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--keep') out.keep = true;
        else if (a === '--model' && argv[i + 1]) out.model = argv[++i];
        else return { error: `unknown argument: ${a}` };
    }
    return out;
}

function report(result, version) {
    if (!version) console.log('Claude CLI version: not installed');
    if (result.decision) console.log(`Engine decision: ${result.decision}${result.refused ? ' (the CLI refused the loop)' : ' (the CLI did not refuse the loop)'}`);
    for (const line of result.logs || []) console.log(`  engine: ${line}`);
    const banner = result.verdict === VERDICT.NOT_RUN ? 'CANARY NOT RUN -- this is NOT a pass' : `CANARY ${result.verdict}`;
    console.log(`${banner}: ${result.reason}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.error) {
        console.error(`claude-cli-loop-canary: ${args.error}`);
        return EXIT_CODES.ERROR;
    }
    const provider = await loadProvider();
    if (!provider) {
        console.error('claude-cli-loop-canary: dist/providers/claude.js is missing -- run npm run build first.');
        return EXIT_CODES.ERROR;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-claude-canary-'));
    let version;
    let result;
    try {
        const credential = findCredential();
        if (!credential.env) {
            result = await canaryVerdict({ notRun: `no usable LLM credential: ${credential.why}` }, { provider });
        } else {
            const installed = installLatestCli(tmp);
            if (installed.error) {
                result = await canaryVerdict({ notRun: installed.error }, { provider });
            } else {
                const env = childEnv(tmp, credential.env);
                const v = spawnSync(installed.cli.cmd, [...installed.cli.pre, '--version'], { env, encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
                version = (v.stdout || '').trim() || `${installed.version} (package; --version printed nothing)`;
                console.log(`Claude CLI version: ${version} (credential source: ${credential.source})`);
                const work = path.join(tmp, 'work');
                fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
                fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
                // The member's composed per-folder config, in the provider's own shape.
                const [settings] = provider.composePermissionConfig('doer', [...CANARY_ALLOW]);
                fs.writeFileSync(path.join(work, '.claude', 'settings.local.json'), JSON.stringify(settings, null, 2));
                const permFlag = provider.resolvePermissionFlag(false, args.model).split(' ');
                const dispatchArgs = [
                    ...installed.cli.pre,
                    '-p', CANARY_PROMPT,
                    '--output-format', 'stream-json', '--verbose',
                    '--max-turns', '6',
                    ...permFlag,
                    ...(args.model ? ['--model', args.model] : []),
                ];
                const res = spawnSync(installed.cli.cmd, dispatchArgs, {
                    cwd: work, env, encoding: 'utf8', timeout: DISPATCH_TIMEOUT_MS,
                    maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
                });
                const timedOut = !!(res.error && /ETIMEDOUT/.test(String(res.error.code || res.error.message)));
                result = await canaryVerdict({ dispatch: { stdout: res.stdout || '', stderr: res.stderr || (res.error ? res.error.message : ''), code: res.status, timedOut } }, { provider });
            }
        }
    } finally {
        if (args.keep) console.log(`Temp dir kept: ${tmp}`);
        else fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    }
    report(result, version);
    return EXIT_CODES[result.verdict];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().then((code) => process.exit(code), (err) => {
        console.error(`claude-cli-loop-canary: ${err && err.stack ? err.stack : err}`);
        process.exit(EXIT_CODES.ERROR);
    });
}
