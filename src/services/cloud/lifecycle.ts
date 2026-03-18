import net from 'node:net';
import type { Agent } from '../../types.js';
import { getAgent, updateAgent } from '../registry.js';
import { awsProvider } from './aws.js';
import { provisionAuth } from '../../tools/provision-auth.js';
import { provisionVcsAuth } from '../../tools/provision-vcs-auth.js';

const SSH_POLL_ATTEMPTS = 30;
const SSH_POLL_DELAY_MS = 2000;

function log(msg: string): void {
  process.stderr.write('[cloud] ' + msg + '\n');
}

async function waitForSsh(host: string, port: number): Promise<void> {
  for (let i = 0; i < SSH_POLL_ATTEMPTS; i++) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port, timeout: 2000 });
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (reachable) return;
    if (i < SSH_POLL_ATTEMPTS - 1) {
      await new Promise<void>(r => setTimeout(r, SSH_POLL_DELAY_MS));
    }
  }
  throw new Error(
    'SSH not ready on ' + host + ':' + port +
    ' after ' + SSH_POLL_ATTEMPTS + ' attempts (' +
    (SSH_POLL_ATTEMPTS * SSH_POLL_DELAY_MS / 1000) + 's)',
  );
}

async function reProvisionAuth(agent: Agent): Promise<void> {
  // F5: Re-provision Claude OAuth credentials from PM machine (best-effort)
  try {
    const result = await provisionAuth({ member_id: agent.id });
    if (!result.startsWith('\u2705')) {
      log('provision_auth warning for ' + agent.friendlyName + ': ' + result.split('\n')[0]);
    }
  } catch (e) {
    log('provision_auth failed for ' + agent.friendlyName + ': ' + (e as Error).message);
  }

  // F5: Re-mint GitHub App tokens if agent has git repos configured (best-effort)
  if (agent.gitAccess && agent.gitRepos && agent.gitRepos.length > 0) {
    try {
      const result = await provisionVcsAuth({
        member_id: agent.id,
        provider: 'github',
        github_mode: 'github-app',
        git_access: agent.gitAccess,
        repos: agent.gitRepos,
      });
      if (!result.startsWith('\u2705')) {
        log('provision_vcs_auth warning for ' + agent.friendlyName + ': ' + result.split('\n')[0]);
      }
    } catch (e) {
      log('provision_vcs_auth failed for ' + agent.friendlyName + ': ' + (e as Error).message);
    }
  }
}

/**
 * Ensures a cloud member's instance is running and SSH-ready before a tool
 * call proceeds. Returns the (possibly updated) agent from the registry.
 *
 * Non-cloud members are returned unchanged immediately.
 * Running:        verify IP is current; update registry if changed.
 * Stopped:        start instance, wait for running, update IP, poll SSH, re-provision auth (F5).
 * Stopping:       wait for stopped, then treat as stopped.
 * Pending:        wait for running, then update IP, poll SSH, re-provision auth.
 * Terminated/shutting-down: throw — instance cannot be used.
 */
export async function ensureCloudReady(agent: Agent): Promise<Agent> {
  if (!agent.cloud) return agent;

  const config = agent.cloud;
  const state = await awsProvider.getInstanceState(config);

  if (state === 'terminated' || state === 'shutting-down') {
    throw new Error('EC2 instance ' + config.instanceId + ' is ' + state + ' and cannot be used.');
  }

  if (state === 'running') {
    // Already running — verify IP and return
    try {
      const currentIp = await awsProvider.getPublicIp(config);
      if (currentIp !== agent.host) {
        log('IP updated for ' + agent.friendlyName + ': ' + agent.host + ' -> ' + currentIp);
        updateAgent(agent.id, { host: currentIp });
      }
    } catch {
      // Cannot get IP — SSH to existing host may still work
    }
    return getAgent(agent.id) ?? agent;
  }

  // Instance is not running — bring it up
  if (state === 'stopping') {
    log(agent.friendlyName + ' is stopping — waiting before start');
    await awsProvider.waitForStopped(config);
    log('Starting ' + agent.friendlyName + ' (' + config.instanceId + ')');
    await awsProvider.startInstance(config);
    await awsProvider.waitForRunning(config);
  } else if (state === 'pending') {
    log(agent.friendlyName + ' is pending — waiting for running');
    await awsProvider.waitForRunning(config);
  } else {
    // stopped
    log('Starting ' + agent.friendlyName + ' (' + config.instanceId + ')');
    await awsProvider.startInstance(config);
    await awsProvider.waitForRunning(config);
  }

  // Get fresh IP after start
  const newIp = await awsProvider.getPublicIp(config);
  log(agent.friendlyName + ' running at ' + newIp);

  // Update registry: new IP + reset idle timer (wiring point for T7)
  updateAgent(agent.id, { host: newIp, lastUsed: new Date().toISOString() });

  // Poll SSH readiness
  const sshPort = agent.port ?? 22;
  log('Waiting for SSH on ' + newIp + ':' + sshPort);
  await waitForSsh(newIp, sshPort);
  log('SSH ready — ' + agent.friendlyName + ' is live');

  // F5: Re-provision auth after fresh start
  await reProvisionAuth(getAgent(agent.id) ?? agent);

  return getAgent(agent.id) ?? agent;
}
