/**
 * resolveServerPort: the port a server (and start/install) uses for a data dir
 * -- APRA_FLEET_PORT, else the port the member install recorded in that data
 * dir's member-install.json, else the built-in default. A service launch
 * carries no environment of its own, so the recorded port is what makes a
 * member install on a non-default port listen there.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveServerPort, recordedMemberInstallPort, BUILTIN_DEFAULT_PORT } from '../src/paths.js';

let dir: string;
const saved = { port: process.env.APRA_FLEET_PORT, data: process.env.APRA_FLEET_DATA_DIR };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-port-res-'));
  delete process.env.APRA_FLEET_PORT;
  process.env.APRA_FLEET_DATA_DIR = dir;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (saved.port === undefined) delete process.env.APRA_FLEET_PORT; else process.env.APRA_FLEET_PORT = saved.port;
  if (saved.data === undefined) delete process.env.APRA_FLEET_DATA_DIR; else process.env.APRA_FLEET_DATA_DIR = saved.data;
});

const writeMarker = (o: object) => fs.writeFileSync(path.join(dir, 'member-install.json'), JSON.stringify(o));

describe('resolveServerPort', () => {
  it('no marker, no env -> built-in default', () => {
    expect(resolveServerPort()).toBe(BUILTIN_DEFAULT_PORT);
  });
  it('marker records a port -> that port', () => {
    writeMarker({ version: 'v1', port: 7611 });
    expect(recordedMemberInstallPort()).toBe(7611);
    expect(resolveServerPort()).toBe(7611);
  });
  it('marker without a port (older install) -> built-in default', () => {
    writeMarker({ version: 'v1' });
    expect(resolveServerPort()).toBe(BUILTIN_DEFAULT_PORT);
  });
  it('APRA_FLEET_PORT wins over the marker', () => {
    writeMarker({ version: 'v1', port: 7611 });
    process.env.APRA_FLEET_PORT = '7700';
    expect(resolveServerPort()).toBe(7700);
  });
  it('an unparseable marker is ignored', () => {
    fs.writeFileSync(path.join(dir, 'member-install.json'), '{not json');
    expect(resolveServerPort()).toBe(BUILTIN_DEFAULT_PORT);
  });
});
