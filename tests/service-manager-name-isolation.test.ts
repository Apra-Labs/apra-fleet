// Guarantees the ported PR #485 suites do not assert: the two registered
// services (mcp-server, fleet-supervisor) can never collide with, or
// silently act on, each other's OS registration -- on ALL THREE platforms,
// from any one test host.
//
// This is a pure unit test over SERVICE_DESCRIPTORS and the platform manager
// constructors. It never invokes systemctl, launchctl or schtasks -- no
// child process is spawned by it -- so it passes identically on Linux, macOS
// and Windows CI regardless of process.platform.
import { describe, it, expect } from 'vitest';
import {
  SERVICE_DESCRIPTORS,
  getServiceDescriptor,
  WINDOWS_TASK_NAME,
  LINUX_UNIT_NAME,
  MACOS_PLIST_LABEL,
  type ServiceId,
} from '../src/services/service-manager/types.js';
import { LinuxServiceManager } from '../src/services/service-manager/linux.js';
import { MacOSServiceManager } from '../src/services/service-manager/macos.js';
import { WindowsServiceManager } from '../src/services/service-manager/windows.js';

const SERVICE_IDS = Object.keys(SERVICE_DESCRIPTORS) as ServiceId[];

const NAME_FIELDS = [
  'linuxUnitName',
  'macosPlistLabel',
  'windowsTaskName',
  'windowsWrapperFileName',
] as const;

describe('SERVICE_DESCRIPTORS name isolation (no two ServiceIds may share a name)', () => {
  it.each(NAME_FIELDS)('%s is pairwise distinct across every ServiceId', (field) => {
    const values = SERVICE_IDS.map((id) => SERVICE_DESCRIPTORS[id][field]);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('every ServiceId key has a descriptor whose id field matches its key', () => {
    for (const key of SERVICE_IDS) {
      expect(SERVICE_DESCRIPTORS[key].id).toBe(key);
    }
  });
});

describe('getServiceDescriptor()', () => {
  it('with no argument returns the mcp-server descriptor', () => {
    expect(getServiceDescriptor()).toBe(SERVICE_DESCRIPTORS['mcp-server']);
  });

  it('the back-compat constants still equal the mcp-server values', () => {
    expect(WINDOWS_TASK_NAME).toBe(SERVICE_DESCRIPTORS['mcp-server'].windowsTaskName);
    expect(LINUX_UNIT_NAME).toBe(SERVICE_DESCRIPTORS['mcp-server'].linuxUnitName);
    expect(MACOS_PLIST_LABEL).toBe(SERVICE_DESCRIPTORS['mcp-server'].macosPlistLabel);
  });

  it('throws rather than returning undefined for an unknown id', () => {
    expect(() => getServiceDescriptor('not-a-real-service-id' as ServiceId)).toThrow();
  });
});

describe('platform managers construct from any host and report their own serviceId', () => {
  // Import the platform modules directly (as above) rather than going
  // through getServiceManager(), which branches on process.platform -- so
  // this exercises all three platform classes regardless of the host OS
  // actually running this suite.
  const managerClasses = [
    { name: 'LinuxServiceManager', Ctor: LinuxServiceManager },
    { name: 'MacOSServiceManager', Ctor: MacOSServiceManager },
    { name: 'WindowsServiceManager', Ctor: WindowsServiceManager },
  ] as const;

  for (const { name, Ctor } of managerClasses) {
    for (const id of SERVICE_IDS) {
      it(`${name} constructed with '${id}' reports serviceId '${id}'`, () => {
        const mgr = new Ctor(id);
        expect(mgr.serviceId).toBe(id);
      });
    }
  }
});
