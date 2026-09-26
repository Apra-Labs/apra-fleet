import { EventEmitter } from 'node:events';

export interface FleetEventMap {
  'credential:stored': { name: string };
  'task:completed': { taskId: string; status: string };
  'member:status-changed': { memberId: string; status: string };
  'stall:detected': { memberId: string; memberName: string };
}

class TypedEventBus extends EventEmitter {
  emit<K extends keyof FleetEventMap>(
    event: K,
    payload: FleetEventMap[K]
  ): boolean {
    return super.emit(event as string, payload);
  }

  on<K extends keyof FleetEventMap>(
    event: K,
    listener: (payload: FleetEventMap[K]) => void
  ): this {
    super.on(event as string, listener);
    return this;
  }

  off<K extends keyof FleetEventMap>(
    event: K,
    listener: (payload: FleetEventMap[K]) => void
  ): this {
    super.off(event as string, listener);
    return this;
  }

  once<K extends keyof FleetEventMap>(
    event: K,
    listener: (payload: FleetEventMap[K]) => void
  ): this {
    super.once(event as string, listener);
    return this;
  }
}

export const fleetEvents = new TypedEventBus();
