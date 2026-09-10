/**
 * apra-fleet-7dir.2.9: installCommand(os, shell) matrix coverage for all six
 * registered provider adapters, under both Windows shells the fleet
 * registers (gitbash, powershell5).
 *
 * No single existing test file covers all six adapters together --
 * tests/providers.test.ts covers claude/codex/copilot/agy per-OS (no
 * per-shell coverage), tests/opencode-provider.test.ts and
 * tests/none-provider.test.ts cover their own adapter only. This file is
 * new rather than extending any one of them, so the full six-adapter x
 * two-shell matrix lives in one place and a newly added adapter that skips
 * the shell parameter is caught by the loop below rather than requiring a
 * matching addition in four separate files.
 *
 * Also covers the "PID wrapper" half of this task's acceptance criteria:
 * OsCommands.wrapPidCapture for a gitbash vs a powershell5 Windows member
 * (mirrors, and does not replace, the getOsCommands-level coverage in
 * tests/os-commands-gitbash.test.ts from the lane-sibling task
 * apra-fleet-7dir.2.3).
 */
import { describe, it, expect } from 'vitest';
import { ClaudeProvider } from '../src/providers/claude.js';
import { CodexProvider } from '../src/providers/codex.js';
import { CopilotProvider } from '../src/providers/copilot.js';
import { AgyProvider } from '../src/providers/agy.js';
import { OpenCodeProvider } from '../src/providers/opencode.js';
import { NoneProvider } from '../src/providers/none.js';
import type { ProviderAdapter } from '../src/providers/provider.js';
import { getOsCommands } from '../src/os/index.js';

type AdapterCase = { name: string; make: () => ProviderAdapter; throwsOnInstall?: boolean };

const ADAPTERS: AdapterCase[] = [
  { name: 'claude', make: () => new ClaudeProvider() },
  { name: 'codex', make: () => new CodexProvider() },
  { name: 'copilot', make: () => new CopilotProvider() },
  { name: 'agy', make: () => new AgyProvider() },
  { name: 'opencode', make: () => new OpenCodeProvider() },
  { name: 'none', make: () => new NoneProvider(), throwsOnInstall: true },
];

const POWERSHELL_CMDLET_MARKERS = [
  'irm ', '| iex', 'Get-Content', 'Get-Item', 'New-Item', 'Set-Content',
  'Test-Path', '$env:', 'Write-Output', 'Write-Warning',
];

describe('installCommand(os, shell) matrix: all six adapters x {gitbash, powershell5}', () => {
  for (const { name, make, throwsOnInstall } of ADAPTERS) {
    describe(`${name}`, () => {
      if (throwsOnInstall) {
        it('refuses by design regardless of shell (no-LLM member)', () => {
          const p = make();
          expect(() => p.installCommand('windows', 'gitbash')).toThrow(/no LLM provider/);
          expect(() => p.installCommand('windows', 'powershell5')).toThrow(/no LLM provider/);
        });
        return;
      }

      it('gitbash install string contains no PowerShell cmdlet', () => {
        const p = make();
        const cmd = p.installCommand('windows', 'gitbash');
        for (const marker of POWERSHELL_CMDLET_MARKERS) {
          expect(cmd).not.toContain(marker);
        }
      });

      it('powershell5 install string is golden-identical to today\'s (no-shell-arg) output', () => {
        const p = make();
        const legacy = p.installCommand('windows');
        const powershell5 = p.installCommand('windows', 'powershell5');
        const noShellRecorded = p.installCommand('windows', undefined);
        expect(powershell5).toBe(legacy);
        expect(noShellRecorded).toBe(legacy);
      });

      it('linux/macos install strings are unaffected by the shell parameter (only windows branches on it)', () => {
        const p = make();
        expect(p.installCommand('linux', 'gitbash')).toBe(p.installCommand('linux'));
        expect(p.installCommand('macos', 'gitbash')).toBe(p.installCommand('macos'));
      });
    });
  }
});

describe('claude/agy: gitbash install routes through the base64 -EncodedCommand envelope (PowerShell-only irm|iex needs a real PS host)', () => {
  it('claude gitbash install is a wrapPowerShellEncoded call, not the raw irm|iex string', () => {
    const p = new ClaudeProvider();
    const gitbash = p.installCommand('windows', 'gitbash');
    expect(gitbash).toMatch(/^powershell -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(p.installCommand('windows')).toBe('irm https://claude.ai/install.ps1 | iex');
  });

  it('agy gitbash install is a wrapPowerShellEncoded call, not the raw powershell -Command string', () => {
    const p = new AgyProvider();
    const gitbash = p.installCommand('windows', 'gitbash');
    expect(gitbash).toMatch(/^powershell -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(p.installCommand('windows')).toBe('powershell -Command "irm https://antigravity.google/cli/install.ps1 | iex"');
  });
});

describe('codex/copilot/opencode: windows install string is identical across shells (no PowerShell-only syntax to route around)', () => {
  it('codex: npm install -g is shell-agnostic', () => {
    const p = new CodexProvider();
    expect(p.installCommand('windows', 'gitbash')).toBe(p.installCommand('windows', 'powershell5'));
    expect(p.installCommand('windows', 'gitbash')).toContain('@openai/codex');
  });

  it('copilot: winget install is shell-agnostic', () => {
    const p = new CopilotProvider();
    expect(p.installCommand('windows', 'gitbash')).toBe(p.installCommand('windows', 'powershell5'));
    expect(p.installCommand('windows', 'gitbash')).toBe('winget install GitHub.CopilotCLI');
  });

  it('opencode: npm install -g is shell-agnostic', () => {
    const p = new OpenCodeProvider();
    expect(p.installCommand('windows', 'gitbash')).toBe(p.installCommand('windows', 'powershell5'));
    expect(p.installCommand('windows', 'gitbash')).toBe('npm install -g opencode-ai');
  });
});

describe('PID wrapper (OsCommands.wrapPidCapture) under each registered Windows shell', () => {
  it('gitbash emits the POSIX FLEET_PID subshell wrapper, in the exact format callers parse (FLEET_PID:<pid>)', () => {
    const cmd = getOsCommands('windows', 'gitbash').wrapPidCapture('echo hi');
    expect(cmd).toContain("printf 'FLEET_PID:%s\\n' \"$_fleet_pid\"");
    expect(cmd).not.toContain('FLEET_PID:$pid');
  });

  it('powershell5 (and no shell recorded) keeps the exact today string, unchanged', () => {
    const legacy = getOsCommands('windows').wrapPidCapture('echo hi');
    const powershell5 = getOsCommands('windows', 'powershell5').wrapPidCapture('echo hi');
    expect(powershell5).toBe(legacy);
    expect(powershell5).toBe('Write-Output "FLEET_PID:$pid"; echo hi');
  });
});
