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
});
