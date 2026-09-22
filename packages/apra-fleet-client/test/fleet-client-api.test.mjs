import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ApraFleet } from '../src/client/api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('ApraFleet', () => {
    test('executePrompt', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'success' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { prompt: 'Hello world', model: 'premium', timeout_s: 60 };
        const result = await fleet.executePrompt(options);

        assert.strictEqual(calledName, 'execute_prompt');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'success' });
    });

    // apra-fleet-eft.81.3: the server's execute_prompt schema (src/tools/
    // execute-prompt.ts) carries expected_context_tokens (number) and
    // context_size ('S'|'M'|'L') for the context-headroom admission check
    // (apra-fleet-eft.81.1) -- this client's wrapper is a generic passthrough
    // (options minus timeoutMs/signal), so both forward automatically when
    // supplied, and neither key is added when the caller omits them.
    test('executePrompt forwards expected_context_tokens and context_size when supplied', async () => {
        let calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledArgs = args;
                return { status: 'success' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = {
            prompt: 'Hello world',
            model: 'premium',
            expected_context_tokens: 12000,
            context_size: 'L'
        };
        await fleet.executePrompt(options);

        assert.strictEqual(calledArgs.expected_context_tokens, 12000);
        assert.strictEqual(calledArgs.context_size, 'L');
        assert.deepStrictEqual(calledArgs, options);
    });

    test('executePrompt omits expected_context_tokens/context_size entirely when not supplied', async () => {
        let calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledArgs = args;
                return { status: 'success' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { prompt: 'Hello world', model: 'premium', timeout_s: 60 };
        await fleet.executePrompt(options);

        assert.ok(!('expected_context_tokens' in calledArgs), 'expected_context_tokens must not be present when omitted');
        assert.ok(!('context_size' in calledArgs), 'context_size must not be present when omitted');
        // Byte-identical to today: no new keys sent when unset.
        assert.deepStrictEqual(calledArgs, options);
    });

    test('executeCommand', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'success' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { command: 'echo hello', long_running: true };
        const result = await fleet.executeCommand(options);

        assert.strictEqual(calledName, 'execute_command');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'success' });
    });

    test('listMembers', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { members: [] };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { format: 'json', tags: ['gpu'] };
        const result = await fleet.listMembers(options);

        assert.strictEqual(calledName, 'list_members');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { members: [] });
    });

    test('listMembers default options', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { members: [] };
            }
        };

        const fleet = new ApraFleet(mockClient);
        await fleet.listMembers();

        assert.strictEqual(calledName, 'list_members');
        assert.deepStrictEqual(calledArgs, {});
    });

    test('fleetStatus', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { format: 'json' };
        const result = await fleet.fleetStatus(options);

        assert.strictEqual(calledName, 'fleet_status');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('memberDetail', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { name: 'alice', folder: '/home/user/work', session: { id: 'sess-1' } };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { member_name: 'alice', format: 'json' };
        const result = await fleet.memberDetail(options);

        assert.strictEqual(calledName, 'member_detail');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { name: 'alice', folder: '/home/user/work', session: { id: 'sess-1' } });
    });

    test('sendFiles', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { local_paths: ['file1.txt', 'file2.txt'], dest_subdir: 'data' };
        const result = await fleet.sendFiles(options);

        assert.strictEqual(calledName, 'send_files');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('receiveFiles', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { remote_paths: ['file1.txt', 'file2.txt'], local_dest_dir: './data' };
        const result = await fleet.receiveFiles(options);

        assert.strictEqual(calledName, 'receive_files');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('provisionLlmAuth', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { member_name: 'alice' };
        const result = await fleet.provisionLlmAuth(options);

        assert.strictEqual(calledName, 'provision_llm_auth');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('provisionVcsAuth', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { member_name: 'alice', provider: 'github', git_access: 'push', repos: ['owner/repo'] };
        const result = await fleet.provisionVcsAuth(options);

        assert.strictEqual(calledName, 'provision_vcs_auth');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('composePermissions', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { member_name: 'alice', tags: ['doer'], project_folder: '/work/alice' };
        const result = await fleet.composePermissions(options);

        assert.strictEqual(calledName, 'compose_permissions');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('setupSshKey', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { member_name: 'alice' };
        const result = await fleet.setupSshKey(options);

        assert.strictEqual(calledName, 'setup_ssh_key');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('doltPushMutex', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { action: 'acquire', sprint_id: 'feat/x', pid: 4321, wait_ms: 1000 };
        const result = await fleet.doltPushMutex(options);

        assert.strictEqual(calledName, 'dolt_push_mutex');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('childIdAllocator', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { action: 'allocate', parent_id: 'apra-fleet-f34', sprint_id: 'feat/x', pid: 4321, floor: 3 };
        const result = await fleet.childIdAllocator(options);

        assert.strictEqual(calledName, 'child_id_allocator');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('shutdownServer', async () => {
        let calledName, calledArgs, calledOpts;
        const mockClient = {
            async callTool(name, args, opts) {
                calledName = name;
                calledArgs = args;
                calledOpts = opts;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const result = await fleet.shutdownServer();

        assert.strictEqual(calledName, 'shutdown_server');
        // shutdown_server takes no arguments -- unlike every other wrapped
        // tool, callers never pass options here.
        assert.deepStrictEqual(calledArgs, {});
        // Defaults to a short timeout: the server closing its own transport
        // as part of shutting down can race this request's response, so
        // callers must not be left hanging up to the SDK's normal 15-minute
        // default waiting for a response that may never arrive.
        assert.deepStrictEqual(calledOpts, { timeoutMs: 5000 });
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('shutdownServer honors an explicit timeoutMs override', async () => {
        let calledOpts;
        const mockClient = {
            async callTool(name, args, opts) {
                calledOpts = opts;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        await fleet.shutdownServer({ timeoutMs: 2000 });

        assert.deepStrictEqual(calledOpts, { timeoutMs: 2000 });
    });

    // apra-fleet-972p.1.1: seven wrappers added to catch up with server tools
    // that previously had no client-side counterpart (src/services/tool-registry.ts).

    test('revokeVcsAuth', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { member_name: 'alice', provider: 'github', label: 'work-github' };
        const result = await fleet.revokeVcsAuth(options);

        assert.strictEqual(calledName, 'revoke_vcs_auth');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('setupGitApp', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { app_id: '12345', private_key_path: '/tmp/app.pem', installation_id: 987 };
        const result = await fleet.setupGitApp(options);

        assert.strictEqual(calledName, 'setup_git_app');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('updateLlmCli', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { member_name: 'alice', install_if_missing: true };
        const result = await fleet.updateLlmCli(options);

        assert.strictEqual(calledName, 'update_llm_cli');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('updateLlmCli default options (omit member to update all)', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        await fleet.updateLlmCli();

        assert.strictEqual(calledName, 'update_llm_cli');
        assert.deepStrictEqual(calledArgs, {});
    });

    test('monitorTask', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { member_name: 'alice', task_id: 'task-ab12', auto_stop: true };
        const result = await fleet.monitorTask(options);

        assert.strictEqual(calledName, 'monitor_task');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('stopPrompt', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { member_name: 'alice' };
        const result = await fleet.stopPrompt(options);

        assert.strictEqual(calledName, 'stop_prompt');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('version', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { content: [{ type: 'text', text: 'apra-fleet 1.0.0' }] };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const result = await fleet.version();

        assert.strictEqual(calledName, 'version');
        assert.deepStrictEqual(calledArgs, {});
        assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'apra-fleet 1.0.0' }] });
    });

    test('kbSetup', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        const options = { repo_path: '/work/repo', provider: 'sqlite' };
        const result = await fleet.kbSetup(options);

        assert.strictEqual(calledName, 'kb_setup');
        assert.deepStrictEqual(calledArgs, options);
        assert.deepStrictEqual(result, { status: 'ok' });
    });

    test('kbSetup default options', async () => {
        let calledName, calledArgs;
        const mockClient = {
            async callTool(name, args) {
                calledName = name;
                calledArgs = args;
                return { status: 'ok' };
            }
        };

        const fleet = new ApraFleet(mockClient);
        await fleet.kbSetup();

        assert.strictEqual(calledName, 'kb_setup');
        assert.deepStrictEqual(calledArgs, {});
    });
});

// apra-fleet-972p.1.1: api-reference.md must document every ApraFleet method,
// exactly once each -- this is the sanity check that catches a wrapper added
// to api.mjs (like the seven above) without its matching docs section.
describe('apra-fleet-client api-reference method-doc parity', () => {
    test('docs/api-reference.md documents every ApraFleet method exactly once', () => {
        const apiSrc = readFileSync(path.join(__dirname, '..', 'src', 'client', 'api.mjs'), 'utf8');
        const docsSrc = readFileSync(path.join(__dirname, '..', 'docs', 'api-reference.md'), 'utf8');

        const classStart = apiSrc.indexOf('export class ApraFleet');
        assert.notStrictEqual(classStart, -1, 'ApraFleet class not found in api.mjs');
        const classBody = apiSrc.slice(classStart);

        // Method definitions are indented exactly 4 spaces inside the class body
        // (nested code -- e.g. an inline exec helper -- sits at 8+ spaces and is
        // deliberately excluded).
        const methodRe = /^ {4}(?:async\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
        const methods = new Set();
        let m;
        while ((m = methodRe.exec(classBody))) {
            if (m[1] !== 'constructor') methods.add(m[1]);
        }

        // Sanity: a marker/regex drift here would otherwise let this test pass
        // vacuously against an (almost) empty set.
        assert.ok(methods.size > 25, `expected many ApraFleet methods, parsed ${methods.size}`);

        // apra-fleet-972p.1.3: pin the exact exported-method count (32 as of
        // the C1-wrapper catch-up). A future wrapper addition/removal must
        // update this assertion deliberately, rather than silently passing
        // the >25 sanity floor above while docs drift out of sync.
        assert.strictEqual(methods.size, 32, `expected exactly 32 ApraFleet methods, parsed ${methods.size}: ${[...methods].sort().join(', ')}`);

        // Documented method names are those referenced as `name(...)` inside a
        // backtick code span anywhere in the doc (covers both a method's own
        // heading and combined headings like the credentialStore* group).
        const docMethodRe = /`([a-zA-Z_][a-zA-Z0-9_]*)\(/g;
        const documented = new Set();
        let d;
        while ((d = docMethodRe.exec(docsSrc))) {
            documented.add(d[1]);
        }

        const missing = [...methods].filter((name) => !documented.has(name)).sort();
        assert.deepStrictEqual(
            missing,
            [],
            `ApraFleet methods missing from docs/api-reference.md: ${missing.join(', ')}`,
        );

        // apra-fleet-972p.9: catch the OTHER direction -- a method documented
        // in docs/api-reference.md that has since been removed from
        // ApraFleet in api.mjs (stale docs), which the two checks above
        // cannot detect: `missing` only walks real methods looking for their
        // docs, and the old `documentedMethodCount === methods.size`
        // assertion it replaces was tautological (it only ever counted
        // documented names that are ALSO real methods -- a subset the
        // `missing` check above already forces to equal methods.size no
        // matter what else is documented).
        //
        // Scope the reverse check to the ApraFleet class's own doc section --
        // everything from its "### `class ApraFleet`" heading up to the next
        // top-level "## " heading -- and only that section's "#### " method
        // headings (a combined heading like the credentialStore* group still
        // yields all of its names). This needs no allowlist for unrelated
        // backtick-wrapped names elsewhere in the doc (parseToolJson(),
        // deriveTimeoutMs(), McpClient/transport internals,
        // server-resolution.mjs's own `#### ` functions, etc.): they simply
        // live outside this slice, or outside a heading line within it.
        const classHeadingIdx = docsSrc.indexOf('### `class ApraFleet`');
        assert.notStrictEqual(classHeadingIdx, -1, '"### `class ApraFleet`" section heading not found in docs/api-reference.md');
        const nextTopLevelOffset = docsSrc.slice(classHeadingIdx).search(/\n## /);
        const apraFleetSection = nextTopLevelOffset === -1
            ? docsSrc.slice(classHeadingIdx)
            : docsSrc.slice(classHeadingIdx, classHeadingIdx + nextTopLevelOffset);

        const methodHeadingRe = /^#### .*$/gm;
        const documentedAsApraFleetMethods = new Set();
        let h;
        while ((h = methodHeadingRe.exec(apraFleetSection))) {
            const headingNameRe = /`([a-zA-Z_][a-zA-Z0-9_]*)\(/g;
            let hm;
            while ((hm = headingNameRe.exec(h[0]))) {
                documentedAsApraFleetMethods.add(hm[1]);
            }
        }

        // Sanity: a scoping/regex drift here would otherwise let the stale
        // check below pass vacuously against an (almost) empty set.
        assert.ok(
            documentedAsApraFleetMethods.size > 25,
            `expected many ApraFleet method headings, parsed ${documentedAsApraFleetMethods.size}`,
        );

        const stale = [...documentedAsApraFleetMethods].filter((name) => !methods.has(name)).sort();
        assert.deepStrictEqual(
            stale,
            [],
            `docs/api-reference.md documents ApraFleet method(s) with no corresponding export in api.mjs (stale docs): ${stale.join(', ')}`,
        );
    });
});
