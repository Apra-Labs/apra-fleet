import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { serverVersion } from '../version.js';
import { parseVersion, isNewer } from '../services/update-check.js';
import { FLEET_DIR } from '../paths.js';

export async function runUpdate(): Promise<void> {
  console.log(`Checking for updates...`);

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 5000);
    let res: Response;
    try {
      res = await fetch('https://api.github.com/repos/Apra-Labs/apra-fleet/releases/latest', {
        signal: controller.signal,
        headers: { 'User-Agent': `apra-fleet/${serverVersion}` },
      });
    } finally {
      clearTimeout(tid);
    }

    if (!res.ok) {
      console.error(`Error: Could not check for updates (Status: ${res.status})`);
      return;
    }

    const data = await res.json() as { tag_name?: string, assets?: { name: string, browser_download_url: string }[] };
    const tagName = data.tag_name;
    if (!tagName || /-(alpha|beta|rc)\b/i.test(tagName)) {
      console.log('apra-fleet is up to date.');
      return;
    }

    const installed = serverVersion.split('_')[0];
    if (!isNewer(tagName, installed)) {
      console.log(`apra-fleet ${serverVersion} is up to date.`);
      return;
    }

    const platform = process.platform === 'win32' ? 'win-x64' : (process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64');
    const assetName = `apra-fleet-installer-${platform}${process.platform === 'win32' ? '.exe' : ''}`;
    const asset = data.assets?.find(a => a.name === assetName);

    if (!asset) {
      console.error(`Error: Could not find installer for platform ${platform}`);
      return;
    }

    console.log(`Updating to ${tagName} — restarting...`);

    const tmpPath = path.join(os.tmpdir(), assetName);
    const downloadRes = await fetch(asset.browser_download_url);
    if (!downloadRes.body) throw new Error('Download failed: No response body');

    const fileStream = fs.createWriteStream(tmpPath);
    await downloadRes.body.pipeTo(new WritableStream({
      write(chunk) {
        fileStream.write(Buffer.from(chunk));
      }
    }));
    
    await new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
      fileStream.end();
    });

    if (process.platform !== 'win32') {
      fs.chmodSync(tmpPath, 0o755);
    }

    const configPath = path.join(FLEET_DIR, '..', 'data', 'install-config.json');
    let config = { llm: 'claude', skill: 'all' };
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (e) {
        console.warn(`Warning: Could not parse install-config.json, using defaults.`);
      }
    } else {
      console.warn(`Warning: install-config.json missing, using defaults.`);
    }

    const args = ['install', '--llm', config.llm, '--skill', config.skill];
    const installer = spawn(tmpPath, args, { detached: true, stdio: 'ignore' });
    installer.unref();
    process.exit(0);

  } catch (e) {
    console.error(`Error: Update failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}
