import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_TASKS_DIR = path.join(os.tmpdir(), `fleet-tasks-test-${Date.now()}`);

import { cleanupStaleTasks, scheduleTaskCleanup } from '../src/services/task-cleanup.js';

function mkTaskDir(taskId: string, status?: string, updatedAt?: string): string {
  const taskDir = path.join(TEST_TASKS_DIR, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  if (status) {
    const updated = updatedAt ?? new Date().toISOString();
    const data = { taskId, status, started: updated, updated };
    fs.writeFileSync(path.join(taskDir, 'status.json'), JSON.stringify(data));
  }
  return taskDir;
}

function setAgeHours(taskDir: string, ageHours: number): void {
  const mtime = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  fs.utimesSync(taskDir, mtime, mtime);
  const statusFile = path.join(taskDir, 'status.json');
  if (fs.existsSync(statusFile)) {
    const data = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
    data.updated = mtime.toISOString();
    fs.writeFileSync(statusFile, JSON.stringify(data));
    fs.utimesSync(statusFile, mtime, mtime);
  }
}

beforeEach(() => {
  fs.mkdirSync(TEST_TASKS_DIR, { recursive: true });
  delete process.env.FLEET_TASK_RETENTION_HOURS_SUCCESS;
  delete process.env.FLEET_TASK_RETENTION_HOURS;
});

afterEach(() => {
  fs.rmSync(TEST_TASKS_DIR, { recursive: true, force: true });
});

describe('cleanupStaleTasks', () => {
  it('removes completed task after 1h retention', async () => {
    const taskDir = mkTaskDir('task-done1', 'completed');
    setAgeHours(taskDir, 2); // 2 hours old > 1h retention

    await cleanupStaleTasks(TEST_TASKS_DIR);

    expect(fs.existsSync(taskDir)).toBe(false);
  });

  it('keeps completed task within 1h retention', async () => {
    const taskDir = mkTaskDir('task-done2', 'completed');
    setAgeHours(taskDir, 0.5); // 30 minutes — within 1h retention

    await cleanupStaleTasks(TEST_TASKS_DIR);

    expect(fs.existsSync(taskDir)).toBe(true);
  });

  it('retains failed task within 7-day (168h) retention', async () => {
    const taskDir = mkTaskDir('task-fail1', 'failed');
    setAgeHours(taskDir, 100); // 100h — within 168h window

    await cleanupStaleTasks(TEST_TASKS_DIR);

    expect(fs.existsSync(taskDir)).toBe(true);
  });

  it('removes failed task after 7 days', async () => {
    const taskDir = mkTaskDir('task-fail2', 'failed');
    setAgeHours(taskDir, 200); // 200h > 168h retention

    await cleanupStaleTasks(TEST_TASKS_DIR);

    expect(fs.existsSync(taskDir)).toBe(false);
  });

  it('skips task with alive PID', async () => {
    const taskDir = mkTaskDir('task-running', 'running');
    setAgeHours(taskDir, 200);
    fs.writeFileSync(path.join(taskDir, 'task.pid'), String(process.pid));

    await cleanupStaleTasks(TEST_TASKS_DIR);

    expect(fs.existsSync(taskDir)).toBe(true);
  });

  it('treats no status.json as failed and uses dir mtime', async () => {
    const taskDir = mkTaskDir('task-nostatus'); // no status file
    setAgeHours(taskDir, 200); // 200h > 168h failed retention

    await cleanupStaleTasks(TEST_TASKS_DIR);

    expect(fs.existsSync(taskDir)).toBe(false);
  });

  it('respects FLEET_TASK_RETENTION_HOURS env var', async () => {
    process.env.FLEET_TASK_RETENTION_HOURS = '10';
    const taskDir = mkTaskDir('task-custom', 'failed');
    setAgeHours(taskDir, 15); // 15h > 10h custom retention

    await cleanupStaleTasks(TEST_TASKS_DIR);

    expect(fs.existsSync(taskDir)).toBe(false);
  });

  it('does nothing when tasks dir does not exist', async () => {
    fs.rmSync(TEST_TASKS_DIR, { recursive: true, force: true });
    await expect(cleanupStaleTasks(TEST_TASKS_DIR)).resolves.toBeUndefined();
  });
});

describe('scheduleTaskCleanup', () => {
  it('schedules completed task removal after retention period', () => {
    vi.useFakeTimers();
    const taskDir = mkTaskDir('task-sched-done');

    scheduleTaskCleanup('task-sched-done', 'completed', TEST_TASKS_DIR);
    expect(fs.existsSync(taskDir)).toBe(true);

    vi.advanceTimersByTime(1 * 60 * 60 * 1000 + 1000);
    expect(fs.existsSync(taskDir)).toBe(false);

    vi.useRealTimers();
  });

  it('schedules failed task removal after 7-day retention', () => {
    vi.useFakeTimers();
    const taskDir = mkTaskDir('task-sched-fail');

    scheduleTaskCleanup('task-sched-fail', 'failed', TEST_TASKS_DIR);

    vi.advanceTimersByTime(100 * 60 * 60 * 1000);
    expect(fs.existsSync(taskDir)).toBe(true);

    vi.advanceTimersByTime(70 * 60 * 60 * 1000);
    expect(fs.existsSync(taskDir)).toBe(false);

    vi.useRealTimers();
  });
});
