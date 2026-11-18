import { LinuxCommands } from './linux.js';
import { escapeDoubleQuoted } from './os-commands.js';
import type { ProviderAdapter } from './os-commands.js';

export class MacOSCommands extends LinuxCommands {
  protected override loginShell(): string { return 'zsh'; }

  override installAgent(provider: ProviderAdapter): string {
    return provider.installCommand('macos');
  }

  override cpuLoad(): string {
    return 'sysctl -n vm.loadavg';
  }

  override memory(): string {
    return 'vm_stat && echo "---" && sysctl -n hw.memsize';
  }

  protected override envProfileFiles(): string[] {
    return ['~/.bashrc', '~/.zshrc', '~/.zshenv', '~/.profile'];
  }

  // BSD sed: -i takes a (here empty) backup-suffix argument. unsetEnv and
  // persistEnvFromFile (LinuxCommands) use it on every envProfileFiles() entry.
  protected override sedInPlace(): string {
    return "sed -i ''";
  }

  override parseMemory(stdout: string): string {
    return stdout.trim().substring(0, 200);
  }

  // --- Agent provisioning ---
  // stock macOS has no sha256sum -- shasum -a 256 is the built-in equivalent

  override hashFilesRecursive(dir: string): string {
    return `cd "${escapeDoubleQuoted(dir)}" 2>/dev/null && find . -type f -exec shasum -a 256 {} + 2>/dev/null || true`;
  }
}
