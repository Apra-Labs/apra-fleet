export type InstanceState =
  | 'pending'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'shutting-down'
  | 'terminated';

export interface CloudConfig {
  provider: 'aws';
  instanceId: string;
  region: string;
  profile?: string;
  idleTimeoutMin: number;
  sshKeyPath: string;
}

export interface CloudInstanceDetails {
  state: InstanceState;
  publicIp?: string;
  instanceType?: string;
  launchTime?: string;
}

export interface CloudProvider {
  getInstanceState(config: CloudConfig): Promise<InstanceState>;
  startInstance(config: CloudConfig): Promise<void>;
  stopInstance(config: CloudConfig): Promise<void>;
  waitForRunning(config: CloudConfig): Promise<void>;
  waitForStopped(config: CloudConfig): Promise<void>;
  getPublicIp(config: CloudConfig): Promise<string>;
  getInstanceDetails(config: CloudConfig): Promise<CloudInstanceDetails>;
}
