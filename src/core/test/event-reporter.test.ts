import { describe, it, expect } from 'vitest';
import { EventReporter, type RecordingEvent } from '../event-reporter';
import { InMemoryStore, type KeyValueStore } from '../../adapters/storage';
import { EventBus } from '../event-bus';
import { createLogger } from '../logger';

/**
 * `chrome.storage.local` structured-clones values in and out, so two readers
 * never share one array the way `InMemoryStore`'s by-reference map does. The
 * concurrency test needs that faithful copy semantics to be meaningful.
 */
class CloningStore implements KeyValueStore {
  private readonly map = new Map<string, string>();

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.map.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }
}

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
    expect(pending?.[0]?.type).toBe('MIC_SILENT');
    expect(pending?.[0]?.payload).toEqual({ sessionId: 's1' });
  });

  it('emits the event on the bus', async () => {
    const { bus, reporter } = makeReporter();
    const received: RecordingEvent[] = [];
    bus.on('event', (e) => received.push(e));
    await reporter.report('TAB_AUDIO_SILENT', {});
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('TAB_AUDIO_SILENT');
  });

  it('caps the queue at 500 entries, dropping the oldest', async () => {
    const { store, reporter } = makeReporter();
    for (let i = 0; i < 501; i++) {
      await reporter.report('LOW_DISK', { i });
    }
    const pending = await store.get<RecordingEvent[]>('pendingEvents');
    expect(pending).toHaveLength(500);
    expect(pending?.[0]?.payload).toEqual({ i: 1 });
  });

  it('serializes concurrent reports instead of dropping interleaved ones', async () => {
    const store = new CloningStore();
    const reporter = new EventReporter(
      store,
      new EventBus<{ event: RecordingEvent }>(),
      createLogger('test', 'error'),
    );

    await Promise.all([
      reporter.report('MIC_SILENT', { i: 0 }),
      reporter.report('TAB_AUDIO_SILENT', { i: 1 }),
      reporter.report('VIDEO_STALLED', { i: 2 }),
    ]);

    const pending = await store.get<RecordingEvent[]>('pendingEvents');
    expect(pending).toHaveLength(3);
    expect(pending?.map((e) => e.type)).toEqual(['MIC_SILENT', 'TAB_AUDIO_SILENT', 'VIDEO_STALLED']);
  });

  it('keeps reporting after one report rejects', async () => {
    const store = new CloningStore();
    let failNext = true;
    const flaky: KeyValueStore = {
      get: (key) => store.get(key),
      set: async (key, value) => {
        if (failNext) {
          failNext = false;
          throw new Error('storage unavailable');
        }
        await store.set(key, value);
      },
    };
    const reporter = new EventReporter(
      flaky,
      new EventBus<{ event: RecordingEvent }>(),
      createLogger('test', 'error'),
    );

    await expect(reporter.report('OPFS_ERROR', {})).rejects.toThrow('storage unavailable');
    await reporter.report('LOW_DISK', {});

    const pending = await store.get<RecordingEvent[]>('pendingEvents');
    expect(pending?.map((e) => e.type)).toEqual(['LOW_DISK']);
  });
});
