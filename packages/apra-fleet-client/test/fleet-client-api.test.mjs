import { test, describe } from 'node:test';
import assert from 'node:assert';
import { ApraFleet } from '../src/client/api.mjs';

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
});
