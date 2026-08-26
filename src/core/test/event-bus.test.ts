import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../event-bus';

type Events = {
  ping: { count: number };
};

describe('EventBus', () => {
  it('delivers emitted payloads to subscribed listeners', () => {
    const bus = new EventBus<Events>();
    const listener = vi.fn();
    bus.on('ping', listener);
    bus.emit('ping', { count: 1 });
    expect(listener).toHaveBeenCalledWith({ count: 1 });
  });

  it('stops delivery after off()', () => {
    const bus = new EventBus<Events>();
    const listener = vi.fn();
    bus.on('ping', listener);
    bus.off('ping', listener);
    bus.emit('ping', { count: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('the unsubscribe function returned by on() also stops delivery', () => {
    const bus = new EventBus<Events>();
    const listener = vi.fn();
    const unsubscribe = bus.on('ping', listener);
    unsubscribe();
    bus.emit('ping', { count: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('supports multiple listeners for the same event', () => {
    const bus = new EventBus<Events>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('ping', a);
    bus.on('ping', b);
    bus.emit('ping', { count: 1 });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });
});
