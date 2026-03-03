import { LinuxCommands } from './linux.js';
import { escapeDoubleQuoted } from './os-commands.js';

export class MacOSCommands extends LinuxCommands {
  protected override loginShell(): string { return 'zsh'; }

  override cpuLoad(): string {
    return 'sysctl -n vm.loadavg';
  }

  override memory(): string {
    return 'vm_stat && echo "---" && sysctl -n hw.memsize';
  }

  override setEnv(name: string, value: string): string[] {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error('Invalid env var name: ' + name);
    const escaped = escapeDoubleQuoted(value);
    return [
      `echo 'export ${name}="${escaped}"' >> ~/.bashrc`,
      `echo 'export ${name}="${escaped}"' >> ~/.zshrc`,
      `echo 'export ${name}="${escaped}"' >> ~/.profile`,
      `export ${name}="${escaped}"`,
    ];
  }

  override unsetEnv(name: string): string[] {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error('Invalid env var name: ' + name);
    return [
      `sed -i '' '/export ${name}=/d' ~/.bashrc 2>/dev/null || true`,
      `sed -i '' '/export ${name}=/d' ~/.zshrc 2>/dev/null || true`,
      `sed -i '' '/export ${name}=/d' ~/.profile 2>/dev/null || true`,
      `unset ${name}`,
    ];
  }

  override parseMemory(stdout: string): string {
    return stdout.trim().substring(0, 200);
  }
}
