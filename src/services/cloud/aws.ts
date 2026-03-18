import { exec, type ExecOptions } from 'node:child_process';
import { promisify } from 'node:util';
import type { CloudConfig, CloudProvider, InstanceState } from './types.js';
import { escapeShellArg } from '../../utils/shell-escape.js';

type ExecResult = { stdout: string; stderr: string };
type ExecFn = (cmd: string, opts?: ExecOptions) => Promise<ExecResult>;

const VALID_STATES = new Set<string>([
  'pending', 'running', 'stopping', 'stopped', 'shutting-down', 'terminated',
]);

const AWS_CLI_MISSING =
  'AWS CLI not found. Install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html';

function validateInstanceId(id: string): void {
  if (!/^i-[0-9a-f]{8,17}$/.test(id)) {
    throw new Error(`Invalid EC2 instance ID: ${id}`);
  }
}

function validateRegion(region: string): void {
  if (!/^[a-z]{2}-[a-z]+-\d+$/.test(region)) {
    throw new Error(`Invalid AWS region: ${region}`);
  }
}

function baseArgs(config: CloudConfig): string {
  validateInstanceId(config.instanceId);
  validateRegion(config.region);
  const profilePart = config.profile ? ` --profile ${escapeShellArg(config.profile)}` : '';
  return `--region ${config.region}${profilePart}`;
}

export class AwsCloudProvider implements CloudProvider {
  private readonly run: ExecFn;
  private cliChecked = false;
  private cliAvailable = false;

  constructor(execFn?: ExecFn) {
    this.run = execFn ?? (promisify(exec) as unknown as ExecFn);
  }

  private async ensureCli(): Promise<void> {
    if (this.cliChecked) {
      if (!this.cliAvailable) throw new Error(AWS_CLI_MISSING);
      return;
    }
    try {
      await this.run('aws --version');
      this.cliAvailable = true;
    } catch {
      this.cliAvailable = false;
    }
    this.cliChecked = true;
    if (!this.cliAvailable) throw new Error(AWS_CLI_MISSING);
  }

  async getInstanceState(config: CloudConfig): Promise<InstanceState> {
    await this.ensureCli();
    const base = baseArgs(config);
    const { stdout } = await this.run(
      `aws ec2 describe-instances --instance-ids ${config.instanceId} --query 'Reservations[0].Instances[0].State.Name' --output text ${base}`,
    );
    const state = stdout.trim();
    if (!VALID_STATES.has(state)) {
      throw new Error(`Unexpected instance state: ${state}`);
    }
    return state as InstanceState;
  }

  async startInstance(config: CloudConfig): Promise<void> {
    await this.ensureCli();
    const base = baseArgs(config);
    await this.run(`aws ec2 start-instances --instance-ids ${config.instanceId} ${base}`);
  }

  async stopInstance(config: CloudConfig): Promise<void> {
    await this.ensureCli();
    const base = baseArgs(config);
    await this.run(`aws ec2 stop-instances --instance-ids ${config.instanceId} ${base}`);
  }

  async waitForRunning(config: CloudConfig): Promise<void> {
    await this.ensureCli();
    const base = baseArgs(config);
    await this.run(
      `aws ec2 wait instance-running --instance-ids ${config.instanceId} ${base}`,
      { timeout: 300_000 },
    );
  }

  async waitForStopped(config: CloudConfig): Promise<void> {
    await this.ensureCli();
    const base = baseArgs(config);
    await this.run(
      `aws ec2 wait instance-stopped --instance-ids ${config.instanceId} ${base}`,
      { timeout: 300_000 },
    );
  }

  async getPublicIp(config: CloudConfig): Promise<string> {
    await this.ensureCli();
    const base = baseArgs(config);
    const { stdout } = await this.run(
      `aws ec2 describe-instances --instance-ids ${config.instanceId} --query 'Reservations[0].Instances[0].PublicIpAddress' --output text ${base}`,
    );
    const ip = stdout.trim();
    if (!ip || ip === 'None') {
      throw new Error(`No public IP address for instance ${config.instanceId}`);
    }
    return ip;
  }
}

export const awsProvider = new AwsCloudProvider();
