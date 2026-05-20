import { describe, it, expect, beforeEach } from 'vitest';
import { fleetEvents, FleetEventMap } from '../src/services/event-bus.js';

describe('event-bus: TypedEventBus', () => {
  beforeEach(() => {
    fleetEvents.removeAllListeners();
  });

  describe('emit and subscribe', () => {
    it('delivers credentials:stored events to all subscribers', () => {
      const results: { name: string }[] = [];

      const handler = (payload: FleetEventMap['credential:stored']) => {
        results.push(payload);
      };

      fleetEvents.on('credential:stored', handler);
      fleetEvents.emit('credential:stored', { name: 'test-cred' });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ name: 'test-cred' });
    });

    it('delivers to multiple subscribers', () => {
      const results1: { name: string }[] = [];
      const results2: { name: string }[] = [];

      const handler1 = (payload: FleetEventMap['credential:stored']) => {
        results1.push(payload);
      };
      const handler2 = (payload: FleetEventMap['credential:stored']) => {
        results2.push(payload);
      };

      fleetEvents.on('credential:stored', handler1);
      fleetEvents.on('credential:stored', handler2);
      fleetEvents.emit('credential:stored', { name: 'shared-cred' });

      expect(results1).toHaveLength(1);
      expect(results1[0]).toEqual({ name: 'shared-cred' });
      expect(results2).toHaveLength(1);
      expect(results2[0]).toEqual({ name: 'shared-cred' });
    });

    it('calls listeners multiple times for multiple emits', () => {
      const results: { name: string }[] = [];

      fleetEvents.on('credential:stored', (payload) => {
        results.push(payload);
      });

      fleetEvents.emit('credential:stored', { name: 'cred1' });
      fleetEvents.emit('credential:stored', { name: 'cred2' });
      fleetEvents.emit('credential:stored', { name: 'cred3' });

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ name: 'cred1' });
      expect(results[1]).toEqual({ name: 'cred2' });
      expect(results[2]).toEqual({ name: 'cred3' });
    });
  });

  describe('unsubscribe (off)', () => {
    it('prevents delivery to unsubscribed listeners', () => {
      const results: { name: string }[] = [];

      const handler = (payload: FleetEventMap['credential:stored']) => {
        results.push(payload);
      };

      fleetEvents.on('credential:stored', handler);
      fleetEvents.emit('credential:stored', { name: 'before-off' });

      fleetEvents.off('credential:stored', handler);
      fleetEvents.emit('credential:stored', { name: 'after-off' });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ name: 'before-off' });
    });

    it('does not affect other subscribers when one is removed', () => {
      const results1: { name: string }[] = [];
      const results2: { name: string }[] = [];

      const handler1 = (payload: FleetEventMap['credential:stored']) => {
        results1.push(payload);
      };
      const handler2 = (payload: FleetEventMap['credential:stored']) => {
        results2.push(payload);
      };

      fleetEvents.on('credential:stored', handler1);
      fleetEvents.on('credential:stored', handler2);
      fleetEvents.emit('credential:stored', { name: 'shared1' });

      fleetEvents.off('credential:stored', handler1);
      fleetEvents.emit('credential:stored', { name: 'shared2' });

      expect(results1).toHaveLength(1);
      expect(results1[0]).toEqual({ name: 'shared1' });
      expect(results2).toHaveLength(2);
      expect(results2[0]).toEqual({ name: 'shared1' });
      expect(results2[1]).toEqual({ name: 'shared2' });
    });
  });

  describe('multiple event types', () => {
    it('different event types are independent', () => {
      const credentialResults: { name: string }[] = [];
      const taskResults: { taskId: string; status: string }[] = [];

      fleetEvents.on('credential:stored', (payload) => {
        credentialResults.push(payload);
      });
      fleetEvents.on('task:completed', (payload) => {
        taskResults.push(payload);
      });

      fleetEvents.emit('credential:stored', { name: 'cred' });
      fleetEvents.emit('task:completed', { taskId: 'task1', status: 'done' });

      expect(credentialResults).toHaveLength(1);
      expect(credentialResults[0]).toEqual({ name: 'cred' });
      expect(taskResults).toHaveLength(1);
      expect(taskResults[0]).toEqual({ taskId: 'task1', status: 'done' });
    });

    it('emitting one event type does not trigger listeners of other types', () => {
      const credentialResults: { name: string }[] = [];
      const memberResults: { memberId: string; status: string }[] = [];

      fleetEvents.on('credential:stored', (payload) => {
        credentialResults.push(payload);
      });
      fleetEvents.on('member:status-changed', (payload) => {
        memberResults.push(payload);
      });

      fleetEvents.emit('credential:stored', { name: 'cred' });

      expect(credentialResults).toHaveLength(1);
      expect(memberResults).toHaveLength(0);
    });
  });

  describe('once: one-time listeners', () => {
    it('once listener fires only once', () => {
      const results: { name: string }[] = [];

      fleetEvents.once('credential:stored', (payload) => {
        results.push(payload);
      });

      fleetEvents.emit('credential:stored', { name: 'first' });
      fleetEvents.emit('credential:stored', { name: 'second' });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ name: 'first' });
    });
  });

  describe('typed payload correctness', () => {
    it('task:completed payload has taskId and status', () => {
      let receivedPayload: FleetEventMap['task:completed'] | null = null;

      fleetEvents.on('task:completed', (payload) => {
        receivedPayload = payload;
      });

      fleetEvents.emit('task:completed', {
        taskId: 'task-123',
        status: 'completed',
      });

      expect(receivedPayload).not.toBeNull();
      expect(receivedPayload).toEqual({
        taskId: 'task-123',
        status: 'completed',
      });
    });

    it('member:status-changed payload has memberId and status', () => {
      let receivedPayload: FleetEventMap['member:status-changed'] | null =
        null;

      fleetEvents.on('member:status-changed', (payload) => {
        receivedPayload = payload;
      });

      fleetEvents.emit('member:status-changed', {
        memberId: 'member-456',
        status: 'offline',
      });

      expect(receivedPayload).not.toBeNull();
      expect(receivedPayload).toEqual({
        memberId: 'member-456',
        status: 'offline',
      });
    });

    it('stall:detected payload has memberId and memberName', () => {
      let receivedPayload: FleetEventMap['stall:detected'] | null = null;

      fleetEvents.on('stall:detected', (payload) => {
        receivedPayload = payload;
      });

      fleetEvents.emit('stall:detected', {
        memberId: 'member-789',
        memberName: 'test-member',
      });

      expect(receivedPayload).not.toBeNull();
      expect(receivedPayload).toEqual({
        memberId: 'member-789',
        memberName: 'test-member',
      });
    });
  });
});
