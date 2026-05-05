import { describe, it, expect } from 'vitest';
import { pidWrapWindows } from '../src/os/windows.js';
import { WindowsCommands } from '../src/os/windows.js';
import { ClaudeProvider } from '../src/providers/claude.js';
import type { PromptOptions } from '../src/providers/provider.js';

const provider = new ClaudeProvider();
const windows = new WindowsCommands();

const baseOpts: PromptOptions = {
  folder: 'C:\\Users\\test\\project',
  promptFile: '.fleet-task.md',
  maxTurns: 50,
};

// ─── 1. PID output format ─────────────────────────────────────────────────────

describe('pidWrapWindows: PID output format', () => {
  it('contains FLEET_PID: followed by $_fleet_proc.Id, not $PID', () => {
    const out = pidWrapWindows('', 'claude', '--version');
    expect(out).toContain('FLEET_PID:');
    expect(out).toContain('$_fleet_proc.Id');
  });

  it('emits FLEET_PID via $_fleet_proc.Id inside a double-quoted Write-Output', () => {
    const out = pidWrapWindows('', 'claude', '--version');
    expect(out).toMatch(/Write-Output "FLEET_PID:\$\(\$_fleet_proc\.Id\)"/);
  });
});

// ─── 2. Structure ─────────────────────────────────────────────────────────────

describe('pidWrapWindows: structure', () => {
  it('contains ProcessStartInfo', () => {
    expect(pidWrapWindows('', 'claude', '--version')).toContain('ProcessStartInfo');
  });

  it('contains UseShellExecute = $false', () => {
    expect(pidWrapWindows('', 'claude', '--version')).toContain('UseShellExecute = $false');
  });

  it('does not contain Start-Process', () => {
    expect(pidWrapWindows('', 'claude', '--version')).not.toContain('Start-Process');
  });

  it('launches via [System.Diagnostics.Process]::Start', () => {
    expect(pidWrapWindows('', 'claude', '--version')).toContain('[System.Diagnostics.Process]::Start');
  });

  it('contains WaitForExit', () => {
    expect(pidWrapWindows('', 'claude', '--version')).toContain('WaitForExit');
  });

  it('contains exit $_fleet_proc.ExitCode', () => {
    expect(pidWrapWindows('', 'claude', '--version')).toContain('exit $_fleet_proc.ExitCode');
  });

  it('uses $_fleet_proc as the process variable', () => {
    const out = pidWrapWindows('', 'claude', '--version');
    expect(out).toContain('[System.Diagnostics.Process]::Start($_fleet_psi)');
  });
});

// ─── 3. No regression on $PID ─────────────────────────────────────────────────

describe('pidWrapWindows: no $PID regression', () => {
  it('does not contain FLEET_PID:$PID anywhere in output', () => {
    const out = pidWrapWindows('', 'claude', '--version');
    expect(out).not.toContain('FLEET_PID:$PID');
  });

  it('does not contain FLEET_PID:$PID in buildAgentPromptCommand (unattended=false)', () => {
    const out = windows.buildAgentPromptCommand(provider, { ...baseOpts, unattended: false });
    expect(out).not.toContain('FLEET_PID:$PID');
  });

  it('does not contain FLEET_PID:$PID in buildAgentPromptCommand (unattended=auto)', () => {
    const out = windows.buildAgentPromptCommand(provider, { ...baseOpts, unattended: 'auto' });
    expect(out).not.toContain('FLEET_PID:$PID');
  });

  it('does not contain FLEET_PID:$PID in buildAgentPromptCommand (unattended=dangerous)', () => {
    const out = windows.buildAgentPromptCommand(provider, { ...baseOpts, unattended: 'dangerous' });
    expect(out).not.toContain('FLEET_PID:$PID');
  });
});

// ─── 4. All unattended modes ──────────────────────────────────────────────────

describe('buildAgentPromptCommand: unattended modes produce correct ArgumentList', () => {
  it('unattended=false: no permission flag in ArgumentList', () => {
    const out = windows.buildAgentPromptCommand(provider, { ...baseOpts, unattended: false });
    expect(out).not.toContain('--permission-mode');
    expect(out).not.toContain('--dangerously-skip-permissions');
  });

  it('unattended=auto: --permission-mode auto appears in ArgumentList', () => {
    const out = windows.buildAgentPromptCommand(provider, { ...baseOpts, unattended: 'auto' });
    expect(out).toContain('--permission-mode auto');
    expect(out).not.toContain('--dangerously-skip-permissions');
  });

  it('unattended=dangerous: --dangerously-skip-permissions appears in ArgumentList', () => {
    const out = windows.buildAgentPromptCommand(provider, { ...baseOpts, unattended: 'dangerous' });
    expect(out).toContain('--dangerously-skip-permissions');
    expect(out).not.toContain('--permission-mode');
  });

  it('unattended=undefined: no permission flag in ArgumentList', () => {
    const out = windows.buildAgentPromptCommand(provider, { ...baseOpts });
    expect(out).not.toContain('--permission-mode');
    expect(out).not.toContain('--dangerously-skip-permissions');
  });
});

// ─── 5. Working directory ─────────────────────────────────────────────────────

describe('buildAgentPromptCommand: working directory', () => {
  it('includes Set-Location with the escaped folder path', () => {
    const out = windows.buildAgentPromptCommand(provider, { ...baseOpts });
    expect(out).toContain('Set-Location');
    expect(out).toContain('C:\\Users\\test\\project');
  });

  it('Set-Location appears before FLEET_PID emission', () => {
    const out = windows.buildAgentPromptCommand(provider, { ...baseOpts });
    const setLocIdx = out.indexOf('Set-Location');
    const pidIdx = out.indexOf('FLEET_PID');
    expect(setLocIdx).toBeGreaterThanOrEqual(0);
    expect(pidIdx).toBeGreaterThanOrEqual(0);
    expect(setLocIdx).toBeLessThan(pidIdx);
  });
});

// ─── 6. Env var setup before Start-Process ───────────────────────────────────

describe('buildAgentPromptCommand: env var setup', () => {
  it('PATH assignment appears before FLEET_PID emission', () => {
    const out = windows.buildAgentPromptCommand(provider, { ...baseOpts });
    const pathIdx = out.indexOf('$env:Path');
    const pidIdx = out.indexOf('FLEET_PID');
    expect(pathIdx).toBeGreaterThanOrEqual(0);
    expect(pidIdx).toBeGreaterThanOrEqual(0);
    expect(pathIdx).toBeLessThan(pidIdx);
  });

  it('uses direct shell execution to launch the claude executable', () => {
    const out = windows.buildAgentPromptCommand(provider, { ...baseOpts });
    expect(out).toContain('FLEET_PID:$pid');
    expect(out).toContain('claude');
  });
});
