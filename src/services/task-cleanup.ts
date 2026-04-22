import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FLEET_TASKS_DIR = path.join(os.homedir(), '.fleet-tasks');

function retentionHoursSuccess(): number {
  return parseInt(process.env.FLEET_TASK_RETENTION_HOURS_SUCCESS ?? '1', 10);
}

function retentionHoursFailed(): number {
  return parseInt(process.env.FLEET_TASK_RETENTION_HOURS ?? '168', 10);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupStaleTasks(tasksDir = FLEET_TASKS_DIR): Promise<void> {
  if (!fs.existsSync(tasksDir)) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(tasksDir);
  } catch {
    return;
  }

  const now = Date.now();

  for (const entry of entries) {
    const taskDir = path.join(tasksDir, entry);
    try {
      const dirStat = fs.statSync(taskDir);
      if (!dirStat.isDirectory()) continue;

      // Skip tasks whose PID is still alive (running locally)
      const pidFile = path.join(taskDir, 'task.pid');
      if (fs.existsSync(pidFile)) {
        const pidStr = fs.readFileSync(pidFile, 'utf-8').trim();
        const pid = parseInt(pidStr, 10);
        if (!isNaN(pid) && isPidAlive(pid)) continue;
      }

      // Determine retention window from status.json
      let retentionHours = retentionHoursFailed();
      let ageReferenceMs = dirStat.mtimeMs;

      const statusFile = path.join(taskDir, 'status.json');
      if (fs.existsSync(statusFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
          if (data.status === 'completed') retentionHours = retentionHoursSuccess();
          if (data.updated) {
            const updatedMs = new Date(data.updated).getTime();
            if (!isNaN(updatedMs)) ageReferenceMs = updatedMs;
          }
        } catch { /* treat as failed */ }
      }

      const ageHours = (now - ageReferenceMs) / (1000 * 60 * 60);
      if (ageHours >= retentionHours) {
        fs.rmSync(taskDir, { recursive: true, force: true });
      }
    } catch { /* best-effort — skip on error */ }
  }
}

export function scheduleTaskCleanup(taskId: string, status: 'completed' | 'failed', tasksDir = FLEET_TASKS_DIR): void {
  const retentionHours = status === 'completed' ? retentionHoursSuccess() : retentionHoursFailed();
  const delayMs = retentionHours * 60 * 60 * 1000;
  setTimeout(() => {
    const taskDir = path.join(tasksDir, taskId);
    try {
      fs.rmSync(taskDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }, delayMs).unref();
}
