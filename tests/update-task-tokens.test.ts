import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';

vi.mock('../src/tools/execute-command.js', () => ({
  executeCommand: vi.fn(),
}));

// Capture the JSON content from the temp file before the tool deletes it
let capturedUploads: any[] = [];
vi.mock('../src/tools/send-files.js', () => ({
  sendFiles: vi.fn(async (input: any) => {
    const filePath: string = input.local_paths[0];
    if (fs.existsSync(filePath)) {
      capturedUploads.push(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    }
    return '✅ Successfully uploaded 1 file(s) to test-agent:\n  - progress.json\n\nRemote destination: /home/user/project';
  }),
}));

import { updateTaskTokens } from '../src/tools/update-task-tokens.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { sendFiles } from '../src/tools/send-files.js';

const mockExecuteCommand = vi.mocked(executeCommand);
const mockSendFiles = vi.mocked(sendFiles);

function makeProgress(tasks: any[]) {
  return JSON.stringify({ project: 'test', tasks });
}

describe('updateTaskTokens', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    capturedUploads = [];
    mockExecuteCommand.mockResolvedValue('Exit code: 0\n[main abc1234] chore: update token counts for task 1');
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('accumulates doer tokens for a task', async () => {
    const agent = makeTestAgent();
    addAgent(agent);

    const progress = makeProgress([
      { id: '1', step: 'Task 1', type: 'work', status: 'pending', tokens: { doer: { input: 0, output: 0 }, reviewer: { input: 0, output: 0 } } },
    ]);
    mockExecuteCommand
      .mockResolvedValueOnce(`Exit code: 0\n${progress}`)
      .mockResolvedValueOnce('Exit code: 0\n[main abc1234] chore: update token counts for task 1');

    const result = await updateTaskTokens({
      member_id: agent.id,
      progress_json: '/home/user/project/progress.json',
      task_id: '1',
      role: 'doer',
      input_tokens: 1000,
      output_tokens: 500,
    });

    expect(result).toContain('task 1');
    expect(result).toContain('doer.input  += 1000');
    expect(result).toContain('doer.output += 500');
    expect(result).toContain('Committed to git on member');
    expect(mockSendFiles).toHaveBeenCalledOnce();
  });

  it('accumulates reviewer tokens separately from doer', async () => {
    const agent = makeTestAgent();
    addAgent(agent);

    const progress = makeProgress([
      { id: '1', step: 'Task 1', type: 'work', status: 'completed', tokens: { doer: { input: 1000, output: 500 }, reviewer: { input: 0, output: 0 } } },
    ]);
    mockExecuteCommand
      .mockResolvedValueOnce(`Exit code: 0\n${progress}`)
      .mockResolvedValueOnce('Exit code: 0\ncommit done');

    const result = await updateTaskTokens({
      member_id: agent.id,
      progress_json: '/home/user/project/progress.json',
      task_id: '1',
      role: 'reviewer',
      input_tokens: 200,
      output_tokens: 100,
    });

    expect(result).toContain('reviewer.input  += 200');
    expect(result).toContain('reviewer.output += 100');

    const uploaded = capturedUploads[0];
    expect(uploaded.tasks[0].tokens.doer.input).toBe(1000);   // unchanged
    expect(uploaded.tasks[0].tokens.reviewer.input).toBe(200);
    expect(uploaded.tasks[0].tokens.reviewer.output).toBe(100);
  });

  it('accumulates reviewer tokens across multiple review cycles (never overwrites)', async () => {
    const agent = makeTestAgent();
    addAgent(agent);

    // First review cycle: add 200/100
    const progress1 = makeProgress([
      { id: '1', step: 'Task 1', tokens: { doer: { input: 1000, output: 500 }, reviewer: { input: 0, output: 0 } } },
    ]);
    mockExecuteCommand
      .mockResolvedValueOnce(`Exit code: 0\n${progress1}`)
      .mockResolvedValueOnce('Exit code: 0\ncommit done');

    await updateTaskTokens({
      member_id: agent.id,
      progress_json: '/home/user/project/progress.json',
      task_id: '1',
      role: 'reviewer',
      input_tokens: 200,
      output_tokens: 100,
    });

    const afterFirst = capturedUploads[0];
    expect(afterFirst.tasks[0].tokens.reviewer.input).toBe(200);
    expect(afterFirst.tasks[0].tokens.reviewer.output).toBe(100);

    // Second review cycle: add 300/150 on top (simulate member returning updated state)
    const progress2 = JSON.stringify(afterFirst);
    mockExecuteCommand
      .mockResolvedValueOnce(`Exit code: 0\n${progress2}`)
      .mockResolvedValueOnce('Exit code: 0\ncommit done');

    await updateTaskTokens({
      member_id: agent.id,
      progress_json: '/home/user/project/progress.json',
      task_id: '1',
      role: 'reviewer',
      input_tokens: 300,
      output_tokens: 150,
    });

    const afterSecond = capturedUploads[1];
    expect(afterSecond.tasks[0].tokens.reviewer.input).toBe(500);   // 200 + 300
    expect(afterSecond.tasks[0].tokens.reviewer.output).toBe(250);  // 100 + 150
  });

  it('initializes missing tokens field before accumulating', async () => {
    const agent = makeTestAgent();
    addAgent(agent);

    const progress = makeProgress([
      { id: '2', step: 'Task 2', type: 'work', status: 'pending' },
    ]);
    mockExecuteCommand
      .mockResolvedValueOnce(`Exit code: 0\n${progress}`)
      .mockResolvedValueOnce('Exit code: 0\ncommit done');

    const result = await updateTaskTokens({
      member_id: agent.id,
      progress_json: '/home/user/project/progress.json',
      task_id: '2',
      role: 'doer',
      input_tokens: 500,
      output_tokens: 250,
    });

    expect(result).toContain('doer.input  += 500');
    const uploaded = capturedUploads[0];
    expect(uploaded.tasks[0].tokens.doer.input).toBe(500);
    expect(uploaded.tasks[0].tokens.reviewer.input).toBe(0);
  });

  it('returns error when cat fails', async () => {
    const agent = makeTestAgent();
    addAgent(agent);

    mockExecuteCommand.mockResolvedValueOnce('Exit code: 1\nNo such file or directory');

    const result = await updateTaskTokens({
      member_id: agent.id,
      progress_json: '/home/user/project/progress.json',
      task_id: '1',
      role: 'doer',
      input_tokens: 100,
      output_tokens: 50,
    });

    expect(result).toContain('Failed to read progress.json');
    expect(mockSendFiles).not.toHaveBeenCalled();
  });

  it('returns error for unknown task_id', async () => {
    const agent = makeTestAgent();
    addAgent(agent);

    const progress = makeProgress([{ id: '1', step: 'Task 1' }]);
    mockExecuteCommand.mockResolvedValueOnce(`Exit code: 0\n${progress}`);

    const result = await updateTaskTokens({
      member_id: agent.id,
      progress_json: '/home/user/project/progress.json',
      task_id: '999',
      role: 'doer',
      input_tokens: 100,
      output_tokens: 50,
    });

    expect(result).toContain('Task "999" not found');
    expect(mockSendFiles).not.toHaveBeenCalled();
  });
});
