export interface StallEntry {
  sessionId: string | null;
  logFilePath: string | null;
  lastActivityAt: number;
  consecutiveIdleCycles: number;
  consecutiveReadFailures: number;
  memberId: string;
  memberName: string;
  provisional: boolean;
}

export class StallDetector {
  private stallCheckList: Map<string, StallEntry> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;

  add(memberId: string, entry: StallEntry): void {
    if (this.stallCheckList.has(memberId)) {
      console.warn(`[StallDetector] Overwriting existing entry for member ${memberId}`);
    }
    this.stallCheckList.set(memberId, entry);
  }

  update(memberId: string, partial: Partial<StallEntry>): void {
    const existing = this.stallCheckList.get(memberId);
    if (!existing) {
      console.warn(`[StallDetector] Cannot update non-existent entry for member ${memberId}`);
      return;
    }
    this.stallCheckList.set(memberId, { ...existing, ...partial });
  }

  remove(memberId: string): void {
    this.stallCheckList.delete(memberId);
  }

  getEntry(memberId: string): StallEntry | undefined {
    return this.stallCheckList.get(memberId);
  }

  start(): void {
    if (this.pollInterval !== null) {
      console.warn('[StallDetector] Already started');
      return;
    }
    // TODO: Implement _poll method
    // this.pollInterval = setInterval(() => this._poll(), STALL_POLL_INTERVAL_MS);
    console.log('[StallDetector] Started (polling not yet implemented)');
  }

  stop(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.stallCheckList.clear();
    console.log('[StallDetector] Stopped');
  }

  private _poll(): void {
    // TODO: Implement polling logic in Task 4
  }
}

// Singleton instance
let instance: StallDetector | null = null;

export function getStallDetector(): StallDetector {
  if (!instance) {
    instance = new StallDetector();
  }
  return instance;
}
