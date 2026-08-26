import { describe, it, expect } from 'vitest';
import { EventReporter, type RecordingEvent } from './event-reporter';
import { InMemoryStore } from '../adapters/storage';
import { EventBus } from './event-bus';
import { createLogger } from './logger';

function makeReporter() {
  const store = new InMemoryStore();
  const bus = new EventBus<{ event: RecordingEvent }>();
  const reporter = new EventReporter(store, bus, createLogger('test', 'error'));
  return { store, bus, reporter };
}

describe('EventReporter', () => {
  it('persists a reported event to the pending-events queue', async () => {
    const { store, reporter } = makeReporter();
    await reporter.report('MIC_SILENT', { sessionId: 's1' });
    const pending = await store.get<RecordingEvent[]>('pendingEvents');
    expect(pending).toHaveLength(1);
    expect(pending?.[0].type).toBe('MIC_SILENT');
    expect(pending?.[0].payload).toEqual({ sessionId: 's1' });
  });

  it('emits the event on the bus', async () => {
    const { bus, reporter } = makeReporter();
    const received: RecordingEvent[] = [];
    bus.on('event', (e) => received.push(e));
    await reporter.report('TAB_AUDIO_SILENT', {});
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('TAB_AUDIO_SILENT');
  });

  it('caps the queue at 500 entries, dropping the oldest', async () => {
    const { store, reporter } = makeReporter();
    for (let i = 0; i < 501; i++) {
      await reporter.report('LOW_DISK', { i });
    }
    const pending = await store.get<RecordingEvent[]>('pendingEvents');
    expect(pending).toHaveLength(500);
    expect(pending?.[0].payload).toEqual({ i: 1 });
  });
});
